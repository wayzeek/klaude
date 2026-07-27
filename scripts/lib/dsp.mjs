/**
 * DSP primitives: FFT, windowing, onset novelty, tempo, chroma, and key.
 *
 * Lifted out of analyze.mjs so the rebuild pipeline can reuse it. The math is
 * unchanged: same constants, same thresholds, same known tempo-octave quirk.
 */

export function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vRe = re[b] * curRe - im[b] * curIm
        const vIm = re[b] * curIm + im[b] * curRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

const hannCache = new Map()

/** Hann window of length n, built once per size. */
export function makeHann(n) {
  let window = hannCache.get(n)
  if (window) return window
  window = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  }
  hannCache.set(n, window)
  return window
}

export const toDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity)
export const fmtDb = (db) => (db === -Infinity || db === null || Number.isNaN(db) ? '-inf' : db.toFixed(1))

export const ONSET_FFT = 1024
export const ONSET_HOP = 512
export const CHROMA_FFT = 4096
export const CHROMA_HOP = 2048
const MIN_BPM = 60
const MAX_BPM = 200
/** Peak must exceed its neighbourhood mean by this factor to count as a hit. */
const ONSET_THRESHOLD = 1.4
/** Half-window, in hops, for the adaptive onset threshold (~90ms each side). */
const ONSET_NEIGHBOURHOOD = 8

/**
 * Spectral flux novelty curve: how much the spectrum brightened at each hop.
 *
 * Percussive attacks add energy across many bins at once, so summing only the
 * positive frame-to-frame magnitude changes gives a curve that spikes on hits
 * and ignores sustained tones.
 */
export function computeNovelty(readSample, numFrames, channels) {
  if (numFrames < ONSET_FFT * 2) return null
  const window = makeHann(ONSET_FFT)
  const re = new Float32Array(ONSET_FFT)
  const im = new Float32Array(ONSET_FFT)
  const bins = ONSET_FFT / 2
  const hops = Math.floor((numFrames - ONSET_FFT) / ONSET_HOP) + 1
  const novelty = new Float32Array(hops)
  let previous = null
  let current = new Float32Array(bins)

  for (let hop = 0; hop < hops; hop++) {
    const start = hop * ONSET_HOP
    for (let i = 0; i < ONSET_FFT; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
      re[i] = (sum / channels) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      current[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }
    if (previous) {
      let flux = 0
      let magnitude = 0
      for (let bin = 1; bin < bins; bin++) {
        const delta = current[bin] - previous[bin]
        if (delta > 0) flux += delta
        magnitude += current[bin]
      }
      // Normalise by the frame's own magnitude. Raw flux scales with loudness,
      // so a quiet attack would score below the numerical jitter of a loud
      // steady tone; the ratio is near zero for anything sustained and large
      // only for a genuine attack, whatever the level.
      novelty[hop] = magnitude > 0 ? flux / magnitude : 0
    }
    // Swap the buffers rather than reallocating each hop.
    const swap = previous ?? new Float32Array(bins)
    previous = current
    current = swap
  }
  return novelty
}

/**
 * Local peaks that stand clear of their surroundings, in seconds.
 *
 * The adaptive threshold alone is not enough: on sustained material the local
 * mean approaches zero and ordinary numerical jitter clears it, so a steady
 * drone reports a stream of imaginary hits. The absolute floor on normalised
 * flux is what makes "nothing is articulating" measurable.
 */
const ONSET_FLOOR = 0.045

export function pickOnsets(novelty, hopSeconds) {
  const onsets = []
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    if (novelty[i] < ONSET_FLOOR) continue
    let sum = 0
    let count = 0
    const from = Math.max(0, i - ONSET_NEIGHBOURHOOD)
    const to = Math.min(novelty.length - 1, i + ONSET_NEIGHBOURHOOD)
    for (let j = from; j <= to; j++) {
      sum += novelty[j]
      count++
    }
    const localMean = sum / count
    if (localMean > 0 && novelty[i] > localMean * ONSET_THRESHOLD) onsets.push(i * hopSeconds)
  }
  return onsets
}

/**
 * Tempo from the novelty curve's self-similarity.
 *
 * Autocorrelation peaks at the beat period. Which multiple of the beat wins is
 * arbitrary (a four-on-the-floor kick correlates just as well at the bar), so
 * the result is folded into a musically plausible range at the end.
 */
export function estimateTempo(novelty, hopSeconds) {
  if (!novelty || novelty.length < 16) return null
  let mean = 0
  for (const value of novelty) mean += value
  mean /= novelty.length
  const centred = Float32Array.from(novelty, (value) => value - mean)

  const minLag = Math.max(1, Math.round(60 / (MAX_BPM * hopSeconds)))
  const maxLag = Math.min(centred.length - 1, Math.round(60 / (MIN_BPM * hopSeconds)))
  if (maxLag <= minLag) return null

  let bestLag = -1
  let bestScore = 0
  let scoreSum = 0
  let scoreCount = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag]
    const score = sum / (centred.length - lag)
    scoreSum += Math.abs(score)
    scoreCount++
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestScore <= 0) return null

  let bpm = 60 / (bestLag * hopSeconds)
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2

  const averageScore = scoreCount ? scoreSum / scoreCount : 0
  const confidence = averageScore > 0 ? Math.min(1, bestScore / (averageScore * 4)) : 0
  return { bpm, confidence }
}

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/**
 * Krumhansl-Kessler key profiles: how strongly each scale degree is expected to
 * sound in a major and a minor key. Correlating a measured chroma against all
 * 24 rotations is the standard way to name a key from audio.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** Restrict chroma to where pitch actually lives; kicks and hiss only blur it. */
