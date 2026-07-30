/**
 * Predominant-melody extraction by harmonic-summation salience.
 *
 * `f0.mjs`'s `trackF0` (YIN) finds *the* periodicity of a signal - the single
 * lag where the waveform best repeats itself. Pointed at a stem holding a
 * hook over pads and stabs there is no single periodicity to find, so YIN
 * locks onto whichever voice's period dominates the window that frame,
 * silently switching voices from frame to frame with no way to tell it did.
 * Measured on two real tracks this lands at chance (see melody.mjs's doc
 * comment for the numbers) - not a threshold problem, a structural one.
 *
 * This module evaluates many candidate pitches independently instead of
 * searching for one. For each frame, a log-spaced grid of candidate
 * fundamentals is scored by summing spectral magnitude at each candidate's
 * harmonics with a decaying weight - a pad and a lead each produce their own
 * peak in that score, rather than only the winner being visible at all. The
 * harder problem - which peak, across the whole track, is the melody - is
 * deliberately kept separate (`selectMelody`) so it can be tuned and tested
 * on its own terms: salience alone answers "what pitches are present and how
 * strong," not "which one a listener would call the tune."
 *
 * Deliberately does *not* build a frame x pitch-grid salience matrix and keep
 * it around. That matrix is exactly the thing the task that commissioned this
 * module warned would "get large fast": at a 30-cent grid over 100-2000 Hz
 * (about 173 candidates) and a hop of 512 samples, a ten-minute stem is
 * ~51,600 frames - 8.9M matrix cells, and every one of those frames also
 * needs its own full magnitude spectrum to build. Instead, each frame's
 * salience curve lives in one reusable scratch buffer, gets reduced to a
 * handful of peaks immediately, and is then discarded before the next frame
 * is computed - the retained state is O(frames x peaksPerFrame), not
 * O(frames x gridSize x binsPerFrame).
 */

import { fft, makeHann } from '../../dsp.mjs'
import { hzToMidi } from './f0.mjs'

/** Candidate fundamentals live on a log-spaced (constant-cents) grid, not a
 *  linear one, because a semitone is a constant *ratio* everywhere in the
 *  range - a linear grid would over-resolve the top octave and under-resolve
 *  the bottom one for the same step count. */
export function buildPitchGrid(minHz, maxHz, centsStep) {
  const totalCents = 1200 * Math.log2(maxHz / minHz)
  const n = Math.max(1, Math.floor(totalCents / centsStep) + 1)
  const grid = new Float64Array(n)
  for (let i = 0; i < n; i++) grid[i] = minHz * 2 ** ((i * centsStep) / 1200)
  return grid
}

/** Linear interpolation between the two FFT bins straddling `freqHz`. Never
 *  rounds to the nearest bin: at 4096 samples/44.1kHz a bin is ~10.8 Hz wide,
 *  which is most of a semitone at 200 Hz, so rounding would make pitch
 *  resolution worse than the ear's own, and worse than it needs to be.
 *
 *  `pos` landing exactly on the last bin (`bins - 1`) is a valid, exact
 *  reading of `mag[bins - 1]` needing no interpolation - it must not be
 *  treated the same as `pos` running past the end of the spectrum entirely.
 *  Only `pos > bins - 1` has nothing on its right to interpolate against. */
function magnitudeAt(mag, binHz, bins, freqHz) {
  const pos = freqHz / binHz
  if (pos < 0 || pos > bins - 1) return 0
  const i0 = Math.floor(pos)
  if (i0 >= bins - 1) return mag[bins - 1]
  const frac = pos - i0
  return mag[i0] * (1 - frac) + mag[i0 + 1] * frac
}

/**
 * Harmonic-summation salience of one candidate fundamental in one frame:
 * `salience(f) = sum_h alpha^(h-1) * mag(h*f)`.
 *
 * Exported on its own (not just inlined into the per-frame loop below)
 * because it is the one formula the whole module depends on being right, and
 * it is cheap to pin down directly against a synthetic spectrum with known
 * harmonics rather than only indirectly through a full frame/contour/track
 * round trip.
 */
