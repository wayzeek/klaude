/**
 * What the reference record is, measured.
 *
 * Mostly a reshaping of analyzeWavBuffer's output into a stable contract, plus
 * the confidence values it does not provide. Confidence matters here more than
 * anywhere else in the pipeline: the worst outcome is not failing, it is
 * succeeding while wrong, and a confidence floor is what makes that detectable.
 */

import { BANDS, analyzeWavBuffer, normalizeKeyName } from '../../analyze.mjs'

const clamp01 = (value) => Math.max(0, Math.min(1, value))

/**
 * Key confidence from the margin over the runner-up.
 *
 * Krumhansl correlations for the top two candidates are usually close, because
 * neighbouring keys share most of their notes. A wide margin means the chroma
 * genuinely prefers one; a narrow one means the detector is guessing between
 * near-identical options, which is exactly when downstream harmony work should
 * not trust it.
 */
function keyConfidence(key) {
  if (!key) return 0
  const best = key.best?.score ?? 0
  const runnerUp = key.runnerUp?.score ?? 0
  if (best <= 0) return 0
  return clamp01((best - runnerUp) / best)
}

export function profileReference(wavBuf, meta = {}) {
  const analysis = analyzeWavBuffer(wavBuf)

  return {
    source: {
      title: meta.title ?? null,
      url: meta.url ?? null,
      origin: meta.source ?? null,
    },
    duration: analysis.duration,
    tempo: {
      bpm: analysis.tempo?.bpm ?? null,
      confidence: clamp01(analysis.tempo?.confidence ?? 0),
    },
    key: {
      name: analysis.key ? normalizeKeyName(analysis.key.best.name) : null,
      runnerUp: analysis.key ? normalizeKeyName(analysis.key.runnerUp.name) : null,
      confidence: keyConfidence(analysis.key),
      chroma: analysis.key?.chroma ?? null,
    },
    loudness: {
      rmsDb: Number.isFinite(analysis.overallRmsDb) ? analysis.overallRmsDb : null,
      peakDb: Number.isFinite(analysis.peakDb) ? analysis.peakDb : null,
      range: analysis.loudnessRange,
      clippedSamples: analysis.clippedSamples,
    },
    bands: {
      names: BANDS.map((band) => band.name),
      pct: analysis.bandPct,
      tiltDb: analysis.bandTiltDb.map((value) => (Number.isFinite(value) ? value : null)),
    },
    width: {
      correlation: analysis.avgCorr,
      // Width cannot be measured on a mono file, and saying so is more useful
      // than reporting a correlation of 1 as though it were a finding.
      confidence: analysis.channels === 2 && analysis.avgCorr !== null ? 1 : 0,
    },
    arc: {
      spark: analysis.spark,
      segments: analysis.segments.map((segment) => ({
        startSec: segment.startSec,
        endSec: segment.endSec,
        rmsDb: Number.isFinite(segment.rmsDb) ? segment.rmsDb : null,
        bandPct: segment.bandPct,
        silent: segment.silent,
      })),
    },
  }
}
