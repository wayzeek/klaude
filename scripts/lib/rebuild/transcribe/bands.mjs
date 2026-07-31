/**
 * Spectral flux and energy restricted to a frequency band.
 *
 * `computeNovelty` in dsp.mjs sums flux across the whole spectrum, which makes
 * it an excellent beat detector and a useless drum classifier: a kick and a hat
 * on the same sixteenth are one peak in one curve, and nothing downstream can
 * pull them apart. One curve per band fixes that, at the cost of running the
 * FFT once per band. A hit with energy in two bands appears in both, which is
 * correct - a snare really does have a body and a crack.
 *
 * `bandNovelty`'s self-normalised ratio is the right tool for a band with real
 * texture to compare against itself (a snare's crack, a hat's shimmer), but it
 * is measurably the wrong one for a band that is close to a single decaying
 * resonance, like a kick's: during the decay, the ratio's own denominator (the
 * band's recent magnitude) keeps shrinking, so ordinary jitter left over from
 * the hit keeps clearing the floor for the whole tail. Measured on the-chase's
 * kick band (20-120Hz): 130/130 true steps found, but a kick predicted on 14
 * of every 16 sixteenths, 359 spurious against 130 real. `bandEnergyRise`
 * exists for exactly this case - see its doc comment for the full comparison
 * against unnormalised flux and a raised flux floor.
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
 * `fftSize` is deliberately flat at `ONSET_FFT` for every band, not widened
 * for narrow ones - this was tried and measured off. A narrow band like the
 * kick's (20-120Hz, 2 bins at 1024) does have an unstable raw onset rate: on
 * the-chase's real drum stem it reads 14.39/s against a true ~2.3/s, improving
 * to 13.60/s at 2048 and 10.14/s at 4096. But raw rate is not what downstream
 * consumes - every onset gets quantised to a sixteenth, so what matters is how
 * many *distinct steps per bar* survive, and measured against ground truth
 * (`the-chase-truth.json`'s `bySound.bd`, bars 8-39, plain four-on-the-floor)
 * none of 1024/2048/4096 is remotely usable: all three predict 14-15 of the
 * 16 sixteenths in nearly every bar, because the raw rate is dense enough that
 * quantising to a 108ms-wide step still fills almost every slot. Only 8192
 * (19 bins) brings the raw rate near true, but it also delays every peak by a
 * measured, systematic ~0.15s - more than a full sixteenth at 138 BPM - which
 * quantises onsets to the *wrong* step with full confidence, a worse failure
 * than the current over-triggering. There is no window in this range that
 * both fixes the step-level accuracy and keeps timing honest, so the fix is
 * not a window size at all - it turned out to be the wrong curve, not the
 * wrong resolution. See `bandEnergyRise`.
 */

/** Map each FFT bin to whether it falls inside [lo, hi). */
function bandBins(sampleRate, fftSize, lo, hi) {
  const bins = fftSize / 2
  const binHz = sampleRate / fftSize
  const from = Math.max(1, Math.ceil(lo / binHz))
  const to = Math.min(bins - 1, Math.floor(hi / binHz))
  return { from, to }
}

/**
 * Positive frame-to-frame magnitude change inside one band, normalised by the
 * band's own magnitude.
 *
 * The normalisation matters for the same reason it matters in `computeNovelty`:
 * raw flux scales with loudness, so a quiet hat attack would score below the
 * jitter of a loud sustained bass note. The ratio is near zero for anything
 * steady and large only for a genuine attack, at any level.
 */
