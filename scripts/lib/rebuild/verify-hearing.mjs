/**
 * Did we hear it right?
 *
 * Comparing emitted code against the transcription only proves the emitter did
 * its job. If the transcriber hears C sharp where the record plays C, the
 * emitted C sharp matches the transcription perfectly and scores clean. A
 * self-consistency check is not an accuracy check, and for a clone the
 * transcription is exactly where accuracy matters.
 *
 * So: synthesize the transcription (Task 10), and compare that synthesis to the
 * stem it was derived from. Chroma for the pitched layers, onset agreement for
 * the drums. Pure math over buffers, no Strudel and no browser, which is what
 * makes this genuinely free.
 *
 * What this cannot do: the comparison is always against the stem in the role's
 * own frequency band, so content that genuinely sits in that band but belongs
 * to a different instrument scores as a match. This catches a wrong note (or a
 * wrong hit position) against the right source; it cannot catch a right-sounding
 * part transcribed from the wrong source entirely. Snare is a deliberate
 * example, not an exception: it legitimately absorbs rim and stick content
 * living in its band (see drums.mjs), and scoring well against that is correct,
 * not a false pass.
 *
 * It can tell you a layer is wrong. It cannot fix one: the remedy is to retry
 * with different parameters, then omit.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { CHROMA_FFT, ONSET_HOP, fft, makeHann } from '../dsp.mjs'
import { bandEnergy, bandEnergyRise, bandNovelty, pickBandOnsets } from './transcribe/bands.mjs'
import { DRUM_ROLES } from './transcribe/drums.mjs'
import { beatChroma } from './transcribe/harmony.mjs'
import { LAYERS, gridFromJson, sectionRange } from './transcribe/quantize.mjs'
import { RESYNTH_SAMPLE_RATE, renderSection } from './resynth.mjs'

/**
 * Recalibrated 2026-07-29, replacing a same-day calibration that shipped from
 * the wrong measurement. That first pass set every threshold at half of Task
 * 11's *self-consistency* ceiling - a transcription scored against a
 * synthesis of itself, so nothing in the fixture can be wrong. That number
 * says how consistent the check is with itself; it says nothing about what a
 * correct transcription scores against a *real* stem, which is the only
 * measurement a real threshold can be based on. The gap was not small: on
 * the-chase, a 95%-accurate real kick transcription (288/302 true onsets,
 * ground truth) scored 0.000-0.035 against the real drums stem under the
 * self-consistency-calibrated method, so kick and snare were dropped from
 * effectively every section regardless of how well they were transcribed.
 * `pnpm run rebuild` on the-chase went from 44 layers before the drop to 10
 * after it.
 *
 * Two things changed:
 *
 * 1. Drum scoring (kick/snare/hats) moved from correlating the role's raw
 *    detection curve to `onsetAgreement`'s tolerance-matched onset F1 - see
 *    that function's comment for why the curve correlation could not work.
 *    Bass and chords are untouched: both already score in a sensible range
 *    against real stems (chords measured 0.87-0.90 in several the-chase
 *    sections), so the fix is scoped to the mechanism that was actually
 *    broken.
 *
 * 2. Every threshold is now set from a *known-good transcription scored
 *    against its real stem*, not a synthetic ceiling. For kick/snare/hats
 *    "known good" means a loop built directly from the-chase's ground-truth
 *    event list (`scripts/lib/rebuild/__fixtures__/the-chase-truth.json`),
 *    not the transcriber's own output - transcribeDrums's own snare recall
 *    against ground truth is only ~43%, so its output cannot serve as "known
 *    good" the way its kick output (95%) can. Bass and chords keep their
 *    already-existing real-stem scores (the actual transcribed output,
 *    independently confirmed accurate for bass via ground truth - 130/130
 *    pitch-class and exact-MIDI - and taken on inspection for chords).
 *
 * Measured real-stem ceiling (mean of per-section scores across every
 * the-chase section with true content; median for chords, to avoid a few
 * sections with unverified chord accuracy dragging the average down):
 *   kick 0.805 (8 sections)   snare 0.637 (9 sections)   hats 0.774 (7 sections)
 *   bass 0.322 (8 sections)   chords 0.758 (10 sections)
 *
 * For kick/snare/hats the threshold is *not* half of this ceiling - proven
 * necessary, not assumed: corrupting the same known-good loop (shifted a
 * step, half its hits dropped, replaced with an unrelated fixed pattern) and
 * rescoring against the real stem shows half-of-ceiling would still pass the
 * worst corruption for every drum role (e.g. kick's dropped-half corruption
 * still averages 0.605, well above half of 0.805). Each drum threshold is
 * instead the midpoint between the correct mean and the *worst discriminable*
 * corruption's mean - the highest threshold that still passes every measured
 * correct section:
 *   kick:  correct 0.805, worst corruption (drop-half) 0.605 -> exact midpoint 0.705, rounded
 *          down to 0.70 (not up to 0.71): the-chase's own section 6 kick scores
 *          0.7089, a correct section that 0.71 would have dropped by one
 *          thousandth - rounding toward "more likely right than wrong" costs
 *          nothing against the corruption gap (still far above 0.605) and
 *          keeps a real, measured, correct section
 *   snare: correct 0.637, worst corruption (drop-half) 0.344 -> 0.49
 *   hats:  correct 0.774, worst *discriminable* corruption (replace) 0.244 -> 0.51
 * Bass and chords keep the original half-of-ceiling rule, since their
 * mechanism wasn't touched: bass 0.322/2 -> 0.16, chords 0.758/2 -> 0.38.
 *
 * `lead` has no entry: that transcriber is disabled (see melody.mjs) and
 * never reaches this check.
 *
 * Honest limits, not smoothed over:
 * - hats cannot be made to discriminate "half the hits dropped" on real
 *   audio - every method tried (current correlation, raw energy, smoothed
 *   rise, onset F1) scores a hats loop missing half its true hits within
 *   0.01-0.03 of the correct score, because hi-hats in this recording carry
 *   enough continuous high-band energy that a depleted onset set still lands
 *   close to real onsets. `HEARING_THRESHOLDS.hats` catches a shifted or
 *   wrong pattern but not a thinned-out one. Lowering the threshold further
 *   would not fix this - the scores are already this close together - so it
 *   is left as a measured, disclosed gap.
 * - Kick's "replace with an unrelated pattern" test needed a pattern that
 *   does not resemble any other the-chase section's real kick, because the
 *   first attempt (borrow another section's true pattern) undersold the
 *   corruption: the-chase's kick is a four-on-the-floor variant almost
 *   everywhere, so two real sections' patterns are often too similar for
 *   swapping them to be a meaningful wrong answer. Swapping is still
 *   measured (kick correct 0.805 vs swap 0.596, some individual sections
 *   overlapping) and reported for transparency, but the fixed fixed-pattern
 *   corruption (kick correct 0.805 vs replace 0.161) is what set the
 *   threshold.
 * - Even the chosen threshold does not perfectly separate correct from
 *   corrupted at the individual-section level (e.g. one section's dropped-
 *   half kick scores 0.815, above another section's correct score of 0.730);
 *   it separates the *means* with a real margin. A single scalar threshold
 *   over noisy real audio cannot do better than that without also rejecting
 *   some correct sections, which is the trade this plan avoids on purpose.
 *
 * These numbers rest on one real track (the-chase, the only recording with
 * exact ground truth) - the same n=1 limitation the beat grid carries.
 */
