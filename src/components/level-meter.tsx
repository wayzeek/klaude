/**
 * =============================================================================
 * LEVEL METER
 * =============================================================================
 *
 * A small master VU bar: see the music breathe, and know instantly when
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

export function LevelMeter() {
  const barRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let analyser: AnalyserNode | null = null
    let tappedGain: GainNode | null = null
    let data: Float32Array<ArrayBuffer> | null = null
    let raf = 0
    let peakHold = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (!analyser || !data || !barRef.current || !peakRef.current) return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity
      const level = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB))

      peakHold = Math.max(level, peakHold * 0.994)

      barRef.current.style.width = `${level * 100}%`
      barRef.current.style.background =
        db > -3 ? 'oklch(0.65 0.24 25)' : db > -10 ? 'oklch(0.8 0.16 85)' : 'var(--primary)'
      peakRef.current.style.left = `${peakHold * 100}%`
      peakRef.current.style.opacity = peakHold > 0.01 ? '0.9' : '0'
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
    <div className="w-20 h-1.5 rounded-full bg-muted/70 relative overflow-visible" title="Master level">
      <div ref={barRef} className="h-full rounded-full transition-none" style={{ width: '0%' }} />
      <div
        ref={peakRef}
        className="absolute top-[-2px] h-[10px] w-[2px] rounded bg-foreground/80"
        style={{ left: '0%', opacity: 0 }}
      />
    </div>
  )
}
