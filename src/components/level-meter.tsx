/**
 * =============================================================================
 * LEVEL METER
 * =============================================================================
 *
 * A segmented master VU: see the music breathe, and know instantly when sound
 * died. Reads the shared audio tap rather than opening its own analyser, so
 * the studio keeps one analyser and one animation loop however many things
 * are watching the music.
 */

'use client'

import { useEffect, useRef } from 'react'
import { subscribeToAudio } from '@/lib/audio-tap'

const FLOOR_DB = -48
const SEGMENTS = 12

export function LevelMeter() {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      subscribeToAudio(({ rms }) => {
        if (!barRef.current) return
        const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity
        const level = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB))
        const lit = Math.round(level * SEGMENTS)
        const cells = barRef.current.children
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i] as HTMLElement
          // the last two segments read hot
          cell.style.background =
            i < lit ? (i >= SEGMENTS - 2 ? 'var(--mk-destructive)' : 'var(--mk-accent)') : 'var(--mk-n5)'
        }
      }),
    [],
  )

  return (
    <div ref={barRef} className="flex gap-[2px] shrink-0" title="Master level">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <div key={i} className="w-[5px] h-3.5" style={{ background: 'var(--mk-n5)' }} />
      ))}
    </div>
  )
}
