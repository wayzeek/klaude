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
 * Code + history persist to .moltek/state.json across restarts.
 * Playback state is deliberately NOT persisted - a fresh server never
 * auto-blasts audio.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CODE } from '@/lib/constants'
import {
  clampTrim,
  hasTrim,
  isNeutral,
  isStructuralDifference,
  NEUTRAL_TRIM,
  trimFor,
  type LayerTrim,
} from '@/lib/trim'

export type NowPlaying = {
  title: string | null
  artist: string | null
  section: string | null
  /** When this piece started (reset when the title changes). */
  since: number
  /** Sections this piece has moved through, oldest first. */
  trail: { section: string; at: number }[]
}

export type Note = {
  text: string
  /** Layer the note targets, or null for the whole track. */
  layer: string | null
  at: number
  revision: number
  section: string | null
}

export type RecordCommand = {
  id: number
  type: 'record-start' | 'record-stop'
  targetClientId: string
}

export type MixState = {
  muted: string[]
  soloed: string[]
  /** Only non-neutral entries are stored, keyed by layer name. */
  trims: Record<string, LayerTrim>
  /** Bumps on any mix change. */
  seq: number
  /**
   * Bumps only on changes that require the pattern to be rebuilt: mute, solo,
   * feel and swing. Volume, tone and space are read per event at query time, so
   * a fader move must not move this counter or the browser would re-evaluate the
   * whole track under the listener's finger.
   */
  structuralSeq: number
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
  mix: MixState
  layers: string[]
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
const NOTES_LIMIT = 200
const TRAIL_LIMIT = 24
const MAX_TRIMS = 64
const MAX_LAYER_NAME = 40
const PERSIST_DEBOUNCE_MS = 500
const CLIENT_STALE_MS = 90_000
const RECORD_START_TIMEOUT_MS = 15_000
const RECORD_STOP_TIMEOUT_MS = 60_000
const STATE_DIR = path.join(process.cwd(), '.moltek')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
/**
 * The state directory was `.klaude` before the rename. Without this, an
 * existing install starts on DEFAULT_CODE and silently loses the working
 * track, its whole revision history, and any notes. Read-only fallback: the
 * legacy file is never written to, so the next persist lands in `.moltek` and
 * the migration stops being consulted.
 */
const LEGACY_STATE_FILE = path.join(process.cwd(), '.klaude', 'state.json')

type PersistedState = {
  code: string
  revision: number
  history: HistoryEntry[]
  mutedLayers?: string[]
  trims?: Record<string, LayerTrim>
  notes?: Note[]
}

function loadPersisted(): PersistedState | null {
  return readStateFile(STATE_FILE) ?? readStateFile(LEGACY_STATE_FILE)
}

function readStateFile(file: string): PersistedState | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
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
    const mutedLayers = (Array.isArray(parsed.mutedLayers) ? parsed.mutedLayers : []).filter(
      (m): m is string => typeof m === 'string',
    )
    const notes = (Array.isArray(parsed.notes) ? parsed.notes : [])
      .filter(
        (n): n is Note =>
          n !== null &&
          typeof n === 'object' &&
          typeof (n as Note).text === 'string' &&
          typeof (n as Note).at === 'number' &&
          typeof (n as Note).revision === 'number',
      )
      .slice(-NOTES_LIMIT)
    // A hand-edited or truncated file must not be able to inject an
    // out-of-range trim that request-time clamping never sees.
    const trims: Record<string, LayerTrim> = {}
    const rawTrims = (parsed as { trims?: unknown }).trims
    if (rawTrims !== null && typeof rawTrims === 'object' && !Array.isArray(rawTrims)) {
      for (const [name, value] of Object.entries(rawTrims as Record<string, unknown>)) {
        if (Object.keys(trims).length >= MAX_TRIMS) break
        if (name.length === 0 || name.length > MAX_LAYER_NAME) continue
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        const clamped = clampTrim(value as Partial<LayerTrim>)
        if (!isNeutral(clamped)) trims[name] = clamped
      }
    }
    return { code: parsed.code, revision: parsed.revision as number, history, mutedLayers, trims, notes }
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
  private _notes: Note[] = []
  private _lastEval: EvalResult | null = null
  private _history: HistoryEntry[]
  private _recording: RecordingState = { phase: 'idle' }
  private _recordIssuedAt = 0
  private _mix: MixState = { muted: [], soloed: [], trims: {}, seq: 0, structuralSeq: 0 }
  private _layerNames: string[] = []

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    const persisted = loadPersisted()
    this._code = persisted?.code ?? DEFAULT_CODE
    this._revision = persisted?.revision ?? 0
    this._history = persisted?.history ?? []
    if (persisted === null) {
      this._history = [{ revision: this._revision, code: this._code, at: Date.now() }]
    }
    this._mix = {
      muted: persisted?.mutedLayers ?? [],
      soloed: [],
      trims: persisted?.trims ?? {},
      seq: 0,
      structuralSeq: 0,
    }
    this._notes = persisted?.notes ?? []
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
      mix: this._mix,
      layers: this._layerNames,
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

  get mix(): MixState {
    return this._mix
  }

  get layerNames(): string[] {
    return this._layerNames
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
    // New revision: solo is a listening gesture, not an arrangement - clear it.
    // Mutes persist until the layer disappears or someone unmutes.
    if (this._mix.soloed.length > 0) {
      this._mix = {
        ...this._mix,
        soloed: [],
        seq: this._mix.seq + 1,
        structuralSeq: this._mix.structuralSeq + 1,
      }
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

  /**
   * Update the HUD metadata. `since` and the section trail are stamped here:
   * a new title starts a new piece (fresh clock, fresh trail); a section
   * change appends to the current piece's trail.
   */
  setNowPlaying(input: { title: string | null; artist: string | null; section: string | null } | null): void {
    if (input === null) {
      this._nowPlaying = null
      this.emit()
      return
    }
    const prev = this._nowPlaying
    const now = Date.now()
    const newPiece = !prev || input.title !== prev.title
    let trail = newPiece ? [] : [...prev.trail]
    if (input.section && input.section !== (newPiece ? null : prev?.section)) {
      trail.push({ section: input.section, at: now })
      if (trail.length > TRAIL_LIMIT) trail = trail.slice(-TRAIL_LIMIT)
    }
    this._nowPlaying = {
      title: input.title,
      artist: input.artist,
      section: input.section,
      since: newPiece ? now : prev.since,
      trail,
    }
    this.emit()
  }

  // --- mix (per-layer solo/mute) ---------------------------------------------

  /**
   * Update mix state. Arrays replace wholesale; toggles flip one name
   * against the CURRENT server state, so two rapid clicks from a stale
   * client snapshot can't overwrite each other. Solo and mute are exclusive
   * per layer: toggling one ON kicks the other OFF for that name - a row
   * that is both soloed and muted means nothing to a listener.
   * Bumps seq, emits.
   */
  setMix(patch: {
    muted?: string[]
    soloed?: string[]
    toggleMuted?: string
    toggleSoloed?: string
    soloOnly?: string
    trim?: { layer: string } & Partial<LayerTrim>
    resetTrim?: string
    resetAllTrims?: boolean
  }): MixState {
    const prev = this._mix
    const without = (list: string[], name: string) => list.filter((n) => n !== name)
    let muted = patch.muted ?? prev.muted
    let soloed = patch.soloed ?? prev.soloed
    if (patch.toggleMuted) {
      if (muted.includes(patch.toggleMuted)) {
        muted = without(muted, patch.toggleMuted)
      } else {
        muted = [...muted, patch.toggleMuted]
        soloed = without(soloed, patch.toggleMuted)
      }
    }
    if (patch.toggleSoloed) {
      if (soloed.includes(patch.toggleSoloed)) {
        soloed = without(soloed, patch.toggleSoloed)
      } else {
        soloed = [...soloed, patch.toggleSoloed]
        muted = without(muted, patch.toggleSoloed)
      }
    }
    // Exclusive solo: "let me hear just this", in one call. It MOVES the solo
    // rather than adding to it, and clears it when the named layer was already
    // alone. Atomic like the toggles - the decision is made against the
    // server's own state, so a stale client snapshot cannot resurrect a solo
    // that was just cleared. The console's own solo button is the additive
    // toggle above: a listener checking a groove wants the kick and the bass
    // soloed together. This one is for auditioning a single layer in isolation
    // without first having to clear whatever else was soloed.
    if (patch.soloOnly) {
      const alreadyAlone = soloed.length === 1 && soloed[0] === patch.soloOnly
      soloed = alreadyAlone ? [] : [patch.soloOnly]
      if (!alreadyAlone) muted = without(muted, patch.soloOnly)
    }

    // Clearing every layer at once is one mutation, so the whole rack returns
    // to as-written in a single SSE frame and a single re-evaluation rather
    // than one per layer.
    const trims = patch.resetAllTrims ? {} : { ...prev.trims }
    if (patch.resetTrim) delete trims[patch.resetTrim]
    if (patch.trim) {
      const { layer, ...values } = patch.trim
      const merged = clampTrim(values, trimFor(trims, layer))
      // A layer back at neutral carries no record, so the common case stays empty.
      if (isNeutral(merged)) delete trims[layer]
      // Live state needs the same ceiling the persisted file has, or a client
      // naming a fresh layer on every request could grow this without bound.
      // Layers that already have a record are always allowed to change.
      else if (hasTrim(trims, layer) || Object.keys(trims).length < MAX_TRIMS) trims[layer] = merged
    }

    // Solo wins over mute, so a name cannot end up in both. The per-layer
    // toggles already enforce that, but a wholesale POST of
    // {"muted":["kick"],"soloed":["kick"]} would otherwise be stored as-is:
    // kick stays audible because solo takes precedence at playback, while the
    // row shows it muted and struck through, and clearing the solo later would
    // silence it for a reason the listener never chose.
    if (soloed.length > 0) {
      const stillMuted = muted.filter((name) => !soloed.includes(name))
      if (stillMuted.length !== muted.length) muted = stillMuted
    }

    const sameNames = (a: string[], b: string[]) =>
      a.length === b.length && a.every((name) => b.includes(name))
    const trimNames = new Set([...Object.keys(prev.trims), ...Object.keys(trims)])
    let trimsChanged = false
    let trimsStructural = false
    for (const name of trimNames) {
      const before = trimFor(prev.trims, name)
      const after = trimFor(trims, name)
      if (isStructuralDifference(before, after)) trimsStructural = true
      if (
        before.volume !== after.volume ||
        before.tone !== after.tone ||
        before.space !== after.space ||
        before.feel !== after.feel ||
        before.swing !== after.swing
      ) {
        trimsChanged = true
      }
    }

    const structural =
      !sameNames(prev.muted, muted) || !sameNames(prev.soloed, soloed) || trimsStructural
    // A patch that changes nothing emits nothing and moves neither counter: a
    // spurious structural bump would re-evaluate the track under a fader.
    if (!structural && !trimsChanged) return prev

    this._mix = {
      muted,
      soloed,
      trims,
      seq: prev.seq + 1,
      structuralSeq: prev.structuralSeq + (structural ? 1 : 0),
    }
    this.schedulePersist()
    this.emit()
    return this._mix
  }

  // --- notes --------------------------------------------------------------

  /** Record listener feedback, tagged with what was playing at the time. */
  addNote(text: string, layer: string | null): Note {
    const note: Note = {
      text,
      layer,
      at: Date.now(),
      revision: this._revision,
      section: this._nowPlaying?.section ?? null,
    }
    this._notes.push(note)
    if (this._notes.length > NOTES_LIMIT) {
      this._notes.splice(0, this._notes.length - NOTES_LIMIT)
    }
    this.schedulePersist()
    return note
  }

  get notes(): Note[] {
    return this._notes
  }

  clearNotes(): void {
    this._notes = []
    this.schedulePersist()
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

  recordEval(result: EvalResult, layers?: string[]): void {
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

    // A successful eval of the current revision reports the track's layer
    // names - adopt them and prune mix entries for layers that no longer
    // exist (a stale solo would otherwise silence everything forever).
    if (result.ok && result.revision === this._revision && layers) {
      const namesChanged =
        layers.length !== this._layerNames.length || layers.some((n, i) => n !== this._layerNames[i])
      if (namesChanged) this._layerNames = [...layers]
      const muted = this._mix.muted.filter((n) => layers.includes(n))
      const soloed = this._mix.soloed.filter((n) => layers.includes(n))
      const trims: Record<string, LayerTrim> = {}
      let structuralTrimPruned = false
      for (const [name, trim] of Object.entries(this._mix.trims)) {
        if (layers.includes(name)) trims[name] = trim
        else if (isStructuralDifference(trim, NEUTRAL_TRIM)) structuralTrimPruned = true
      }
      const namesPruned =
        muted.length !== this._mix.muted.length || soloed.length !== this._mix.soloed.length
      const pruned =
        namesPruned || Object.keys(trims).length !== Object.keys(this._mix.trims).length
      if (pruned) {
        // A vanished layer's trim would otherwise apply to whatever later
        // reuses the name. Only a pruned mute, solo, feel or swing is
        // structural: dropping a stale volume needs no re-evaluation, and
        // bumping structuralSeq here would evaluate the track a second time
        // immediately after the evaluation that reported these names.
        const structural = namesPruned || structuralTrimPruned
        this._mix = {
          muted,
          soloed,
          trims,
          seq: this._mix.seq + 1,
          structuralSeq: this._mix.structuralSeq + (structural ? 1 : 0),
        }
        this.schedulePersist()
      }
      if (namesChanged || pruned) this.emit()
    }
  }

  // --- recording ---------------------------------------------------------------

  /**
   * Issue a record command. Start targets the best available client (most
   * recently seen with audio ready and a live SSE stream); stop prefers the
   * client that began the recording, since another tab would only reply
   * "nothing was recorded" while the real one kept capturing.
   * Returns the command, or null if no eligible client exists.
   */
  issueRecordCommand(type: RecordCommand['type']): RecordCommand | null {
    const bestAudioClient = () =>
      this.liveClients.filter((c) => c.audioReady).sort((a, b) => b.lastSeen - a.lastSeen)[0]

    let target: ClientInfo | undefined
    if (type === 'record-start') {
      target = bestAudioClient()
    } else {
      const recordingClientId =
        this._recording.phase === 'starting' || this._recording.phase === 'recording'
          ? this._recording.clientId
          : null
      target = recordingClientId
        ? this.liveClients.find((c) => c.id === recordingClientId)
        : undefined
      // A take can outlive the registration it started with - a stream that
      // closes without a replacement drops the client entry even though the
      // tab is alive and still buffering. Rather than abandon the take, fall
      // back to whoever can still receive commands; a tab that is not running
      // the server's recording refuses and acks an error, so the worst case is
      // an explicit failure instead of a silently lost bounce.
      // Note this cannot rescue a take whose tab remounted: the recorder's
      // buffer dies with the component, so nothing is left to stop.
      if (!target) target = bestAudioClient()
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
      // Follow the command: the ack route validates against recording.clientId,
      // so a stop routed to a fallback tab would otherwise have its ack
      // rejected and the state machine would sit in "stopping" until timeout.
      this._recording = { ...this._recording, phase: 'stopping', clientId: target.id }
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
        mutedLayers: this._mix.muted,
        trims: this._mix.trims,
        notes: this._notes,
      }
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload))
      fs.renameSync(tmp, STATE_FILE)
    } catch (err) {
      console.error('[moltek] failed to persist state:', err)
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
