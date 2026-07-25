/**
 * =============================================================================
 * STRUDEL STUDIO
 * =============================================================================
 *
 * The studio layout, terminal-style: the code editor is the work surface,
 * a right rack holds the mixer and the tape deck, and all chrome sits at
 * the bottom - the transport statusline, then the command line as the very
 * last line (vim order: status above, prompt last). Also wires remote
 * (API-driven) recording and the unlock overlay for when the browser blocks
 * audio before the first user gesture.
 */

'use client'

import { useRef, useEffect, useCallback, useState } from 'react'
import { useStrudel, type RemoteCommand } from '@/hooks/use-strudel'
import { useAudioRecorder } from '@/hooks/use-audio-recorder'
import { TransportBar } from '@/components/transport-bar'
import { MoltekOverlay } from '@/components/moltek-overlay'
import { UnlockScreen } from '@/components/unlock-screen'
import { MixerPanel } from '@/components/mixer-panel'
import { TapeDeck } from '@/components/tape-deck'
import { DragDivider } from '@/components/drag-divider'
import { DEFAULT_CODE } from '@/lib/constants'

/* Panel sizing: user-adjustable, persisted across sessions. */
const RACK_WIDTH_KEY = 'moltek.rackWidth'
const TAPES_HEIGHT_KEY = 'moltek.tapesHeight'
const MOLTEK_KEY = 'moltek.mascot'
const MIXER_KEY = 'moltek.mixer'
const RACK_WIDTH_DEFAULT = 384
const TAPES_HEIGHT_DEFAULT = 240

const clampRackWidth = (w: number) =>
  Math.round(Math.min(Math.max(w, 300), Math.max(300, window.innerWidth - 480)))
const clampTapesHeight = (h: number) =>
  Math.round(Math.min(Math.max(h, 148), Math.max(148, window.innerHeight * 0.6)))

/* localStorage can throw (privacy modes, denied storage) - sizes are a
   nicety, never worth crashing the studio over. */
const readStoredSize = (key: string): number => {
  try {
    return Number(localStorage.getItem(key))
  } catch {
    return 0
  }
}
const writeStoredSize = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {}
}