export function harmonicSalience(
  mag,
  binHz,
  bins,
  f0,
  { harmonics = DEFAULT_HARMONICS, alpha = DEFAULT_ALPHA, nyquist = Infinity } = {},
) {
  let sum = 0
  let weight = 1
  for (let h = 1; h <= harmonics; h++) {
    const freq = f0 * h
    if (freq >= nyquist) break
    sum += weight * magnitudeAt(mag, binHz, bins, freq)
    weight *= alpha
  }
  return sum
}

/**
 * Parabolic refinement of a local maximum on a curve sampled at a uniform
 * step (here, constant cents). Same idea as `f0.mjs`'s own lag interpolation:
 * three points either side of a discrete peak locate the true peak of the
 * parabola through them far more precisely than the grid step alone.
 */
function refineLocalMax(curve, i, stepCents, originHz) {
  const y0 = curve[i - 1]
  const y1 = curve[i]
  const y2 = curve[i + 1]
  const denom = y0 - 2 * y1 + y2
  const rawOffset = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  const offset = Math.max(-1, Math.min(1, rawOffset))
  const cents = i * stepCents + offset * stepCents
  const salience = y1 - 0.25 * (y0 - y2) * offset
  return { hz: originHz * 2 ** (cents / 1200), salience }
}

/** Local maxima of `curve`, refined and sorted strongest-first, capped at
 *  `maxPeaks`. Keeping several candidates rather than one is the entire
 *  advantage over a monophonic tracker - collapsing to a single winner here
 *  would throw away exactly the information contour tracking needs.
 *
 * Same-frame octave/fifth suppression (discarding a weaker peak that sits at
 * a low integer ratio of a stronger one) was tried and measured out. It
 * fixes a synthetic worst case - a monophonic line alternating between two
 * notes exactly an octave apart, nothing else sounding: without suppression,
 * the ghost that harmonic summation always produces an octave above whichever
 * note is real lands so close to the *other* note's own real pitch that
 * contour tracking bridges straight through the note change, producing one
 * long, wrong contour for the whole clip. But real polyphonic material
 * routinely has a genuine second voice sitting near an octave or a fifth of
 * the loudest one - a bass doubling the chord root, a pad's upper note near
 * the lead's octave - and suppressing it there is not a narrow fix, it is
 * throwing away real candidates. Measured on the reference track it took
 * exact-MIDI agreement from 15.9% to 3.8% and Bicep's "Glue" independent
 * check from 70.1% to 64.9%. Reverted; `melody.mjs`'s doc comment and the
 * report both name the alternating-octave case as a known limitation this
 * module accepts rather than one it silently mishandles. */
function pickFramePeaks(curve, grid, centsStep, maxPeaks) {
  const peaks = []
  const last = curve.length - 1
  for (let i = 0; i <= last; i++) {
    if (curve[i] <= 0) continue
    // A boundary index has only one neighbour to compare against, not two -
    // treat the missing side as "no evidence against it being a peak" rather
    // than excluding index 0 and `last` outright. Without this, the grid's
    // own endpoints (and any grid of length 1 or 2) could never produce a
    // peak at all, silently dropping a true fundamental that happens to sit
    // exactly at `minHz` or `maxHz`.
    const left = i > 0 ? curve[i - 1] : -Infinity
    const right = i < last ? curve[i + 1] : -Infinity
    if (curve[i] <= left || curve[i] < right) continue
    // Parabolic refinement needs a point on both sides; a boundary peak has
    // no far side to fit a parabola through, so it is reported at the grid's
    // own resolution instead of a sub-grid-step estimate.
    peaks.push(i === 0 || i === last ? { hz: grid[i], salience: curve[i] } : refineLocalMax(curve, i, centsStep, grid[0]))
  }
  peaks.sort((a, b) => b.salience - a.salience)
  return peaks.slice(0, maxPeaks)
}

