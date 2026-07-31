/**
 * The bar grid: tempo, where beat one falls, and how many beats are in a bar.
 *
 * This is a direct BPM search over the novelty curve, not a wrapper around
 * `estimateTempo`. That function is frozen (analyze.mjs and its baseline depend
 * on its exact output) and, measured directly, its integer-hop autocorrelation
 * plus a power-of-two fold cannot reach every tempo: on a 120 BPM test clip it
 * locked onto a period roughly three times the beat and folded to 83.35 BPM, a
 * factor-of-three error no amount of doubling repairs. A ratio search built on
 * top of that peak inherited the same shape of problem one level up: scored on
 * a real recording at a known 138 BPM, it locked onto a 2/3 ratio (91.875 BPM)
 * confidently enough to pass its own gate. Searching BPM directly removes the
 * dependency on which peak `estimateTempo` happened to find.
 *
 * A BPM without a downbeat places every bar line at an arbitrary offset, and
 * every quantised note downstream inherits that error. This is the pipeline's
 * most important gate: nothing further can detect a bad grid, so a grid that
 * cannot be measured confidently stops the run here.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty, fft, makeHann } from '../dsp.mjs'
import { MIN_MATCH_CONFIDENCE } from './metadata.mjs'

export class LowConfidenceGridError extends Error {
  /**
   * `message` is optional: the default covers "the detector alone could not
   * clear the gate". A known-tempo disagreement (see `reconcileTempo`) is a
   * different situation - both the detector and an external source produced
   * an answer, and they are both being treated as too confident to ignore,
   * not too unconfident to trust - so it supplies its own wording rather
   * than reusing a message that says "cannot establish confidently".
   */
  constructor(field, grid, message) {
    super(
      message ??
        `Cannot establish the ${field} confidently enough to build on.\n` +
          `Measured: ${JSON.stringify(grid)}\n` +
          'Everything downstream is built on this grid and none of it could detect the error, so the run stops here.',
    )
    this.name = 'LowConfidenceGridError'
    this.field = field
    this.grid = grid
  }
}

const clamp01 = (value) => Math.max(0, Math.min(1, value))

/**
 * Sum the novelty curve at every beat position for a given phase.
 *
 * `beatHops` is a float, not a rounded hop count. A beat period is almost never
 * an integer number of hops, and re-deriving each beat's position from `offset
 * + i * beatHops` (rounding only when indexing) tracks the true continuous grid
 * across the whole clip. Rounding the period itself once and then striding by
 * that integer compounds the rounding error beat after beat, which drifts the
 * sampled position away from the real onset by a growing fraction of a hop -
 * measured on a 120 BPM click clip, that drift alone produced a spurious 10-20%
 * spread across bar positions with no accent anywhere in the audio.
 *
 * The phase whose beats land on the most onset energy is the one where beat one
 * actually falls. Comparing the winner to the mean over all phases gives a
 * confidence: on a strongly pulsed track one phase stands far clear, and on
 * something arrhythmic every phase scores alike.
 */
export function beatPhase(novelty, beatHops) {
  const period = Math.max(1, Math.round(beatHops))
  let bestOffset = 0
  let bestScore = -Infinity
  let sum = 0
  let count = 0

  for (let offset = 0; offset < period; offset++) {
    let score = 0
    let beats = 0
    for (let i = 0; ; i++) {
      const hop = Math.round(offset + i * beatHops)
      if (hop >= novelty.length) break
      score += novelty[hop]
      beats++
    }
    if (beats === 0) continue
    score /= beats
    sum += score
    count++
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }

  const mean = count ? sum / count : 0
  const confidence = mean > 0 ? clamp01((bestScore - mean) / mean) : 0
  return { offsetHops: bestOffset, confidence, strength: bestScore }
}

