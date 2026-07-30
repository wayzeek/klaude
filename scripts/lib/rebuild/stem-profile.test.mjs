import { describe, expect, it } from 'vitest'
import { clickTrainClip, rhythmClip, writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { makeNoise } from './resynth.mjs'
import { decayFromEnvelope, profileDrumRoles, profileStem, profileStems } from './stem-profile.mjs'

describe('decayFromEnvelope', () => {
  const HOP = 0.01

  it('reports null with too few onsets to trust', () => {
    // Two onsets is below MIN_DECAY_ONSETS - a mean of two samples is noise.
    const energy = [1, 0.9, 0.01, 0.01, 1, 0.9, 0.01, 0.01]
    const result = decayFromEnvelope(energy, [0, 0.04], HOP)
    expect(result.seconds).toBeNull()
    expect(result.count).toBe(2)
  })

  it('measures a short, dry tail as short', () => {
    // Still above -30dB (0.0316 of peak 1) one hop later, then drops.
    const energy = new Array(20).fill(0.001)
    for (const onsetHop of [0, 5, 10]) {
      energy[onsetHop] = 1
      energy[onsetHop + 1] = 0.05
      energy[onsetHop + 2] = 0.001
    }
    const result = decayFromEnvelope(energy, [0, 0.05, 0.1], HOP)
    expect(result.count).toBe(3)
    expect(result.seconds).toBeCloseTo(HOP, 5) // one hop past onset, then gone
  })

  it('measures a long, wet tail as long', () => {
    // Stays above -30dB of peak 1 (0.0316) for six hops before dropping.
    const energy = new Array(30).fill(0.001)
    for (const onsetHop of [0, 8, 16]) {
      for (let i = 0; i <= 6; i++) energy[onsetHop + i] = 1 * Math.pow(0.6, i) // 0.6^6 = 0.047, still > 0.0316
      energy[onsetHop + 7] = 0.001
    }
    const result = decayFromEnvelope(energy, [0, 0.08, 0.16], HOP)
    expect(result.count).toBe(3)
    expect(result.seconds).toBeCloseTo(6 * HOP, 5)
  })

  it('caps a tail at the next onset, not letting a busy passage borrow tail length', () => {
    // Each hit's own decay would naturally run six hops, but the next onset
    // always arrives after only two - without the cap this would measure
    // close to six hops on average; with it, each (but the last) is capped
    // to one.
    const onsets = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18]
    const energy = new Array(30).fill(0.001)
    for (const seconds of onsets) {
      const hop = Math.round(seconds / HOP)
      for (let i = 0; i <= 6 && hop + i < energy.length; i++) energy[hop + i] = Math.pow(0.6, i)
    }
    const result = decayFromEnvelope(energy, onsets, HOP)
    expect(result.seconds).toBeLessThan(2 * HOP)
  })

  it('returns null for an empty envelope or onset list', () => {
    expect(decayFromEnvelope(null, [0, 1, 2], HOP).seconds).toBeNull()
    expect(decayFromEnvelope([1, 1, 1], [], HOP).seconds).toBeNull()
  })
})

