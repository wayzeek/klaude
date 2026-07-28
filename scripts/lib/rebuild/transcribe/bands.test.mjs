import { describe, expect, it } from 'vitest'
import { decodeWav } from '../../decoded-audio.mjs'
import { ONSET_FFT, ONSET_HOP } from '../../dsp.mjs'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { bandEnergy, bandEnergyRise, bandNovelty, pickBandOnsets } from './bands.mjs'

const SAMPLE_RATE = 44100
const HOP_SECONDS = ONSET_HOP / SAMPLE_RATE

/**
 * A clip with a low thud and a high tick on independent schedules, so a
 * band-limited curve can be shown to follow one and ignore the other.
 *
 * `lowEvery` and `highEvery` are in seconds.
 *
 * The thud decays over 150ms with a 2ms raised-cosine attack, not the near-
 * instant click a naive envelope suggests. That matters for more than realism:
 * a decaying envelope's own Fourier transform is broad (a first-order decay
 * falls off only 20dB/decade), so an instant attack plus a fast (~20ms) decay
 * splatters real, measurable energy across the whole spectrum, including the
 * high band four decades away - not a code bug, just what an amplitude step
 * looks like in frequency. A 909 kick's sub-thump genuinely rings for
 * 100-300ms, so the slower decay is the more honest simulation, and it has
 * the side effect of keeping this fixture's two voices actually separable:
 * measured directly, the fast/instant version reads as onsets on the *other*
 * voice's schedule in both directions (see task-3-report.md).
 */
function twoBandClip({ seconds = 4, lowEvery = 0.5, highEvery = 0.25 } = {}) {
  const frames = Math.floor(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const thudTau = SAMPLE_RATE * 0.15
  const thudRamp = Math.round(SAMPLE_RATE * 0.002)
  const thudAttack = (i) => (i >= thudRamp ? 1 : 0.5 * (1 - Math.cos((Math.PI * i) / thudRamp)))
  for (let t = 0; t < seconds; t += lowEvery) {
    const start = Math.floor(t * SAMPLE_RATE)
    for (let i = 0; i < thudTau * 6 && start + i < frames; i++) {
      const env = Math.exp(-i / thudTau) * thudAttack(i)
      left[start + i] += 0.9 * env * Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE)
    }
  }
  // A deterministic pseudo-noise burst for the high band.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let t = 0; t < seconds; t += highEvery) {
    const start = Math.floor(t * SAMPLE_RATE)
    for (let i = 0; i < SAMPLE_RATE * 0.02 && start + i < frames; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * 0.004))
      // Alternating sign puts the energy at Nyquist-adjacent frequencies.
      left[start + i] += 0.5 * env * rand() * (i % 2 ? 1 : -1)
    }
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [left] })
}

