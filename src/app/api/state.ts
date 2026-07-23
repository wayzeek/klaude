/**
 * =============================================================================
 * SHARED APPLICATION STATE WITH EVENT EMITTER
 * =============================================================================
 *
 * In-memory state for the Strudel REPL with Server-Sent Events support.
 *
 * The protocol is revision-based so agents get a real feedback loop:
 * - Every code change bumps `revision`; browsers report eval results per revision.
 * - Every explicit play bumps `playEpoch` so a repeated play forces re-evaluation.
 * - Browsers register as clients and report readiness (editor loaded, audio unlocked).
 * - Record start/stop travel as targeted, id'd commands so SSE reconnects
 *   can't replay them and multiple tabs don't all record.
 *
 * Code + history persist to .klaude/state.json across restarts.
 * Playback state is deliberately NOT persisted - a fresh server never
 * auto-blasts audio.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CODE } from '@/lib/constants'

export type NowPlaying = {
  title: string | null
  artist: string | null
  section: string | null
}

export type RecordCommand = {
  id: number
  type: 'record-start' | 'record-stop'
  targetClientId: string
}

/** The slice of state broadcast to browsers over SSE. */
export type BroadcastState = {
  code: string
  revision: number
  desiredPlaying: boolean
  playEpoch: number
  gain: { level: number; rampMs: number; seq: number }
  nowPlaying: NowPlaying | null
  command: RecordCommand | null
}

export type ClientInfo = {
  id: string
  connectedAt: number
  lastSeen: number
  editorReady: boolean
  audioReady: boolean
  isPlaying: boolean
  appliedRevision: number
  /** Open SSE streams for this id - reconnects briefly overlap old and new */
  connections: number
}

export type EvalResult = {
  revision: number
  playEpoch: number
  ok: boolean
  error: string | null
  clientId: string
  at: number
}

export type RecordingState =
  | { phase: 'idle' }
  | { phase: 'starting' | 'recording' | 'stopping'; commandId: number; clientId: string; startedAt: number | null }
  | { phase: 'done'; file: string; bytes: number; at: number }
  | { phase: 'error'; error: string; at: number }

export type HistoryEntry = { revision: number; code: string; at: number }

type Listener = (state: BroadcastState) => void

const HISTORY_LIMIT = 100
const PERSIST_DEBOUNCE_MS = 500
const CLIENT_STALE_MS = 90_000
const RECORD_START_TIMEOUT_MS = 15_000
const RECORD_STOP_TIMEOUT_MS = 60_000
const STATE_DIR = path.join(process.cwd(), '.klaude')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

type PersistedState = {
  code: string
  revision: number
  history: HistoryEntry[]
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (typeof parsed.code !== 'string' || !Number.isSafeInteger(parsed.revision)) return null
    const history = (Array.isArray(parsed.history) ? parsed.history : [])
      .filter(
        (h): h is HistoryEntry =>
          h !== null &&
          typeof h === 'object' &&
          Number.isSafeInteger((h as HistoryEntry).revision) &&
          typeof (h as HistoryEntry).code === 'string' &&
          typeof (h as HistoryEntry).at === 'number',
      )
      .slice(-HISTORY_LIMIT)
    return { code: parsed.code, revision: parsed.revision as number, history }
  } catch {
    return null
  }
}

class StateEmitter {
  private listeners: Set<Listener> = new Set()

  private _code: string
  private _revision: number
  private _desiredPlaying = false
  private _playEpoch = 0
  private _gain = { level: 1, rampMs: 200, seq: 0 }
  private _nowPlaying: NowPlaying | null = null
  private _command: RecordCommand | null = null
  private _commandSeq = 0