/**
 * How well a candidate beat period explains the novelty curve.
 *
 * Sum onset energy at every beat position for the phase `beatPhase` already
 * found. Total, not mean: a wrong candidate period is not just wrong, it is
 * usually sparser or denser than the truth over the same clip - a candidate at
 * two-thirds the correct tempo covers fewer beats in 16 seconds than the truth
 * does. Dividing by beat count throws that away: measured on a 128 BPM clip, a
 * musically meaningless two-thirds-ratio candidate had a slightly higher
 * per-beat mean than the true tempo (0.092 vs 0.086) purely because it sampled
 * fewer, luckier hops, and would have won. Summed rather than averaged, the
 * true tempo's larger beat count wins decisively (2.92 vs 2.09) because it is
 * the candidate that actually explains where the record's onset energy went.
 *
 * This used to also subtract onset energy from the midpoints between beats,
 * on the reasoning that a candidate period twice too slow puts its beats on
 * real hits while its midpoints land on the hits it skipped. That is true on
 * a four-on-the-floor clip with silent off-beats - every synthetic fixture
 * this module was built and tuned against - and false on syncopated music,
 * where the off-beats are busy by construction. Measured on Bicep's "Glue"
 * (broken beat, true tempo 130 BPM): at the true tempo, off-beat energy is
 * 88% of on-beat energy (286.8 vs 326.4), because the off-beats are where a
 * lot of the track's kicks actually land. At 104 BPM - a musically unrelated
 * slower tempo, and the one the subtraction picked - off-beat energy is only
 * 48% of on-beat (87.5 vs 180.8), purely because that candidate's off-beat
 * positions happen to fall in gaps of the syncopated pattern. Subtracting
 * off-beat energy was therefore scoring which candidate's off-beats were
 * emptiest, not which candidate was correct, and confidence came out at 0.19
 * on the wrong answer - on real syncopated material those are different
 * questions and the subtraction answers the wrong one. On the-chase, the
 * verified recording with a plainer beat, dropping the subtraction still
 * recovers 138 BPM, at higher confidence than before (0.56 vs 0.28) - the
 * subtraction was not load-bearing there either, just harmless. The on-beat
 * sum alone, still built on `beatPhase`'s continuously-tracked positions
 * rather than a once-rounded lag, is what is left. `findTempo` below handles
 * the tempo-doubling gap this removal reopened, separately from this score.
 */
function periodScore(novelty, beatHops) {
  const { offsetHops } = beatPhase(novelty, beatHops)
  let onBeat = 0
  for (let i = 0; ; i++) {
    const hop = Math.round(offsetHops + i * beatHops)
    if (hop >= novelty.length) break
    onBeat += novelty[hop]
  }
  return onBeat
}

/**
 * Find the tempo by scoring the BPM range directly, rather than folding
 * whatever peak `estimateTempo`'s autocorrelation happened to find.
 *
 * Autocorrelation on a periodic novelty curve peaks at the beat period and at
 * every integer multiple of it, with near-identical scores, and only searching
 * lags at whole-hop resolution adds a quantisation error that grows with BPM
 * (~5 BPM steps near 160 BPM - too coarse to land within half a BPM of the
 * truth). Any correction layered on top of that peak - octave folding, ratio
 * search - inherits both problems: it can only reach the true tempo if the
 * true tempo is a simple multiple of whatever the peak was, and it can only
 * land as precisely as the peak did.
 *
 * Scoring every BPM in the plausible range directly removes both problems at
 * once. 60 to 200 BPM at 0.25 BPM resolution is 561 candidates, each an O(n)
 * pass over the novelty curve - milliseconds of work, not a hot path.
 */
const MIN_BPM = 60
const MAX_BPM = 200
const BPM_STEP = 0.25

/**
 * How far a competing candidate's BPM must sit from the winner's before it
 * counts as a genuinely different hypothesis rather than a neighbour the scan
 * resolution manufactured.
 *
 * At 0.25 BPM resolution, the candidates immediately either side of the true
 * peak score almost identically to it by construction - they are measuring the
 * same beat, just fractionally off. Comparing the winner to one of those
 * neighbours rather than to a real competitor (double time, half time, a wrong
 * ratio) collapses confidence to near zero on every input, telling nothing
 * apart. Excluding anything within 3% of the winner's BPM clears the scan's own
 * neighbours - at 120 BPM that is +/-3.6 BPM, well past the 0.25 BPM step - while
 * still comparing against real alternatives like 60 or 240 BPM.
 */
const DISTINCT_BAND = 0.03

