import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { DRUM_ROLES, transcribeDrums } from './drums.mjs'
import { gridFromJson } from './quantize.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const grid = gridFromJson({
  bpm: BPM,
  beatSeconds: 60 / BPM,
  barSeconds: (60 / BPM) * 4,
  downbeatSeconds: 0,
  beatsPerBar: 4,
})

/** Deterministic pseudo-noise; no Math.random anywhere in this repo's DSP. */
function makeRand(seed = 987654321) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff - 0.5
  }
}

/**
 * A drum pattern with known content: kick on every beat, snare on beats two
 * and four, hats on every eighth. Four bars at 120 BPM is eight seconds.
 */
function drumClip({ bars = 4, kickGain = 0.9, snareGain = 0.6, hatGain = 0.35 } = {}) {
  const beatSeconds = 60 / BPM
  const seconds = bars * 4 * beatSeconds
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const out = new Float32Array(frames)
  const rand = makeRand()

  // `attack` is a short raised-cosine ramp rather than an instantaneous step.
  // A step discontinuity has broadband content independent of `decay` - the
  // same phenomenon bands.test.mjs's low-thud fixture hit in Task 3 (see its
  // doc comment), just one octave down. A real kick's transient isn't a
  // sample-zero jump either, so this is a more honest signal, not a tuned one.
  const addTone = (at, hz, decay, gain, length, attack = 0) => {
    const start = Math.floor(at * SAMPLE_RATE)
    const n = Math.floor(length * SAMPLE_RATE)
    const attackFrames = Math.floor(attack * SAMPLE_RATE)
    for (let i = 0; i < n && start + i < frames; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * decay))
      const ramp = attackFrames > 0 && i < attackFrames ? 0.5 * (1 - Math.cos((Math.PI * i) / attackFrames)) : 1
      out[start + i] += gain * env * ramp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
    }
  }
  const addNoise = (at, decay, gain, length, alternate) => {
    const start = Math.floor(at * SAMPLE_RATE)
    const n = Math.floor(length * SAMPLE_RATE)
    for (let i = 0; i < n && start + i < frames; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * decay))
      out[start + i] += gain * env * rand() * (alternate && i % 2 ? -1 : 1)
    }
  }

  for (let beat = 0; beat < bars * 4; beat++) {
    const at = beat * beatSeconds
    addTone(at, 55, 0.03, kickGain, 0.12, 0.01)
    if (beat % 4 === 1 || beat % 4 === 3) addNoise(at, 0.02, snareGain, 0.1, false)
    addNoise(at, 0.003, hatGain, 0.02, true)
    addNoise(at + beatSeconds / 2, 0.003, hatGain, 0.02, true)
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

const SECTIONS = [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null }]

describe('DRUM_ROLES', () => {
  it('is exactly moltek’s three drum layers, in order', () => {
    expect(DRUM_ROLES.map((r) => r.name)).toEqual(['kick', 'snare', 'hats'])
    expect(Object.isFrozen(DRUM_ROLES)).toBe(true)
  })
})

describe('transcribeDrums', () => {
  it('recovers four-to-the-floor as a one-bar kick loop', () => {
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    const kick = result.kick[0]
    expect(kick).not.toBeNull()
    expect(kick.loopBars).toBe(1)
    expect(kick.events.map((e) => e.step)).toEqual([0, 4, 8, 12])
  })

  it('recovers the snare on the backbeat', () => {
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    const snare = result.snare[0]
    expect(snare).not.toBeNull()
    expect(snare.events.map((e) => e.step)).toEqual([4, 12])
  })

  it('recovers eighth-note hats', () => {
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    const hats = result.hats[0]
    expect(hats).not.toBeNull()
    expect(hats.events.map((e) => e.step)).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
  })

  it('leaves drum events unpitched', () => {
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    for (const event of result.kick[0].events) {
      expect(event.midi).toBeNull()
      expect(event.symbol).toBeNull()
      expect(event.length).toBe(1)
    }
  })

  it('preserves relative velocity so ghost notes stay ghosts', () => {
    // A loud kick on the downbeat, a quiet one on beat three.
    const beatSeconds = 60 / BPM
    const frames = Math.ceil(4 * 4 * beatSeconds * SAMPLE_RATE)
    const out = new Float32Array(frames)
    for (let beat = 0; beat < 16; beat++) {
      const gain = beat % 4 === 0 ? 0.9 : 0.25
      const start = Math.floor(beat * beatSeconds * SAMPLE_RATE)
      for (let i = 0; i < SAMPLE_RATE * 0.12 && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.03))
        out[start + i] += gain * env * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE)
      }
    }
    const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const kick = transcribeDrums(buf, grid, SECTIONS).kick[0]
    const byStep = new Map(kick.events.map((e) => [e.step, e]))
    expect(byStep.get(0).velocity).toBeGreaterThan(byStep.get(8).velocity * 1.5)
  })

  it('omits a role with nothing in its band', () => {
    // Kick only: no snare body, no hat noise.
    const beatSeconds = 60 / BPM
    const frames = Math.ceil(4 * 4 * beatSeconds * SAMPLE_RATE)
    const out = new Float32Array(frames)
    for (let beat = 0; beat < 16; beat++) {
      const start = Math.floor(beat * beatSeconds * SAMPLE_RATE)
      for (let i = 0; i < SAMPLE_RATE * 0.12 && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.03))
        out[start + i] += 0.9 * env * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE)
      }
    }
    const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const result = transcribeDrums(buf, grid, SECTIONS)
    expect(result.kick[0]).not.toBeNull()
    expect(result.hats[0]).toBeNull()
  })

  it('returns one entry per section, aligned by index', () => {
    const twoSections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const result = transcribeDrums(drumClip(), grid, twoSections)
    for (const role of ['kick', 'snare', 'hats']) {
      expect(result[role]).toHaveLength(2)
    }
  })

  it('carries confidence on every event and on the loop', () => {
    const kick = transcribeDrums(drumClip(), grid, SECTIONS).kick[0]
    expect(kick.confidence).toBeGreaterThan(0)
    expect(kick.confidence).toBeLessThanOrEqual(1)
    for (const event of kick.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
    }
  })
})
