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

export class LowConfidenceGridError extends Error {
  constructor(field, grid) {
    super(
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
 * Onset energy on the beats alone is not enough, and the reason is worth
 * stating because it is the failure this whole function exists to catch. Take a
 * clip with a kick on every beat. A candidate at twice the true period puts a
 * beat on every second kick: every one of its beats still lands on a hit, so
 * scoring beats alone rates half-time exactly as highly as the truth.
 *
 * What separates them is the midpoints. At the true period the midpoints are
 * empty; at half-time they are full of kicks. So the score is onset energy on
 * the beats minus onset energy halfway between them, which punishes a period
 * that is too slow and a period that is too fast for opposite reasons.
 *
 * Both totals, not means. A wrong candidate period is not just wrong, it is
 * usually sparser or denser than the truth over the same clip - a candidate at
 * two-thirds the correct tempo covers fewer beats in 16 seconds than the truth
 * does. Dividing by beat count throws that away: measured on a 128 BPM clip, a
 * musically meaningless two-thirds-ratio candidate had a slightly higher
 * per-beat mean than the true tempo (0.092 vs 0.086) purely because it sampled
 * fewer, luckier hops, and would have won. Summed rather than averaged, the
 * true tempo's larger beat count wins decisively (2.92 vs 2.09) because it is
 * the candidate that actually explains where the record's onset energy went.
 */
function periodScore(novelty, beatHops) {
  const { offsetHops } = beatPhase(novelty, beatHops)
  let onBeat = 0
  let offBeat = 0
  for (let i = 0; ; i++) {
    const hop = Math.round(offsetHops + i * beatHops)
    if (hop >= novelty.length) break
    onBeat += novelty[hop]
    const mid = Math.round(offsetHops + (i + 0.5) * beatHops)
    if (mid >= 0 && mid < novelty.length) offBeat += novelty[mid]
  }
  return onBeat - offBeat
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

export function findTempo(novelty, hopSeconds) {
  const scored = []
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += BPM_STEP) {
    const beatHops = 60 / bpm / hopSeconds
    scored.push({ bpm, score: periodScore(novelty, beatHops) * tempoPrior(bpm) })
  }
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (best.score <= 0) return { bpm: best.bpm, confidence: 0 }

  const runnerUp = scored.find((candidate) => Math.abs(candidate.bpm - best.bpm) / best.bpm > DISTINCT_BAND)
  // Confidence is the margin over the nearest genuinely different candidate. A
  // curve that explains one tempo far better than any real alternative is one
  // to trust; a field of near-ties means the tracker is guessing, and
  // downstream work should not be built on a guess.
  const confidence = runnerUp ? clamp01((best.score - Math.max(0, runnerUp.score)) / best.score) : 1
  return { bpm: best.bpm, confidence }
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
 * How much to trust a beatsPerBar candidate before the audio has said
 * anything at all.
 *
 * This repertoire is techno and adjacent - essentially all of it is in four.
 * A period-2 pattern in the low band (a bassline moving every two beats) is
 * genuinely present in the audio and genuinely nests inside a four-beat bar;
 * the signal alone cannot say whether that pattern IS the bar or sits inside
 * one, because both readings explain the same measurement equally well. The
 * answer comes from what this material actually is, the same reason
 * `tempoPrior` exists. 3 has to overcome this before it can win; 4 does not.
 */
const BEATS_PER_BAR_PRIOR = { 3: 0.4, 4: 1 }

/**
 * How many beats to a bar.
 *
 * Downbeats carry more low-end energy than other beats - a real kick, and
 * this module's own accented test fixture alike. Score a 3 and a 4 with
 * `contrastAt`, weight by `BEATS_PER_BAR_PRIOR`, and take the better.
 * Anything more exotic is out of scope: the clone emits `arrange()` over
 * bars, and guessing 7/8 wrong is worse than calling it 4.
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
    if (frame >= audio.numFrames) break
    beats.push(lowBandEnergyAt(audio, frame))
  }
  if (beats.length < 8) return { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 }

  let best = { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 }
  for (const beatsPerBar of [3, 4]) {
    const own = contrastAt(beats, beatsPerBar)
    const confidence = own.confidence * BEATS_PER_BAR_PRIOR[beatsPerBar]
    // Which beat of the bar is strongest IS the downbeat. Computing it for a
    // confidence score and then discarding it would leave the grid with beats
    // but no bar one, so bar lines would land on an arbitrary beat: exactly the
    // error this whole module exists to prevent.
    if (confidence > best.confidence) best = { beatsPerBar, downbeatOffset: own.downbeatOffset, confidence }
  }
  return best
}

export function detectGrid(wavBuf, { minConfidence = 0.25 } = {}) {
  const audio = decodeWav(wavBuf)
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
  if (!novelty) throw new LowConfidenceGridError('tempo', { bpm: null, confidence: 0 })

  const tempo = findTempo(novelty, hopSeconds)
  const measured = { bpm: tempo.bpm, tempoConfidence: tempo.confidence }
  if (tempo.confidence < minConfidence) throw new LowConfidenceGridError('tempo', measured)

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
    beatAt: (index) => downbeatSeconds + index * beatSeconds,
    barAt: (index) => downbeatSeconds + index * barSeconds,
    secondsToBars: (seconds) => seconds / barSeconds,
  }
}