/** Default analysis window. 4096 samples at 44.1kHz is ~93ms - the same
 *  order the rest of this pipeline already uses for pitch (trackF0's own
 *  default) - wide enough to resolve low fundamentals with the grid's cents
 *  spacing once harmonic summation and parabolic refinement are applied, and
 *  the sweep in the report backing this module did not find a smaller window
 *  that scored better on the real corpus. */
const DEFAULT_FFT_SIZE = 4096
const DEFAULT_HOP = 512
/** Salience grid range: above where a sub-bass fundamental would alias
 *  against low harmonics of everything else, below where cymbal/hat wash
 *  dominates and a "fundamental" up there is almost always someone else's
 *  harmonic. */
export const SALIENCE_RANGE = Object.freeze({ minHz: 100, maxHz: 2000 })

/**
 * Defaults below are not guesses - they are the winners of the sweep in the
 * report this module was built for, run against the real reference track's
 * 462-event ground truth (`the-chase-truth.json`'s `gm_tenor_sax`). Swept
 * ranges and the runner-up values are documented there; these four are the
 * ones the sweep was not flat on.
 */
/** Harmonic decay. 0.6-0.7 underweighted real harmonics enough that a
 *  subharmonic ghost (see `harmonicSalience`'s doc comment) occasionally
 *  outscored the true fundamental; 0.95 overfit the sweep's own noise. 0.9
 *  was the stable middle. */
const DEFAULT_ALPHA = 0.9
/** Harmonics summed per candidate. The sweep was flat from 12-24; 20 sits in
 *  the middle of the sketch's own suggested 8-20 range. */
const DEFAULT_HARMONICS = 20
/** Grid resolution in cents. 20 and 25 scored within noise of each other; 25
 *  costs fewer candidates per frame for the same result. */
const DEFAULT_CENTS_STEP = 25
/** Minimum contour length to be a selection candidate at all, in frames -
 *  about 139ms at the default hop, just past a sixteenth note at this
 *  corpus's tempo. This was the single biggest lever in the whole sweep:
 *  raising it from 3 to 12 frames took exact-MIDI agreement on the reference
 *  track from single digits to ~16% by refusing to let brief, unstable
 *  harmonic-summation debris ever compete for a frame in the first place.
 *  Higher (14+) started cutting into real short notes and gave the score
 *  back. */
const DEFAULT_MIN_CONTOUR_FRAMES = 12

/**
 * Reduce one audio buffer to a per-frame list of salience peaks. This is the
 * only place a magnitude spectrum is ever materialised, and it exists for
 * exactly one frame at a time - see the module doc comment.
 */
export function pickSaliencePeaks(
  audio,
  {
    minHz = SALIENCE_RANGE.minHz,
    maxHz = SALIENCE_RANGE.maxHz,
    centsStep = DEFAULT_CENTS_STEP,
    fftSize = DEFAULT_FFT_SIZE,
    hop = DEFAULT_HOP,
    harmonics = DEFAULT_HARMONICS,
    alpha = DEFAULT_ALPHA,
    maxPeaksPerFrame = 5,
    rmsFloor = 0.003,
  } = {},
) {
  const { sampleRate, numFrames, readMono } = audio
  const hopSeconds = hop / sampleRate
  if (numFrames < fftSize) return { hopSeconds, peaksPerFrame: [], frameRms: new Float32Array(0) }

  const grid = buildPitchGrid(minHz, maxHz, centsStep)
  const window = makeHann(fftSize)
  const bins = fftSize / 2
  const binHz = sampleRate / fftSize
  const nyquist = sampleRate / 2
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const mag = new Float32Array(bins)
  const curve = new Float64Array(grid.length)

  const count = Math.floor((numFrames - fftSize) / hop) + 1
  const peaksPerFrame = new Array(count)
  const frameRms = new Float32Array(count)

  for (let index = 0; index < count; index++) {
    const start = index * hop
    let power = 0
    for (let i = 0; i < fftSize; i++) {
      const sample = readMono(start + i)
      power += sample * sample
      re[i] = sample * window[i]
      im[i] = 0
    }
    const rms = Math.sqrt(power / fftSize)
    frameRms[index] = rms
    if (rms < rmsFloor) {
      peaksPerFrame[index] = []
      continue
    }

    fft(re, im)
    for (let bin = 0; bin < bins; bin++) mag[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])

    let total = 0
    for (let g = 0; g < grid.length; g++) {
      const s = harmonicSalience(mag, binHz, bins, grid[g], { harmonics, alpha, nyquist })
      curve[g] = s
      total += s
    }

    const framePeaks = pickFramePeaks(curve, grid, centsStep, maxPeaksPerFrame)
    for (const peak of framePeaks) peak.normSalience = total > 0 ? peak.salience / total : 0
    peaksPerFrame[index] = framePeaks
  }

  return { hopSeconds, peaksPerFrame, frameRms }
}

