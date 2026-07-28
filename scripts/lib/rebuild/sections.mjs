/**
 * The song's shape: where sections start, how long they run, and which ones
 * come back.
 *
 * Two things the obvious approach gets wrong.
 *
 * computeNovelty is spectral flux tuned to spike on percussive attacks, which
 * makes it a beat detector. Used for structure it follows the drums and misses
 * any boundary expressed through harmony or instrumentation. So boundaries come
 * from a self-similarity matrix over beat-synchronous features instead, with
 * Foote's checkerboard kernel run down the diagonal.
 *
 * And repeats cannot be matched on band energy alone: two sections with the
 * same instrumentation and different chords look identical in six broad bands.
 * A false match is severe here, because a repeated section is transcribed once
 * and reused, so a wrong match writes definitively wrong notes into the clone.
 * Matching therefore uses chroma alongside bands, and an unconfident match
 * transcribes separately rather than reusing.
 *
 * A third thing, found by measuring against real recordings rather than
 * designed up front: centroid similarity alone cannot rule out matching a
 * short section against a much longer one. Averaging over a long section
 * smooths out whatever would distinguish it, so a short, harmonically
 * simple passage routinely scores above 0.95 against a long passage that
 * happens to spend most of its length on the same chord - see
 * `matchRepeats`'s length-ratio gate for the measured numbers. A repeat that
 * cannot be reused at the length it was found - because the two sections
 * are not even the same duration - is not a repeat.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { CHROMA_FFT, fft, makeHann } from '../dsp.mjs'

const BANDS_HZ = [
  [20, 60],
  [60, 150],
  [150, 400],
  [400, 2000],
  [2000, 6000],
  [6000, 16000],
]

const CHROMA_MIN_HZ = 80
const CHROMA_MAX_HZ = 2000

/** One 18-value vector per beat: 12 chroma, then 6 band energies. */
export function beatFeatures(audio, grid) {
  const { sampleRate, numFrames, channels, readSample } = audio
  const window = makeHann(CHROMA_FFT)
  const re = new Float32Array(CHROMA_FFT)
  const im = new Float32Array(CHROMA_FFT)
  const bins = CHROMA_FFT / 2
  const binHz = sampleRate / CHROMA_FFT

  const binPitchClass = new Int8Array(bins).fill(-1)
  const binBand = new Int8Array(bins).fill(-1)
  for (let bin = 1; bin < bins; bin++) {
    const hz = bin * binHz
    if (hz >= CHROMA_MIN_HZ && hz <= CHROMA_MAX_HZ) {
      const midi = 69 + 12 * Math.log2(hz / 440)
      binPitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12
    }
    for (let b = 0; b < BANDS_HZ.length; b++) {
      if (hz >= BANDS_HZ[b][0] && hz < BANDS_HZ[b][1]) {
        binBand[bin] = b
        break
      }
    }
  }

  const times = []
  const vectors = []
  // Beat index only ever increases from 0, and every grid this module is
  // handed places its downbeat at or after zero, so `start` is never
  // negative in practice. The loop still stops on the one condition that
  // matters: the full analysis window must fit inside the buffer. A window
  // that ran past the end would zero-pad, manufacturing a spurious quiet
  // reading for the last beat instead of just not measuring it - the same
  // shape of bug the grid's own beat-energy pass had before it was fixed to
  // require the whole window to fit, not just its start.
  for (let beat = 0; ; beat++) {
    const start = Math.round(grid.beatAt(beat) * sampleRate)
    if (start + CHROMA_FFT > numFrames) break

    for (let i = 0; i < CHROMA_FFT; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
      re[i] = (sum / channels) * window[i]
      im[i] = 0
    }
    fft(re, im)

    const vector = new Float32Array(18)
    for (let bin = 1; bin < bins; bin++) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      const pitchClass = binPitchClass[bin]
      if (pitchClass >= 0) vector[pitchClass] += magnitude
      const band = binBand[bin]
      if (band >= 0) vector[12 + band] += magnitude
    }

    // Normalise chroma and bands separately, so a loud section does not simply
    // dominate the harmony half of the vector.
    normaliseSlice(vector, 0, 12)
    normaliseSlice(vector, 12, 18)

    times.push(grid.beatAt(beat))
    vectors.push(vector)
  }

  return { times, vectors }
}

function normaliseSlice(vector, from, to) {
  let sum = 0
  for (let i = from; i < to; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return
  for (let i = from; i < to; i++) vector[i] /= norm
}

export function similarityMatrix(vectors) {
  const n = vectors.length
  const matrix = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0
      for (let k = 0; k < vectors[i].length; k++) dot += vectors[i][k] * vectors[j][k]
      matrix[i * n + j] = dot
      matrix[j * n + i] = dot
    }
  }
  return matrix
}