export const HEARING_THRESHOLDS = {
  kick: 0.7,
  snare: 0.49,
  hats: 0.51,
  bass: 0.16,
  chords: 0.38,
}

/** How much of a pitched layer's score its octave can cost. At 0.7 an octave
 *  error caps the layer near 0.7 of its harmonic (chroma) score, enough to push
 *  a borderline layer under threshold without failing a merely bright one. */
export const REGISTER_WEIGHT = 0.7

/** Which stem each layer was derived from. */
const LAYER_STEM = {
  kick: 'drums',
  snare: 'drums',
  hats: 'drums',
  bass: 'bass',
  chords: 'other',
  lead: 'other',
}

/** A mono slice of a decoded stem, resampled by nearest neighbour if its rate
 *  differs from the resynth rate. Stems come from ffmpeg at 44100, so the
 *  resample is a no-op in practice and exists so a mismatch is silent-safe
 *  rather than silently wrong. */
export function sliceAudio(audio, fromSec, toSec, sampleRate = RESYNTH_SAMPLE_RATE) {
  const frames = Math.max(0, Math.round((toSec - fromSec) * sampleRate))
  const out = new Float32Array(frames)
  const ratio = audio.sampleRate / sampleRate
  const base = fromSec * audio.sampleRate
  for (let i = 0; i < frames; i++) {
    const frame = Math.round(base + i * ratio)
    if (frame < 0 || frame >= audio.numFrames) continue
    out[i] = audio.readMono(frame)
  }
  return out
}

