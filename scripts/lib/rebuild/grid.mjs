/**
 * The bar grid: tempo, where beat one falls, and how many beats are in a bar.
 *
 * estimateTempo answers only the first of those, and folds its answer into 70
 * to 180 BPM by doubling and halving, so a confident result can still be half
 * or double time. A BPM without a downbeat places every bar line at an
 * arbitrary offset, and every quantised note downstream inherits that error.
 *
 * This is the pipeline's most important gate. Nothing further can detect a bad
 * grid, so a grid that cannot be measured confidently stops the run here.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty, estimateTempo } from '../dsp.mjs'

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
    for (let hop = offset; hop < novelty.length; hop += period) {
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
 */
function periodScore(novelty, beatHops) {
  const period = Math.max(2, Math.round(beatHops))
  const { offsetHops } = beatPhase(novelty, period)
  let onBeat = 0
  let onBeatCount = 0
  let offBeat = 0
  let offBeatCount = 0
  const half = Math.floor(period / 2)

  for (let hop = offsetHops; hop < novelty.length; hop += period) {
    onBeat += novelty[hop]
    onBeatCount++
    const mid = hop + half
    if (mid < novelty.length) {
      offBeat += novelty[mid]
      offBeatCount++
    }
  }
  if (onBeatCount === 0) return 0
  return onBeat / onBeatCount - (offBeatCount ? offBeat / offBeatCount : 0)
}

/**
 * Recover the true beat period from an ambiguous autocorrelation estimate.
 *
 * Autocorrelation on a periodic novelty curve peaks at the beat period and at
 * every integer multiple of it, with near-identical scores. Which one wins is
 * close to arbitrary. `estimateTempo` then folds its answer into 70 to 180 BPM
 * by doubling and halving, which only repairs errors that are a power of two.
 *
 * That gap is not hypothetical: on a synthetic clip generated at exactly 120
 * BPM, `estimateTempo` locked onto a period roughly three times the beat and
 * folded it to 83.35 BPM. No amount of doubling reaches 120 from there, because
 * the error was a factor of three.
 *
 * So the candidate set covers the simple ratios a beat tracker actually
 * confuses, not just octaves, and each is scored by `periodScore` rather than
 * by phase clarity alone.
 */
const RATIOS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3, 4]

export function resolveOctave(novelty, bpm, hopSeconds) {
  const seen = new Set()
  const candidates = []
  for (const ratio of RATIOS) {
    const value = bpm * ratio
    if (value < 60 || value > 200) continue
    const key = value.toFixed(3)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(value)
  }
  if (candidates.length === 0) return { bpm, confidence: 0 }

  const scored = candidates.map((candidate) => ({
    bpm: candidate,
    score: periodScore(novelty, 60 / candidate / hopSeconds),
  }))
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  const runnerUp = scored[1]
  // Confidence is the margin over the next best candidate. A curve that
  // explains one period far better than any other is one to trust; a field of
  // near-ties means the tracker is guessing, and downstream work should not be
  // built on a guess.
  const confidence =
    best.score > 0 && runnerUp ? clamp01((best.score - Math.max(0, runnerUp.score)) / best.score) : best.score > 0 ? 1 : 0

  return { bpm: best.bpm, confidence }
}

/**
 * How many beats to a bar.
 *
 * Downbeats carry more onset energy than other beats. Score a 3 and a 4 by how
 * much the strongest beat-of-bar position stands clear of the others, and take
 * the better. Anything more exotic is out of scope: the clone emits `arrange()`
 * over bars, and guessing 7/8 wrong is worse than calling it 4.
 */
export function detectMeter(novelty, beatHops, phaseHops) {
  const period = Math.max(1, Math.round(beatHops))
  const beats = []
  for (let hop = phaseHops; hop < novelty.length; hop += period) beats.push(novelty[hop])
  if (beats.length < 8) return { beatsPerBar: 4, confidence: 0 }

  let best = { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 }
  for (const beatsPerBar of [3, 4]) {
    const positions = new Array(beatsPerBar).fill(0)
    const counts = new Array(beatsPerBar).fill(0)
    for (let i = 0; i < beats.length; i++) {
      positions[i % beatsPerBar] += beats[i]
      counts[i % beatsPerBar]++
    }
    const means = positions.map((total, i) => (counts[i] ? total / counts[i] : 0))
    const overall = means.reduce((a, b) => a + b, 0) / beatsPerBar
    const strongest = Math.max(...means)
    // Which beat of the bar is strongest IS the downbeat. Computing it for a
    // confidence score and then discarding it would leave the grid with beats
    // but no bar one, so bar lines would land on an arbitrary beat: exactly the
    // error this whole module exists to prevent.
    const downbeatOffset = means.indexOf(strongest)
    const confidence = overall > 0 ? clamp01((strongest - overall) / overall) : 0
    if (confidence > best.confidence) best = { beatsPerBar, downbeatOffset, confidence }
  }
  return best
}

export function detectGrid(wavBuf, { minConfidence = 0.25 } = {}) {
  const audio = decodeWav(wavBuf)
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)

  const rough = novelty ? estimateTempo(novelty, hopSeconds) : null
  if (!rough) throw new LowConfidenceGridError('tempo', { bpm: null, confidence: 0 })

  const tempo = resolveOctave(novelty, rough.bpm, hopSeconds)
  const measured = { bpm: tempo.bpm, tempoConfidence: tempo.confidence }
  if (tempo.confidence < minConfidence) throw new LowConfidenceGridError('tempo', measured)

  const beatSeconds = 60 / tempo.bpm
  const beatHops = beatSeconds / hopSeconds
  const phase = beatPhase(novelty, beatHops)
  measured.phaseSeconds = phase.offsetHops * hopSeconds
  measured.phaseConfidence = phase.confidence
  if (phase.confidence < minConfidence) throw new LowConfidenceGridError('phase', measured)

  const meter = detectMeter(novelty, beatHops, phase.offsetHops)
  measured.beatsPerBar = meter.beatsPerBar
  measured.downbeatOffset = meter.downbeatOffset
  measured.meterConfidence = meter.confidence
  if (meter.confidence < minConfidence) throw new LowConfidenceGridError('meter', measured)

  const phaseSeconds = phase.offsetHops * hopSeconds
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
