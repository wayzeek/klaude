/**
 * =============================================================================
 * STRUDEL EDITOR COMPONENT
 * =============================================================================
 *
 * Full-screen Strudel editor with the console (transport, per-layer mixer,
 * notes, tapes), remote (API-driven) recording, and an unlock overlay for
 * when the browser blocks audio before the first user gesture.
 */

'use client'

import { useRef, useEffect, useCallback } from 'react'
import { useStrudel, type RemoteCommand } from '@/hooks/use-strudel'
import { useAudioRecorder } from '@/hooks/use-audio-recorder'
import { Console } from '@/components/console'
import { DEFAULT_CODE } from '@/lib/constants'

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
    revision,
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
          },
          body: blob,
        })
        if (!res.ok) throw new Error(`upload failed: ${res.status}`)
      } catch (err) {
        console.error('[klaude] recording upload failed:', err)
        ackRecord(commandId, 'error', 'WAV upload to the server failed')
      }
    },
    [nowPlaying, ackRecord],
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
      <div className="h-screen bg-background flex items-center justify-center text-muted-foreground text-sm">
        Failed to load the Strudel engine from the CDN. Check your connection and reload.
      </div>
    )
  }

  if (!loaded) {
    return <div className="h-screen bg-background" />
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
      className="h-screen w-screen flex flex-col bg-background relative"
      onKeyDownCapture={handleKeyDownCapture}
    >
      {/* Editor */}
      <div className="editor-container">
        {/* @ts-expect-error - strudel-editor is a custom web component */}
        <strudel-editor ref={editorRef} code={DEFAULT_CODE} lineWrapping />
      </div>

      <Console
        isPlaying={isPlaying}
        revision={revision}
        nowPlaying={nowPlaying}
        gainLevel={gainLevel}
        mix={mix}
        layers={layers}
        isRecording={isRecording}
        recordingDuration={duration}
        recorderError={recorderError}
        recordedUrl={recordedUrl}
        onPlay={play}
        onStop={stop}
        onRecordClick={handleRecordClick}
        onDownloadRecording={downloadRecording}
        onDismissRecording={dismissRecording}
      />

      {/* Audio blocked overlay - browsers refuse sound before a user gesture */}
      {audioBlocked && (
        <button
          onClick={unlockAudio}
          className="fixed inset-0 z-50 bg-background/85 flex items-center justify-center cursor-pointer"
        >
          <div className="border border-primary px-6 py-4 font-mono text-sm text-primary">
            ▶ tap anywhere to join the music
          </div>
        </button>
      )}
    </div>
  )
}