/** Wrap a Float32Array as something `beatChroma` and the band helpers can read. */
function asAudio(samples, sampleRate = RESYNTH_SAMPLE_RATE) {
  return {
    channels: 1,
    sampleRate,
    numFrames: samples.length,
    duration: samples.length / sampleRate,
    float32: true,
    readSample: (frame) => samples[frame] ?? 0,
    readMono: (frame) => samples[frame] ?? 0,
  }
}

/**
 * A role's own detection curve: `bandEnergyRise` needs `bandEnergy` computed
 * first, `bandNovelty` (flux) stands alone. Mirrors the dispatch in drums.mjs's
 * own (unexported) `DETECTORS` map - duplicated rather than imported because
 * that map is private to the transcriber, but the rule it encodes ("each role
 * names its own detector, no hardcoded default") is exactly what the hearing
 * check has to honour too. Using flux for every role, the way a first draft of
 * this function did, over-triggers the kick band specifically: its decaying
 * tone thins out, flux's self-normalised denominator shrinks with it, and
 * ordinary jitter clears the floor for the whole tail (see bands.mjs).
 */
function detectorCurve(samples, role) {
  const audio = asAudio(samples)
  return role.detector === 'energyRise' ? bandEnergyRise(bandEnergy(audio, role)) : bandNovelty(audio, role)
}

/**
 * Where the role's own detection curve peaks - the same onset picker
 * `detectDrumHits` uses for real transcription, applied here to a rendered
 * buffer instead. `hopSeconds` has to be computed from `ONSET_HOP`, not
 * assumed, because `bandEnergy`/`bandEnergyRise` sample at that hop spacing
 * regardless of what sample rate the caller passed in.
 */
function detectorOnsets(samples, role, sampleRate) {
  const curve = detectorCurve(samples, role)
  return pickBandOnsets(curve, ONSET_HOP / sampleRate, { floor: role.floor }).map((onset) => onset.seconds)
}

/**
 * How far apart two onsets may sit and still count as the same hit. Coarser
 * than `MATCH_TOLERANCE_STEPS` in verify-emission.mjs (that compares two
 * already-quantised event lists; this compares raw analysis onsets, which
 * carry their own few-hop jitter before quantisation ever happens) and
 * coarser than the ~46ms gap measured directly between a real kick's energy
 * peak and its own true onset time on the-chase - wide enough to swallow that
 * kind of production/detection lag without also swallowing a genuine
 * quarter-step timing error.
 */
const ONSET_MATCH_TOLERANCE_SECONDS = 0.06