/**
 * Foote's checkerboard novelty.
 *
 * Slide a kernel down the diagonal that rewards self-similarity within each
 * half and penalises similarity across the middle. It peaks exactly where the
 * material stops being like itself and starts being like something else, which
 * is what a section boundary is.
 */
export function structuralNovelty(matrix, n, kernelSize) {
  const half = Math.max(1, Math.floor(kernelSize / 2))
  const novelty = new Float32Array(n)
  for (let centre = half; centre < n - half; centre++) {
    let score = 0
    for (let i = -half; i < half; i++) {
      for (let j = -half; j < half; j++) {
        const row = centre + i
        const col = centre + j
        const sign = (i < 0) === (j < 0) ? 1 : -1
        score += sign * matrix[row * n + col]
      }
    }
    novelty[centre] = score
  }
  return novelty
}

/**
 * How far below (or above) the novelty curve's mean a peak is allowed to sit
 * and still count as a boundary, in standard deviations.
 *
 * A missed boundary and a spurious one are not equally costly downstream.
 * Each section becomes exactly one transcribed loop. Miss a boundary and two
 * genuinely different sections get merged into one: that single transcription
 * is drawn from a non-representative sample of heterogeneous material, and
 * roughly half the merged section then plays wrong notes - not recoverable
 * without re-detecting the split. Add a spurious boundary and homogeneous
 * material just gets cut in two: both halves transcribe to the same content,
 * and `matchRepeats`'s length-ratio gate (both halves are close to the same
 * length) tends to catch the second as a repeat of the first for free. Cost:
 * some redundant work. The music is still right either way. That asymmetry
 * means the threshold should lean toward catching more boundaries, not fewer.
 *
 * Measured against `the-chase` (ground truth from its saved `arrange()`
 * source, 16 interior boundaries, matched within 1 bar): the default of 1.0
 * (a full standard deviation above the mean) catches 4 of them, all correct
 * (precision 1.00, recall 0.25) - badly under-sensitive. Lowering the
 * multiplier trades threshold height for recall at no precision cost for a
 * while: 0.0 reaches 8/16 (recall 0.50, still precision 1.00), and -0.2
 * reaches 11/16 (recall 0.69, still precision 1.00). That is where it stops
 * being free: pushing to -0.25 gains nothing further on `the-chase` (still
 * 11/16) while nearly tripling the boundary count on a second recording
 * (blackout goes from 12 to 36 boundaries at that exact step) - a cliff, not
 * a trend, and a sign of fitting one file's noise floor rather than finding
 * a real boundary. -0.2 is the most sensitive setting that still shows a
 * measured gain on the one file this module has ground truth for.
 */
const DEFAULT_THRESHOLD_MULTIPLIER = -0.2

export function findBoundaries(novelty, { minBeats, thresholdMultiplier = DEFAULT_THRESHOLD_MULTIPLIER }) {
  let mean = 0
  let count = 0
  for (const value of novelty) {
    if (value !== 0) {
      mean += value
      count++
    }
  }
  mean = count ? mean / count : 0

  let variance = 0
  for (const value of novelty) if (value !== 0) variance += (value - mean) ** 2
  const stdDev = count ? Math.sqrt(variance / count) : 0
  const threshold = mean + thresholdMultiplier * stdDev

  const peaks = []
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] < threshold) continue
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    if (peaks.length && i - peaks[peaks.length - 1] < minBeats) {
      // Keep whichever of the two is stronger rather than the earlier one.
      if (novelty[i] > novelty[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i
      continue
    }
    peaks.push(i)
  }
  return peaks
}

/**
 * How close two sections' bar counts must be, as a ratio of the shorter to
 * the longer, before their centroids are even compared.
 *
 * Measured against the three real recordings this module has: centroid
 * cosine similarity alone routinely scores well above 0.9 for section pairs
 * whose lengths differ by 2-4x (a 6-bar section against a 19-bar one at
 * 0.9723; a 7-bar section against a 14-bar one at 0.9812; a 17-bar section
 * against a 40-bar one at 0.9710) - averaging over a long section smooths
 * out the very content that would tell two sections apart, so a short,
 * mostly-one-chord passage reads as extremely similar to a long passage that
 * happens to spend most of its length on that chord. A "repeat" is only a
 * meaningful signal if it can actually be reused - transcribing a 6-bar
 * section as a copy of 19 bars of something else is not applicable, whatever
 * the centroid says. Length has no vote in the similarity score itself
 * (a genuinely identical repeat can be snapped a bar or two longer or
 * shorter than its original by boundary quantisation), so it is enforced as
 * a hard gate before scoring instead: candidates outside the ratio are never
 * considered, regardless of how high their score would have been.
 *
 * 0.8 sits in the gap this data actually shows: every pair that should match
 * lands at 0.89 or above (the two true-looking repeats found across all
 * three recordings), and every pair that should not match tops out at 0.71
 * (a 17-bar section against a 24-bar one, itself scoring an alarming
 * 0.9839) - an 0.18 margin either side of 0.8.
 */