/**
 * A log-normal prior favouring tempos near 120 BPM, multiplied into
 * `periodScore` before ranking.
 *
 * Harmonic tempo ambiguity is not resolvable from onset novelty alone: 92,
 * 138 and 184 BPM all explain the same real-recording onsets, because 138 is
 * 92's 3/2 and 184's 2/3, and every one of them lands beats on a subset of the
 * others' beats. Nothing in the signal picks 138 over its neighbours - a
 * listener does, because of what tempo perception prefers, not because the
 * audio says so. Every serious beat tracker encodes that preference as a
 * prior; leaving it out is the gap, not a missing signal-processing trick.
 *
 * The width is tuned in log2(bpm/120) space (octaves from centre) rather than
 * raw BPM, because tempo ambiguity is itself multiplicative (a wrong answer is
 * usually a ratio of the truth, not an offset from it). It is tuned against
 * the two cases that pull in opposite directions: the-chase's real 92/138/184
 * family wants a *narrow* prior (confidence on 138 falls as width grows - 0.32
 * at width 0.42 down to 0.23 at 0.55), while the sweep's 174 BPM clip - a
 * real, strong, unambiguous signal 0.54 octaves from centre - wants a *wide*
 * one (confidence rises from 0.15 at 0.42 to 0.39 at 0.55, since the prior
 * still discounts it at low width). 0.47 is the balance point: both land at
 * confidence 0.279, an equal margin above the 0.25 gate on either side. Move
 * it and one of those two measured cases loses its margin first.
 */
const TEMPO_PRIOR_CENTER_BPM = 120
const TEMPO_PRIOR_WIDTH = 0.47

function tempoPrior(bpm) {
  const distance = Math.log2(bpm / TEMPO_PRIOR_CENTER_BPM) / TEMPO_PRIOR_WIDTH
  return Math.exp(-0.5 * distance * distance)
}

/**
 * Above this BPM, the halving check below is skipped.
 *
 * `periodScore` summing raw novelty at each beat position cannot tell a slow
 * tempo from its own double on plain, unsyncopated material: a candidate at
 * twice the true tempo places a beat on every real hit plus one on every true
 * silence, and the silences contribute nothing, so the two candidates' sums
 * tie exactly. Measured on a 70 BPM click-only clip, both the true 70 BPM
 * candidate and the wrong double, 140 BPM, score 15.673 - identical. A tie
 * leaves `tempoPrior` (centred on 120) as the sole tiebreaker, and for a
 * genuinely slow track it decides wrongly: prior(140) = 0.894 against
 * prior(70) = 0.254, pulling the answer toward the middle of the search range
 * for no reason the audio supports. This is not new - the code before this
 * whole fix tied the same way, for the same reason, and picked the double
 * just as confidently (measured: 67 BPM read as 134 at confidence 0.68) - it
 * was simply never caught, because every fixture this module had before this
 * change started at 90 BPM. It matters on real material: DOOM's "Funeral for
 * the Damned" is 67 BPM.
 *
 * The ceiling exists because the same halving check misfires above roughly
 * 160 BPM, for an unrelated reason: at a beat period only a handful of onset
 * hops wide, `computeNovelty`'s frame-to-frame flux genuinely misses some
 * real hits (measured on a 180 BPM click clip: 10 of 48 beats read exactly
 * zero, even at the correct tempo, purely from hop-vs-decay phase - see
 * `computeNovelty` in dsp.mjs), which can make a correct fast candidate's own
 * sum look artificially close to its half's. Gating the check to candidates
 * at or below 160 BPM keeps it out of that zone. It does not fully close the
 * octave gap at the top of the range - some fast tempos can still fold to
 * their half there, a pre-existing failure (measured on the code before this
 * whole fix too) this change does not target - but it leaves that region
 * exactly as it was, while fixing the slow end.
 */
const OCTAVE_HALVING_CEILING_BPM = 160

/**
 * How much more a candidate's own sum must exceed its half's before the
 * candidate is trusted over the half.
 *
 * Tuned against the full 60-200 BPM sweep (1 BPM steps) plus both verified
 * recordings. Below ~1.2, real slow tempos (60-85 BPM on the plain synthetic
 * sweep) still lose to their double because the tie isn't caught firmly
 * enough. From 1.3 to 1.5 the result is flat - the same set of candidates
 * gets corrected either way, including both verified recordings staying
 * exactly where they were (the-chase 138 BPM, Glue 130 BPM) - which is why
 * 1.4, the middle of that flat stretch, is the value here rather than either
 * edge. Above ~1.8 the check starts overriding candidates it should leave
 * alone (174 BPM on the sweep folds to 87), and above 2.0 it reaches into
 * both verified recordings and gets them wrong. 1.4 sits in the middle of
 * the range that fixes the slow end without touching anything else measured.
 */
const OCTAVE_HALF_TOLERANCE = 1.4

