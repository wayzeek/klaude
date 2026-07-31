import { describe, expect, it } from 'vitest'
import { clickTrainClip, harmonicNotesClip, rhythmClip, writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { makeNoise } from './resynth.mjs'
import { attackFromEnvelope, decayFromEnvelope, profileDrumRoles, profileOnsetTimbre, profileStem, profileStems } from './stem-profile.mjs'

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

describe('attackFromEnvelope', () => {
  const HOP = 0.01

  it('reports null with too few onsets to trust', () => {
    const energy = [0.01, 1, 0.9, 0.01, 0.01, 1, 0.9, 0.01]
    const result = attackFromEnvelope(energy, [0, 0.04], HOP)
    expect(result.seconds).toBeNull()
    expect(result.count).toBe(2)
  })

  it('measures a fast rise as short', () => {
    // Peaks one hop after each onset.
    const energy = new Array(20).fill(0.001)
    for (const onsetHop of [0, 5, 10]) {
      energy[onsetHop] = 0.01
      energy[onsetHop + 1] = 1
      energy[onsetHop + 2] = 0.9
    }
    const result = attackFromEnvelope(energy, [0, 0.05, 0.1], HOP)
    expect(result.count).toBe(3)
    expect(result.seconds).toBeCloseTo(HOP, 5) // one hop to reach the peak
  })

  it('measures a slow rise as long', () => {
    // Ramps up linearly over six hops before peaking.
    const energy = new Array(30).fill(0.001)
    for (const onsetHop of [0, 10, 20]) {
      for (let i = 0; i <= 6; i++) energy[onsetHop + i] = i / 6
    }
    const result = attackFromEnvelope(energy, [0, 0.1, 0.2], HOP)
    expect(result.count).toBe(3)
    expect(result.seconds).toBeCloseTo(6 * HOP, 5)
  })

  it('caps a rise at the next onset, not letting a busy passage borrow rise length', () => {
    // Each hit would naturally take six hops to peak, but the next onset
    // always arrives after only two - without the cap this would measure
    // close to six hops on average; with it, the peak search never sees past
    // one hop in.
    const onsets = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18]
    const energy = new Array(30).fill(0.001)
    for (const seconds of onsets) {
      const hop = Math.round(seconds / HOP)
      for (let i = 0; i <= 6 && hop + i < energy.length; i++) energy[hop + i] = i / 6
    }
    const result = attackFromEnvelope(energy, onsets, HOP)
    expect(result.seconds).toBeLessThan(2 * HOP)
  })

  it('returns null for an empty envelope or onset list', () => {
    expect(attackFromEnvelope(null, [0, 1, 2], HOP).seconds).toBeNull()
    expect(attackFromEnvelope([1, 1, 1], [], HOP).seconds).toBeNull()
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

describe('profileOnsetTimbre', () => {
  // E5 - inside LEAD_RANGE (150-2000Hz) so the attack/sustain envelope has
  // real signal to measure, and low enough that its own higher harmonics
  // still land inside a synthesized clip's own Nyquist limit.
  const MIDI = 76

  it('reports null spectral features and a low count with too few onsets', () => {
    const onsets = [{ seconds: 1, midi: MIDI }, { seconds: 2, midi: MIDI }]
    const buf = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1] })
    const result = profileOnsetTimbre(buf, onsets)
    expect(result.count).toBe(2)
    expect(result.centroidHz).toBeNull()
    expect(result.brightRatio).toBeNull()
    expect(result.oddEvenRatio).toBeNull()
  })

  it('excludes an onset outside the stem\'s own duration from the usable count', () => {
    const onsets = [{ seconds: 1, midi: MIDI }, { seconds: 2, midi: MIDI }, { seconds: 3, midi: MIDI }]
    const buf = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1] })
    const result = profileOnsetTimbre(buf, [...onsets, { seconds: 100, midi: MIDI }])
    expect(result.count).toBe(3)
  })

  it('reads a harmonically rich tone as brighter (higher centroid, higher brightRatio) than a near-sine one', () => {
    const onsets = [1, 2, 3, 4].map((seconds) => ({ seconds, midi: MIDI }))
    const bright = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: new Array(10).fill(1) })
    const dark = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1, 0.15] })

    const brightFeatures = profileOnsetTimbre(bright, onsets)
    const darkFeatures = profileOnsetTimbre(dark, onsets)

    expect(brightFeatures.count).toBe(4)
    expect(darkFeatures.count).toBe(4)
    expect(brightFeatures.centroidHz).toBeGreaterThan(darkFeatures.centroidHz)
    expect(brightFeatures.brightRatio).toBeGreaterThan(darkFeatures.brightRatio)
    expect(darkFeatures.brightRatio).toBeLessThan(0.1)
    expect(brightFeatures.brightRatio).toBeGreaterThan(0.5)
  })

  /**
   * This is the test that would have caught the real bug found while
   * rebuilding the two real tracks for the voice-selection report: an
   * earlier version of `profileOnsetTimbre` called `bandEnergy(audio,
   * LEAD_RANGE)` directly, but `LEAD_RANGE` is shaped `{ minHz, maxHz }` for
   * `melody.mjs`'s own callers, not `bandEnergy`'s `{ lo, hi }` -
   * `bandBins` silently produced `NaN` bin indices from the mismatched keys,
   * which made every envelope sample `NaN`. `decayFromEnvelope`'s `Math.max`
   * based peak search let that `NaN` slip through as a false, non-null
   * `seconds: 0` for every single onset on real audio - a defect only
   * visible by asserting that an actual measured number comes out the other
   * end and is directionally correct, not merely that it isn't null.
   */
  it('measures a fast attack as shorter than a slow one, on the same tone', () => {
    // Both read slower than their true ramp: `bandEnergy`'s 1024-sample
    // (~23ms) analysis window and 512-sample (~11.6ms) hop smear a fast
    // transient's rise across roughly a window's width before it is ever
    // sampled - the same kind of FFT-window bias `profileStem`'s own decay
    // test documents for `clickTrainClip`, just on the rising edge instead of
    // the falling one. The bounds below bracket that bias with headroom
    // rather than asserting the true (pre-smearing) attack times; the
    // ordering, not the absolute number, is what a real measurement has to
    // get right.
    const onsets = [1, 2, 3, 4].map((seconds) => ({ seconds, midi: MIDI }))
    const fast = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1], attackSeconds: 0.005, sustainSeconds: 0.3 })
    const slow = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1], attackSeconds: 0.2, sustainSeconds: 0.3 })

    const fastFeatures = profileOnsetTimbre(fast, onsets)
    const slowFeatures = profileOnsetTimbre(slow, onsets)

    expect(fastFeatures.attack.seconds).not.toBeNull()
    expect(slowFeatures.attack.seconds).not.toBeNull()
    expect(fastFeatures.attack.seconds).toBeLessThan(0.15)
    expect(slowFeatures.attack.seconds).toBeGreaterThan(0.3)
    expect(slowFeatures.attack.seconds).toBeGreaterThan(fastFeatures.attack.seconds)
  })

  it('measures sustain (onset-aligned decay) on the same envelope, independently of attack', () => {
    const onsets = [1, 2, 3, 4].map((seconds) => ({ seconds, midi: MIDI }))
    const buf = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1], attackSeconds: 0.005, sustainSeconds: 0.3 })
    const result = profileOnsetTimbre(buf, onsets)
    expect(result.sustain.seconds).not.toBeNull()
    expect(result.sustain.seconds).toBeGreaterThan(0.05)
  })

  it('reads a higher odd/even harmonic ratio for an odd-harmonics-only tone than an all-harmonics-equal one', () => {
    const onsets = [1, 2, 3, 4].map((seconds) => ({ seconds, midi: MIDI }))
    const oddOnly = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1, 0, 1, 0, 1, 0, 1, 0] })
    const equal = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: new Array(8).fill(1) })

    const oddFeatures = profileOnsetTimbre(oddOnly, onsets)
    const equalFeatures = profileOnsetTimbre(equal, onsets)

    expect(oddFeatures.oddEvenRatio).not.toBeNull()
    expect(equalFeatures.oddEvenRatio).not.toBeNull()
    expect(oddFeatures.oddEvenRatio).toBeGreaterThan(equalFeatures.oddEvenRatio)
  })

  it('returns null oddEvenRatio when no onset carries a known pitch', () => {
    const onsets = [1, 2, 3, 4].map((seconds) => ({ seconds, midi: MIDI }))
    const buf = harmonicNotesClip({ seconds: 8, notes: onsets, harmonicGains: [1] })
    const noPitch = onsets.map(({ seconds }) => ({ seconds, midi: null }))
    const result = profileOnsetTimbre(buf, noPitch)
    expect(result.oddEvenRatio).toBeNull()
  })
})
