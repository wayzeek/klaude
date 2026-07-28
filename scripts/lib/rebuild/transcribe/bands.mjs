/**
 * Spectral flux and energy restricted to a frequency band.
 *
 * `computeNovelty` in dsp.mjs sums flux across the whole spectrum, which makes
 * it an excellent beat detector and a useless drum classifier: a kick and a hat
 * on the same sixteenth are one peak in one curve, and nothing downstream can
 * pull them apart. One curve per band fixes that, at the cost of running the
 * FFT once per band. A hit with energy in two bands appears in both, which is
 * correct - a snare really does have a body and a crack.
 */

import { ONSET_FFT, ONSET_HOP, fft, makeHann } from '../../dsp.mjs'

/** Peak must exceed its neighbourhood mean by this factor. Matches dsp.mjs's
 *  ONSET_THRESHOLD, which was tuned on this repo's own material. */
const THRESHOLD = 1.4
/** Half-window, in hops, for the adaptive threshold (~90ms each side). */
const NEIGHBOURHOOD = 8
/** Absolute floor on normalised flux. Without it, a band holding nothing but
 *  numerical jitter reports a steady stream of imaginary hits, because the
 *  local mean approaches zero and everything clears it. */
const FLOOR = 0.045
/** Two peaks closer than this are one hit seen twice. 30ms is shorter than any
 *  musically distinct pair of drum hits and longer than one FFT hop. */
const MIN_SEPARATION_SECONDS = 0.03

/**
 * Minimum FFT bins a band needs before its self-normalised flux ratio is
 * measuring anything rather than noise.
 *
 * Below this, "the band's own magnitude" is an average of a handful of bins,
 * and the ratio swings on almost nothing. Measured on the-chase's real drum
 * stem (20-120Hz, the kick band) against its true four-on-the-floor rate of
 * ~2.3 onsets/s: 2 bins (fftSize 1024) reads 14.39/s, 5 bins (2048) reads
 * 13.60/s, 10 bins (4096) reads 10.14/s, 19 bins (8192) reads 4.76/s - stable
 * only once the window is wide enough to clear this count. Snare (23 bins)
 * and hats (255 bins) already clear it at the default 1024, so this only
 * escalates bands narrow enough to need it. Full sweep in task-3-report.md.
 */
const MIN_BAND_BINS = 16

/** Widest window `autoFftSize` will reach for. Doubling further keeps buying
 *  bins but each doubling also roughly doubles the window's time span, and
 *  every callsite in this file still hops at ONSET_HOP - a wider window does
 *  not cost hop-to-hop timing resolution, only how sharply one transient is
 *  localised inside it. 8192 (186ms at 44.1kHz) is the largest measured in
 *  the sweep above; there was no real-stem case that needed to go further. */
const MAX_AUTO_FFT = 8192

/** Map each FFT bin to whether it falls inside [lo, hi). */
function bandBins(sampleRate, fftSize, lo, hi) {
  const bins = fftSize / 2
  const binHz = sampleRate / fftSize
  const from = Math.max(1, Math.ceil(lo / binHz))
  const to = Math.min(bins - 1, Math.floor(hi / binHz))
  return { from, to }
}

/**
 * The smallest power-of-two window (from `ONSET_FFT` up to `MAX_AUTO_FFT`)
 * that gives a band at least `MIN_BAND_BINS` bins to average.
 *
 * Callers can still override `fftSize` explicitly; this only picks the
 * default. Hop is never touched here - see `MAX_AUTO_FFT`.
 */
function autoFftSize(sampleRate, lo, hi) {
  for (let fftSize = ONSET_FFT; fftSize <= MAX_AUTO_FFT; fftSize *= 2) {
    const { from, to } = bandBins(sampleRate, fftSize, lo, hi)
    if (to - from + 1 >= MIN_BAND_BINS) return fftSize
  }
  return MAX_AUTO_FFT
}

/**
 * Positive frame-to-frame magnitude change inside one band, normalised by the
 * band's own magnitude.
 *
 * The normalisation matters for the same reason it matters in `computeNovelty`:
 * raw flux scales with loudness, so a quiet hat attack would score below the
 * jitter of a loud sustained bass note. The ratio is near zero for anything
 * steady and large only for a genuine attack, at any level.
 *
 * `fftSize` defaults to whatever `autoFftSize` picks for this band, not a
 * flat `ONSET_FFT` - a narrow band like a kick's needs a wider window before
 * the ratio means anything (see `MIN_BAND_BINS`). `hop` always defaults to
 * `ONSET_HOP` regardless of window size, so the curve's time resolution never
 * moves; only how sharply one transient is localised inside it does.
 */
