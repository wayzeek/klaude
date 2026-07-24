/**
 * =============================================================================
 * CONSOLE
 * =============================================================================
 *
 * The one control surface: a flat, monospace, tracker-style panel. Header
 * carries transport, what's playing, the master meter and volume; below it,
 * one row per named layer (activity, solo, mute, a note back to the agent),
 * a track-level note line, tapes, and recording states. No other floating
 * UI exists.
 */

'use client'

import { useEffect, useRef, useState, useReducer } from 'react'
import { LevelMeter } from '@/components/level-meter'
import { onLayerPulse } from '@/lib/layer-pulse'
import { formatDuration } from '@/hooks/use-audio-recorder'
import type { NowPlaying, Mix } from '@/hooks/use-strudel'

type Tape = { name: string; bytes: number; modified: number }

export type ConsoleProps = {
  isPlaying: boolean
  revision: number
  nowPlaying: NowPlaying | null
  gainLevel: number
  mix: Mix
  layers: string[]
  isRecording: boolean
  recordingDuration: number
  recorderError: string | null
  recordedUrl: string | null
  onPlay: () => void
  onStop: () => void
  onRecordClick: () => void
  onDownloadRecording: () => void
  onDismissRecording: () => void
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})

/** "2026-07-23T18-35-40-145-blackout-bomt.wav" → { title: "blackout", detail } */
function describeTape(tape: Tape): { title: string; detail: string } {
  const m = tape.name.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:-(.+?))?-[a-z0-9]{4}\.wav$/)
  const title = m ? (m[1] ? m[1].replace(/-/g, ' ') : 'untitled') : tape.name.replace(/\.wav$/, '')
  const date = new Date(tape.modified)
  const mb = (tape.bytes / (1024 * 1024)).toFixed(1)
  return {
    title,
    detail: `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mb}mb`,
  }
}

