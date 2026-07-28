import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { decodeWav } from '../../decoded-audio.mjs'
import { DRUM_ROLES, detectDrumHits, transcribeDrums } from './drums.mjs'
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

  it('omits a snare that only ever coincides with the kick', () => {
    // `drumClip`'s kick fires on every beat and its snare fires only on beats
    // two and four, so every snare hit in this fixture coincides with a kick
    // hit at the same step - there is no beat where one fires without the
    // other. `suppressKickBleed` (task-4-report.md, "Critical" follow-up)
    // measures a snare hit's raw level against the raw level of a coincident
    // kick hit, because on the real drum stem that ratio cleanly separates a
    // kick's own broadband splatter (ratio 0.11-0.66) from every confirmed
    // real snare hit (none of which coincide with a kick at all). Comparing
    // raw magnitude across a 2-bin kick band and a 23-bin snare band has no
    // gain at which a noise-based snare wins that comparison against a
    // tonal kick sharing its step - swept snareGain from 0.6 to 8x drumClip's
    // default and the ratio topped out at 0.2, still short of the measured
    // 0.7 floor. A backbeat that always lands under the kick is exactly the
    // case this mechanism cannot tell apart from bleed, so the honest result
    // here is `null`, not a guessed-at [4, 12]: silence is correct when the
    // classifier genuinely can't distinguish signal from bleed, the same as
    // when there is no signal at all.
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    expect(result.snare[0]).toBeNull()
  })

  it('drops a snare hit that is really the kick\'s own splatter, keeps one that is not', () => {
    // An instant-attack kick (no ramp-in) on every beat, exactly the shape
    // Task 3 identified as spectrally broad regardless of decay time - it
    // splatters into the snare band at every kick step. One isolated, real
    // snare-band burst sits off the beat (step 6 of each bar) where no kick
    // plays at all.
    const beatSeconds = 60 / BPM
    const bars = 4
    const frames = Math.ceil(bars * 4 * beatSeconds * SAMPLE_RATE)
    const out = new Float32Array(frames)
    const rand = makeRand(777)
    for (let beat = 0; beat < bars * 4; beat++) {
      const start = Math.floor(beat * beatSeconds * SAMPLE_RATE)
      for (let i = 0; i < SAMPLE_RATE * 0.12 && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.03))
        out[start + i] += 0.9 * env * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE)
      }
    }
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * 4 * beatSeconds + 6 * (beatSeconds / 4)
      const start = Math.floor(barStart * SAMPLE_RATE)
      for (let i = 0; i < SAMPLE_RATE * 0.1 && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.02))
        out[start + i] += 1.2 * env * rand()
      }
    }
    const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const hits = detectDrumHits(decodeWav(buf), grid)
    const snareSteps = hits.snare.map((h) => h.step)
    // The off-beat, kick-free hit at step 6 (every bar: 6, 22, 38, 54) survives.
    expect(snareSteps).toEqual(expect.arrayContaining([6, 22, 38, 54]))
    // Every on-beat step (a kick plays at 4, 8, 12, ...) is gone.
    for (const step of snareSteps) {
      expect(step % 16 === 6).toBe(true)
    }
  })

  it('recovers eighth-note hats', () => {
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    const hats = result.hats[0]
    expect(hats).not.toBeNull()
    expect(hats.events.map((e) => e.step)).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
  })

  it('drops a hat hit that is really a snare crack, keeps one that is not', () => {
    // A low-passed "body" burst (real energy concentrated below ~1200Hz, like
    // a real snare drum, not the flat-spectrum noise `drumClip`'s snare uses)
    // plus a small broadband "crack" at the same instant - small enough that
    // hat/snare stays under `CRACK_SUPPRESSION_RATIO` (measured ~0.09 here),
    // but still loud enough on its own to clear the hats floor. A separate,
    // isolated, full-strength hat burst sits off that step with no coincident
    // snare.
    const beatSeconds = 60 / BPM
    const bars = 4
    const frames = Math.ceil(bars * 4 * beatSeconds * SAMPLE_RATE)
    const out = new Float32Array(frames)
    const rand = makeRand(555)
    const addBody = (at, decay, gain, length, lowpass) => {
      const start = Math.floor(at * SAMPLE_RATE)
      const n = Math.floor(length * SAMPLE_RATE)
      let y = 0
      for (let i = 0; i < n && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * decay))
        y = lowpass * y + (1 - lowpass) * rand()
        out[start + i] += gain * env * y
      }
    }
    const addBurst = (at, decay, gain, length) => {
      const start = Math.floor(at * SAMPLE_RATE)
      const n = Math.floor(length * SAMPLE_RATE)
      for (let i = 0; i < n && start + i < frames; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * decay))
        out[start + i] += gain * env * rand()
      }
    }
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * 4 * beatSeconds
      addBody(barStart, 0.03, 1.2, 0.1, 0.95) // snare body, step 0 of each bar
      addBurst(barStart, 0.003, 0.04, 0.02) // small crack, same instant
      addBurst(barStart + 6 * (beatSeconds / 4), 0.003, 0.6, 0.02) // isolated real hat, step 6
    }
    const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const hits = detectDrumHits(decodeWav(buf), grid)
    const hatSteps = hits.hats.map((h) => h.step)
    // The isolated hat at step 6 (every bar: 6, 22, 38, 54) survives.
    expect(hatSteps).toEqual(expect.arrayContaining([6, 22, 38, 54]))
    // The crack riding on the snare body (step 0 of each bar: 16, 32, 48) is gone.
    for (const step of hatSteps) {
      expect(step % 16 === 6).toBe(true)
    }
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