const MAX_OCTAVE_HALVINGS = 4

export function findTempo(novelty, hopSeconds) {
  const scoreAt = (bpm) => periodScore(novelty, 60 / bpm / hopSeconds)
  const scored = []
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += BPM_STEP) {
    scored.push({ bpm, score: scoreAt(bpm) * tempoPrior(bpm) })
  }
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (best.score <= 0) return { bpm: best.bpm, confidence: 0 }

  // The winner and every bpm visited while checking whether it should halve -
  // all of them are the same hypothesis at different octaves, not genuinely
  // different candidates, so none of them can serve as the other's runner-up.
  let winner = best.bpm
  const octaveChain = [winner]
  if (winner <= OCTAVE_HALVING_CEILING_BPM) {
    for (let i = 0; i < MAX_OCTAVE_HALVINGS && winner / 2 >= MIN_BPM; i++) {
      const halfScore = scoreAt(winner / 2)
      if (halfScore <= 0 || scoreAt(winner) > OCTAVE_HALF_TOLERANCE * halfScore) break
      winner /= 2
      octaveChain.push(winner)
    }
  }
  const bestScore = scoreAt(winner) * tempoPrior(winner)
  if (bestScore <= 0) return { bpm: winner, confidence: 0 }

  const inOctaveChain = (bpm) => octaveChain.some((chained) => Math.abs(bpm - chained) / chained <= DISTINCT_BAND)
  const runnerUp = scored.find((candidate) => !inOctaveChain(candidate.bpm))
  // Confidence is the margin over the nearest genuinely different candidate. A
  // curve that explains one tempo far better than any real alternative is one
  // to trust; a field of near-ties means the tracker is guessing, and
  // downstream work should not be built on a guess.
  const confidence = runnerUp ? clamp01((bestScore - Math.max(0, runnerUp.score)) / bestScore) : 1
  return { bpm: winner, confidence }
}

/**
 * Low-band spectral energy in a short window starting at a given sample
 * frame - the measurement detectMeter is built on.
 *
 * computeNovelty's flux is normalised by the current frame's own magnitude,
 * which is precisely why it cannot carry an accent: measured directly (see
 * detectMeter's own tests), an isolated attack from silence reads ~1.0
 * regardless of loudness, swept from 0.6x gain to 9.6x with zero difference.
 * Raw FFT magnitude in a fixed band has no such normalisation - it scales
 * with amplitude, so a louder kick genuinely measures louder here. Kick
 * energy lives in the sub/bass range, so restricting to roughly 20-200 Hz
 * (widened slightly past the "20-150 Hz" rule of thumb specifically so this
 * fixture's 150 Hz test kick, chosen in make-wav.mjs for onset resolvability
 * rather than tonal realism, falls inside the measured band rather than
 * against its edge) picks up the kick and rejects everything living above it.
 */
const BAND_FFT = 2048
const LOW_BAND_MIN_HZ = 20
const LOW_BAND_MAX_HZ = 200

function lowBandEnergyAt(audio, startFrame) {
  const window = makeHann(BAND_FFT)
  const re = new Float32Array(BAND_FFT)
  const im = new Float32Array(BAND_FFT)
  for (let i = 0; i < BAND_FFT; i++) {
    const frame = startFrame + i
    let sample = 0
    if (frame >= 0 && frame < audio.numFrames) {
      for (let ch = 0; ch < audio.channels; ch++) sample += audio.readSample(frame, ch)
      sample /= audio.channels
    }
    re[i] = sample * window[i]
    im[i] = 0
  }
  fft(re, im)
  const binHz = audio.sampleRate / BAND_FFT
  let energy = 0
  for (let bin = 1; bin < BAND_FFT / 2; bin++) {
    const hz = bin * binHz
    if (hz < LOW_BAND_MIN_HZ || hz > LOW_BAND_MAX_HZ) continue
    energy += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
  }
  return energy
}

/**
 * How much one beat-of-bar position stands clear of the others, grouping the
 * per-beat low-band energy by a given period.
 *
 * The spread is the full range across positions (loudest minus quietest)
 * relative to the overall level, not the loudest position minus the overall
 * mean. Those read the same on a genuinely single-peaked pattern (one real
 * downbeat, everything else quiet) but not on a pattern that nests - a
 * bassline alternating every two beats groups at period 4 into two nearly
 * tied loud positions and two nearly tied quiet ones. "Loudest minus the
 * mean" is diluted by the *other* loud position pulling the mean up toward
 * it: measured on a real recording, that read 0.237, half the 0.466 that
 * "loudest minus quietest" reads on the exact same beats, because the mean
 * sits roughly halfway between the two levels while the quietest position
 * does not.
 */
