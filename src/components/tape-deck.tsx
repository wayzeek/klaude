/**
 * =============================================================================
 * TAPE DECK
 * =============================================================================
 *
 * The rack's archive section: saved recordings listed and playable, plus the
 * just-recorded bounce waiting for its keep/discard verdict at the top of
 * the pile. Each tape is a two-line block - header row, then a full-width
 * seek bar with the playhead. Files stream from /api/recordings/<name>.
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import { PlayToggle, SeekBar, useSharedPlayer, type SharedPlayer } from '@/components/mini-player'
import { DownloadIcon, RefreshIcon } from '@/components/icons'
import { formatDuration } from '@/hooks/use-audio-recorder'

type Tape = { name: string; bytes: number; modified: number }

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

/** Header meta: playback clock while this tape spins, date · size otherwise. */
function TapeMeta({ url, player, detail }: { url: string; player: SharedPlayer; detail: string }) {
  const active = player.playingUrl === url
  if (active && player.clock) {
    return (
      <span className="shrink-0 text-[11px] text-primary tabular-nums">
        {formatDuration(Math.floor(player.clock.current))} /{' '}
        {formatDuration(Math.floor(player.clock.duration))}
      </span>
    )
  }
  return <span className="shrink-0 text-[11px] text-muted-foreground/70">{detail}</span>
}

export type TapeDeckProps = {
  /** A just-finished recording awaiting keep/discard, if any. */
  recordedUrl: string | null
  recorderError: string | null
  onKeepRecording: () => void
  onDismissRecording: () => void
}

export function TapeDeck({ recordedUrl, recorderError, onKeepRecording, onDismissRecording }: TapeDeckProps) {
  const [tapes, setTapes] = useState<Tape[] | null>(null)
  const player = useSharedPlayer()

  // Resolving the bounce removes its row - a still-spinning preview would
  // keep playing with no visible control, so silence it first.
  const resolveBounce = (action: () => void) => {
    if (recordedUrl && player.playingUrl === recordedUrl) player.stop()
    action()
  }

  const refresh = useCallback(() => {
    fetch('/api/recordings')
      .then((res) => res.json())
      .then((data) => setTapes(Array.isArray(data.recordings) ? data.recordings : []))
      .catch(() => setTapes([]))
  }, [])

  // Load on mount; reload when a recording finishes or gets resolved, so
  // remote bounces and kept takes appear without a manual refresh.
  useEffect(() => {
    refresh()
  }, [refresh, recordedUrl])

  return (
    <section className="h-full flex flex-col">
      <div className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-border bg-card text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>tapes{tapes && tapes.length > 0 ? ` · ${tapes.length}` : ''}</span>
        <button
          onClick={refresh}
          title="refresh tapes"
          className="w-6 h-6 flex items-center justify-center hover:text-foreground"
        >
          <RefreshIcon size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Fresh bounce first: review it where it will live */}
        {recorderError && (
          <div className="px-2.5 h-11 flex items-center border-b border-border/40 text-destructive truncate">
            {recorderError}
          </div>
        )}
        {recordedUrl && (
          <div className="px-2.5 pt-2 pb-2.5 border-b border-border/40 border-l-2 border-l-primary bg-card">
            <div className="flex items-center gap-2.5">
              <PlayToggle url={recordedUrl} player={player} />
              <span className="flex-1 truncate">fresh bounce</span>
              <TapeMeta url={recordedUrl} player={player} detail="just now" />
              <button
                onClick={() => resolveBounce(onKeepRecording)}
                className="px-2.5 h-8 shrink-0 border border-primary text-primary hover:bg-primary hover:text-primary-foreground text-xs leading-none"
              >
                keep
              </button>
              <button
                onClick={() => resolveBounce(onDismissRecording)}
                className="px-2.5 h-8 shrink-0 border border-border text-muted-foreground hover:text-destructive hover:border-destructive text-xs leading-none"
              >
                discard
              </button>
            </div>
            <SeekBar url={recordedUrl} player={player} className="mt-2" />
          </div>
        )}

        {tapes === null && (
          <div className="px-2.5 h-11 flex items-center text-muted-foreground/60">loading</div>
        )}
        {tapes !== null && tapes.length === 0 && !recordedUrl && (
          <div className="px-2.5 h-11 flex items-center text-muted-foreground/60">
            no tapes yet: record a set and it lands here
          </div>
        )}
        {tapes?.map((tape) => {
          const { title, detail } = describeTape(tape)
          const url = `/api/recordings/${encodeURIComponent(tape.name)}`
          return (
            <div key={tape.name} className="px-2.5 pt-2 pb-2.5 border-b border-border/40">
              <div className="flex items-center gap-2.5">
                <PlayToggle url={url} player={player} />
                <span className="flex-1 truncate" title={title}>
                  {title}
                </span>
                <TapeMeta url={url} player={player} detail={detail} />
                <a
                  href={url}
                  download={tape.name}
                  title="download"
                  className="w-8 h-8 shrink-0 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground/40"
                >
                  <DownloadIcon />
                </a>
              </div>
              <SeekBar url={url} player={player} className="mt-2" />
            </div>
          )
        })}
      </div>
    </section>
  )
}