/**
 * F1 of onset agreement between two curves, matched within a time tolerance.
 *
 * Replaces a plain zero-lag correlation of the two curves (kept in git
 * history, not here - see the commit that introduced this), which measured
 * near zero for kick and snare against every real the-chase stem regardless
 * of transcription accuracy: a resynthesised decaying tone's rise curve is a
 * handful of tall, sparse spikes, while a real drum's rise curve - carrying
 * room tone, harmonic beating and same-band bleed from neighbouring roles -
 * is a much denser, more moderate scatter. Correlating those two shapes
 * directly measures how alike their *statistical texture* is, which a
 * synthetic voice can never match, rather than whether hits land in the same
 * place, which is the only thing this check is supposed to answer. Matching
 * onsets within a tolerance instead asks exactly that question and ignores
 * everything about the curves' shape in between.
 *
 * Measured directly against the-chase (probe script, not committed - see
 * verify-hearing's calibration comment on `HEARING_THRESHOLDS` for the
 * numbers): a known-good kick transcription (95% accurate against ground
 * truth) scores 0.805 by this method against the real drums stem, where the
 * old correlation scored 0.004. The same known-good transcription, shifted a
 * step, missing half its hits, or replaced with an unrelated pattern, scores
 * materially lower every time.
 */
function onsetAgreement(rendered, stemSlice, role, sampleRate) {
  const a = detectorOnsets(rendered, role, sampleRate)
  const b = detectorOnsets(stemSlice, role, sampleRate)
  if (!a.length || !b.length) return 0
  const usedB = new Set()
  let matched = 0
  for (const time of a) {
    let best = -1
    let bestDistance = Infinity
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue
      const distance = Math.abs(b[i] - time)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    if (best >= 0 && bestDistance <= ONSET_MATCH_TOLERANCE_SECONDS) {
      usedB.add(best)
      matched++
    }
  }
  const precision = matched / a.length
  const recall = matched / b.length
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
}

/**
 * How well a rendered layer matches the stem it came from.
 *
 * Pitched layers compare chroma, because chroma is invariant to the things
 * resynthesis gets wrong on purpose - timbre, voicing, octave register of the
 * synthesis voice - and sensitive to the thing that matters, which is which
 * notes are sounding. Chroma alone cannot see an octave error, so single-voice
 * pitched layers (not chords - `.voicing()` chooses its own register by
 * design) also carry a register term: the spectral centroid moves with the
 * octave even though chroma does not, and getting the octave right is #42's
 * headline criterion.
 *
 * Drums compare onset timing rather than pitch, because a drum layer has no
 * pitch content and what we want to know is whether hits land where we said
 * they do. That used to mean a zero-lag correlation of the role's raw
 * detection curve; it does not any more (see `onsetAgreement`'s comment) -
 * correlating curve *shape* could not tell a 95%-accurate real kick
 * transcription from a wrong one, because a synthesised decaying tone's curve
 * and a real drum's curve never share enough texture to correlate well
 * regardless of whether the hits are in the right place. Matching discrete
 * onsets within a tolerance answers the actual question directly, and is
 * still tolerant of same-band bleed from a louder neighbouring role (a kick's
 * broadband splatter reaching into the snare band, for instance - see
 * drums.mjs's own `suppressKickBleed`): a bleed onset is one more unmatched
 * point in the stem's onset set, which costs recall gradually rather than
 * collapsing correlation outright.
 */