describe('profileStem', () => {
  const DRY_TAU = 0.005 // -30dB crossing ~17ms
  const WET_TAU = 0.2 // -30dB crossing ~690ms

  it('measures a dry click train as a short decay', () => {
    const buf = clickTrainClip({ seconds: 8, bpm: 120, tauSeconds: DRY_TAU })
    const profile = profileStem(buf)
    expect(profile.decay.count).toBeGreaterThanOrEqual(3)
    expect(profile.decay.seconds).toBeLessThan(0.05)
  })

  it('measures a wet click train as a longer decay than a dry one', () => {
    const dry = profileStem(clickTrainClip({ seconds: 8, bpm: 120, tauSeconds: DRY_TAU }))
    const wet = profileStem(clickTrainClip({ seconds: 8, bpm: 120, tauSeconds: WET_TAU }))
    expect(wet.decay.seconds).toBeGreaterThan(dry.decay.seconds)
  })

  /**
   * `clickTrainClip`'s tau gives a calculable -30dB point (`tauSeconds *
   * 3.454`, see the fixture's own comment) - a stronger check than "wet
   * decays longer than dry" alone, which a badly broken measurement (wrong
   * sign, wrong dB conversion, an off-by-one hop) could still pass by
   * accident as long as it stayed monotonic.
   *
   * The match is not exact, and should not be asserted as if it were:
   * `bandEnergy`'s envelope comes from a 1024-sample (~23ms) FFT window, which
   * smooths the click's true instantaneous peak toward the frame's average -
   * for a tau comparable to or shorter than that window, the *measured* peak
   * undershoots the true one, so the floor derived from it crosses earlier
   * than the analytic formula predicts. Measured directly (probe script, not
   * committed) at bpm 60 (spacing wide enough that the next-onset cap never
   * engages): a 5ms tau reads ~0.99x theoretical, a 100ms tau reads ~0.49x -
   * a stable, physically explained bias, not noise. The bounds below bracket
   * both regimes with headroom, so this catches a measurement that is wrong
   * by an order of magnitude or the wrong sign, without being tuned to a
   * single tau's exact undershoot.
   */
  it('tracks the click train\'s analytic -30dB point within the FFT-window bias', () => {
    const ratio = (tauSeconds) => {
      const profile = profileStem(clickTrainClip({ seconds: 12, bpm: 60, tauSeconds }))
      return profile.decay.seconds / (tauSeconds * 3.454)
    }
    expect(ratio(0.005)).toBeGreaterThan(0.6)
    expect(ratio(0.005)).toBeLessThan(1.4)
    expect(ratio(0.1)).toBeGreaterThan(0.3)
    expect(ratio(0.1)).toBeLessThan(0.7)
  })

  it('carries band names and a percentage that sums to 100', () => {
    const profile = profileStem(rhythmClip({ seconds: 8, bpm: 120 }))
    expect(profile.bands.names).toEqual(['sub', 'bass', 'low-mid', 'mid', 'high-mid', 'air'])
    expect(profile.bands.pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0)
  })

  it('reads a mono-identical stereo signal as narrow width', () => {
    const mono = rhythmClip({ seconds: 4, bpm: 120, channels: 1 })
    const profile = profileStem(writeWavBuffer({ sampleRate: 44100, channels: 2, float32: false, samples: [monoSamples(mono), monoSamples(mono)] }))
    expect(profile.width.confidence).toBe(1)
    expect(profile.width.correlation).toBeGreaterThan(0.9)
  })

  it('reads two decorrelated channels as wide width', () => {
    const noiseA = makeNoise(1)
    const noiseB = makeNoise(99991)
    const n = 44100 * 4
    const left = Float32Array.from({ length: n }, () => noiseA())
    const right = Float32Array.from({ length: n }, () => noiseB())
    const profile = profileStem(writeWavBuffer({ sampleRate: 44100, channels: 2, float32: false, samples: [left, right] }))
    expect(profile.width.correlation).toBeLessThan(0.3)
  })

  it('reports zero width confidence for a mono file', () => {
    const profile = profileStem(rhythmClip({ seconds: 4, bpm: 120, channels: 1 }))
    expect(profile.width.confidence).toBe(0)
  })
})

/** Decode a WAV buffer's single channel back to a Float32Array of samples,
 *  for building a second, identical channel without re-synthesising. */
function monoSamples(wavBuf) {
  const dataStart = 44
  const bytesPerSample = 2
  const n = (wavBuf.length - dataStart) / bytesPerSample
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = wavBuf.readInt16LE(dataStart + i * bytesPerSample) / 32768
  return out
}

describe('profileDrumRoles', () => {
  it('isolates a kick-band click train from a hats-band one', () => {
    const kickish = clickTrainClip({ seconds: 8, bpm: 120, hz: 60, tauSeconds: 0.15 })
    const roles = profileDrumRoles(kickish)
    expect(roles.kick.count).toBeGreaterThanOrEqual(3)
    // A 60Hz click has essentially no energy in the 5-16kHz hats band, so it
    // must not be mistaken for hat hits.
    expect(roles.hats.count).toBe(0)
  })

  it('measures a boomy kick band as a longer tail than a tight one', () => {
    const tight = profileDrumRoles(clickTrainClip({ seconds: 8, bpm: 120, hz: 60, tauSeconds: 0.01 }))
    const boomy = profileDrumRoles(clickTrainClip({ seconds: 8, bpm: 120, hz: 60, tauSeconds: 0.2 }))
    expect(tight.kick.seconds).not.toBeNull()
    expect(boomy.kick.seconds).not.toBeNull()
    expect(boomy.kick.seconds).toBeGreaterThan(tight.kick.seconds)
  })
})

describe('profileStems', () => {
  it('attaches per-role decay only to the drums stem', () => {
    const drums = rhythmClip({ seconds: 8, bpm: 120 })
    const bass = rhythmClip({ seconds: 8, bpm: 120 })
    const other = rhythmClip({ seconds: 8, bpm: 120 })
    const profile = profileStems({ drums, bass, other })
    expect(profile.drums.roles).toBeDefined()
    expect(profile.drums.roles.kick).toBeDefined()
    expect(profile.bass.roles).toBeUndefined()
    expect(profile.other.roles).toBeUndefined()
  })

  it('profiles only the stems it is given', () => {
    const profile = profileStems({ drums: rhythmClip({ seconds: 4, bpm: 120 }) })
    expect(profile.drums).toBeDefined()
    expect(profile.bass).toBeUndefined()
    expect(profile.other).toBeUndefined()
  })
})