  private _clients = new Map<string, ClientInfo>()
  private _lastEval: EvalResult | null = null
  private _history: HistoryEntry[]
  private _recording: RecordingState = { phase: 'idle' }
  private _recordIssuedAt = 0

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    const persisted = loadPersisted()
    this._code = persisted?.code ?? DEFAULT_CODE
    this._revision = persisted?.revision ?? 0
    this._history = persisted?.history ?? []
    if (persisted === null) {
      this._history = [{ revision: this._revision, code: this._code, at: Date.now() }]
    }
  }

  // --- broadcast state ------------------------------------------------------

  get broadcast(): BroadcastState {
    return {
      code: this._code,
      revision: this._revision,
      desiredPlaying: this._desiredPlaying,
      playEpoch: this._playEpoch,
      gain: this._gain,
      nowPlaying: this._nowPlaying,
      command: this._command,
    }
  }

  get code(): string {
    return this._code
  }

  get revision(): number {
    return this._revision
  }

  get desiredPlaying(): boolean {
    return this._desiredPlaying
  }

  get playEpoch(): number {
    return this._playEpoch
  }

  get gain() {
    return this._gain
  }

  get nowPlaying(): NowPlaying | null {
    return this._nowPlaying
  }

  get lastEval(): EvalResult | null {
    return this._lastEval
  }

  get recording(): RecordingState {
    return this._recording
  }

  get history(): HistoryEntry[] {
    return this._history
  }

  /** True if any live client reports audio actually playing. */
  get actualPlaying(): boolean {
    return this.liveClients.some((c) => c.isPlaying)
  }

  // --- mutations ------------------------------------------------------------

  /** Apply a code change without emitting. Returns whether anything changed. */
  private applyCode(code: string): boolean {
    if (code === this._code) return false
    this._code = code
    this._revision += 1
    this._history.push({ revision: this._revision, code, at: Date.now() })
    if (this._history.length > HISTORY_LIMIT) {
      this._history.splice(0, this._history.length - HISTORY_LIMIT)
    }
    this.schedulePersist()
    return true
  }

  /** Push new code: bumps the revision and records history. Returns the new revision. */
  setCode(code: string): number {
    if (this.applyCode(code)) this.emit()
    return this._revision
  }

  /** Request playback. Always bumps playEpoch so browsers re-evaluate even if already playing. */
  play(): void {
    this._desiredPlaying = true
    this._playEpoch += 1
    this.emit()
  }

  /**
   * Atomic push-and-play: one state mutation, one SSE snapshot. Emitting
   * code and play separately would let browsers evaluate twice (once per
   * snapshot) when already playing.
   */
  pushAndPlay(code: string): number {
    this.applyCode(code)
    this._desiredPlaying = true
    this._playEpoch += 1
    this.emit()
    return this._revision
  }

  stop(): void {
    this._desiredPlaying = false
    this._nowPlaying = null
    this.emit()
  }

  setGain(level: number, rampMs: number): void {
    this._gain = { level, rampMs, seq: this._gain.seq + 1 }
    this.emit()
  }

  setNowPlaying(nowPlaying: NowPlaying | null): void {
    this._nowPlaying = nowPlaying
    this.emit()
  }

  // --- clients ----------------------------------------------------------------

  registerClient(id: string): void {
    const existing = this._clients.get(id)
    const now = Date.now()
    if (existing) {
      existing.lastSeen = now
      existing.connections += 1
      return
    }
    this._clients.set(id, {
      id,
      connectedAt: now,
      lastSeen: now,
      editorReady: false,
      audioReady: false,
      isPlaying: false,
      appliedRevision: -1,
      connections: 1,
    })
  }

  /**
   * Called when an SSE stream closes. During a reconnect the new stream
   * registers before the old one cancels, so only drop the client when its
   * last connection is gone.
   */
  unregisterClient(id: string): void {
    const client = this._clients.get(id)
    if (!client) return
    client.connections -= 1
    if (client.connections <= 0) {
      this._clients.delete(id)
    }
  }

  updateClient(
    id: string,
    patch: Partial<Pick<ClientInfo, 'editorReady' | 'audioReady' | 'isPlaying' | 'appliedRevision'>>,
  ): void {
    let client = this._clients.get(id)
    if (!client) {
      // Client posted before (or after) its SSE stream registered. Recreate
      // it with no counted connection - the stream's own register adds that.
      const now = Date.now()
      client = {
        id,
        connectedAt: now,
        lastSeen: now,
        editorReady: false,
        audioReady: false,
        isPlaying: false,
        appliedRevision: -1,
        connections: 0,
      }
      this._clients.set(id, client)
    }
    Object.assign(client, patch)
    client.lastSeen = Date.now()
  }

  /**
   * Non-stale clients. Entries that stopped reporting (browser heartbeats
   * every 10s; background tabs get throttled, hence the generous window) are
   * treated as gone - they linger only if a tab died without its SSE stream
   * cancelling cleanly.
   */
  get clients(): ClientInfo[] {
    const cutoff = Date.now() - CLIENT_STALE_MS
    return [...this._clients.values()].filter((c) => c.lastSeen >= cutoff)
  }

  /**
   * Clients with an open SSE stream - the only ones that can receive
   * commands or actually play anything. A readiness POST alone (connections
   * 0) means the tab can talk to us but we can't talk to it.
   */
  get liveClients(): ClientInfo[] {
    return this.clients.filter((c) => c.connections > 0)
  }

  // --- eval feedback -----------------------------------------------------------

  recordEval(result: EvalResult): void {
    // Future-keyed reports are impossible from an honest client in this
    // process's lifetime (e.g. leftovers from before a server restart, when
    // playEpoch reset) - drop them so they can't masquerade as fresh later.
    if (result.revision > this._revision || result.playEpoch > this._playEpoch) return

    // Keep only the freshest result (later revision, or same revision/newer epoch)
    const prev = this._lastEval
    if (
      !prev ||
      result.revision > prev.revision ||
      (result.revision === prev.revision && result.playEpoch >= prev.playEpoch)
    ) {
      this._lastEval = result
    }
    // On failure, don't touch isPlaying: a failed eval leaves the previous
    // pattern running, and the client reports its true playing state anyway.
    this.updateClient(
      result.clientId,
      result.ok
        ? { appliedRevision: result.revision, isPlaying: this._desiredPlaying }
        : { appliedRevision: result.revision },
    )
  }

  // --- recording ---------------------------------------------------------------

  /**
   * Issue a record command. Start targets the best available client (most
   * recently seen with audio ready and a live SSE stream); stop MUST target
   * the client that is actually recording - any other tab would just reply
   * "nothing was recorded" while the real one keeps capturing.
   * Returns the command, or null if no eligible client exists.
   */
  issueRecordCommand(type: RecordCommand['type']): RecordCommand | null {
    let target: ClientInfo | undefined
    if (type === 'record-start') {
      target = this.liveClients
        .filter((c) => c.audioReady)
        .sort((a, b) => b.lastSeen - a.lastSeen)[0]
    } else {
      const recordingClientId =
        this._recording.phase === 'starting' || this._recording.phase === 'recording'
          ? this._recording.clientId
          : null
      target = recordingClientId
        ? this.liveClients.find((c) => c.id === recordingClientId)
        : undefined
    }
    if (!target) return null

    this._commandSeq += 1
    this._command = { id: this._commandSeq, type, targetClientId: target.id }
    this._recordIssuedAt = Date.now()

    if (type === 'record-start') {
      this._recording = {
        phase: 'starting',
        commandId: this._commandSeq,
        clientId: target.id,
        startedAt: null,
      }
    } else if (this._recording.phase === 'recording' || this._recording.phase === 'starting') {
      this._recording = { ...this._recording, phase: 'stopping' }
    }

    this.emit()
    return this._command
  }

  /**
   * Recover from recording dead-ends: a lost ack or a vanished tab must not
   * wedge the phase forever. Called from the record/status routes.
   */
  reconcileRecording(): void {
    const rec = this._recording
    if (rec.phase === 'starting' && Date.now() - (rec.startedAt ?? this._recordIssuedAt) > RECORD_START_TIMEOUT_MS) {
      this._recording = { phase: 'error', error: 'Recording never started (no ack from the browser)', at: Date.now() }
    } else if (rec.phase === 'stopping' && Date.now() - this._recordIssuedAt > RECORD_STOP_TIMEOUT_MS) {
      this._recording = { phase: 'error', error: 'Recording never finished (WAV upload did not arrive)', at: Date.now() }
    }
  }

  setRecording(recording: RecordingState): void {
    this._recording = recording
  }

  /** Clear an executed command (matched by id) so SSE reconnects can't replay it. */
  clearCommand(id: number): void {
    if (this._command?.id === id) {
      this._command = null
      this.emit()
    }
  }

  // --- pub/sub -------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.broadcast
    this.listeners.forEach((listener) => listener(snapshot))
  }

  // --- persistence -----------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt the file. */
  private persistNow(): void {
    try {
      const payload: PersistedState = {
        code: this._code,
        revision: this._revision,
        history: this._history,
      }
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload))
      fs.renameSync(tmp, STATE_FILE)
    } catch (err) {
      console.error('[klaude] failed to persist state:', err)
    }
  }
}

/**
 * Singleton via globalThis so dev-mode hot reloads and separately-bundled
 * route handlers all share the same state and listeners.
 */
const globalForState = globalThis as unknown as { __strudelState?: StateEmitter }

export const state =
  globalForState.__strudelState ?? (globalForState.__strudelState = new StateEmitter())