/**
 * Link per-frame peaks into continuous pitch contours.
 *
 * Greedy nearest-neighbour matching, not a full assignment solver: at up to
 * `maxPeaksPerFrame` candidates per frame and rarely more than a handful of
 * contours alive at once, the cases an optimal matching would resolve
 * differently are noise-level, and this stays linear-ish in practice.
 * Deliberately breaks a contour at any jump bigger than `pitchToleranceCents`
 * rather than trying to follow a melody through its own leaps as one
 * contour - a real hook's individual notes end up as separate (short)
 * contours, same as a pad's individual chord tones would. That is fine:
 * `selectMelody` chooses per-contour, not per-phrase, so a hook is recovered
 * as a sequence of winning contours rather than one giant one.
 */
export function trackContours(peaksPerFrame, { pitchToleranceCents = 60, maxGapFrames = 3 } = {}) {
  const active = []
  const closed = []

  for (let frameIndex = 0; frameIndex < peaksPerFrame.length; frameIndex++) {
    const peaks = peaksPerFrame[frameIndex] ?? []
    const candidates = []
    for (const contour of active) {
      for (let p = 0; p < peaks.length; p++) {
        const cents = Math.abs(1200 * Math.log2(peaks[p].hz / contour.lastHz))
        if (cents <= pitchToleranceCents) candidates.push({ contour, p, cents })
      }
    }
    candidates.sort((a, b) => a.cents - b.cents)

    const usedContours = new Set()
    const usedPeaks = new Set()
    for (const { contour, p } of candidates) {
      if (usedContours.has(contour) || usedPeaks.has(p)) continue
      const peak = peaks[p]
      contour.frames.push({ frameIndex, hz: peak.hz, salience: peak.salience, normSalience: peak.normSalience })
      contour.lastHz = peak.hz
      contour.lastFrame = frameIndex
      usedContours.add(contour)
      usedPeaks.add(p)
    }

    for (let i = active.length - 1; i >= 0; i--) {
      const contour = active[i]
      if (!usedContours.has(contour) && frameIndex - contour.lastFrame > maxGapFrames) {
        closed.push(contour)
        active.splice(i, 1)
      }
    }

    for (let p = 0; p < peaks.length; p++) {
      if (usedPeaks.has(p)) continue
      active.push({ lastHz: peaks[p].hz, lastFrame: frameIndex, frames: [{ frameIndex, ...peaks[p] }] })
    }
  }

  closed.push(...active)
  return closed
}

/** Contours too short to be a note - a stray peak lasting one or two frames -
 *  rather than a sustained pitch. Kept separate from `segmentNotes`' own
 *  `minFrames` gate downstream: that one filters the *selected, merged*
 *  track after melody selection has already happened, and operates on
 *  smoothed/median-filtered data; this one stops debris from ever being a
 *  candidate for selection in the first place, which matters because a
 *  contour's *length* is one of the features selection scores on - a flock
 *  of one-frame noise blips must not be strengthened by treating them as unit
 *  contours competing on equal footing with anything else. */
export function filterContours(contours, minFrames) {
  return contours.filter((contour) => {
    const first = contour.frames[0].frameIndex
    const last = contour.frames[contour.frames.length - 1].frameIndex
    return last - first + 1 >= minFrames
  })
}

function minMax(values) {
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return [min, max]
}

