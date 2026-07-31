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

  it('recovers the snare on the backbeat', () => {
    // `drumClip`'s kick fires on every beat and its snare fires only on beats
    // two and four, so every snare hit here coincides with a kick hit at the
    // same step - the standard four-on-the-floor-plus-backbeat pattern this
    // whole classifier exists to serve. An earlier version of
    // `suppressKickBleed` compared raw levels across the kick and snare
    // bands and could not recover this case at any gain:
    // `bandEnergy` divides by bin count, so a kick concentrated in ~2 bins
    // always reads louder than a noise-based snare spread across ~23,
    // regardless of which one is real - overfitting the rule to this one
    // recording's near-silent ghost pattern by breaking the genre's most
    // common pattern. `bandFlatness` (see its doc comment in bands.mjs)
    // replaced that comparison with one that never touches the kick band at
    // all, so a real backbeat snare is recovered correctly here.
    const result = transcribeDrums(drumClip(), grid, SECTIONS)
    const snare = result.snare[0]
    expect(snare).not.toBeNull()
    expect(snare.events.map((e) => e.step)).toEqual([4, 12])
  })

  it('drops a snare hit that is really the kick\'s own splatter, keeps one that is not', () => {
    // An instant-attack kick (no ramp-in) on every beat, exactly the shape
    // Task 3 identified as spectrally broad regardless of decay time - it
    // splatters into the snare band at every kick step, but as a few
    // discrete tones (the kick's harmonics), not broadband noise, so
    // `bandFlatness` reads it as low there. One isolated, real snare-band
    // burst sits off the beat (step 6 of each bar) where no kick plays at
    // all, and survives regardless of flatness since it has no coincident
    // kick to be judged against.
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

  describe('fills and one-off variation (#23)', () => {
    // #23: fills.mjs reclaims what foldToLoop discards, restricted to drum
    // roles. `drumClip()`'s four-on-the-floor is uniform by construction -
    // every bar identical - so it is the "no variation" half of the pair on
    // real, decoded audio, not just the synthetic-events tests in
    // fills.test.mjs.
    it('carries no variation on a uniform four-on-the-floor loop', () => {
      const kick = transcribeDrums(drumClip(), grid, SECTIONS).kick[0]
      expect(kick.variation).toBeNull()
    })

    it('attaches a real fill detected from actual audio, end to end through transcribeDrums', () => {
      // A busy bar (six kicks) alternating with a sparse one (one kick) -
      // bars 0/2 share the busy phase, bars 1/3 the sparse one, so the fold
      // settles on a real 2-bar loop. The section's own closing bar (3)
      // repeats that one sparse hit, plus three extra kicks nowhere else in
      // the clip - a real fill, not a synthesised one. A 2-bar silent lead-in
      // keeps the very first kick off sample zero, where a decaying tone's
      // own attack transient reads differently to bandEnergyRise than one
      // with quiet audio ahead of it.
      const beatSeconds = 60 / BPM
      const stepSeconds = beatSeconds / 4
      const leadInBars = 2
      const totalBars = leadInBars + 4
      const frames = Math.ceil(totalBars * 4 * beatSeconds * SAMPLE_RATE)
      const out = new Float32Array(frames)
      const addKick = (bar, step) => {
        const at = (leadInBars + bar) * 4 * beatSeconds + step * stepSeconds
        const start = Math.floor(at * SAMPLE_RATE)
        const attackFrames = Math.floor(0.01 * SAMPLE_RATE)
        for (let i = 0; i < SAMPLE_RATE * 0.12 && start + i < frames; i++) {
          const env = Math.exp(-i / (SAMPLE_RATE * 0.03))
          const ramp = i < attackFrames ? 0.5 * (1 - Math.cos((Math.PI * i) / attackFrames)) : 1
          out[start + i] += 0.9 * env * ramp * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE)
        }
      }
      for (const bar of [0, 2]) {
        for (const step of [0, 2, 4, 6, 8, 10]) addKick(bar, step)
      }
      addKick(1, 0)
      addKick(3, 0)
      addKick(3, 12)
      addKick(3, 14)
      addKick(3, 15)

      const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
      const sections = [
        { index: 0, startBar: 0, bars: leadInBars, label: 'lead-in', sameAs: null },
        { index: 1, startBar: leadInBars, bars: 4, label: 'mid', sameAs: null },
      ]
      const kick = transcribeDrums(buf, grid, sections).kick[1]
      expect(kick.loopBars).toBe(2)
      expect(kick.variation).not.toBeNull()
      expect(kick.variation.kind).toBe('fill')
      expect(kick.variation.bar).toBe(3)
      // The three onsets nowhere else in the clip, and none of the sparse
      // bar's own recurring hit (step 0).
      expect(kick.variation.events.map((e) => e.step)).toEqual([12, 14, 15])
    })
  })
})