export function scoreLayer(rendered, stemSlice, layer, grid) {
  const hasSignal = (buffer) => buffer.some((sample) => sample !== 0)
  if (!hasSignal(rendered) || !hasSignal(stemSlice)) return 0

  const role = DRUM_ROLES.find((candidate) => candidate.name === layer)
  if (role) {
    return onsetAgreement(rendered, stemSlice, role, RESYNTH_SAMPLE_RATE)
  }

  // A grid anchored at zero, because both buffers start at the section's
  // downbeat rather than the track's.
  const localGrid = gridFromJson({
    bpm: grid.bpm,
    beatSeconds: grid.beatSeconds,
    barSeconds: grid.barSeconds,
    beatsPerBar: grid.beatsPerBar,
    downbeatSeconds: 0,
  })
  const a = beatChroma(asAudio(rendered), localGrid).vectors
  const b = beatChroma(asAudio(stemSlice), localGrid).vectors
  if (!a.length || !b.length) return 0

  // A beat where both vectors are silent (no chroma energy at all) carries no
  // harmonic information - a bass note lasting 4 of 16 steps is legitimately
  // silent the rest of the bar, in both the rendering and the stem it came
  // from, and that agreement is not what this term measures. Counting it as a
  // mismatch (cosine's zero-norm fallback) would punish a correctly silent gap
  // exactly as hard as a wrong note; counted beats are only those where at
  // least one side has something sounding.
  const beats = Math.min(a.length, b.length)
  let total = 0
  let counted = 0
  for (let beat = 0; beat < beats; beat++) {
    if (isSilent(a[beat]) && isSilent(b[beat])) continue
    total += cosine(a[beat], b[beat])
    counted++
  }
  const harmonic = counted > 0 ? Math.max(0, total / counted) : 1

  if (layer === 'chords') return harmonic
  const register = centroidAgreement(rendered, stemSlice)
  return harmonic * (REGISTER_WEIGHT + (1 - REGISTER_WEIGHT) * register)
}

/** 1 when two buffers share a spectral centre of mass, falling off with the
 *  log-frequency distance between them - an octave apart scores 0. */
function centroidAgreement(a, b) {
  const centroidA = spectralCentroid(a)
  const centroidB = spectralCentroid(b)
  if (!centroidA || !centroidB) return 1
  const octaves = Math.abs(Math.log2(centroidA / centroidB))
  return Math.max(0, 1 - octaves)
}

function spectralCentroid(samples, fftSize = CHROMA_FFT) {
  if (samples.length < fftSize) return 0
  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const bins = fftSize / 2
  const binHz = RESYNTH_SAMPLE_RATE / fftSize
  const hops = Math.max(1, Math.floor((samples.length - fftSize) / fftSize))
  let weighted = 0
  let total = 0
  for (let hop = 0; hop < hops; hop++) {
    const start = hop * fftSize
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      weighted += magnitude * bin * binHz
      total += magnitude
    }
  }
  return total > 0 ? weighted / total : 0
}

/**
 * Per section, per layer.
 *
 * `stemBuffers` is `{ drums, bass, other }`, each a WAV buffer. A layer the
 * transcription omitted reports `null` rather than a zero score: there is a
 * difference between "we heard nothing" and "we heard it wrong," and collapsing
 * them would make the overall score punish correct omissions - the `lead`
 * layer is disabled by default (see resynth.mjs) for exactly this reason.
 */
export function verifyHearing(transcription, stemBuffers, { thresholds = HEARING_THRESHOLDS } = {}) {
  const grid = gridFromJson(transcription.grid)
  const stems = {}
  for (const [name, buffer] of Object.entries(stemBuffers)) stems[name] = decodeWav(buffer)

  const sections = []
  const allScores = []

  for (const section of transcription.sections) {
    const { layers: rendered } = renderSection(section, grid)
    const range = sectionRange(grid, section)
    const layers = {}

    for (const layer of LAYERS) {
      if (!section.loops?.[layer]) {
        layers[layer] = null
        continue
      }
      const stem = stems[LAYER_STEM[layer]]
      if (!stem) {
        layers[layer] = null
        continue
      }
      const slice = sliceAudio(stem, range.fromSec, range.toSec)
      const score = scoreLayer(rendered[layer], slice, layer, grid)
      const threshold = thresholds[layer] ?? Infinity
      layers[layer] = { score, pass: score >= threshold }
      allScores.push(score)
    }
    sections.push({ index: section.index, layers })
  }

  return {
    sections,
    overall: allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0,
  }
}

/** A chroma vector `beatChroma` never normalised because it found nothing in
 *  the pitch band during that beat - `beatChroma` leaves it as all zeros
 *  rather than a unit vector, so a plain norm check is the correct test. */
function isSilent(vector) {
  return vector.every((value) => value === 0)
}

function cosine(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const den = Math.sqrt(normA * normB)
  return den > 0 ? dot / den : 0
}