/** Rescale `value` into 0..1 given its observed `[min, max]`. A degenerate
 *  range (every contour tied, or a single contour) has nothing to
 *  discriminate on - returns 1 rather than dividing by zero, so a tie never
 *  looks like the worst possible score on that feature. */
function normalize(value, [min, max]) {
  if (!(max > min)) return 1
  return (value - min) / (max - min)
}

/**
 * Choose, frame by frame, which contour (if any) is the melody.
 *
 * Salience alone answers "which pitch is loudest," which in a stem holding a
 * pad under a hook is frequently the pad - a pad sustains full chords, a lead
 * is one voice. Two further features come from the sketch this module
 * implements: register (a lead usually sits above its accompaniment) and
 * continuity (a hook is a sustained, coherent line; noise and a pad's own
 * wandering top voice are not). All three are combined into one score per
 * contour, contours are ranked by it, and higher-ranked contours claim their
 * frames first - so two overlapping contours (a pad note and a lead note
 * sounding at once) resolve to whichever one actually scores as the melody
 * for the frames they share, not to whichever was found first.
 *
 * Register is measured relative to what else is *sounding at that instant*
 * (the salience-weighted mean pitch of every peak active in the frame, lead
 * or not), not against a fixed frequency - a lead sitting above a bass line
 * an octave down should not need to also out-register a soprano pad to
 * count as "high." Only credited when positive (`Math.max(0, ...)`): being
 * below the room's centre of gravity is not by itself evidence *against* a
 * contour the way being above it is evidence *for* one. Capped at
 * `registerCapOctaves` above that centre: measured directly (see the
 * report), an *uncapped* register term lets a real instrument's own weak,
 * high overtone - itself picked up as a harmonic-summation candidate a
 * fourth or more above the true note, at a fraction of the true note's
 * salience - outscore the true note outright, because raw octaves and raw
 * salience live on unrelated numeric scales and nothing stopped "further
 * above the room" from mattering more than "far louder than everything
 * else." One octave of credit is already enough to separate a lead from
 * its own accompaniment in every case measured; more than that stopped
 * being evidence of melody and started being evidence of exactly that
 * failure mode.
 *
 * Salience and register are rescaled to 0..1 by two *different* methods, not
 * the same one - worth stating precisely, since the two are easy to conflate.
 * `normSalience` has no fixed, interpretable scale (a fraction of one
 * frame's total salience curve, which depends on the grid resolution and how
 * much else is sounding) so it is min-max normalised *against the other
 * contours in this call* - "loudest among the current candidates" is the
 * only meaningful reading available. Register already has a fixed,
 * physically meaningful scale (octaves above the room), so it is rescaled
 * against that fixed `[0, registerCapOctaves]` range instead of the other
 * contours' observed spread - two contours a semitone apart should read as
 * "barely separated," not be stretched to the opposite ends of 0..1 the way
 * a per-call min-max would if they happened to be the only two contours
 * being compared. Both choices exist so `salienceWeight`/`registerWeight`/
 * `lengthWeight` mean roughly the same thing call to call - salience relative
 * to its own local competition, register relative to a fixed, portable
 * notion of "how high above the room."
 */
