/**
 * =============================================================================
 * TRANSPORT BAR
 * =============================================================================
 *
 * The studio's statusline, pinned above the command line at the bottom of
 * the screen (vim-style: status above, prompt last). Far left is the mode
 * block - IDLE / PLAY / REC with its timer - readable from across the room.
 * Then transport controls, what's playing, and a meter + master fader
 * section exactly as wide as the rack so the column rule runs through.
 */

'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { LevelMeter } from '@/components/level-meter'
import { PlayIcon, StopIcon, RecordIcon, RefreshIcon, MoltekIcon } from '@/components/icons'
import { formatDuration } from '@/hooks/use-audio-recorder'
import { postQuiet } from '@/lib/api-client'
import type { NowPlaying } from '@/hooks/use-strudel'

export type TransportBarProps = {
  isPlaying: boolean
  nowPlaying: NowPlaying | null
  gainLevel: number
  isRecording: boolean
  recordingDuration: number
  onPlay: () => void
  onStop: () => void
  onRecordClick: () => void
  showMoltek: boolean
  onToggleMoltek: () => void
}

export function TransportBar({
  isPlaying,
  nowPlaying,
  gainLevel,
  isRecording,
  recordingDuration,
  onPlay,
  onStop,
  onRecordClick,
  showMoltek,
  onToggleMoltek,
}: TransportBarProps) {
  // Volume: local value while dragging so the SSE echo can't fight the thumb.
  const [dragVolume, setDragVolume] = useState<number | null>(null)
  const volumePostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volumeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleVolumeChange = (level: number) => {
    setDragVolume(level)
    if (volumePostTimerRef.current) clearTimeout(volumePostTimerRef.current)
    volumePostTimerRef.current = setTimeout(() => {
      postQuiet('/api/gain', { level, rampMs: 120 })
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

  const elapsed = nowPlaying ? Math.max(0, Math.floor((Date.now() - nowPlaying.since) / 1000)) : 0
  const detail = nowPlaying
    ? [nowPlaying.section, formatDuration(elapsed)].filter(Boolean).join(' · ')
    : ''
  const headlineFull = nowPlaying
    ? [nowPlaying.title, nowPlaying.artist, nowPlaying.section, formatDuration(elapsed)]
        .filter(Boolean)
        .join(' · ')
    : ''

  const volume = dragVolume ?? gainLevel

  return (
    <div className="flex items-stretch h-11 shrink-0 border-t border-border bg-card">
      {/* Mode block - the statusline anchor */}
      <div
        className={`w-24 shrink-0 flex items-center justify-center text-[11px] font-medium tracking-[0.2em] uppercase ${
          isRecording
            ? 'bg-destructive text-background'
            : isPlaying
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
        }`}
      >
        {isRecording ? `rec ${formatDuration(recordingDuration)}` : isPlaying ? 'play' : 'idle'}
      </div>

      {/* Transport controls */}
      <div className="flex items-center gap-2 px-3 shrink-0">
        <button
          onClick={isPlaying ? onStop : onPlay}
          title={isPlaying ? 'stop' : 'play'}
          className="w-8 h-8 flex items-center justify-center border border-border text-primary hover:border-foreground/40"
        >
          {isPlaying ? <StopIcon /> : <PlayIcon />}
        </button>
        <button
          onClick={onPlay}
          title="re-evaluate"
          className="w-8 h-8 flex items-center justify-center border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
        >
          <RefreshIcon />
        </button>
        <button
          onClick={onRecordClick}
          title={isRecording ? 'stop recording' : 'record'}
          className={`w-8 h-8 flex items-center justify-center border ${
            isRecording
              ? 'border-destructive text-destructive'
              : 'border-border text-muted-foreground hover:text-destructive hover:border-destructive/60'
          }`}
        >
          <RecordIcon />
        </button>
        <button
          onClick={onToggleMoltek}
          title={showMoltek ? 'hide moltek' : 'show moltek'}
          className={`w-8 h-8 flex items-center justify-center border text-[13px] ${
            showMoltek
              ? 'border-primary text-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
          }`}
        >
          <MoltekIcon size={19} />
        </button>
      </div>

      {/* Now playing */}
      <div className="flex-1 min-w-0 flex items-center px-1" title={headlineFull}>
        {nowPlaying && (
          <span className="truncate">
            <span className="text-foreground">{nowPlaying.title ?? 'untitled'}</span>
            {detail && <span className="text-muted-foreground"> · {detail}</span>}
          </span>
        )}
      </div>

      {/* Meter + master fader, aligned under the rack column */}
      <div className="w-[var(--rack-w)] shrink-0 flex items-center gap-3 px-3 border-l border-border">
        <LevelMeter />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          title="Master volume"
          className="flat-fader flex-1 min-w-0 cursor-pointer"
        />
        <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
          {Math.round(volume * 100)}%
        </span>
      </div>
    </div>
  )
}