/** Square, flat toggle - inverse video when active. */
function Toggle({
  label,
  active,
  activeClass,
  title,
  onClick,
}: {
  label: string
  active: boolean
  activeClass: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-5 h-5 shrink-0 border text-[10px] leading-none ${
        active
          ? activeClass
          : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
      }`}
    >
      {label}
    </button>
  )
}

/** Inline note input - Enter sends, Escape closes. */
function NoteInput({
  placeholder,
  onSend,
  onClose,
  autoFocus,
}: {
  placeholder: string
  onSend: (text: string) => void
  onClose?: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  return (
    <input
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text.trim()) {
          onSend(text.trim())
          setText('')
          onClose?.()
        } else if (e.key === 'Escape') {
          onClose?.()
        }
      }}
      placeholder={placeholder}
      maxLength={500}
      className="flex-1 min-w-0 bg-transparent border border-border px-1.5 h-5 text-[11px] font-mono outline-none placeholder:text-muted-foreground/60 focus:border-primary"
    />
  )
}

function LayerRow({ name, mix }: { name: string; mix: Mix }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const dotRef = useRef<HTMLSpanElement>(null)

  // Activity pulse: flash the dot when this layer fires. Direct style
  // mutation - a re-render per audio event would be wasteful.
  useEffect(
    () =>
      onLayerPulse((layer) => {
        if (layer !== name || !dotRef.current) return
        const dot = dotRef.current
        dot.style.background = 'var(--primary)'
        setTimeout(() => {
          if (dotRef.current) dotRef.current.style.background = 'var(--muted)'
        }, 90)
      }),
    [name],
  )

  const muted = mix.muted.includes(name)
  const soloed = mix.soloed.includes(name)
  const toggleMute = () =>
    post('/api/mix', { muted: muted ? mix.muted.filter((n) => n !== name) : [...mix.muted, name] })
  const toggleSolo = () =>
    post('/api/mix', { soloed: soloed ? mix.soloed.filter((n) => n !== name) : [...mix.soloed, name] })
  const sendNote = (text: string) => {
    post('/api/notes', { text, layer: name })
    setSent(true)
    setTimeout(() => setSent(false), 1200)
  }

  return (
    <div className="flex items-center gap-2 px-2 h-7 border-t border-border/60">
      <span ref={dotRef} className="w-1.5 h-1.5 shrink-0" style={{ background: 'var(--muted)' }} />
      <span
        className={`flex-1 truncate lowercase ${muted && !soloed ? 'text-muted-foreground/50 line-through' : ''}`}
      >
        {name}
      </span>
      {sent && <span className="text-primary shrink-0">sent</span>}
      {noteOpen ? (
        <NoteInput autoFocus placeholder={`note on ${name}…`} onSend={sendNote} onClose={() => setNoteOpen(false)} />
      ) : (
        <>
          <Toggle
            label="s"
            active={soloed}
            activeClass="bg-primary text-primary-foreground border-primary"
            title={`solo ${name}`}
            onClick={toggleSolo}
          />
          <Toggle
            label="m"
            active={muted}
            activeClass="bg-destructive text-white border-destructive"
            title={`mute ${name}`}
            onClick={toggleMute}
          />
          <button
            onClick={() => setNoteOpen(true)}
            title={`send a note about ${name}`}
            className="text-muted-foreground hover:text-foreground text-[10px] shrink-0"
          >
            note
          </button>
        </>
      )}
    </div>
  )
}

export function Console(props: ConsoleProps) {
  const {
    isPlaying,
    revision,
    nowPlaying,
    gainLevel,
    mix,
    layers,
    isRecording,
    recordingDuration,
    recorderError,
    recordedUrl,
    onPlay,
    onStop,
    onRecordClick,
    onDownloadRecording,
    onDismissRecording,
  } = props

  const [collapsed, setCollapsed] = useState(false)
  const [tapesOpen, setTapesOpen] = useState(false)
  const [tapes, setTapes] = useState<Tape[] | null>(null)
  const [trackSent, setTrackSent] = useState(false)

  // Volume: local value while dragging so the SSE echo can't fight the thumb.
  const [dragVolume, setDragVolume] = useState<number | null>(null)
  const volumePostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volumeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleVolumeChange = (level: number) => {
    setDragVolume(level)
    if (volumePostTimerRef.current) clearTimeout(volumePostTimerRef.current)
    volumePostTimerRef.current = setTimeout(() => {
      post('/api/gain', { level, rampMs: 120 })
    }, 80)
    if (volumeSettleTimerRef.current) clearTimeout(volumeSettleTimerRef.current)
    volumeSettleTimerRef.current = setTimeout(() => setDragVolume(null), 800)
  }

  // Tick the elapsed display once a second while a piece plays.
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!nowPlaying) return
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [nowPlaying])

  useEffect(() => {
    if (!tapesOpen) return
    setTapes(null)
    fetch('/api/recordings')
      .then((res) => res.json())
      .then((data) => setTapes(Array.isArray(data.recordings) ? data.recordings : []))
      .catch(() => setTapes([]))
  }, [tapesOpen])

  const sendTrackNote = (text: string) => {
    post('/api/notes', { text })
    setTrackSent(true)
    setTimeout(() => setTrackSent(false), 1200)
  }

  const elapsed = nowPlaying ? Math.max(0, Math.floor((Date.now() - nowPlaying.since) / 1000)) : 0
  const headline = nowPlaying
    ? [nowPlaying.title, nowPlaying.section, formatDuration(elapsed)].filter(Boolean).join(' · ')
    : isPlaying
      ? 'playing'
      : 'stopped'

  return (
    <div className="fixed bottom-3 right-3 w-[26rem] max-w-[calc(100vw-1.5rem)] font-mono text-[11px] text-foreground border border-border bg-[oklch(0.1_0.008_285/0.97)] select-none">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 h-8">
        <span className="text-primary font-semibold shrink-0">klaude</span>
        <button
          onClick={isPlaying ? onStop : onPlay}
          title={isPlaying ? 'stop' : 'play'}
          className="w-4 shrink-0 text-primary hover:opacity-80"
        >
          {isPlaying ? '■' : '▶'}
        </button>
        <button
          onClick={onPlay}
          title="re-evaluate"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          ⟳
        </button>
        <button
          onClick={onRecordClick}
          title={isRecording ? 'stop recording' : 'record'}
          className={`shrink-0 ${isRecording ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}`}
        >
          {isRecording ? `● ${formatDuration(recordingDuration)}` : '●'}
        </button>
        <span className="flex-1 truncate text-muted-foreground" title={headline}>
          {headline} · r{revision}
        </span>
        <LevelMeter />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={dragVolume ?? gainLevel}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          title="Master volume"
          className="w-14 h-1 shrink-0 accent-[var(--primary)] cursor-pointer"
        />
        <button
          onClick={() => setTapesOpen((o) => !o)}
          className={`shrink-0 text-[10px] ${tapesOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        >
          tapes
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'expand' : 'collapse'}
          className="w-3 shrink-0 text-muted-foreground hover:text-foreground"
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Layer mixer */}
          <div className="max-h-[40vh] overflow-y-auto">
            {layers.map((name) => (
              <LayerRow key={name} name={name} mix={mix} />
            ))}
            {layers.length === 0 && (
              <div className="px-2 h-7 flex items-center border-t border-border/60 text-muted-foreground/60">
                no layers - push a track with layers({'{ … }'})
              </div>
            )}
          </div>

          {/* Track-level note */}
          <div className="flex items-center gap-1.5 px-2 h-7 border-t border-border/60">
            <span className="text-primary shrink-0">&gt;</span>
            {trackSent && <span className="text-primary shrink-0">sent</span>}
            <NoteInput placeholder="tell klaude…" onSend={sendTrackNote} />
          </div>

          {/* Recorder error */}
          {recorderError && (
            <div className="px-2 h-7 flex items-center border-t border-border/60 text-destructive truncate">
              {recorderError}
            </div>
          )}

          {/* Recording review */}
          {recordedUrl && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border/60">
              <audio src={recordedUrl} controls className="h-7 flex-1 min-w-0" />
              <button onClick={onDownloadRecording} className="text-primary hover:opacity-80 text-[10px] shrink-0">
                keep
              </button>
              <button
                onClick={onDismissRecording}
                className="text-muted-foreground hover:text-destructive text-[10px] shrink-0"
              >
                discard
              </button>
            </div>
          )}

          {/* Tapes */}
          {tapesOpen && (
            <div className="max-h-[30vh] overflow-y-auto border-t border-border">
              {tapes === null && <div className="px-2 h-7 flex items-center text-muted-foreground/60">loading…</div>}
              {tapes !== null && tapes.length === 0 && (
                <div className="px-2 h-7 flex items-center text-muted-foreground/60">
                  no tapes yet - record a set and it lands here
                </div>
              )}
              {tapes?.map((tape) => {
                const { title, detail } = describeTape(tape)
                const url = `/api/recordings/${encodeURIComponent(tape.name)}`
                return (
                  <div key={tape.name} className="px-2 py-1.5 border-t border-border/40 first:border-t-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate">{title}</span>
                      <span className="text-muted-foreground/70 text-[10px] shrink-0">{detail}</span>
                      <a href={url} download={tape.name} className="text-primary text-[10px] shrink-0">
                        dl
                      </a>
                    </div>
                    <audio controls preload="none" src={url} className="w-full h-7 mt-1" />
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