const DEFAULT_MIN_LENGTH_RATIO = 0.8

export function matchRepeats(sections, vectors, { threshold, minLengthRatio = DEFAULT_MIN_LENGTH_RATIO }) {
  const centroids = sections.map((section) => {
    const centroid = new Float32Array(18)
    let n = 0
    for (let beat = section.startBeat; beat < section.endBeat && beat < vectors.length; beat++) {
      for (let k = 0; k < 18; k++) centroid[k] += vectors[beat][k]
      n++
    }
    if (n) for (let k = 0; k < 18; k++) centroid[k] /= n
    normaliseSlice(centroid, 0, 12)
    normaliseSlice(centroid, 12, 18)
    return centroid
  })

  const lengthOf = (section) => section.endBeat - section.startBeat

  for (let i = 1; i < sections.length; i++) {
    let bestIndex = null
    let bestScore = 0
    for (let j = 0; j < i; j++) {
      const shorter = Math.min(lengthOf(sections[i]), lengthOf(sections[j]))
      const longer = Math.max(lengthOf(sections[i]), lengthOf(sections[j]))
      if (longer === 0 || shorter / longer < minLengthRatio) continue

      // Chroma similarity and band similarity computed separately, then
      // combined. Both have to agree: same instrumentation with different
      // chords must not read as a repeat.
      let chroma = 0
      for (let k = 0; k < 12; k++) chroma += centroids[i][k] * centroids[j][k]
      let bands = 0
      for (let k = 12; k < 18; k++) bands += centroids[i][k] * centroids[j][k]
      const score = Math.min(chroma, bands)
      if (score > bestScore) {
        bestScore = score
        bestIndex = j
      }
    }
    sections[i].sameAs = bestScore >= threshold ? bestIndex : null
    sections[i].confidence = bestScore
  }
}

export function findSections(
  wavBuf,
  grid,
  {
    minBars = 4,
    repeatThreshold = 0.9,
    minLengthRatio = DEFAULT_MIN_LENGTH_RATIO,
    thresholdMultiplier = DEFAULT_THRESHOLD_MULTIPLIER,
  } = {},
) {
  const audio = decodeWav(wavBuf)
  const { vectors } = beatFeatures(audio, grid)
  const n = vectors.length
  if (n < grid.beatsPerBar * minBars * 2) {
    // Too short to have structure. One section is the honest answer.
    return [
      {
        index: 0,
        startSec: 0,
        endSec: audio.duration,
        startBar: 0,
        bars: Math.max(1, Math.round(grid.secondsToBars(audio.duration))),
        energy: 1,
        label: 'full',
        sameAs: null,
        confidence: 0,
      },
    ]
  }

  const matrix = similarityMatrix(vectors)
  const kernel = grid.beatsPerBar * 4
  const novelty = structuralNovelty(matrix, n, kernel)
  const peaks = findBoundaries(novelty, { minBeats: grid.beatsPerBar * minBars, thresholdMultiplier })

  // Snap every boundary to a bar line, then drop duplicates the snap created.
  const beatsPerBar = grid.beatsPerBar
  const snapped = [...new Set([0, ...peaks.map((beat) => Math.round(beat / beatsPerBar) * beatsPerBar), n])]
    .filter((beat) => beat >= 0 && beat <= n)
    .sort((a, b) => a - b)

  const sections = []
  for (let i = 0; i < snapped.length - 1; i++) {
    const startBeat = snapped[i]
    const endBeat = snapped[i + 1]
    if (endBeat - startBeat < beatsPerBar) continue

    let energy = 0
    let count = 0
    for (let beat = startBeat; beat < endBeat && beat < n; beat++) {
      for (let k = 12; k < 18; k++) energy += vectors[beat][k]
      count++
    }

    sections.push({
      index: sections.length,
      startBeat,
      endBeat,
      startSec: grid.beatAt(startBeat),
      endSec: grid.beatAt(endBeat),
      startBar: Math.round(startBeat / beatsPerBar),
      bars: Math.round((endBeat - startBeat) / beatsPerBar),
      energy: count ? energy / count : 0,
      label: null,
      sameAs: null,
      confidence: 0,
    })
  }

  // Relative energy labels. Musical names are deliberately not attempted:
  // boundaries matter more than calling something a chorus.
  const energies = sections.map((section) => section.energy).sort((a, b) => a - b)
  const low = energies[Math.floor(energies.length * 0.33)] ?? 0
  const high = energies[Math.floor(energies.length * 0.66)] ?? 0
  for (const section of sections) {
    section.label = section.energy <= low ? 'low' : section.energy >= high ? 'high' : 'mid'
  }

  matchRepeats(sections, vectors, { threshold: repeatThreshold, minLengthRatio })
  return sections
}
