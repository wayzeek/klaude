/**
 * =============================================================================
 * USE STRUDEL HOOK
 * =============================================================================
 *
 * Manages the Strudel REPL lifecycle and the revision-based sync protocol
 * with the server:
 *
 * - Applies pushed revisions and reports eval results back (/api/eval), so
 *   agents know whether their code actually ran.
 * - Registers as a client and reports readiness (/api/clients): editor loaded,
 *   audio unlocked, playing.
 * - Syncs local edits back to the server (debounced), so /api/code never lies.
 * - Applies master gain ramps and dispatches targeted record commands.
 * - Detects autoplay blocking and exposes it so the UI can ask for a click.
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { clearPendingPulses, schedulePulse } from '@/lib/layer-pulse'
import { createLayersRuntime, type LayerPattern } from '@/lib/layers-runtime'
import { trimFor, type LayerTrim } from '@/lib/trim'
import { installSyntaxTheme } from '@/lib/cm-theme'

/**
 * CDN fallback for the Strudel REPL web component, used only if the locally
 * bundled @strudel/repl fails to load. Pinned to the same exact version -
 * `@latest` can silently break skills and saved tracks.
 */
const STRUDEL_CDN = 'https://unpkg.com/@strudel/repl@1.3.0'

/** Delay before recreating a fatally closed SSE connection */
const SSE_RETRY_MS = 2000

/** How often to check for local edits and editor play-state drift */
const EDIT_SYNC_MS = 1500

/** Debounce between the last observed local edit and pushing it to the server */
const EDIT_PUSH_DEBOUNCE_MS = 1000

/** Readiness heartbeat interval */
const HEARTBEAT_MS = 10_000

export type NowPlaying = {
  title: string | null
  artist: string | null
  section: string | null
  /** When this piece started (server time; same machine, so usable directly). */
  since: number
  /** Sections the piece has moved through, oldest first. */
  trail: { section: string; at: number }[]
}

export type RemoteCommand = {
  id: number
  type: 'record-start' | 'record-stop'
  targetClientId: string
}

export type Mix = {
  muted: string[]
  soloed: string[]
  /** Per-layer trims. Only non-neutral layers appear. */
  trims: Record<string, LayerTrim>
  /** Bumps on any mix change. */
  seq: number
  /** Bumps only when the pattern has to be rebuilt: mute, solo, feel, swing. */
  structuralSeq: number
}

type ServerState = {
  code: string
  revision: number
  desiredPlaying: boolean
  playEpoch: number
  gain: { level: number; rampMs: number; seq: number }
  nowPlaying: NowPlaying | null
  command: RemoteCommand | null
  mix: Mix
  layers: string[]
}

function getStrudelAudioContext(): AudioContext | null {
  const fn = (window as unknown as { getAudioContext?: () => AudioContext }).getAudioContext
  return typeof fn === 'function' ? (fn() ?? null) : null
}

function getDestinationGain(): GainNode | null {
  const fn = (window as unknown as { getSuperdoughAudioController?: () => any })
    .getSuperdoughAudioController
  if (typeof fn !== 'function') return null
  return fn()?.output?.destinationGain ?? null
}

/**
 * Read the editor's current text. The CodeMirror document is the source of
 * truth for live edits; StrudelMirror's `.code` property is the fallback.
 */
function readEditorCode(mirror: any): string | null {
  const doc = mirror?.editor?.state?.doc
  if (doc) return doc.toString()
  return typeof mirror?.code === 'string' ? mirror.code : null
}