describe('bandNovelty', () => {
  it('follows the low band and ignores the high one', () => {
    const audio = decodeWav(twoBandClip())
    const low = bandNovelty(audio, { lo: 20, hi: 120 })
    const onsets = pickBandOnsets(low, HOP_SECONDS)
    // Eight thuds in four seconds at 0.5s spacing; the first may fall inside
    // the first analysis window.
    expect(onsets.length).toBeGreaterThanOrEqual(6)
    expect(onsets.length).toBeLessThanOrEqual(9)
    for (const onset of onsets) {
      const nearest = Math.round(onset.seconds / 0.5) * 0.5
      expect(Math.abs(onset.seconds - nearest)).toBeLessThan(0.04)
    }
  })

  it('follows the high band and ignores the low one', () => {
    const audio = decodeWav(twoBandClip())
    const high = bandNovelty(audio, { lo: 8000, hi: 16000 })
    const onsets = pickBandOnsets(high, HOP_SECONDS)
    // Sixteen ticks in four seconds at 0.25s spacing.
    expect(onsets.length).toBeGreaterThanOrEqual(12)
    expect(onsets.length).toBeLessThanOrEqual(18)
  })

  it('returns null for a clip too short to analyse', () => {
    const short = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(512)],
    })
    expect(bandNovelty(decodeWav(short), { lo: 20, hi: 120 })).toBeNull()
  })

  it('reports strength and a confidence in range for every onset', () => {
    const audio = decodeWav(twoBandClip())
    const onsets = pickBandOnsets(bandNovelty(audio, { lo: 20, hi: 120 }), HOP_SECONDS)
    for (const onset of onsets) {
      expect(onset.strength).toBeGreaterThan(0)
      expect(onset.confidence).toBeGreaterThan(0)
      expect(onset.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('finds nothing in a band with no content', () => {
    // Pure 60 Hz thuds: the 8-16 kHz band holds only leakage.
    const audio = decodeWav(twoBandClip({ highEvery: 100 }))
    const onsets = pickBandOnsets(bandNovelty(audio, { lo: 8000, hi: 16000 }), HOP_SECONDS)
    expect(onsets.length).toBeLessThan(4)
  })
})

describe('bandEnergy', () => {
  it('peaks where the band has content', () => {
    const audio = decodeWav(twoBandClip({ lowEvery: 1, highEvery: 100 }))
    const energy = bandEnergy(audio, { lo: 20, hi: 120 })
    expect(energy).not.toBeNull()
    const hopsPerSecond = SAMPLE_RATE / ONSET_HOP
    const atHit = energy[Math.round(1 * hopsPerSecond)]
    const between = energy[Math.round(1.4 * hopsPerSecond)]
    expect(atHit).toBeGreaterThan(between * 4)
  })
})

/**
 * A single low tone repeated on a schedule, each hit rising slowly to its
 * peak (100ms raised-cosine ramp) and then decaying much more slowly still
 * (500ms time constant), so the envelope's absolute peak and the point of
 * fastest rise are nowhere near each other in time, and each hit is still
 * substantially elevated across the whole neighbourhood `pickBandOnsets`
 * looks at (+-8 hops, ~93ms). That second property is what makes this
 * fixture discriminating: on `twoBandClip`'s fast-attack thud, a pass-through
 * `bandEnergyRise` is *not* caught, because the neighbourhood around its peak
 * still spans quiet lead-in time, so the adaptive threshold clears anyway.
 * Here it can't - the neighbourhood is uniformly high, so raw energy fed
 * straight into `pickBandOnsets` never clears its own local mean by the
 * required factor and finds nothing at any floor, while the actual rising
 * edge is still a sharp, isolated spike against near-zero on either side.
 */
function slowRiseSlowDecayClip({ seconds = 4, every = 1, riseMs = 100, decayMs = 500, freq = 60 } = {}) {
  const frames = Math.floor(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const rise = Math.round((SAMPLE_RATE * riseMs) / 1000)
  const decayTau = (SAMPLE_RATE * decayMs) / 1000
  for (let t = 0; t < seconds; t += every) {
    const start = Math.floor(t * SAMPLE_RATE)
    const dur = rise + Math.round(decayTau * 4)
    for (let i = 0; i < dur && start + i < frames; i++) {
      const env = i < rise ? 0.5 * (1 - Math.cos((Math.PI * i) / rise)) : Math.exp(-(i - rise) / decayTau)
      left[start + i] += 0.9 * env * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
    }
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [left] })
}

describe('bandEnergyRise', () => {
  // bandNovelty's self-normalised ratio measurably fails on a kick-style band:
  // ground truth on the-chase's real stem showed 130/130 recall but a kick
  // predicted on 14 of 16 sixteenths per bar (359 spurious against 130 real),
  // because the ratio's own denominator shrinks through a decay and lets
  // ordinary jitter clear the floor for the whole tail. bandEnergyRise looks
  // at the absolute envelope instead - a decay has no positive rise in it, by
  // definition - and raised precision to 99% at floor~10 on real material (see
  // task-3-report.md for the full candidate comparison). This block proves
  // that mechanism on the synthetic fixture: same clip, same thud, a curve
  // built from bandEnergy instead of bandNovelty.
  it('returns null when energy is null', () => {
    expect(bandEnergyRise(null)).toBeNull()
  })

  it('finds the low thud with tight timing, across a wide range of floors', () => {
    const audio = decodeWav(twoBandClip())
    const rise = bandEnergyRise(bandEnergy(audio, { lo: 20, hi: 120 }))
    // The absolute floor for a raw envelope isn't the 0-1 ratio scale
    // pickBandOnsets defaults to; unlike that default, though, this mechanism
    // isn't sensitive to the exact value - 1 through 20 all land the same
    // seven onsets in this fixture (see task-3-report.md's sweep).
    for (const floor of [1, 5, 10, 20]) {
      const onsets = pickBandOnsets(rise, HOP_SECONDS, { floor })
      expect(onsets.length).toBeGreaterThanOrEqual(6)
      expect(onsets.length).toBeLessThanOrEqual(9)
      for (const onset of onsets) {
        const nearest = Math.round(onset.seconds / 0.5) * 0.5
        expect(Math.abs(onset.seconds - nearest)).toBeLessThan(0.04)
      }
    }
  })

  it('does not reintroduce cross-band leakage from the high tick', () => {
    const audio = decodeWav(twoBandClip())
    const rise = bandEnergyRise(bandEnergy(audio, { lo: 20, hi: 120 }))
    const onsets = pickBandOnsets(rise, HOP_SECONDS, { floor: 10 })
    // Eight real thuds; leakage from the sixteen high ticks would push this
    // well past that.
    expect(onsets.length).toBeLessThanOrEqual(9)
  })

  it('finds the four slow hits that a pass-through cannot', () => {
    // This is the test that would fail if bandEnergyRise were simplified to
    // `return energy` - proven below, not asserted. Confirmed by temporarily
    // making that exact change and rerunning this file: only this test
    // failed (0 onsets where 3-5 were expected), and it passed again once
    // reverted.
    const audio = decodeWav(slowRiseSlowDecayClip())
    const energy = bandEnergy(audio, { lo: 20, hi: 120 })

    for (const floor of [1, 5, 10, 20]) {
      // The mechanism this test exists to guard: differencing before picking.
      const riseOnsets = pickBandOnsets(bandEnergyRise(energy), HOP_SECONDS, { floor })
      expect(riseOnsets.length).toBeGreaterThanOrEqual(3)
      expect(riseOnsets.length).toBeLessThanOrEqual(5)
      for (const onset of riseOnsets) {
        const nearest = Math.round(onset.seconds)
        expect(Math.abs(onset.seconds - nearest)).toBeLessThan(0.1)
      }

      // The failure mode this test exists to catch: picking straight off the
      // envelope. Every hit is still substantially elevated across the whole
      // neighbourhood pickBandOnsets compares against, so the adaptive
      // threshold never clears and a pass-through finds nothing at all.
      const passThroughOnsets = pickBandOnsets(energy, HOP_SECONDS, { floor })
      expect(passThroughOnsets.length).toBe(0)
    }
  })
})

describe('fftSize override', () => {
  // fftSize is flat at ONSET_FFT by default for every band - auto-widening a
  // narrow band was tried and measured off (see bands.mjs's comment and
  // task-3-report.md: it doesn't fix the kick band's step-level accuracy, and
  // the one window that fixes its raw rate has a disqualifying timing delay).
  // That leaves an explicit override as the only remaining way a caller can
  // give a narrow band more bins, so this guards that the override actually
  // takes effect rather than being silently ignored. hop is fixed at
  // ONSET_HOP, so the returned array's length is a direct fingerprint of
  // which window was used.
  it('honours an explicit fftSize wider than the default', () => {
    const audio = decodeWav(twoBandClip())
    const hopsFor = (fftSize) => Math.floor((audio.numFrames - fftSize) / ONSET_HOP) + 1

    const novelty = bandNovelty(audio, { lo: 20, hi: 120, fftSize: 8192 })
    expect(novelty.length).toBe(hopsFor(8192))
    expect(novelty.length).not.toBe(hopsFor(ONSET_FFT))

    const energy = bandEnergy(audio, { lo: 20, hi: 120, fftSize: 8192 })
    expect(energy.length).toBe(hopsFor(8192))
  })
})
