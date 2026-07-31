/**
 * Render a transcription back to plain audio, in Node.
 *
 * This exists to answer one question and no other: did we hear the record
 * right? The synthesis has to be comparable to a stem, not pleasant. Plain
 * tones for pitched layers, filtered clicks for drums, no Strudel, no samples,
 * no browser - which is what makes the hearing check in Task 11 genuinely free.
 *
 * Determinism is a hard requirement, not a nicety. Every comparison downstream
 * assumes the same transcription renders to the same bytes, so the noise source
 * is a seeded generator and `Math.random` appears nowhere.
 */

import { CHORD_TEMPLATES } from './transcribe/chords.mjs'
import { midiToHz } from './transcribe/f0.mjs'
import { LAYERS, stepSeconds } from './transcribe/quantize.mjs'

export const RESYNTH_SAMPLE_RATE = 44100

/** Per-layer voice settings. Drum decays are short enough to stay separate at
 *  sixteenth spacing; pitched releases are long enough that a held note reads
 *  as held. */
const VOICES = {
  kick: { kind: 'tone', hz: 60, decay: 0.055, length: 0.2, gain: 1 },
  snare: { kind: 'noise', lo: 180, hi: 1200, decay: 0.045, length: 0.18, gain: 0.8 },
  hats: { kind: 'noise', lo: 5000, hi: 16000, decay: 0.012, length: 0.06, gain: 0.5 },
  bass: { kind: 'pitched', partials: [1, 0.5, 0.25], attack: 0.005, release: 0.04, gain: 0.9 },
  // Near-pure tone (a single partial), unlike `bass`'s harmonically rich
  // sawtooth-shaped voice above - this is what `emit.mjs`'s `SOUNDS.sub`
  // (`.s("sine")`) actually sounds like, and `bassAgreement` in
  // `verify-hearing.mjs` compares by F0 pitch directly, not harmonic content,
  // so the shape only has to be honest, not tuned for the scorer.
  sub: { kind: 'pitched', partials: [1], attack: 0.006, release: 0.05, gain: 0.9 },
  chords: { kind: 'chord', partials: [1, 0.4], attack: 0.02, release: 0.08, gain: 0.5 },
  lead: { kind: 'pitched', partials: [1, 0.4, 0.15], attack: 0.008, release: 0.06, gain: 0.7 },
}

/**
 * Deterministic pseudo-noise in -0.5..0.5.
 *
 * A linear congruential generator, which is more than good enough for a noise
 * burst and has the one property that matters here: the same seed gives the
 * same sequence, run to run and machine to machine.
 */
export function makeNoise(seed = 1) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    return state / 0x7fffffff - 0.5
  }
}

/**
 * One layer's loop, repeated to fill `bars`.
 *
 * A null loop renders as silence of the right length, so callers never have to
 * special-case an omitted layer.
 */
export function renderLoop(loop, layer, grid, { bars, sampleRate = RESYNTH_SAMPLE_RATE } = {}) {
  const frames = Math.round(bars * grid.barSeconds * sampleRate)
  const out = new Float32Array(frames)
  if (!loop || !loop.events.length) return out

  const voice = VOICES[layer]
  if (!voice) throw new Error(`no resynth voice for layer "${layer}"`)
  const perStep = stepSeconds(grid)
  const loopSeconds = loop.loopBars * grid.barSeconds
  const repetitions = Math.ceil((bars * grid.barSeconds) / loopSeconds)

  // One noise generator per layer per render, seeded from the layer name, so
  // every repetition of a hat gets different noise while the whole render stays
  // reproducible.
  const noise = makeNoise(hashString(layer))

  for (let rep = 0; rep < repetitions; rep++) {
    const repOffset = rep * loopSeconds
    for (const event of loop.events) {
      const at = repOffset + event.step * perStep
      const start = Math.round(at * sampleRate)
      if (start >= frames) continue
      const noteSeconds = Math.max(event.length, 1) * perStep
      renderVoice(out, start, voice, event, noteSeconds, sampleRate, noise)
    }
  }
  return out
}

