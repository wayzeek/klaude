/**
 * =============================================================================
 * USE STRUDEL HOOK
 * =============================================================================
 *
 * A custom React hook that manages the Strudel REPL lifecycle.
 * Handles script loading, playback state, editor control, and real-time
 * sync with the server via Server-Sent Events.
 *
 * USAGE:
 * ```tsx
 * const { loaded, isPlaying, editorRef, play, stop } = useStrudel()
 * ```
 *
 * RETURNS:
 * - loaded: boolean     - Whether the Strudel script has loaded
 * - loadError: boolean  - Whether the Strudel script failed to load
 * - isPlaying: boolean  - Whether audio is currently playing
 * - editorRef: ref      - Ref to attach to the strudel-editor element
 * - play: () => void    - Start/update playback (syncs server state)
 * - stop: () => void    - Stop playback (syncs server state)
 */

import { useEffect, useState, useRef, useCallback } from 'react'

/**
 * CDN URL for the Strudel REPL web component.
 * Pinned to an exact version - `@latest` can silently break skills and saved tracks.
 */
const STRUDEL_CDN = 'https://unpkg.com/@strudel/repl@1.3.0'

/** Delay before recreating a fatally closed SSE connection */
const SSE_RETRY_MS = 2000

type ServerState = {
  code: string
  isPlaying: boolean
}

/**
 * Custom hook for managing the Strudel REPL.
 */
export function useStrudel() {
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)

  // Bumped to force a fresh EventSource after a fatal connection loss
  const [sseGeneration, setSseGeneration] = useState(0)

  const editorRef = useRef<HTMLElement>(null)

  // Track last known server state to detect changes
  const lastServerStateRef = useRef<ServerState | null>(null)

  // Callback ref for when playback stops (used by audio recorder)
  const onStopCallbackRef = useRef<(() => void) | null>(null)

  /**
   * Load the Strudel script on mount.
   * The script registers the <strudel-editor> web component globally.
   */
  useEffect(() => {
    if (customElements.get('strudel-editor')) {
      setLoaded(true)
      return
    }

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
  }, [])

  /**
   * Get the editor instance from the ref.
   */
  const getEditor = useCallback(() => {
    const el = editorRef.current as any
    return el?.editor
  }, [])

  /**
   * Evaluate the current editor code. Local only - does not inform the server.
   * Returns false if the editor isn't ready or evaluation threw.
   */
  const evaluateLocal = useCallback(async () => {
    const editor = getEditor()
    if (!editor) return false
    try {
      await editor.evaluate()
      setIsPlaying(true)
      return true
    } catch (err) {
      console.error('[strudel] evaluation failed:', err)
      return false
    }
  }, [getEditor])

  /**
   * Stop all audio playback. Local only - does not inform the server.
   * Also calls the onStopCallback if registered (used by audio recorder).
   */
  const stopLocal = useCallback(() => {
    const editor = getEditor()
    if (!editor) return
    editor.stop()
    setIsPlaying(false)
    if (onStopCallbackRef.current) {
      onStopCallbackRef.current()
    }
  }, [getEditor])

  /**
   * UI-initiated play: evaluate, then sync the server so /api/status
   * reflects what's actually happening in the browser.
   */
  const play = useCallback(async () => {
    const ok = await evaluateLocal()
    if (!ok) return
    // Update the ref first so the SSE echo of this change is a no-op
    if (lastServerStateRef.current) {
      lastServerStateRef.current = { ...lastServerStateRef.current, isPlaying: true }
    }
    fetch('/api/play', { method: 'POST' }).catch(() => {})
  }, [evaluateLocal])

  /**
   * UI-initiated stop: stop locally, then sync the server.
   */
  const stop = useCallback(() => {
    stopLocal()
    if (lastServerStateRef.current) {
      lastServerStateRef.current = { ...lastServerStateRef.current, isPlaying: false }
    }
    fetch('/api/stop', { method: 'POST' }).catch(() => {})
  }, [stopLocal])

  /**
   * Register a callback to be called when playback stops.
   * Used by the audio recorder to auto-stop recording.
   */
  const setOnStopCallback = useCallback((callback: (() => void) | null) => {
    onStopCallbackRef.current = callback
  }, [])

  /**
   * Subscribe to Server-Sent Events for real-time state sync.
   * When the server state changes (via API), update the editor accordingly.
   */
  useEffect(() => {
    if (!loaded) return

    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const eventSource = new EventSource('/api/events')

    eventSource.onmessage = (event) => {
      const newState: ServerState = JSON.parse(event.data)
      const lastState = lastServerStateRef.current
      const editor = getEditor()

      // First snapshot after connecting: adopt the server's code so work
      // pushed before this tab opened isn't lost. Playback may still need a
      // click if the browser blocks audio without a user gesture.
      if (!lastState) {
        if (editor) {
          editor.setCode(newState.code)
        }
        if (newState.isPlaying) {
          evaluateLocal()
        }
        lastServerStateRef.current = newState
        return
      }

      const codeChanged = newState.code !== lastState.code
      const playStateChanged = newState.isPlaying !== lastState.isPlaying

      // Update code if changed
      if (codeChanged && editor) {
        editor.setCode(newState.code)
      }

      // Evaluate if:
      // 1. Code changed AND server says we should be playing, OR
      // 2. Play state just changed to true
      if ((codeChanged && newState.isPlaying) || (playStateChanged && newState.isPlaying)) {
        evaluateLocal()
      } else if (playStateChanged && !newState.isPlaying) {
        stopLocal()
      }

      lastServerStateRef.current = newState
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
  }, [loaded, sseGeneration, getEditor, evaluateLocal, stopLocal])

  return {
    loaded,
    loadError,
    isPlaying,
    editorRef,
    play,
    stop,
    getEditor,
    setOnStopCallback,
  }
}
