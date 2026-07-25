/**
 * =============================================================================
 * AUDIO TAP
 * =============================================================================
 *
 * One passive analyser on Strudel's destination gain, one animation loop, many
 * consumers. It is only ever a connect() target and never sits in the signal
 * path, so it cannot break playback or recording.
 *
 * It rebinds rather than attaching once. Strudel's audio context can be
 * rebuilt underneath us, and an analyser attached to the old graph reports
 * silence forever with no error to notice.
 *
 * The loop runs only while something is subscribed.
 */

import type { Bands } from '@/lib/moltek-motion'

type Listener = (bands: Bands, dt: number) => void

const SILENT: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }
const listeners = new Set<Listener>()

let ctx: AudioContext | null = null
let gain: GainNode | null = null
let analyser: AnalyserNode | null = null
// The ArrayBuffer type argument is required: this repo's TypeScript DOM types
// reject plain Uint8Array / Float32Array on the analyser calls, which is why
// level-meter.tsx:39 already spells it out.
let freq: Uint8Array<ArrayBuffer> | null = null
let wave: Float32Array<ArrayBuffer> | null = null
let edges: number[] = []
let raf = 0
let last = 0

function currentNodes(): { ctx: AudioContext; gain: GainNode } | null {
  const w = window as unknown as {
    getAudioContext?: () => AudioContext
    getSuperdoughAudioController?: () => { output?: { destinationGain?: GainNode } }
  }
  const c = typeof w.getAudioContext === 'function' ? w.getAudioContext() : null
  const g =
    typeof w.getSuperdoughAudioController === 'function'
      ? (w.getSuperdoughAudioController()?.output?.destinationGain ?? null)
      : null
  return c && g ? { ctx: c, gain: g } : null
}

function detach(): void {
  if (gain && analyser) {
    try {
      gain.disconnect(analyser)
    } catch {}
  }
  ctx = null
  gain = null
  analyser = null
  freq = null
  wave = null
}

/** Attach to the live graph, or re-attach if it was replaced. */
function rebindIfNeeded(): void {
  const now = currentNodes()
  if (!now) {
    if (analyser) detach()
    return
  }
  if (now.ctx === ctx && now.gain === gain) return
  detach()
  ctx = now.ctx
  gain = now.gain
  analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.6
  freq = new Uint8Array(analyser.frequencyBinCount)
  wave = new Float32Array(analyser.fftSize)
  gain.connect(analyser)
  // Band edges in bins, derived from the real sample rate rather than assumed.
  const binHz = ctx.sampleRate / analyser.fftSize
  edges = [20, 60, 250, 2000, 8000].map((hz) => Math.max(1, Math.round(hz / binHz)))
}

function average(from: number, to: number): number {
  if (!freq) return 0
  const end = Math.min(to, freq.length)
  if (end <= from) return 0
  let sum = 0
  for (let i = from; i < end; i++) sum += freq[i]
  return sum / (end - from) / 255
}

function read(): Bands {
  if (!analyser || !freq || !wave) return SILENT
  analyser.getByteFrequencyData(freq)
  analyser.getFloatTimeDomainData(wave)
  let sum = 0
  for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i]
  return {
    rms: Math.sqrt(sum / wave.length),
    sub: average(edges[0], edges[1]),
    bass: average(edges[1], edges[2]),
    mid: average(edges[2], edges[3]),
    high: average(edges[3], edges[4]),
  }
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = last === 0 ? 1 / 60 : (now - last) / 1000
  last = now
  rebindIfNeeded()
  const bands = read()
  listeners.forEach((listener) => {
    try {
      listener(bands, dt)
    } catch (err) {
      console.error('[moltek] audio tap listener failed:', err)
    }
  })
}

export function subscribeToAudio(listener: Listener): () => void {
  listeners.add(listener)
  // Gate on whether the loop is running, not on set size: subscribing the
  // same function reference twice leaves the Set at size 1, and gating on
  // size would start a second, orphaned requestAnimationFrame chain that no
  // unsubscribe could ever cancel.
  if (raf === 0) {
    last = 0
    raf = requestAnimationFrame(frame)
  }
  let released = false
  return () => {
    // Idempotent: a second call after release must never re-run teardown,
    // which could otherwise detach a tap other subscribers still depend on.
    if (released) return
    released = true
    listeners.delete(listener)
    if (listeners.size === 0) {
      cancelAnimationFrame(raf)
      raf = 0
      detach()
    }
  }
}