function contrastAt(beats, period) {
  const positions = new Array(period).fill(0)
  const counts = new Array(period).fill(0)
  for (let i = 0; i < beats.length; i++) {
    positions[i % period] += beats[i]
    counts[i % period]++
  }
  const means = positions.map((total, i) => (counts[i] ? total / counts[i] : 0))
  const overall = means.reduce((a, b) => a + b, 0) / period
  const strongest = Math.max(...means)
  const quietest = Math.min(...means)
  return {
    downbeatOffset: means.indexOf(strongest),
    confidence: overall > 0 ? clamp01((strongest - quietest) / overall) : 0,
  }
}

/**
 * How many beats to a bar.
 *
 * Downbeats carry more low-end energy than other beats - a real kick, and
 * this module's own accented test fixture alike. Score a 3 and a 4 with
 * `contrastAt` and take the better. Anything more exotic is out of scope: the
 * clone emits `arrange()` over bars, and guessing 7/8 wrong is worse than
 * calling it 4.
 *
 * There is no prior weighting 4 over 3 here. One was added and then measured
 * away: on all three real recordings this module has, `contrastAt(beats, 4)`
 * already beats `contrastAt(beats, 3)` by 0.35-0.44 raw, before any prior -
 * the spread fix (see `contrastAt`) already resolves the bassline-nesting
 * ambiguity a prior was meant to cover, so the prior was never load-bearing
 * for anything this module has been measured against. And on a genuinely
 * three-beat accented fixture, the raw margin for 3 over 4 is just as
 * decisive (0.41-0.50) - a discount strong enough to matter on real material
 * would have to be strong enough to turn that decisive a signal into a
 * refusal, which measured directly at a discount of 0.4, is exactly what
 * happened: correct beatsPerBar, confidence pushed from ~0.50 to ~0.20,
 * under the 0.25 gate. A weight that cannot help on anything this module can
 * check and demonstrably hurts on the one thing it can check is worse than no
 * weight at all.
 *
 * This takes the decoded audio directly rather than the novelty curve,
 * because the novelty curve is exactly what cannot carry this measurement -
 * see lowBandEnergyAt's docstring.
 */
export function detectMeter(audio, beatSeconds, phaseSeconds) {
  const beatFrames = beatSeconds * audio.sampleRate
  const phaseFrames = phaseSeconds * audio.sampleRate
  const beats = []
  for (let i = 0; ; i++) {
    const frame = Math.round(phaseFrames + i * beatFrames)
    // The full BAND_FFT window must fit, not just its start. A beat whose
    // window runs off the end of the buffer gets zero-padded by
    // lowBandEnergyAt, which reads as an artificially quiet beat rather than
    // an absent one - measured directly, a last beat 64% zero-padded read as
    // the quietest position in its bar-position group, on a clip whose total
    // beat count happened to divide evenly by 4, concentrating that one
    // corrupted beat into a single group and manufacturing a bar-length
    // signal (0.235) that was not in the audio at all.
    if (frame + BAND_FFT > audio.numFrames) break
    beats.push(lowBandEnergyAt(audio, frame))
  }
  if (beats.length < 8) return { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 }

  let best = { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 }
  for (const beatsPerBar of [3, 4]) {
    const own = contrastAt(beats, beatsPerBar)
    // Which beat of the bar is strongest IS the downbeat. Computing it for a
    // confidence score and then discarding it would leave the grid with beats
    // but no bar one, so bar lines would land on an arbitrary beat: exactly the
    // error this whole module exists to prevent.
    if (own.confidence > best.confidence) best = { beatsPerBar, downbeatOffset: own.downbeatOffset, confidence: own.confidence }
  }
  return best
}

