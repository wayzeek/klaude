import { describe, expect, it } from 'vitest'
import { decodeWav } from '../../decoded-audio.mjs'
import { ONSET_FFT, ONSET_HOP } from '../../dsp.mjs'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { bandEnergy, bandNovelty, pickBandOnsets } from './bands.mjs'

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
    // 20-120Hz only clears 16 bins (MIN_BAND_BINS) at fftSize 8192, so this
    // call auto-widens from the default 1024. hop stays ONSET_HOP - the curve
    // is still sampled every 11.6ms - but an 8192-sample (~186ms) window takes
    // a real fraction of its own width to "see" an attack, so every peak lands
    // late by a consistent, measured ~0.15-0.16s (see task-3-report.md's
    // fftSize sweep). That is a bias, not jitter: spacing between onsets is
    // still tight even though their absolute position is not.
    for (let i = 1; i < onsets.length; i++) {
      expect(Math.abs(onsets[i].seconds - onsets[i - 1].seconds - 0.5)).toBeLessThan(0.02)
    }
    for (const onset of onsets) {
      const nearest = Math.round(onset.seconds / 0.5) * 0.5
      expect(Math.abs(onset.seconds - nearest)).toBeLessThan(0.2)
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

describe('default fftSize', () => {
  // hop is fixed at ONSET_HOP regardless of fftSize, so the array length is a
  // direct fingerprint of which window was actually used: a wider window
  // fits fewer hops in the same clip. This is what would catch a regression
  // like "someone forces fftSize back to 1024 for every band" without
  // reaching into bands.mjs's internals - the kick band's onset rate would
  // quietly go 6x wrong (see task-3-report.md) while this assertion fails
  // loudly instead.
  const hopsFor = (numFrames, fftSize) => Math.floor((numFrames - fftSize) / ONSET_HOP) + 1

  it('widens a narrow low-frequency band past the default window', () => {
    const audio = decodeWav(twoBandClip())
    // 20-120Hz clears 16 bins (MIN_BAND_BINS) only at fftSize 8192.
    const novelty = bandNovelty(audio, { lo: 20, hi: 120 })
    expect(novelty.length).toBe(hopsFor(audio.numFrames, 8192))
    expect(novelty.length).not.toBe(hopsFor(audio.numFrames, ONSET_FFT))

    const energy = bandEnergy(audio, { lo: 20, hi: 120 })
    expect(energy.length).toBe(hopsFor(audio.numFrames, 8192))
  })

  it('leaves a wide high-frequency band at the default window', () => {
    const audio = decodeWav(twoBandClip())
    // 8000-16000Hz already clears 16 bins at the default 1024.
    const novelty = bandNovelty(audio, { lo: 8000, hi: 16000 })
    expect(novelty.length).toBe(hopsFor(audio.numFrames, ONSET_FFT))

    const energy = bandEnergy(audio, { lo: 8000, hi: 16000 })
    expect(energy.length).toBe(hopsFor(audio.numFrames, ONSET_FFT))
  })

  it('still honours an explicit fftSize override', () => {
    const audio = decodeWav(twoBandClip())
    const novelty = bandNovelty(audio, { lo: 20, hi: 120, fftSize: ONSET_FFT })
    expect(novelty.length).toBe(hopsFor(audio.numFrames, ONSET_FFT))
  })
})