function renderVoice(out, start, voice, event, noteSeconds, sampleRate, noise) {
  const gain = voice.gain * (event.velocity ?? 0.8)

  if (voice.kind === 'tone') {
    const n = Math.floor(voice.length * sampleRate)
    for (let i = 0; i < n && start + i < out.length; i++) {
      const env = Math.exp(-i / (sampleRate * voice.decay))
      out[start + i] += gain * env * Math.sin((2 * Math.PI * voice.hz * i) / sampleRate)
    }
    return
  }

  if (voice.kind === 'noise') {
    const n = Math.floor(voice.length * sampleRate)
    // A one-pole pair approximating a band-pass. Crude on purpose: the hearing
    // check compares band energy, and a steeper filter would not change which
    // band the energy lands in.
    const lowCoeff = 1 - Math.exp((-2 * Math.PI * voice.hi) / sampleRate)
    const highCoeff = 1 - Math.exp((-2 * Math.PI * voice.lo) / sampleRate)
    let low = 0
    let high = 0
    for (let i = 0; i < n && start + i < out.length; i++) {
      const raw = noise()
      low += lowCoeff * (raw - low)
      high += highCoeff * (low - high)
      const env = Math.exp(-i / (sampleRate * voice.decay))
      out[start + i] += gain * env * (low - high) * 2
    }
    return
  }

  const midis =
    voice.kind === 'chord' ? chordMidis(event.symbol) : event.midi === null ? [] : [event.midi]
  if (!midis.length) return

  const n = Math.floor(noteSeconds * sampleRate)
  const attackFrames = Math.max(1, Math.floor(voice.attack * sampleRate))
  const releaseFrames = Math.max(1, Math.floor(voice.release * sampleRate))
  const perVoice = gain / Math.sqrt(midis.length)

  for (const midi of midis) {
    const hz = midiToHz(midi)
    for (let i = 0; i < n && start + i < out.length; i++) {
      const env = Math.min(1, i / attackFrames, (n - i) / releaseFrames)
      if (env <= 0) continue
      let value = 0
      for (let p = 0; p < voice.partials.length; p++) {
        value += voice.partials[p] * Math.sin((2 * Math.PI * hz * (p + 1) * i) / sampleRate)
      }
      out[start + i] += perVoice * env * value
    }
  }
}

/** Chord symbol to MIDI notes, voiced in one octave above C3. Voicing is
 *  arbitrary because chroma - which is what the hearing check compares -
 *  discards it entirely. */
function chordMidis(symbol) {
  const template = CHORD_TEMPLATES.find((candidate) => candidate.symbol === symbol)
  if (!template) return []
  const root = 48 + template.root
  const midis = []
  for (let pc = 0; pc < 12; pc++) {
    if (template.vector[pc] > 0) {
      let midi = 48 + pc
      if (midi < root) midi += 12
      midis.push(midi)
    }
  }
  return midis
}

/**
 * A whole section: every layer rendered separately, plus their sum.
 *
 * The per-layer buffers are what the hearing check scores; the mix exists so a
 * caller can listen to the result or write it out for inspection.
 */
export function renderSection(section, grid, { sampleRate = RESYNTH_SAMPLE_RATE } = {}) {
  const frames = Math.round(section.bars * grid.barSeconds * sampleRate)
  const layers = {}
  for (const layer of LAYERS) {
    layers[layer] = renderLoop(section.loops?.[layer] ?? null, layer, grid, {
      bars: section.bars,
      sampleRate,
    })
  }

  const mix = new Float32Array(frames)
  for (const layer of LAYERS) {
    const buffer = layers[layer]
    for (let i = 0; i < frames && i < buffer.length; i++) mix[i] += buffer[i]
  }
  // Normalise rather than clip. A clipped mix would compare badly against a
  // stem for reasons that have nothing to do with whether the notes are right.
  let peak = 0
  for (const sample of mix) peak = Math.max(peak, Math.abs(sample))
  if (peak > 1) for (let i = 0; i < frames; i++) mix[i] /= peak

  return { mix, layers }
}

function hashString(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