/**
 * The tempo gate's own floor, independent of the general `minConfidence` a
 * caller passes for phase and meter.
 *
 * Found by running the same 60-200 BPM, 1 BPM full sweep used to build the
 * octave-halving fix above through a four-way classification (right and
 * confident, right but gated, wrong but gated, wrong and confident) at
 * several gate values. At the general 0.25 gate, two points on that sweep -
 * both unusual tempos, not anything a real track is likely to sit at, and
 * both only marginally over the line - are wrong and confident: 193 BPM
 * reads 96.5 at confidence 0.2555, and 197 BPM reads 98.5 at 0.2517. That is
 * the one outcome the whole confidence gate exists to prevent: succeeding
 * while wrong. Raising the tempo gate to 0.26 puts both below it (0/141
 * wrong-and-confident on the full sweep) at zero measured cost: it is still
 * below 174 BPM's confidence (0.2682), the sweep point the tempo prior's own
 * width was tuned to keep just above 0.25, so none of this module's existing
 * tests move from passing to failing, and both verified recordings (the-chase
 * 0.562, Glue 0.473) and the two regression guards (blackout 0.580, nightswim
 * 0.489) all still clear it by a wide margin. 0.27, tried first, also closes
 * both dangerous points but costs exactly one sweep point - 174 BPM drops to
 * 0.268, just under it - which would have failed this module's own tests;
 * 0.26 gets the same safety without that cost.
 *
 * A separate constant rather than raising `minConfidence` itself, because
 * that parameter also gates phase and meter, and this finding is specific to
 * the tempo score's own susceptibility to marginal false positives at unusual
 * BPMs - phase and meter were not part of what this measured, and folding the
 * fix into their shared threshold would raise their bar too on no evidence.
 */
const MIN_TEMPO_CONFIDENCE = 0.26

/**
 * How far a known tempo (from `metadata.mjs`'s `lookupTrack`) may sit from
 * the detector's own answer and still count as agreement, rather than a
 * material disagreement.
 *
 * `Math.max` of an absolute and a relative bound: the absolute floor matters
 * at slow tempos (2% of 70 BPM is 1.4 BPM, tighter than any tap-tempo/catalog
 * rounding should be held to), the relative bound at fast ones. Measured
 * against both verifiable recordings: Glue's known tempo (Deezer, 130.01) and
 * its corrected detected tempo (130, confidence 0.473) differ by 0.01 BPM,
 * nowhere near either bound - a clean case of case 1 below, "agree".
 */
const KNOWN_TEMPO_ABS_TOLERANCE_BPM = 1.5
const KNOWN_TEMPO_REL_TOLERANCE = 0.03

/** Confidence reported when the detector and a known tempo agree. */
const KNOWN_TEMPO_AGREEMENT_CONFIDENCE = 0.9

/**
 * Combine a detected tempo with a known one (e.g. from a public database),
 * as a prior and a cross-check, never a silent replacement. Three cases:
 *
 *   1. Agree (within tolerance): the two independent measurements corroborate
 *      each other, so confidence is raised regardless of how unconfident the
 *      detector's own raw score was - agreement IS the evidence here.
 *   2. Known, detector unsure (its own confidence under `gate`): the
 *      detector's number is not trusted (it did not clear its own bar), so
 *      the known tempo is used outright. `beatSeconds` downstream is then
 *      built on it, and only phase/meter - which genuinely need the audio,
 *      and are measured at confidence 1.000 on both verifiable recordings -
 *      still come from the detector.
 *   3. Disagree materially (detector confident, but at a different tempo):
 *      this is information, not noise - two confident-looking answers that
 *      contradict each other, and picking either silently risks building the
 *      whole grid on the wrong one. Reported as 'disagreement' rather than
 *      resolved; `detectGrid` turns that into the same halt a low-confidence
 *      grid already causes, because tempo is the one measurement everything
 *      downstream depends on.
 *
 * Pure and exported so all three cases - especially the disagreement case,
 * which `detectGrid` cannot exercise without a real conflicting audio clip -
 * are unit-testable without decoding audio at all.
 */
