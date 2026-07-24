/**
 * =============================================================================
 * LEVEL METER
 * =============================================================================
 *
 * A segmented master VU: see the music breathe, and know instantly when
 * sound died. Taps Strudel's destination gain with a passive AnalyserNode -
 * it never sits in the audio path, so it can't break playback or recording.
 */

'use client'

import { useEffect, useRef } from 'react'

const ATTACH_POLL_MS = 500
const FLOOR_DB = -48

function getStrudelAudio(): { ctx: AudioContext; gain: GainNode } | null {
  const w = window as unknown as {
    getAudioContext?: () => AudioContext
    getSuperdoughAudioController?: () => { output?: { destinationGain?: GainNode } }
  }
  const ctx = typeof w.getAudioContext === 'function' ? w.getAudioContext() : null
  const gain =
    typeof w.getSuperdoughAudioController === 'function'
      ? (w.getSuperdoughAudioController()?.output?.destinationGain ?? null)
      : null
  return ctx && gain ? { ctx, gain } : null
}

const SEGMENTS = 12

export function LevelMeter() {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let analyser: AnalyserNode | null = null
    let tappedGain: GainNode | null = null
    let data: Float32Array<ArrayBuffer> | null = null
    let raf = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (!analyser || !data || !barRef.current) return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity
      const level = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB))
      const lit = Math.round(level * SEGMENTS)
      const cells = barRef.current.children
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] as HTMLElement
        // the last two segments read hot
        cell.style.background =
          i < lit ? (i >= SEGMENTS - 2 ? 'var(--destructive)' : 'var(--primary)') : 'var(--muted)'
      }
    }

    // Strudel's audio context appears only after the engine initializes -
    // keep trying until it exists, then tap it once.
    const poll = setInterval(() => {
      const audio = getStrudelAudio()
      if (!audio) return
      clearInterval(poll)
      analyser = audio.ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0
      data = new Float32Array(analyser.fftSize)
      tappedGain = audio.gain
      tappedGain.connect(analyser)
      draw()
    }, ATTACH_POLL_MS)

    return () => {
      clearInterval(poll)
      cancelAnimationFrame(raf)
      if (tappedGain && analyser) {
        try {
          tappedGain.disconnect(analyser)
        } catch {}
      }
    }
  }, [])

  return (
    <div ref={barRef} className="flex gap-px shrink-0" title="Master level">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <div key={i} className="w-1 h-3" style={{ background: 'var(--muted)' }} />
      ))}
    </div>
  )
}