const CHROMA_MIN_HZ = 80
const CHROMA_MAX_HZ = 2000

/** Energy per pitch class, summed over the whole clip. */
export function computeChroma(readSample, numFrames, channels, sampleRate) {
  if (numFrames < CHROMA_FFT * 2) return null
  const window = makeHann(CHROMA_FFT)
  const re = new Float32Array(CHROMA_FFT)
  const im = new Float32Array(CHROMA_FFT)
  const bins = CHROMA_FFT / 2
  const binHz = sampleRate / CHROMA_FFT

  // Precompute each bin's pitch class once.
  const binPitchClass = new Int8Array(bins).fill(-1)
  for (let bin = 1; bin < bins; bin++) {
    const hz = bin * binHz
    if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue
    const midi = 69 + 12 * Math.log2(hz / 440)
    binPitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12
  }

  const chroma = new Array(12).fill(0)
  const hops = Math.floor((numFrames - CHROMA_FFT) / CHROMA_HOP) + 1
  for (let hop = 0; hop < hops; hop++) {
    const start = hop * CHROMA_HOP
    for (let i = 0; i < CHROMA_FFT; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
      re[i] = (sum / channels) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      const pitchClass = binPitchClass[bin]
      if (pitchClass < 0) continue
      chroma[pitchClass] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0)
  return total > 0 ? chroma.map((value) => value / total) : null
}

function correlate(a, b) {
  const meanA = a.reduce((x, y) => x + y, 0) / a.length
  const meanB = b.reduce((x, y) => x + y, 0) / b.length
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > 0 ? num / den : 0
}

/** Best-matching key, plus the runner-up so ambiguity is visible. */
export function detectKey(chroma) {
  if (!chroma) return null
  const scored = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12])
    scored.push({ name: `${PITCH_NAMES[tonic]} major`, score: correlate(rotated, MAJOR_PROFILE) })
    scored.push({ name: `${PITCH_NAMES[tonic]} minor`, score: correlate(rotated, MINOR_PROFILE) })
  }
  scored.sort((a, b) => b.score - a.score)
  return { best: scored[0], runnerUp: scored[1], chroma }
}

/** Normalise "F minor", "Fm", "f:minor" to one comparable form. */
export function normalizeKeyName(text) {
  if (!text) return null
  const match = String(text)
    .trim()
    .match(/^([A-Ga-g])\s*([b#]?)\s*[:\s-]*\s*(maj|major|min|minor|m)?/i)
  if (!match) return null
  const [, letter, accidental, quality] = match
  const mode = quality && /^m(in)?/i.test(quality) && quality.toLowerCase() !== 'maj' ? 'minor' : 'major'
  return `${letter.toUpperCase()}${accidental === '#' ? '#' : accidental === 'b' ? 'b' : ''} ${mode}`
}

/** Enharmonic spellings so "D#" and "Eb" compare equal. */
const ENHARMONIC = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' }

const PITCH_INDEX = (() => {
  const index = new Map()
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
  names.forEach((name, i) => index.set(name, i))
  flats.forEach((name, i) => index.set(name, i))
  return index
})()

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]

/** The seven pitch classes of a key like "F minor". */
function scaleOf(key) {
  const [note, mode] = key.split(' ')
  const tonic = PITCH_INDEX.get(ENHARMONIC[note] ?? note)
  if (tonic === undefined) return null
  const steps = mode === 'minor' ? MINOR_STEPS : MAJOR_STEPS
  return new Set(steps.map((step) => (tonic + step) % 12))
}

/**
 * Are two key names close enough that the audio cannot tell them apart?
 *
 * Key detection finds the pitch content reliably but not which of its notes is
 * home. A relative major and minor (C major, A minor) are the same seven pitch
 * classes, so nothing spectral can separate them. Neighbours a fifth apart
 * (C major, G major) differ by one note, as do F minor and C minor, and a
 * detector fed a bass note plus its own fifth harmonic routinely prefers the
 * neighbour over the tonic.
 *
 * No threshold can flag one of those without flagging all of them, so the line
 * is drawn well past them: a mismatch is reported only when the note sets
 * genuinely diverge. Crying wolf on a correct track would cost more than
 * missing a subtle error, because a check nobody trusts gets ignored, and the
 * faults this exists to catch are named exactly by scripts/check.mjs anyway.
 */
const KEY_MIN_SHARED_NOTES = 5

export function keysMatch(a, b) {
  if (!a || !b) return false
  const canonical = (key) => {
    const [note, mode] = key.split(' ')
    return `${ENHARMONIC[note] ?? note} ${mode}`
  }
  if (canonical(a) === canonical(b)) return true
  const scaleA = scaleOf(a)
  const scaleB = scaleOf(b)
  if (!scaleA || !scaleB) return false
  let shared = 0
  for (const pitchClass of scaleA) if (scaleB.has(pitchClass)) shared++
  return shared >= KEY_MIN_SHARED_NOTES
}