export function selectMelody(
  contours,
  peaksPerFrame,
  numFrames,
  { salienceWeight = 1, registerWeight = 1, lengthWeight = 1, lengthNormFrames = 20, registerCapOctaves = 1 } = {},
) {
  const referenceLogHz = new Float64Array(numFrames).fill(NaN)
  for (let f = 0; f < numFrames; f++) {
    const peaks = peaksPerFrame[f]
    if (!peaks || !peaks.length) continue
    let weightSum = 0
    let logSum = 0
    for (const peak of peaks) {
      weightSum += peak.salience
      logSum += peak.salience * Math.log2(peak.hz)
    }
    referenceLogHz[f] = weightSum > 0 ? logSum / weightSum : Math.log2(peaks[0].hz)
  }

  const raw = contours.map((contour) => {
    let salienceSum = 0
    let registerSum = 0
    for (const frame of contour.frames) {
      salienceSum += frame.normSalience
      const reference = referenceLogHz[frame.frameIndex]
      registerSum += Number.isFinite(reference) ? Math.log2(frame.hz) - reference : 0
    }
    const n = contour.frames.length
    const meanSalience = salienceSum / n
    const meanRegister = Math.max(0, Math.min(registerCapOctaves, registerSum / n))
    const lengthScore = n / (n + lengthNormFrames)
    return { contour, meanSalience, meanRegister, lengthScore }
  })

  const salienceRange = minMax(raw.map((r) => r.meanSalience))
  const registerRange = [0, registerCapOctaves]

  const scored = raw.map(({ contour, meanSalience, meanRegister, lengthScore }) => {
    const normSalience = normalize(meanSalience, salienceRange)
    const normRegister = normalize(meanRegister, registerRange)
    const score = salienceWeight * normSalience + registerWeight * normRegister + lengthWeight * lengthScore
    return { contour, score }
  })
  scored.sort((a, b) => b.score - a.score)

  const timeline = new Array(numFrames).fill(null)
  for (const { contour, score } of scored) {
    for (const frame of contour.frames) {
      if (timeline[frame.frameIndex] === null) {
        timeline[frame.frameIndex] = { hz: frame.hz, normSalience: frame.normSalience, score }
      }
    }
  }
  return timeline
}

/**
 * The full pipeline: audio in, a `trackF0`-shaped pitch track out, so
 * `segmentNotes`/`foldToLoop` can consume it exactly as they consume a YIN
 * track. `clarity` here is the winning contour's own score, min-max
 * normalised against the loudest contour actually selected anywhere in the
 * track (not a fixed constant), so a whole quiet section does not read as
 * uniformly "unclear" relative to a loud one - what matters downstream is
 * relative confidence within this run, the same thing YIN's clarity already
 * measures.
 */
export function computeMelodyContour(
  audio,
  {
    minHz = SALIENCE_RANGE.minHz,
    maxHz = SALIENCE_RANGE.maxHz,
    centsStep = DEFAULT_CENTS_STEP,
    fftSize = DEFAULT_FFT_SIZE,
    hop = DEFAULT_HOP,
    harmonics = DEFAULT_HARMONICS,
    alpha = DEFAULT_ALPHA,
    maxPeaksPerFrame = 5,
    rmsFloor = 0.003,
    pitchToleranceCents = 60,
    maxGapFrames = 3,
    minContourFrames = DEFAULT_MIN_CONTOUR_FRAMES,
    salienceWeight = 1,
    registerWeight = 1,
    lengthWeight = 1,
    lengthNormFrames = 20,
    registerCapOctaves = 1,
  } = {},
) {
  const { hopSeconds, peaksPerFrame, frameRms } = pickSaliencePeaks(audio, {
    minHz,
    maxHz,
    centsStep,
    fftSize,
    hop,
    harmonics,
    alpha,
    maxPeaksPerFrame,
    rmsFloor,
  })

  const raw = trackContours(peaksPerFrame, { pitchToleranceCents, maxGapFrames })
  const contours = filterContours(raw, minContourFrames)
  const timeline = selectMelody(contours, peaksPerFrame, peaksPerFrame.length, {
    salienceWeight,
    registerWeight,
    lengthWeight,
    lengthNormFrames,
    registerCapOctaves,
  })

  let maxScore = 0
  for (const entry of timeline) if (entry && entry.score > maxScore) maxScore = entry.score

  const frames = new Array(peaksPerFrame.length)
  for (let i = 0; i < peaksPerFrame.length; i++) {
    const entry = timeline[i]
    const seconds = i * hopSeconds
    frames[i] = entry
      ? {
          seconds,
          hz: entry.hz,
          midi: hzToMidi(entry.hz),
          clarity: maxScore > 0 ? Math.max(0, Math.min(1, entry.score / maxScore)) : 0,
          rms: frameRms[i] ?? 0,
          voiced: true,
        }
      : {
          seconds,
          hz: null,
          midi: null,
          clarity: 0,
          rms: frameRms[i] ?? 0,
          voiced: false,
        }
  }

  return { hopSeconds, frames }
}