export function bandNovelty(audio, { lo, hi, fftSize = autoFftSize(audio.sampleRate, lo, hi), hop = ONSET_HOP }) {
  const { numFrames, sampleRate, readMono } = audio
  if (numFrames < fftSize * 2) return null
  const { from, to } = bandBins(sampleRate, fftSize, lo, hi)
  if (to < from) return null

  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const hops = Math.floor((numFrames - fftSize) / hop) + 1
  const novelty = new Float32Array(hops)
  const width = to - from + 1
  let previous = null
  let current = new Float32Array(width)

  for (let index = 0; index < hops; index++) {
    const start = index * hop
    for (let i = 0; i < fftSize; i++) {
      re[i] = readMono(start + i) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = from; bin <= to; bin++) {
      current[bin - from] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }
    if (previous) {
      let flux = 0
      let magnitude = 0
      for (let i = 0; i < width; i++) {
        const delta = current[i] - previous[i]
        if (delta > 0) flux += delta
        magnitude += current[i]
      }
      novelty[index] = magnitude > 0 ? flux / magnitude : 0
    }
    const swap = previous ?? new Float32Array(width)
    previous = current
    current = swap
  }
  return novelty
}

/** RMS magnitude inside one band, per hop. Used for velocity, where what
 *  matters is how loud the hit was rather than how abruptly it started.
 *  Shares `bandNovelty`'s auto-sized default `fftSize` so the two curves stay
 *  aligned hop-for-hop on the same band. */
export function bandEnergy(audio, { lo, hi, fftSize = autoFftSize(audio.sampleRate, lo, hi), hop = ONSET_HOP }) {
  const { numFrames, sampleRate, readMono } = audio
  if (numFrames < fftSize * 2) return null
  const { from, to } = bandBins(sampleRate, fftSize, lo, hi)
  if (to < from) return null

  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const hops = Math.floor((numFrames - fftSize) / hop) + 1
  const energy = new Float32Array(hops)

  for (let index = 0; index < hops; index++) {
    const start = index * hop
    for (let i = 0; i < fftSize; i++) {
      re[i] = readMono(start + i) * window[i]
      im[i] = 0
    }
    fft(re, im)
    let sum = 0
    for (let bin = from; bin <= to; bin++) sum += re[bin] * re[bin] + im[bin] * im[bin]
    energy[index] = Math.sqrt(sum / (to - from + 1))
  }
  return energy
}

/**
 * Local peaks that stand clear of their surroundings.
 *
 * Returns seconds, the peak's normalised flux as `strength`, and a confidence
 * derived from how far the peak cleared its local mean: at the threshold it is
 * near zero, at three times the local mean it saturates. Callers use strength
 * for velocity and confidence for whether to believe the hit at all.
 */
export function pickBandOnsets(
  novelty,
  hopSeconds,
  { threshold = THRESHOLD, floor = FLOOR, minSeparation = MIN_SEPARATION_SECONDS } = {},
) {
  if (!novelty) return []
  const found = []
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    if (novelty[i] < floor) continue
    let sum = 0
    let count = 0
    const from = Math.max(0, i - NEIGHBOURHOOD)
    const to = Math.min(novelty.length - 1, i + NEIGHBOURHOOD)
    for (let j = from; j <= to; j++) {
      sum += novelty[j]
      count++
    }
    const localMean = sum / count
    if (localMean <= 0 || novelty[i] <= localMean * threshold) continue
    const ratio = novelty[i] / localMean
    found.push({
      seconds: i * hopSeconds,
      strength: novelty[i],
      // Threshold maps to 0, three times the local mean maps to 1.
      confidence: Math.max(0, Math.min(1, (ratio - threshold) / (3 - threshold))),
    })
  }

  // Collapse peaks that are too close together, keeping the strongest.
  const kept = []
  for (const onset of found) {
    const last = kept[kept.length - 1]
    if (last && onset.seconds - last.seconds < minSeparation) {
      if (onset.strength > last.strength) kept[kept.length - 1] = onset
      continue
    }
    kept.push(onset)
  }
  return kept
}
