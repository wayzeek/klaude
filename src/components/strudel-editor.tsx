/**
 * =============================================================================
 * STRUDEL EDITOR COMPONENT
 * =============================================================================
 *
 * Full-screen Strudel editor with floating playback controls, a now-playing
 * HUD, remote (API-driven) recording, and an unlock overlay for when the
 * browser blocks audio before the first user gesture.
 */

'use client'

import { useRef, useEffect, useCallback } from 'react'
import { useStrudel, type RemoteCommand } from '@/hooks/use-strudel'
import { useAudioRecorder, formatDuration } from '@/hooks/use-audio-recorder'
import { DEFAULT_CODE } from '@/lib/constants'
import { Play, Square, RefreshCw, Circle, Download, Trash2 } from 'lucide-react'

export function StrudelEditor() {
  const {
    loaded,
    loadError,
    isPlaying,
    audioBlocked,
    nowPlaying,
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

      {/* Now Playing HUD */}
      {nowPlaying && (nowPlaying.title || nowPlaying.artist || nowPlaying.section) && (
        <div className="fixed top-6 left-6 bg-card/90 backdrop-blur-lg rounded-xl px-4 py-3 shadow-2xl border border-border/50 max-w-xs animate-in fade-in slide-in-from-top-2 duration-300">
          {nowPlaying.title && (
            <div className="text-sm font-semibold leading-tight">{nowPlaying.title}</div>
          )}
          {nowPlaying.artist && (
            <div className="text-xs text-muted-foreground mt-0.5">{nowPlaying.artist}</div>
          )}
          {nowPlaying.section && (
            <div className="text-[10px] text-primary mt-1.5 uppercase tracking-widest">
              {nowPlaying.section}
            </div>
          )}
        </div>
      )}

      {/* Recorder error toast */}
      {recorderError && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-card/95 backdrop-blur-lg rounded-lg px-4 py-2 shadow-xl border border-red-500/30 text-sm text-red-400">
          {recorderError}
        </div>
      )}

      {/* Recording Preview Toast */}
      {recordedUrl && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 flex flex-col gap-3 bg-card/95 backdrop-blur-lg rounded-xl p-4 shadow-2xl border border-border/50 animate-in slide-in-from-bottom-4 fade-in duration-300">
          <audio src={recordedUrl} controls className="h-10 w-72" />
          <div className="flex gap-2">
            <button
              onClick={dismissRecording}
              className="flex-1 h-9 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 flex items-center justify-center gap-2 transition-colors text-sm font-medium"
            >
              <Trash2 className="size-4" />
              Discard
            </button>
            <button
              onClick={downloadRecording}
              className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center gap-2 hover:opacity-90 transition-opacity text-sm font-medium"
            >
              <Download className="size-4" />
              Download
            </button>
          </div>
        </div>
      )}

      {/* Floating Controls */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-card/90 backdrop-blur-lg rounded-full px-2 py-2 shadow-2xl border border-border/50">
        {/* Record Button */}
        <button
          onClick={handleRecordClick}
          className={`h-10 rounded-full flex items-center justify-center gap-2 transition-all ${
            isRecording
              ? 'bg-red-500 text-white px-4 animate-pulse'
              : 'w-10 text-muted-foreground hover:text-red-500 hover:bg-red-500/10'
          }`}
        >
          {isRecording ? (
            <>
              <Square className="size-3 fill-current" />
              <span className="text-sm font-medium">{formatDuration(duration)}</span>
            </>
          ) : (
            <Circle className="size-4 fill-current text-red-500" />
          )}
        </button>

        {/* Play/Stop Button */}
        <button
          onClick={isPlaying ? stop : play}
          className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:scale-105 transition-transform"
        >
          {isPlaying ? <Square className="size-5 fill-current" /> : <Play className="size-5 ml-0.5 fill-current" />}
        </button>

        {/* Refresh Button */}
        <button
          onClick={play}
          className="w-10 h-10 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center justify-center transition-colors"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>

      {/* Audio blocked overlay - browsers refuse sound before a user gesture */}
      {audioBlocked && (
        <button
          onClick={unlockAudio}
          className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex flex-col items-center justify-center gap-4 cursor-pointer"
        >
          <div className="w-20 h-20 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-2xl">
            <Play className="size-8 ml-1 fill-current" />
          </div>
          <div className="text-sm text-muted-foreground">Tap anywhere to join the music</div>
        </button>
      )}
    </div>
  )
}