export function reconcileTempo(detectedBpm, detectedConfidence, known, gate) {
  if (!known || known.bpm == null || (known.matchConfidence ?? 1) < MIN_MATCH_CONFIDENCE) {
    return { bpm: detectedBpm, confidence: detectedConfidence, agreement: 'none' }
  }

  const tolerance = Math.max(KNOWN_TEMPO_ABS_TOLERANCE_BPM, known.bpm * KNOWN_TEMPO_REL_TOLERANCE)
  const agrees = Math.abs(detectedBpm - known.bpm) <= tolerance

  if (agrees) {
    return {
      bpm: known.bpm,
      confidence: Math.max(detectedConfidence, KNOWN_TEMPO_AGREEMENT_CONFIDENCE),
      agreement: 'agree',
    }
  }

  if (detectedConfidence < gate) {
    // No `Math.max(gate, ...)` here: this branch is only reachable once the
    // guard above has already required `known.matchConfidence >=
    // MIN_MATCH_CONFIDENCE` (0.6), so the formula below is always >= 0.8 -
    // strictly above every `gate` any real caller passes (`rebuild.mjs`'s
    // default produces 0.26; see `MIN_TEMPO_CONFIDENCE`). A `Math.max` against
    // `gate` here was dead on every reachable path and, worse, made the test
    // below unable to tell this formula apart from a broken one - see that
    // test's own comment.
    return {
      bpm: known.bpm,
      confidence: 0.5 + 0.5 * (known.matchConfidence ?? 1),
      agreement: 'known',
    }
  }

  return { bpm: detectedBpm, confidence: detectedConfidence, agreement: 'disagreement', detectedBpm, knownBpm: known.bpm }
}

export function detectGrid(wavBuf, { minConfidence = 0.25, knownTempo = null } = {}) {
  const audio = decodeWav(wavBuf)
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
  if (!novelty) throw new LowConfidenceGridError('tempo', { bpm: null, confidence: 0 })

  const rawTempo = findTempo(novelty, hopSeconds)
  const tempoGate = Math.max(minConfidence, MIN_TEMPO_CONFIDENCE)
  const reconciled = reconcileTempo(rawTempo.bpm, rawTempo.confidence, knownTempo, tempoGate)
  const tempo = { bpm: reconciled.bpm, confidence: reconciled.confidence }
  const measured = {
    bpm: tempo.bpm,
    tempoConfidence: tempo.confidence,
    detectedBpm: rawTempo.bpm,
    detectedConfidence: rawTempo.confidence,
    knownBpm: knownTempo?.bpm ?? null,
    tempoAgreement: reconciled.agreement,
  }
  if (reconciled.agreement === 'disagreement') {
    throw new LowConfidenceGridError(
      'tempo',
      measured,
      `The detected tempo (${rawTempo.bpm.toFixed(1)} BPM, confidence ${rawTempo.confidence.toFixed(3)}) and the ` +
        `known tempo (${knownTempo.bpm} BPM${knownTempo.source ? ` from ${knownTempo.source}` : ''}) disagree by more ` +
        'than the tolerance, and the detector is itself confident - not a case of "the detector is unsure, trust the ' +
        'source". Refusing to silently pick one; everything downstream is built on this number.',
    )
  }
  if (tempo.confidence < tempoGate) throw new LowConfidenceGridError('tempo', measured)

  const beatSeconds = 60 / tempo.bpm
  const beatHops = beatSeconds / hopSeconds
  const phase = beatPhase(novelty, beatHops)
  const phaseSeconds = phase.offsetHops * hopSeconds
  measured.phaseSeconds = phaseSeconds
  measured.phaseConfidence = phase.confidence
  if (phase.confidence < minConfidence) throw new LowConfidenceGridError('phase', measured)

  const meter = detectMeter(audio, beatSeconds, phaseSeconds)
  measured.beatsPerBar = meter.beatsPerBar
  measured.downbeatOffset = meter.downbeatOffset
  measured.meterConfidence = meter.confidence
  if (meter.confidence < minConfidence) throw new LowConfidenceGridError('meter', measured)

  const barSeconds = beatSeconds * meter.beatsPerBar
  // Where bar one actually starts: the beat grid's phase, advanced to the first
  // beat that is a downbeat.
  const downbeatSeconds = phaseSeconds + meter.downbeatOffset * beatSeconds

  return {
    bpm: tempo.bpm,
    beatSeconds,
    phaseSeconds,
    downbeatSeconds,
    beatsPerBar: meter.beatsPerBar,
    downbeatOffset: meter.downbeatOffset,
    barSeconds,
    confidence: {
      tempo: tempo.confidence,
      phase: phase.confidence,
      meter: meter.confidence,
    },
    // 'none' when no known tempo was supplied at all; otherwise which of
    // reconcileTempo's three cases decided the final bpm above.
    tempoAgreement: reconciled.agreement,
    beatAt: (index) => downbeatSeconds + index * beatSeconds,
    barAt: (index) => downbeatSeconds + index * barSeconds,
    secondsToBars: (seconds) => seconds / barSeconds,
  }
}