export function useStrudel() {
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [editorReady, setEditorReady] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null)
  const [gainLevel, setGainLevel] = useState(1)
  const [mix, setMix] = useState<Mix>({ muted: [], soloed: [], trims: {}, seq: 0, structuralSeq: 0 })
  const [layerNames, setLayerNames] = useState<string[]>([])
  const [revision, setRevision] = useState(0)

  // Bumped to force a fresh EventSource after a fatal connection loss
  const [sseGeneration, setSseGeneration] = useState(0)

  const editorRef = useRef<HTMLElement>(null)
  const clientIdRef = useRef<string>('')
  if (clientIdRef.current === '') {
    clientIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `client-${Math.random().toString(36).slice(2)}`
  }

  // Protocol tracking: what this tab has already applied
  const appliedRevisionRef = useRef(-1)
  const appliedEpochRef = useRef(-1)
  const appliedGainSeqRef = useRef(0)
  const lastCommandIdRef = useRef(0)

  // Latest server state + buffer for states that arrive before the editor exists
  const serverStateRef = useRef<ServerState | null>(null)
  const pendingStateRef = useRef<ServerState | null>(null)

  // Edit-sync bookkeeping
  const lastPushedCodeRef = useRef<string | null>(null)
  const editObservedAtRef = useRef(0)
  const editCandidateRef = useRef<string | null>(null)

  // Pending gain for when audio isn't initialized yet
  const pendingGainRef = useRef<{ level: number; rampMs: number } | null>(null)

  // Mix state the layers() runtime reads at evaluation time, the trims it
  // reads at query time, and the names collected during the current pass.
  const mixRef = useRef<{ muted: string[]; soloed: string[] }>({ muted: [], soloed: [] })
  const trimsRef = useRef<Record<string, LayerTrim>>({})
  const appliedStructuralSeqRef = useRef(-1)
  const collectedLayersRef = useRef<string[]>([])

  const audioReadyRef = useRef(false)
  const isPlayingRef = useRef(false)

  // Set when an eval failed only because audio was blocked, so the moment
  // audio unlocks (click, or a permissive browser) we can retry and report.
  const blockedEvalRef = useRef(false)
  const evaluateAndReportRef = useRef<((revision: number, playEpoch: number) => Promise<boolean>) | null>(null)

  // Evaluation control: evaluations run strictly one at a time through a
  // promise queue. Queued requests coalesce to the newest key (a burst of
  // mix toggles evaluates once, with the final state), identical concurrent
  // requests share one run (SSE echo + UI play can race), and the generation
  // counter invalidates runs superseded by a stop mid-flight.
  const evalQueueRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const queuedKeyRef = useRef<string | null>(null)
  const latestKeyRef = useRef<string>('')
  const evalGenerationRef = useRef(0)

  // Callback refs for the recorder integration
  const onStopCallbackRef = useRef<(() => void) | null>(null)
  const commandHandlerRef = useRef<((command: RemoteCommand) => void) | null>(null)

  /**
   * Load the Strudel engine on mount: the locally bundled @strudel/repl first
   * (works offline, no CDN in the critical path), the pinned CDN build as a
   * fallback. Either one registers the <strudel-editor> web component.
   */
  useEffect(() => {
    if (customElements.get('strudel-editor')) {
      setLoaded(true)
      return
    }

    const loadFromCdn = () => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRUDEL_CDN}"]`)
      if (existing) {
        existing.addEventListener('load', () => setLoaded(true))
        existing.addEventListener('error', () => setLoadError(true))
        return
      }

      const script = document.createElement('script')
      script.src = STRUDEL_CDN
      script.onload = () => setLoaded(true)
      script.onerror = () => setLoadError(true)
      document.head.appendChild(script)
    }

    import('@strudel/repl')
      .then(() => setLoaded(true))
      .catch((err) => {
        console.warn('[moltek] bundled Strudel failed to load, falling back to CDN:', err)
        loadFromCdn()
      })
  }, [])

  /**
   * Install the layers() runtime. Dependencies are refs and module-level
   * helpers, so the effect runs once and the runtime always reads current
   * state rather than a snapshot from install time.
   */
  useEffect(() => {
    const w = window as unknown as { layers?: (map: Record<string, LayerPattern>) => LayerPattern }
    w.layers = createLayersRuntime({
      getMix: () => mixRef.current,
      getTrim: (layer) => trimFor(trimsRef.current, layer),
      collect: (name) => {
        if (!collectedLayersRef.current.includes(name)) collectedLayersRef.current.push(name)
      },
      // The pulse bus owns the timers, so a stop can drop what has not fired
      // yet instead of letting the mascot twitch at silence.
      onPulse: schedulePulse,
    })
    return () => {
      delete w.layers
    }
  }, [])

  /** Get the StrudelMirror instance from the web component. */
  const getEditor = useCallback(() => {
    const el = editorRef.current as any
    return el?.editor
  }, [])

  /**
   * Install our syntax theme once the editor exists.
   *
   * The web component mounts CodeMirror asynchronously and there is no ready
   * event to hook, so this polls briefly and stops the moment it lands. Without
   * it the editor keeps Strudel's own highlighter and ignores theme switches,
   * because CM6 tokens carry generated class names that no stylesheet can target.
   */
  useEffect(() => {
    let stop = false
    let tries = 0
    const tick = () => {
      if (stop) return
      if (installSyntaxTheme(getEditor()?.editor)) return
      if (++tries > 60) return // ~15s, then give up quietly
      timer = setTimeout(tick, 250)
    }
    let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 250)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [getEditor])

  /** Fire-and-forget report to the server; sync failures must never break audio. */
  const post = useCallback((url: string, body: unknown) => {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  }, [])

  const reportClient = useCallback(
    (patch: Record<string, boolean | number>) => {
      post('/api/clients', { clientId: clientIdRef.current, ...patch })
    },
    [post],
  )

  /** Check whether the audio context is actually running and update readiness. */
  const refreshAudioReady = useCallback(() => {
    const ctx = getStrudelAudioContext()
    const ready = ctx !== null && ctx.state === 'running'
    if (ready !== audioReadyRef.current) {
      audioReadyRef.current = ready
      reportClient({ audioReady: ready })
    }
    if (ready) {
      setAudioBlocked(false)
      // Audio just became available after a blocked eval: retry it so the
      // server's lastEval stops reporting a failure that has resolved itself.
      if (blockedEvalRef.current) {
        blockedEvalRef.current = false
        const s = serverStateRef.current
        if (s?.desiredPlaying) {
          evaluateAndReportRef.current?.(s.revision, s.playEpoch)
        }
      }
    }
    return ready
  }, [reportClient])

  /** Apply a master gain ramp on Strudel's destination gain node. */
  const applyGain = useCallback((level: number, rampMs: number) => {
    const gainNode = getDestinationGain()
    const ctx = getStrudelAudioContext()
    if (!gainNode || !ctx) {
      pendingGainRef.current = { level, rampMs }
      return
    }
    pendingGainRef.current = null
    const param = gainNode.gain
    const now = ctx.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(level, now + Math.max(rampMs, 1) / 1000)
  }, [])

  /**
   * Evaluate the current editor code and report the result for the given
   * revision/epoch. Detects autoplay blocking (evaluation "succeeds" but the
   * audio context stays suspended). Runs are serialized: two evaluations
   * never overlap, so a slow older one can't install its pattern after a
   * newer one finished. Requests that are superseded while queued are
   * skipped; identical concurrent requests share one run.
   */
  const evaluateAndReport = useCallback(
    (revision: number, playEpoch: number): Promise<boolean> => {
      const key = `${revision}:${playEpoch}:${appliedStructuralSeqRef.current}`
      latestKeyRef.current = key
      // The same request is already queued (SSE echo racing UI play): share it.
      if (queuedKeyRef.current === key) {
        return evalQueueRef.current
      }
      queuedKeyRef.current = key
      evalQueueRef.current = evalQueueRef.current
        .catch(() => false)
        .then(() => {
          // Superseded while waiting - only the newest queued request runs.
          if (latestKeyRef.current !== key) return false
          return runEvaluation(revision, playEpoch)
        })
        .finally(() => {
          if (queuedKeyRef.current === key) queuedKeyRef.current = null
        })
      return evalQueueRef.current
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  async function runEvaluation(revision: number, playEpoch: number): Promise<boolean> {
      const editor = getEditor()
      if (!editor) return false

      const generation = evalGenerationRef.current
      let ok = true
      let error: string | null = null
      blockedEvalRef.current = false
      // Fresh collector per run, captured locally: layers() writes into
      // whatever the ref points at, this run reports only what it collected.
      const collectedLayers: string[] = []
      collectedLayersRef.current = collectedLayers
      try {
        await editor.evaluate()
        // Strudel's evaluate() resolves even when the code throws - the
        // failure is parked on the repl state instead.
        const evalError = editor.repl?.state?.evalError
        if (evalError) {
          ok = false
          error = evalError instanceof Error ? evalError.message : String(evalError)
        }
      } catch (err) {
        ok = false
        error = err instanceof Error ? err.message : String(err)
        console.error('[strudel] evaluation failed:', err)
      }

      // Superseded while evaluating (stop, or a newer revision took over):
      // discard this result, and silence the scheduler if the current desire
      // is silence - a late eval must not resurrect stopped audio.
      if (generation !== evalGenerationRef.current) {
        if (serverStateRef.current?.desiredPlaying === false) {
          try {
            editor.stop()
          } catch {}
        }
        return false
      }

      if (ok) {
        const ctx = getStrudelAudioContext()
        if (ctx && ctx.state === 'suspended') {
          setAudioBlocked(true)
          blockedEvalRef.current = true
          ok = false
          error = 'Audio blocked by the browser - click the tab once to unlock sound'
          // Some contexts resume on their own moments later - recheck soon
          // instead of waiting for the next heartbeat.
          setTimeout(() => refreshAudioReady(), 600)
        }
      }

      // A failed eval keeps the previous pattern audibly playing - report
      // what the scheduler is actually doing, not just this eval's outcome.
      const started: unknown = editor.repl?.scheduler?.started
      const playing = typeof started === 'boolean' ? started : ok
      setIsPlaying(playing)
      isPlayingRef.current = playing
      refreshAudioReady()

      if (ok && pendingGainRef.current) {
        applyGain(pendingGainRef.current.level, pendingGainRef.current.rampMs)
      }

      post('/api/eval', {
        clientId: clientIdRef.current,
        revision,
        playEpoch,
        ok,
        error,
        layers: ok ? collectedLayers : undefined,
      })
      return ok
  }

  useEffect(() => {
    evaluateAndReportRef.current = evaluateAndReport
  }, [evaluateAndReport])

  /** Stop all audio playback locally and notify the recorder. */
  const stopLocal = useCallback(() => {
    const editor = getEditor()
    if (!editor) return
    // Invalidate in-flight evaluations - one finishing after this stop must
    // not restart the scheduler.
    evalGenerationRef.current += 1
    // Drop queued visual pulses too, or they land after the sound has gone.
    clearPendingPulses()
    editor.stop()
    setIsPlaying(false)
    isPlayingRef.current = false
    if (onStopCallbackRef.current) {
      onStopCallbackRef.current()
    }
  }, [getEditor])

  /** Handle one server state snapshot (from SSE). */
  const handleServerState = useCallback(
    (s: ServerState) => {
      serverStateRef.current = s

      // Feed the layers() runtime BEFORE any evaluation below reads it. Trims
      // are refreshed unconditionally: the value wrapper reads them on every
      // query, so a fader move needs nothing else to be heard.
      mixRef.current = { muted: s.mix.muted, soloed: s.mix.soloed }
      trimsRef.current = s.mix.trims
      const structuralChanged = s.mix.structuralSeq !== appliedStructuralSeqRef.current
      appliedStructuralSeqRef.current = s.mix.structuralSeq
      setMix(s.mix)
      setLayerNames(s.layers)
      setRevision(s.revision)

      const editor = getEditor()
      if (!editor) {
        pendingStateRef.current = s
        return
      }

      const revisionChanged = s.revision !== appliedRevisionRef.current
      const epochChanged = s.playEpoch !== appliedEpochRef.current

      if (revisionChanged) {
        // If this revision is the echo of code we just pushed from this editor,
        // adopt it silently - re-setting (and re-evaluating) would hiccup audio.
        if (s.code === lastPushedCodeRef.current) {
          appliedRevisionRef.current = s.revision
        } else {
          editor.setCode(s.code)
          appliedRevisionRef.current = s.revision
          lastPushedCodeRef.current = null
          editCandidateRef.current = null
        }
        reportClient({ appliedRevision: s.revision })
      }

      if (
        (s.desiredPlaying && (epochChanged || (revisionChanged && s.code !== lastPushedCodeRef.current))) ||
        (structuralChanged && s.desiredPlaying && isPlayingRef.current)
      ) {
        appliedEpochRef.current = s.playEpoch
        evaluateAndReport(s.revision, s.playEpoch)
      } else if (epochChanged) {
        appliedEpochRef.current = s.playEpoch
        if (!s.desiredPlaying && isPlayingRef.current) stopLocal()
      } else if (!s.desiredPlaying && isPlayingRef.current) {
        stopLocal()
      }

      if (s.gain.seq !== appliedGainSeqRef.current) {
        appliedGainSeqRef.current = s.gain.seq
        applyGain(s.gain.level, s.gain.rampMs)
      }
      setGainLevel(s.gain.level)

      setNowPlaying(s.nowPlaying)

      if (
        s.command &&
        s.command.targetClientId === clientIdRef.current &&
        // Inequality, not greater-than: command ids restart at 1 when the
        // server restarts while this tab stays open.
        s.command.id !== lastCommandIdRef.current
      ) {
        lastCommandIdRef.current = s.command.id
        commandHandlerRef.current?.(s.command)
      }
    },
    [getEditor, evaluateAndReport, stopLocal, applyGain, reportClient],
  )

  /**
   * Editor readiness handshake: the web component initializes its internal
   * editor asynchronously after mount, so poll until it exists, then apply
   * any state that arrived early.
   */
  useEffect(() => {
    if (!loaded || editorReady) return
    const poll = setInterval(() => {
      if (getEditor()) {
        clearInterval(poll)
        setEditorReady(true)
        reportClient({ editorReady: true })
        if (pendingStateRef.current) {
          const pending = pendingStateRef.current
          pendingStateRef.current = null
          handleServerState(pending)
        }
      }
    }, 100)
    return () => clearInterval(poll)
  }, [loaded, editorReady, getEditor, reportClient, handleServerState])

  /**
   * UI-initiated play: sync the editor's current code to the server (atomic
   * push-and-play when it changed), evaluate locally, and report the result.
   */
  const play = useCallback(async () => {
    const editor = getEditor()
    if (!editor) return

    const currentCode = readEditorCode(editor)
    const server = serverStateRef.current
    const codeChanged = typeof currentCode === 'string' && currentCode !== server?.code

    let revision = server?.revision ?? appliedRevisionRef.current
    let playEpoch = (server?.playEpoch ?? appliedEpochRef.current) + 1

    // Mark our own push BEFORE the request so the SSE echo (which can arrive
    // before the fetch resolves) is recognized and not re-evaluated.
    if (codeChanged && typeof currentCode === 'string') {
      lastPushedCodeRef.current = currentCode
    }

    try {
      const res = await fetch(codeChanged ? '/api/code' : '/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(codeChanged ? { code: currentCode, play: true } : {}),
      })
      const data = await res.json()
      if (typeof data.revision === 'number') revision = data.revision
      if (typeof data.playEpoch === 'number') playEpoch = data.playEpoch
    } catch {
      // Server unreachable - still play locally, and clear the own-push
      // marker so the edit-sync loop retries delivering this code.
      if (codeChanged) lastPushedCodeRef.current = null
    }

    appliedRevisionRef.current = revision
    appliedEpochRef.current = playEpoch
    await evaluateAndReport(revision, playEpoch)
  }, [getEditor, evaluateAndReport])

  /** UI-initiated stop: stop locally, then sync the server. */
  const stop = useCallback(() => {
    stopLocal()
    fetch('/api/stop', { method: 'POST' }).catch(() => {})
  }, [stopLocal])

  /** Unblock audio after the browser refused to start it without a gesture. */
  const unlockAudio = useCallback(async () => {
    const ctx = getStrudelAudioContext()
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // resume can only fail if the page is still gestureless; the next click retries
      }
    }
    setAudioBlocked(false)
    const s = serverStateRef.current
    if (s?.desiredPlaying) {
      await evaluateAndReport(s.revision, s.playEpoch)
    } else {
      refreshAudioReady()
    }
  }, [evaluateAndReport, refreshAudioReady])

  /**
   * Local edit sync: while the editor is ready, watch for the user editing
   * code (or toggling playback with the editor's own shortcuts) and push
   * those changes to the server, debounced. Without this, /api/code lies
   * about what is actually playing.
   */
  useEffect(() => {
    if (!editorReady) return

    const tick = setInterval(() => {
      const editor = getEditor()
      const server = serverStateRef.current
      if (!editor || !server) return

      const currentCode = readEditorCode(editor)
      if (typeof currentCode !== 'string') return

      const serverCode = server.code
      if (currentCode === serverCode || currentCode === lastPushedCodeRef.current) {
        editCandidateRef.current = null
        return
      }

      const now = Date.now()
      if (editCandidateRef.current !== currentCode) {
        // New edit observed - start the debounce window
        editCandidateRef.current = currentCode
        editObservedAtRef.current = now
        return
      }

      if (now - editObservedAtRef.current >= EDIT_PUSH_DEBOUNCE_MS) {
        editCandidateRef.current = null
        lastPushedCodeRef.current = currentCode
        fetch('/api/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: currentCode }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`push failed: ${res.status}`)
            return res.json()
          })
          .then((data) => {
            if (typeof data.revision === 'number') {
              appliedRevisionRef.current = data.revision
            }
          })
          .catch(() => {
            // Failed delivery must not permanently suppress this code -
            // clearing the marker lets the next tick retry.
            if (lastPushedCodeRef.current === currentCode) {
              lastPushedCodeRef.current = null
            }
          })
      }
    }, EDIT_SYNC_MS)

    return () => clearInterval(tick)
  }, [editorReady, getEditor])

  /** Readiness heartbeat: keeps lastSeen fresh and audioReady truthful. */
  useEffect(() => {
    if (!editorReady) return
    const beat = setInterval(() => {
      refreshAudioReady()
      reportClient({
        editorReady: true,
        audioReady: audioReadyRef.current,
        isPlaying: isPlayingRef.current,
      })
    }, HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [editorReady, refreshAudioReady, reportClient])

  /** Subscribe to Server-Sent Events for real-time state sync. */
  useEffect(() => {
    if (!loaded) return

    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const eventSource = new EventSource(`/api/events?clientId=${clientIdRef.current}`)

    eventSource.onopen = () => {
      // (Re)connected: the server may have restarted and lost our registry
      // entry - repost full readiness immediately instead of waiting for
      // the next heartbeat.
      reportClient({
        editorReady: Boolean(getEditor()),
        audioReady: audioReadyRef.current,
        isPlaying: isPlayingRef.current,
      })
    }

    eventSource.onmessage = (event) => {
      handleServerState(JSON.parse(event.data) as ServerState)
    }

    eventSource.onerror = () => {
      // CONNECTING means the browser is already auto-reconnecting.
      // CLOSED is fatal - recreate the connection ourselves after a delay.
      if (eventSource.readyState === EventSource.CLOSED) {
        retryTimer = setTimeout(() => setSseGeneration((g) => g + 1), SSE_RETRY_MS)
      }
    }

    return () => {
      if (retryTimer) clearTimeout(retryTimer)
      eventSource.close()
    }
  }, [loaded, sseGeneration, handleServerState, reportClient, getEditor])

  /** Register a callback for when playback stops (used by the audio recorder). */
  const setOnStopCallback = useCallback((callback: (() => void) | null) => {
    onStopCallbackRef.current = callback
  }, [])

  /** Register the handler for targeted remote commands (record start/stop). */
  const setCommandHandler = useCallback((handler: ((command: RemoteCommand) => void) | null) => {
    commandHandlerRef.current = handler
  }, [])

  return {
    loaded,
    loadError,
    editorReady,
    isPlaying,
    audioBlocked,
    nowPlaying,
    mix,
    layers: layerNames,
    revision,
    gainLevel,
    clientId: clientIdRef.current,
    editorRef,
    play,
    stop,
    unlockAudio,
    getEditor,
    setOnStopCallback,
    setCommandHandler,
  }
}