export function bandNovelty(audio, { lo, hi, fftSize = ONSET_FFT, hop = ONSET_HOP }) {
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
 *  matters is how loud the hit was rather than how abruptly it started - and
 *  as the input to `bandEnergyRise`, where abruptness is exactly the point. */
export function bandEnergy(audio, { lo, hi, fftSize = ONSET_FFT, hop = ONSET_HOP }) {
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
 * Spectral flatness inside one band, per hop: the geometric mean of the bins'
 * magnitudes divided by their arithmetic mean. Near 0 for energy concentrated
 * in a few bins (a tone and its harmonics), near 1 for energy spread evenly
 * across the whole band (noise).
 *
 * This is a ratio of two means taken over the *same* set of bins, so unlike
 * comparing `bandEnergy` between two differently-sized bands, it carries no
 * bin-count bias to correct for - the geometric and arithmetic mean of N
 * numbers are both already normalised by that same N, so it cancels out of
 * the ratio exactly. That makes it the right tool for a question `bandEnergy`
 * cannot safely answer on its own: not "how loud is this band" but "does this
 * band's content look like this band's own instrument, or like the tail of
 * something tonal bleeding in from next door."
 *
 * Built for exactly that second question. A kick's harmonics land in a few
 * discrete bins of the snare band and read as low flatness there; a real
 * snare or hat's broadband noise spreads across the whole band and reads
 * high. Measured on the-chase: kick bleed coincident with
 * a kick hit in the snare band reads 0.12-0.68 (bars 8-39: confirmed false
 * positives top out at 0.68); a synthetic backbeat snare genuinely coincident
 * with a kick on every hit reads 0.84-0.96. The two do not overlap.
 */
export function bandFlatness(audio, { lo, hi, fftSize = ONSET_FFT, hop = ONSET_HOP }) {
  const { numFrames, sampleRate, readMono } = audio
  if (numFrames < fftSize * 2) return null
  const { from, to } = bandBins(sampleRate, fftSize, lo, hi)
  if (to < from) return null

  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const hops = Math.floor((numFrames - fftSize) / hop) + 1
  const flatness = new Float32Array(hops)
  const width = to - from + 1
  // Keeps log(0) from producing -Infinity in a silent bin without measurably
  // biasing a bin that actually has signal in it.
  const EPSILON = 1e-12

  for (let index = 0; index < hops; index++) {
    const start = index * hop
    for (let i = 0; i < fftSize; i++) {
      re[i] = readMono(start + i) * window[i]
      im[i] = 0
    }
    fft(re, im)
    let logSum = 0
    let sum = 0
    for (let bin = from; bin <= to; bin++) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) + EPSILON
      logSum += Math.log(magnitude)
      sum += magnitude
    }
    const arithmeticMean = sum / width
    flatness[index] = arithmeticMean > 0 ? Math.exp(logSum / width) / arithmeticMean : 0
  }
  return flatness
}

/**
 * Positive frame-to-frame rise in a band's own energy envelope.
 *
 * Where `bandNovelty` normalises flux by the band's own magnitude - wrong for
 * a band close to a single decaying resonance, because the magnitude keeps
 * shrinking through the decay and inflates the ratio right back up - this
 * looks at the absolute envelope instead. A decay, almost by definition, has
 * no positive rise in it; only a genuine attack does. Feed the result straight
 * into `pickBandOnsets`, same as `bandNovelty`'s output.
 *
 * The units here are the band's own absolute magnitude, not a 0-1 ratio, so
 * `pickBandOnsets`'s default `floor` (tuned for the normalised case) does not
 * apply - a caller needs to pass a `floor` measured on their own material.
 * On the-chase's kick band (20-120Hz, fftSize 1024) a floor around 10 took
 * step-level precision from 27% (via `bandNovelty`) to 99%, at a cost of one
 * missed step out of 130. That number is calibrated to this recording's gain
 * staging, not universal; it is not exported as a
 * default because doing so would hide exactly the per-band judgement call
 * this function exists to make explicit.
 */
export function bandEnergyRise(energy) {
  if (!energy) return null
  const rise = new Float32Array(energy.length)
  for (let i = 1; i < energy.length; i++) {
    const delta = energy[i] - energy[i - 1]
    if (delta > 0) rise[i] = delta
  }
  return rise
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