export function StrudelEditor() {
  const {
    loaded,
    loadError,
    isPlaying,
    audioBlocked,
    nowPlaying,
    gainLevel,
    mix,
    layers,
    clientId,
    editorRef,
    play,
    stop,
    unlockAudio,
    setOnStopCallback,
    setCommandHandler,
  } = useStrudel()

  const {
    isRecording,
    duration,
    error: recorderError,
    recordedUrl,
    startRecording,
    stopRecording,
    downloadRecording,
    dismissRecording,
  } = useAudioRecorder()

  // Whether the active recording was started by the user (button) or the
  // agent (API command). Remote recordings upload their WAV to the server.
  const recordingModeRef = useRef<'manual' | 'remote' | null>(null)
  const remoteCommandIdRef = useRef(0)

  // Adjustable panels: rack width and tapes height, saved as they change.
  const [rackWidth, setRackWidth] = useState(RACK_WIDTH_DEFAULT)
  const [tapesHeight, setTapesHeight] = useState(TAPES_HEIGHT_DEFAULT)
  const [showMoltek, setShowMoltek] = useState(true)
  // The mixer folds to its header line. Lifted this high because the fold
  // changes the rack's layout, not just the panel's: the tapes take the space.
  const [mixerFolded, setMixerFolded] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const w = readStoredSize(RACK_WIDTH_KEY)
    if (w) setRackWidth(clampRackWidth(w))
    const h = readStoredSize(TAPES_HEIGHT_KEY)
    if (h) setTapesHeight(clampTapesHeight(h))
    try {
      if (localStorage.getItem(MOLTEK_KEY) === 'off') setShowMoltek(false)
      if (localStorage.getItem(MIXER_KEY) === 'folded') setMixerFolded(true)
    } catch {}
  }, [])

  // A shrinking window re-clamps the panels so they can't swallow the
  // editor. The stored preference is left alone - a bigger window later
  // gets the size the user actually chose.
  useEffect(() => {
    const onResize = () => {
      setRackWidth((w) => clampRackWidth(w))
      setTapesHeight((h) => clampTapesHeight(h))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const resizeRack = (width: number) => {
    const w = clampRackWidth(width)
    setRackWidth(w)
    writeStoredSize(RACK_WIDTH_KEY, w)
  }

  const resizeTapes = (height: number) => {
    const h = clampTapesHeight(height)
    setTapesHeight(h)
    writeStoredSize(TAPES_HEIGHT_KEY, h)
  }

  const toggleMixer = () => {
    setMixerFolded((f) => {
      const next = !f
      try {
        localStorage.setItem(MIXER_KEY, next ? 'folded' : 'open')
      } catch {}
      return next
    })
  }

  const toggleMoltek = () => {
    setShowMoltek((on) => {
      const next = !on
      try {
        localStorage.setItem(MOLTEK_KEY, next ? 'on' : 'off')
      } catch {}
      return next
    })
  }

  const ackRecord = useCallback(
    (commandId: number, event: 'started' | 'stopped' | 'error', error?: string) => {
      fetch('/api/record/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, commandId, event, error }),
      }).catch(() => {})
    },
    [clientId],
  )

  const uploadRecording = useCallback(
    async (blob: Blob, commandId: number) => {
      try {
        const res = await fetch('/api/recordings', {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'X-Recording-Name': nowPlaying?.title ?? '',
            // Claim the take. Without this the server accepts a WAV from any
            // tab, so a stale recorder could complete someone else's recording.
            'X-Recording-Client': clientId,
          },
          body: blob,
        })
        if (!res.ok) throw new Error(`upload failed: ${res.status}`)
      } catch (err) {
        console.error('[moltek] recording upload failed:', err)
        ackRecord(commandId, 'error', 'WAV upload to the server failed')
      }
    },
    [nowPlaying, ackRecord, clientId],
  )

  /** Execute targeted record commands from the server. */
  useEffect(() => {
    setCommandHandler((command: RemoteCommand) => {
      if (command.type === 'record-start') {
        // A manual recording in progress must not be silently converted
        // into a remote one (it would upload from the wrong start time).
        if (isRecording) {
          ackRecord(command.id, 'error', 'Already recording (started manually in the browser)')
          return
        }
        recordingModeRef.current = 'remote'
        remoteCommandIdRef.current = command.id
        startRecording().then(({ ok, error }) => {
          if (ok) {
            ackRecord(command.id, 'started')
          } else {
            recordingModeRef.current = null
            ackRecord(command.id, 'error', error ?? 'Recording failed to start')
          }
        })
      } else {
        // Only this tab's remote take may be stopped from the server. A stop
        // can now be routed here as a fallback when the server lost track of
        // which tab owns the recording, and a manual take must not be ended
        // and uploaded as if it were the server's.
        if (recordingModeRef.current !== 'remote') {
          ackRecord(command.id, 'error', 'No server-started recording in this tab')
          return
        }
        const blob = stopRecording()
        recordingModeRef.current = null
        if (blob) {
          ackRecord(command.id, 'stopped')
          uploadRecording(blob, command.id)
        } else {
          ackRecord(command.id, 'error', 'Nothing was recorded')
        }
      }
    })
    return () => setCommandHandler(null)
  }, [setCommandHandler, startRecording, stopRecording, ackRecord, uploadRecording, isRecording])

  /**
   * When playback stops while recording, finish the recording instead of
   * capturing silence. Remote recordings still upload their bounce.
   */
  useEffect(() => {
    setOnStopCallback(() => {
      if (!isRecording) return
      const mode = recordingModeRef.current
      const commandId = remoteCommandIdRef.current
      const blob = stopRecording()
      recordingModeRef.current = null
      if (mode === 'remote') {
        if (blob) {
          ackRecord(commandId, 'stopped')
          uploadRecording(blob, commandId)
        } else {
          ackRecord(commandId, 'error', 'Nothing was recorded')
        }
      }
    })
    return () => setOnStopCallback(null)
  }, [setOnStopCallback, isRecording, stopRecording, ackRecord, uploadRecording])

  /**
   * Intercept the documented shortcuts (Cmd+Enter play, Cmd+. stop) before
   * the web component sees them, so playback always flows through the synced
   * play()/stop() paths and the server never drifts from the browser.
   */
  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      play()
    } else if (e.key === '.') {
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
  }

  if (loadError) {
    return (
      <div className="h-full bg-background flex items-center justify-center text-muted-foreground text-sm">
        Failed to load the Strudel engine from the CDN. Check your connection and reload.
      </div>
    )
  }

  if (!loaded) {
    return <div className="h-full bg-background" />
  }

  const handleRecordClick = () => {
    if (isRecording) {
      const mode = recordingModeRef.current
      const commandId = remoteCommandIdRef.current
      const blob = stopRecording()
      recordingModeRef.current = null
      if (mode === 'remote') {
        if (blob) {
          ackRecord(commandId, 'stopped')
          uploadRecording(blob, commandId)
        } else {
          ackRecord(commandId, 'error', 'Nothing was recorded')
        }
      }
    } else {
      recordingModeRef.current = 'manual'
      startRecording().then(({ ok }) => {
        if (!ok) recordingModeRef.current = null
      })
    }
  }

  return (
    <div
      /* h-full rather than h-screen, and w-full rather than w-screen: html and
         body are already height:100% with overflow:hidden, so filling the body
         box fills exactly what is visible. The viewport units do not: 100vh is
         the layout viewport, which is taller than the visible area whenever
         there is browser or webview chrome over it, and body's overflow:hidden
         then clips the difference off the bottom. The transport bar is the last
         child, so it was the thing that got cut. */
      className="h-full w-full flex flex-col bg-background font-mono text-[13px] text-foreground select-none"
      style={{ '--rack-w': `${rackWidth}px` } as React.CSSProperties}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div className="flex-1 flex min-h-0">
        {/* Main work surface: the code */}
        <div className="flex-1 min-w-0 flex flex-col select-text">
          <div className="editor-container">
            {/* @ts-expect-error - strudel-editor is a custom web component */}
            <strudel-editor ref={editorRef} code={DEFAULT_CODE} lineWrapping />
          </div>
        </div>

        <DragDivider
          direction="col"
          label="resize the rack"
          onDrag={(x) => resizeRack(window.innerWidth - x)}
          onNudge={(d) => resizeRack(rackWidth + d)}
        />

        {/* Right rack: mixer over tape deck */}
        <aside
          ref={asideRef}
          className="w-[var(--rack-w)] shrink-0 flex flex-col min-h-0 border-l border-border bg-background"
        >
          <MixerPanel layers={layers} mix={mix} folded={mixerFolded} onToggleFolded={toggleMixer} />
          {/* No handle while the mixer is folded: there is nothing above the
              tapes left to trade height with, and the stored height is kept for
              when the mixer comes back. */}
          {!mixerFolded && (
            <DragDivider
              direction="row"
              label="resize the tapes"
              onDrag={(_x, y) => {
                const bottom = asideRef.current?.getBoundingClientRect().bottom
                if (bottom !== undefined) resizeTapes(bottom - y)
              }}
              onNudge={(d) => resizeTapes(tapesHeight + d)}
            />
          )}
          <div
            style={mixerFolded ? undefined : { height: tapesHeight }}
            className={`border-t border-border ${mixerFolded ? 'flex-1 min-h-0' : 'shrink-0'}`}
          >
            <TapeDeck
              recordedUrl={recordedUrl}
              recorderError={recorderError}
              onKeepRecording={downloadRecording}
              onDismissRecording={dismissRecording}
            />
          </div>
        </aside>
      </div>

      <TransportBar
        isPlaying={isPlaying}
        nowPlaying={nowPlaying}
        gainLevel={gainLevel}
        isRecording={isRecording}
        recordingDuration={duration}
        onPlay={play}
        onStop={stop}
        onRecordClick={handleRecordClick}
        showMoltek={showMoltek}
        onToggleMoltek={toggleMoltek}
      />


      {showMoltek && <MoltekOverlay onDismiss={toggleMoltek} />}

      {/* Audio blocked - browsers refuse sound before a user gesture */}
      {audioBlocked && <UnlockScreen onUnlock={unlockAudio} />}
    </div>
  )
}
