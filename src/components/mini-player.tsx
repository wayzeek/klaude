/**
 * =============================================================================
 * MINI PLAYER
 * =============================================================================
 *
 * Flat playback primitives driven by one shared HTMLAudioElement - the
 * terminal answer to the browser's rounded native audio chrome. The tape
 * deck composes them: PlayToggle in the tape's header row, SeekBar spanning
 * the full row beneath it.
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { PlayIcon, StopIcon } from '@/components/icons'

/**
 * Playback engine. Side effects live outside state updaters (dev StrictMode
 * runs updaters twice), and playback state is mirrored in a ref so
 * toggle/seek never act on a stale snapshot.
 */
export function useSharedPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playingUrlRef = useRef<string | null>(null)
  // Bumped on every toggle/playFrom/stop; async callbacks from an older
  // session (play() rejections) compare against it instead of the URL, so
  // stop-and-restart of the same tape can't be clobbered by stale handlers.
  const sessionRef = useRef(0)
  // A seek requested before the tape's duration is known - applied (and
  // cleared) on loadedmetadata. Session changes reset it.
  const pendingSeekRef = useRef<number | null>(null)
  const [playingUrl, setPlayingUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [clock, setClock] = useState<{ current: number; duration: number } | null>(null)

  const setPlaying = (url: string | null) => {
    playingUrlRef.current = url
    setPlayingUrl(url)
    if (!url) setClock(null)
  }

  const getAudio = () => {
    if (!audioRef.current) {
      const a = new Audio()
      a.addEventListener('timeupdate', () => {
        const ok = Number.isFinite(a.duration) && a.duration > 0
        setProgress(ok ? a.currentTime / a.duration : 0)
        setClock(ok ? { current: a.currentTime, duration: a.duration } : null)
      })
      a.addEventListener('loadedmetadata', () => {
        const fraction = pendingSeekRef.current
        pendingSeekRef.current = null
        if (fraction !== null && Number.isFinite(a.duration) && a.duration > 0) {
          a.currentTime = fraction * a.duration
        }
      })
      a.addEventListener('ended', () => {
        playingUrlRef.current = null
        setPlayingUrl(null)
        setClock(null)
      })
      audioRef.current = a
    }
    return audioRef.current
  }

  const start = (a: HTMLAudioElement, url: string) => {
    const session = ++sessionRef.current
    a.src = url
    setClock(null) // the new tape's clock arrives with its first timeupdate
    setPlaying(url)
    // Switching tapes rejects the previous play() promise (AbortError) after
    // the new tape is already active - only clear state if it's still ours.
    a.play().catch(() => {
      if (sessionRef.current === session) setPlaying(null)
    })
  }

  const toggle = useCallback((url: string) => {
    const a = getAudio()
    if (playingUrlRef.current === url) {
      sessionRef.current++
      pendingSeekRef.current = null
      a.pause()
      setPlaying(null)
      return
    }
    pendingSeekRef.current = null
    setProgress(0)
    start(a, url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const seek = useCallback((url: string, fraction: number) => {
    const a = audioRef.current
    if (!a || playingUrlRef.current !== url) return
    if (Number.isFinite(a.duration) && a.duration > 0) {
      a.currentTime = fraction * a.duration
    } else {
      // Duration not known yet - remember the wish, land there on metadata
      pendingSeekRef.current = fraction
      setProgress(fraction)
    }
  }, [])

  /** Start a tape directly at a position - clicking its bar while it's idle. */
  const playFrom = useCallback((url: string, fraction: number) => {
    const a = getAudio()
    pendingSeekRef.current = fraction
    setProgress(fraction) // show the playhead where it will land, not at 0
    start(a, url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = useCallback(() => {
    sessionRef.current++
    pendingSeekRef.current = null
    audioRef.current?.pause()
    setPlaying(null)
  }, [])

  // Kill sound if the owning component unmounts mid-playback
  useEffect(
    () => () => {
      audioRef.current?.pause()
    },
    [],
  )

  return { playingUrl, progress, clock, toggle, seek, playFrom, stop }
}

export type SharedPlayer = ReturnType<typeof useSharedPlayer>

/** Square play/stop button for one URL on the shared player. */
export function PlayToggle({ url, player }: { url: string; player: SharedPlayer }) {
  const active = player.playingUrl === url
  return (
    <button
      onClick={() => player.toggle(url)}
      title={active ? 'stop' : 'play'}
      className="w-8 h-8 shrink-0 border border-border flex items-center justify-center text-primary hover:border-foreground/40"
    >
      {active ? <StopIcon /> : <PlayIcon />}
    </button>
  )
}

/**
 * Full-width flat seek bar. Clicking it jumps within the playing tape - or
 * starts an idle tape right at that spot.
 */
export function SeekBar({
  url,
  player,
  className = '',
}: {
  url: string
  player: SharedPlayer
  className?: string
}) {
  const active = player.playingUrl === url
  return (
    <div
      className={`h-2.5 w-full bg-muted cursor-pointer ${className}`}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const fraction = (e.clientX - rect.left) / rect.width
        if (active) player.seek(url, fraction)
        else player.playFrom(url, fraction)
      }}
    >
      <div
        className="h-full bg-primary"
        style={{ width: `${active ? player.progress * 100 : 0}%` }}
      />
    </div>
  )
}
