/**
 * Time-varying effects: sidechain pumping, filter sweeps and risers.
 *
 * Everything else this pipeline emits is static per section - one room amount,
 * one lpf cutoff, one pan. That is why a rebuild reads as flat next to the
 * record even when every note is right: the record's kick pumps the bass and
 * pad, its pads sweep open, and sections build into their own boundary. None
 * of that survives a static parameter.
 *
 * Three detectors. The sidechain detector's constants are each measured
 * against `tracks/MINUIT/02-the-chase.md`'s own bounced render
 * (`.duckorbit(2).duckdepth(.3).duckattack(.09)` on the kick, targeting the
 * orbit `chords`/`lead` share - `bass`/`sub` are never on that orbit and
 * carry no duck at all) - the one place in this codebase where the *source*
 * is a hand-authored moltek track, not a mystery record, so what the
 * detector should find is a written fact, not a guess - plus a cross-check
 * against Bicep's "Glue" for a second, unrelated real recording. Both are
 * cited by name in that detector's own doc comments rather than in a
 * companion report, because the comments are what a future change to these
 * constants has to argue with.
 *
 * The sweep and riser detectors' gates (`SWEEP_R_MIN`,
 * `SWEEP_MIN_RELATIVE_CHANGE`, `RISER_R_MIN`, `RISER_MIN_RELATIVE_RISE`) are
 * reasoned defaults, not measurements against either track - see each
 * constant's own comment for the reasoning. Neither calibration track
 * carries a deliberate, monotonic per-section sweep or riser on the layers
 * this module can detect one on (see `SWEEP_R_MIN`'s own comment for why),
 * so there is no written fact for these four to be measured against the way
 * the sidechain constants are - stated here plainly rather than left for a
 * reader to infer from the sidechain detector's own citations looking
 * different in kind.
 *
 * Detection is intentionally conservative in the same direction as
 * `sound-match.mjs`: a real effect measured as absent stays absent in the
 * emitted track, because a wrong effect is worse than a missing one. All
 * three detectors return `null` per section rather than guess when the
 * evidence does not clear their gate.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { CHROMA_HOP, CHROMA_FFT, ONSET_HOP, correlate, fft, makeHann } from '../dsp.mjs'
import { BANDS } from '../../analyze.mjs'
import { bandEnergy } from './transcribe/bands.mjs'
import { detectDrumHits } from './transcribe/drums.mjs'
import { sectionRange } from './transcribe/quantize.mjs'

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const round2 = (value) => Math.round(value * 100) / 100
const round3 = (value) => Math.round(value * 1000) / 1000

/** Ordinary least squares fit of `y` against `x`, plus the Pearson `r`
 *  (via `dsp.mjs`'s own `correlate`, the same function `key.mjs` uses to
 *  score a chroma against a profile - one correlation implementation for the
 *  whole pipeline). `x`/`y` are equal-length and at least 2 long; callers
 *  gate on sample count before calling this. */
function linearFit(x, y) {
  const n = x.length
  const meanX = x.reduce((a, b) => a + b, 0) / n
  const meanY = y.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (y[i] - meanY)
    den += (x[i] - meanX) ** 2
  }
  const slope = den > 0 ? num / den : 0
  const intercept = meanY - slope * meanX
  return { slope, intercept, r: correlate(x, y) }
}

// ============================================================================
// 1. Sidechain pumping
// ============================================================================

/** Full-audible-range envelope, matching `stem-profile.mjs`'s `stemDecay` -
 *  the same "one broadband envelope" reuse of `bandEnergy`, not a new FFT. */
function fullBandEnergy(audio) {
  return bandEnergy(audio, { lo: BANDS[0].lo, hi: BANDS[BANDS.length - 1].hi })
}

/** Hops averaged into the pre-onset baseline. A single hop is noisy enough
 *  that one unlucky sample flips a kick between "measurable" and not; three
 *  hops (~35ms at the pipeline's 512-hop/44.1kHz default) smooths that out
 *  without reaching back far enough to catch the *previous* kick's own tail. */
const BASELINE_HOPS = 3
/** A kick's pre-onset baseline below this share of the stem's own median
 *  level is treated as silence - there is nothing there to duck, and the
 *  ratio a near-zero baseline produces is pure noise, not a measurement. */
const BASELINE_FLOOR_FRACTION = 0.25
/** How far past the onset to search for the trough. A real duck's dip and a
 *  coincidental note decay both resolve well inside this on the material
 *  measured here (138-130 BPM house/techno); a genuinely slow-attack duck
 *  would be missed, which is a documented limitation below. */
const ATTACK_WINDOW_SECONDS = 0.15
/** The envelope has "recovered" once it is back to this share of baseline. */
const RECOVERY_FRACTION = 0.85
const MAX_RECOVERY_SECONDS = 0.6
/**
 * Below this fractional dip, a kick is not admitted into the phase-lock
 * timing test at all (see `PHASE_LOCK_WINDOW_SECONDS`) - not because 3% is
 * the significance floor (it is far below `MIN_REPORTED_DEPTH`), but because
 * a kick with essentially nothing to measure has a trough position that is
 * arbitrary numerical noise, and letting arbitrary noise vote on "is the
 * timing consistent" would only dilute the real signal.
 */
const MIN_DIP_FOR_TIMING = 0.03
/**
 * The trough must land within this many seconds of the kick to count as
 * phase-locked. This is the load-bearing threshold in this detector, and it
 * is the one measured directly on the-chase's own bounced render - see the
 * module doc comment for the ground truth. Restricting to kicks with at
 * least `MIN_DIP_FOR_TIMING` depth, on the-chase's five busiest sections
 * (76-147 kicks each): the *other* stem - which really is ducked
 * (`duckorbit(2)`, and `chords`/`lead` are the only layers on that orbit) -
 * has a trough within 30ms of the kick 77-100% of the time. The *bass* stem
 * - which carries no duck at all - only manages 34-44%, because its own
 * `mkBass`/`mkSub` notes decay on the same 16th-note grid the kick sits on
 * and so *look* kick-locked in raw dip depth, but not in dip *timing*: a
 * plucked bass note's own envelope takes 48-90ms to reach its post-onset
 * minimum, nearly always outside this window, while the record's actual
 * duck (a fast compressor, not a slow release) reaches its minimum inside
 * it almost every time. Sweeping this window from 30ms to 100ms on the same
 * data shows exactly why 30ms and not something looser: bass's own fraction
 * climbs past 50% (as high as 78%) well before 100ms, which would start
 * mistaking the bass's own decay for a duck. This is calibrated to one
 * track's compressor attack, not a law of nature - a slower real duck would
 * be missed by design; see the module doc comment's Glue cross-check.
 */
const PHASE_LOCK_WINDOW_SECONDS = 0.03
/** Fewer than this many kicks (raw, and again after the baseline/depth
 *  filters) and a per-section vote is a coin flip, not a measurement. */
const MIN_KICKS = 6
/** The phase-locked fraction must clear a majority, not just a plurality -
 *  "periodic and kick-locked" per the module brief, not "sometimes". */
const CONSISTENCY_THRESHOLD = 0.5
/** The phase-locked subset's own mean depth must still be audible - a
 *  majority of technically-phase-locked 4% blips is not a pump. */
const MIN_REPORTED_DEPTH = 0.08

/**
 * One kick's dip: baseline, trough, depth, recovery and how long after the
 * onset the trough actually landed. Returns `null` when the pre-onset
 * baseline is at or below `floor` - nothing to measure a dip against.
 *
 * `nextOnsetSeconds` (or `null` for the last kick in a section) caps both the
 * trough search and the recovery search, so a dense passage never borrows a
 * neighbouring kick's own attack as if it were this kick's recovery.
 */
export function measureKickDip(energy, hopSeconds, onsetSeconds, nextOnsetSeconds, floor) {
  const onsetHop = Math.round(onsetSeconds / hopSeconds)
  if (onsetHop < BASELINE_HOPS || onsetHop >= energy.length - 1) return null

  let baseline = 0
  for (let h = onsetHop - BASELINE_HOPS; h < onsetHop; h++) baseline += energy[h]
  baseline /= BASELINE_HOPS
  if (!(baseline > floor)) return null

  const nextHop = nextOnsetSeconds != null ? Math.round(nextOnsetSeconds / hopSeconds) : energy.length
  const attackHops = Math.max(1, Math.round(ATTACK_WINDOW_SECONDS / hopSeconds))
  const troughSearchEnd = Math.min(energy.length, onsetHop + attackHops, nextHop)

  let troughHop = onsetHop
  let trough = baseline
  for (let h = onsetHop; h < troughSearchEnd; h++) {
    if (energy[h] < trough) {
      trough = energy[h]
      troughHop = h
    }
  }
  const depth = clamp(1 - trough / baseline, 0, 1)

  const recoverTarget = baseline * RECOVERY_FRACTION
  const maxRecoverHop = Math.min(energy.length, onsetHop + Math.round(MAX_RECOVERY_SECONDS / hopSeconds), nextHop)
  let recoverHop = maxRecoverHop
  for (let h = troughHop; h < maxRecoverHop; h++) {
    if (energy[h] >= recoverTarget) {
      recoverHop = h
      break
    }
  }

  return {
    depth,
    recoverySeconds: (recoverHop - onsetHop) * hopSeconds,
    troughLagSeconds: (troughHop - onsetHop) * hopSeconds,
  }
}

/**
 * Sidechain pumping on one stem, one section: depth, recovery and how many of
 * the section's kicks were phase-locked, or `null` if the section does not
 * clear `MIN_KICKS`, `CONSISTENCY_THRESHOLD` or `MIN_REPORTED_DEPTH`.
 *
 * `kickOnsetsSeconds` is every kick in the *whole track* (as `detectDrumHits`
 * finds them); this function does the per-section windowing itself so
 * `detectSidechainStem` can share one kick list across every section.
 */
function sidechainForSection(energy, hopSeconds, floor, kickOnsetsSeconds, fromSec, toSec) {
  const inSection = kickOnsetsSeconds.filter((s) => s >= fromSec && s < toSec)
  if (inSection.length < MIN_KICKS) return null

  const dips = []
  for (let i = 0; i < inSection.length; i++) {
    // The section's own last kick has no "next kick" *within* `inSection` -
    // but a real one may still exist just past the section boundary, in the
    // next section's own share of the same global kick list. Without this,
    // its trough/recovery search runs uncapped to the end of the whole
    // stem, exactly the "borrow a neighbour's attack" failure the cap
    // exists to prevent, just for one kick per section instead of none.
    const next = i + 1 < inSection.length ? inSection[i + 1] : kickOnsetsSeconds.find((s) => s >= toSec) ?? null
    const dip = measureKickDip(energy, hopSeconds, inSection[i], next, floor)
    if (dip && dip.depth >= MIN_DIP_FOR_TIMING) dips.push(dip)
  }
  if (dips.length < MIN_KICKS) return null

  const phaseLocked = dips.filter((d) => d.troughLagSeconds <= PHASE_LOCK_WINDOW_SECONDS)
  const consistency = phaseLocked.length / dips.length
  // Strictly more than half, not "at least half" - CONSISTENCY_THRESHOLD is
  // 0.5, and a tie is not a majority.
  if (consistency <= CONSISTENCY_THRESHOLD) return null

  const depth = phaseLocked.reduce((a, b) => a + b.depth, 0) / phaseLocked.length
  if (depth < MIN_REPORTED_DEPTH) return null
  const recoverySeconds = phaseLocked.reduce((a, b) => a + b.recoverySeconds, 0) / phaseLocked.length

  return {
    depth: round3(depth),
    recoverySeconds: round3(recoverySeconds),
    consistency: round3(consistency),
    kicksInSection: inSection.length,
    kicksMeasured: dips.length,
  }
}

/**
 * Sidechain pumping on one stem, every section - `bass` or `other`, per the
 * module brief. `stemBuf` is the raw stem WAV; `kickOnsetsSeconds` comes from
 * `detectDynamics`'s own single `detectDrumHits` pass over the drum stem, so
 * both `bass` and `other` are scored against the exact same kicks.
 */
export function detectSidechainStem(stemBuf, kickOnsetsSeconds, grid, sections) {
  const audio = decodeWav(stemBuf)
  const energy = fullBandEnergy(audio)
  if (!energy) return sections.map(() => null)
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const sorted = [...energy].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.5)] * BASELINE_FLOOR_FRACTION

  return sections.map((section) => {
    const range = sectionRange(grid, section)
    return sidechainForSection(energy, hopSeconds, floor, kickOnsetsSeconds, range.fromSec, range.toSec)
  })
}

// ============================================================================
// 2. Filter sweeps
// ============================================================================

/** Only pitch/harmonic-bearing content votes on the centroid - matches
 *  `dsp.mjs`'s own chroma band, extended upward to include the "air" band a
 *  bright lead or hat bleed lives in, since a sweep's whole point is often to
 *  open or close exactly that region. */
const CENTROID_MIN_HZ = 100
const CENTROID_MAX_HZ = 12000
/**
 * A trend has to correlate at least this strongly with time to count as a
 * sweep rather than the wobble a `perlin`/`sine`-modulated pad's *own* filter
 * LFO produces when it happens to be mid-swing over a section's span.
 *
 * A reasoned default, not a measurement: neither of this module's two
 * calibration tracks carries a deliberate, monotonic per-section sweep on
 * `chords`/`lead` to measure a real threshold against (the-chase's own
 * sweep-shaped moments are either a continuous pad LFO wobble, measurably not
 * monotonic within a section, or a riser on an unrelated auxiliary noise
 * layer this pipeline never transcribes as `chords`/`lead`), so there is no
 * written fact here the way there is for the sidechain constants above. What
 * *is* verified directly: neither track clears this bar on any section - the
 * honest result for two records with no such sweep to find, and what makes
 * "sections without audible sweeps come back flat" true on both, not a
 * coincidence. The value itself is picked high enough to demand a strong,
 * near-monotonic trend rather than tuned against a case known to need it.
 */
const SWEEP_R_MIN = 0.7
/**
 * And the trend has to move the centroid by a musically real amount, not
 * just a statistically confident sliver of it.
 *
 * A reasoned default alongside `SWEEP_R_MIN`, for the same reason: no
 * calibration track carries a real sweep to size this against. 25% is a
 * judgment call ("more than a rounding error, less than a demand for an
 * extreme sweep"), not a value read off either track.
 */
const SWEEP_MIN_RELATIVE_CHANGE = 0.25
/** Fewer frames than this and a linear fit is describing noise. */
const MIN_TREND_FRAMES = 8

/**
 * Centroid mapped to an equivalent `.lpf()` cutoff - a documented model, not
 * a rendered measurement (this pipeline cannot render real audio through
 * Strudel offline - see `sound-match.mjs`'s own module comment for the same
 * constraint). A spectral centroid is a magnitude-weighted *average*
 * frequency, always well below the cutoff that would produce it, because the
 * energy below the cutoff still counts in the average - so the cutoff has to
 * sit above the centroid, not at it. `CENTROID_TO_LPF_FACTOR` is a
 * deliberately conservative multiple (a real inverse filter-design solve is
 * not attempted, per this module's own "a wrong sweep is worse than none"),
 * clamped to a range wide enough to matter but never opened past what a real
 * mix's air band carries.
 */
const CENTROID_TO_LPF_FACTOR = 2
const LPF_MIN_HZ = 300
const LPF_MAX_HZ = 8000

function centroidToLpf(hz) {
  return Math.round(clamp(hz * CENTROID_TO_LPF_FACTOR, LPF_MIN_HZ, LPF_MAX_HZ))
}

/**
 * The mapped `{lpfStart, lpfEnd}` for a trend, or `null` if clamping erased
 * it. A trend whose start and end both land past the same clamp boundary
 * (e.g. a sweep from 5kHz to 7kHz, both of which map above `LPF_MAX_HZ`)
 * maps to two equal cutoffs - a real, measured trend that this module's own
 * conservative mapping cannot represent as an audible sweep. Emitting
 * `saw.range(X, X)` would claim a sweep and produce a static filter, which
 * is exactly the "a wrong sweep is worse than none" case this module exists
 * to avoid - so a collapsed range is treated as "not eligible", not "eligible
 * with no audible effect".
 */
function mappedLpfRange(startHz, endHz) {
  const lpfStart = centroidToLpf(startHz)
  const lpfEnd = centroidToLpf(endHz)
  return lpfStart === lpfEnd ? null : { lpfStart, lpfEnd }
}

/**
 * Per-frame spectral centroid across `[fromSec, toSec)`, in seconds-since-
 * `fromSec` and Hz - the same Hann/FFT primitives `dsp.mjs` exports
 * (`makeHann`, `fft`), no reimplementation, just a magnitude-weighted mean
 * bin frequency instead of a chroma histogram or an onset-flux sum.
 */
export function centroidSeries(audio, fromSec, toSec) {
  const window = makeHann(CHROMA_FFT)
  const re = new Float32Array(CHROMA_FFT)
  const im = new Float32Array(CHROMA_FFT)
  const bins = CHROMA_FFT / 2
  const binHz = audio.sampleRate / CHROMA_FFT
  const fromFrame = Math.max(0, Math.round(fromSec * audio.sampleRate))
  const toFrame = Math.min(audio.numFrames, Math.round(toSec * audio.sampleRate))

  const times = []
  const centroids = []
  for (let start = fromFrame; start + CHROMA_FFT <= toFrame; start += CHROMA_HOP) {
    for (let i = 0; i < CHROMA_FFT; i++) {
      re[i] = audio.readMono(start + i) * window[i]
      im[i] = 0
    }
    fft(re, im)
    let num = 0
    let den = 0
    for (let bin = 1; bin < bins; bin++) {
      const hz = bin * binHz
      if (hz < CENTROID_MIN_HZ || hz > CENTROID_MAX_HZ) continue
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      num += magnitude * hz
      den += magnitude
    }
    if (den > 0) {
      times.push((start - fromFrame) / audio.sampleRate)
      centroids.push(num / den)
    }
  }
  return { times, centroids }
}

/** A linear trend fit to a centroid series, or `null` if there is too little
 *  data or the fit does not clear `SWEEP_R_MIN`/`SWEEP_MIN_RELATIVE_CHANGE`. */
function trendFromCentroid(times, centroids, { rMin = SWEEP_R_MIN, minRelativeChange = SWEEP_MIN_RELATIVE_CHANGE } = {}) {
  if (times.length < MIN_TREND_FRAMES) return null
  const { slope, intercept, r } = linearFit(times, centroids)
  if (Math.abs(r) < rMin) return null

  const duration = times[times.length - 1] - times[0]
  const startHz = intercept + slope * times[0]
  const endHz = intercept + slope * (times[0] + duration)
  const meanCentroid = centroids.reduce((a, b) => a + b, 0) / centroids.length
  const relativeChange = meanCentroid > 0 ? (endHz - startHz) / meanCentroid : 0
  if (Math.abs(relativeChange) < minRelativeChange) return null

  return { startHz, endHz, r, relativeChange, rising: endHz > startHz }
}

/**
 * Filter sweep on the `other` stem, every section - per the module brief,
 * this detector only ever looks at `other` (`chords`/`lead`'s shared stem).
 * Each entry is `null` (no sweep found or not eligible) or
 * `{ startHz, endHz, lpfStart, lpfEnd, r, relativeChange }`.
 */
export function detectFilterSweeps(otherBuf, grid, sections) {
  const audio = decodeWav(otherBuf)
  return sections.map((section) => {
    const range = sectionRange(grid, section)
    const { times, centroids } = centroidSeries(audio, range.fromSec, range.toSec)
    const trend = trendFromCentroid(times, centroids)
    if (!trend) return null
    const mapped = mappedLpfRange(trend.startHz, trend.endHz)
    if (!mapped) return null
    return {
      startHz: Math.round(trend.startHz),
      endHz: Math.round(trend.endHz),
      lpfStart: mapped.lpfStart,
      lpfEnd: mapped.lpfEnd,
      r: round3(trend.r),
      relativeChange: round3(trend.relativeChange),
    }
  })
}

// ============================================================================
// 3. Risers
// ============================================================================

/** How many bars, at most, before a section's own boundary the riser trend is
 *  measured over. Longer sections still only look at their last few bars -
 *  a riser is a run into the boundary, not the whole section. */
const RISER_WINDOW_BARS_MAX = 4
/**
 * Both RMS and centroid must correlate at least this strongly with time -
 * looser than `SWEEP_R_MIN` because the window is shorter (fewer frames, so
 * more sensitive to noise per the same absolute threshold), but still a real
 * trend, not a coin flip.
 *
 * A reasoned default, not a measurement, for the same reason `SWEEP_R_MIN`
 * is: neither calibration track carries a deliberate riser on `chords`/
 * `lead` into a section boundary to size this against. Set relative to
 * `SWEEP_R_MIN` by the stated frame-count reasoning above, not read off
 * either track directly.
 */
const RISER_R_MIN = 0.6
/**
 * And the rise has to be a musically real fraction of the starting value,
 * not a statistically confident sliver of it - same role as
 * `SWEEP_MIN_RELATIVE_CHANGE`, sized slightly lower because a riser's own
 * window is shorter and a real build can still be underway without having
 * moved as far yet as a full section-length sweep would.
 *
 * A reasoned default, not a measurement, for the same reason as
 * `SWEEP_MIN_RELATIVE_CHANGE`: no calibration track carries a real riser to
 * size this against.
 */
const RISER_MIN_RELATIVE_RISE = 0.2

/** RMS trend over `[fromSec, toSec)`, via the same broadband envelope
 *  `detectSidechainStem` uses - reused, not a second implementation. */
function rmsTrend(audio, fromSec, toSec) {
  const energy = fullBandEnergy(audio)
  if (!energy) return null
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const fromHop = Math.max(0, Math.round(fromSec / hopSeconds))
  const toHop = Math.min(energy.length, Math.round(toSec / hopSeconds))
  if (toHop - fromHop < MIN_TREND_FRAMES) return null

  const times = []
  const values = []
  for (let h = fromHop; h < toHop; h++) {
    times.push((h - fromHop) * hopSeconds)
    values.push(energy[h])
  }
  const { slope, intercept, r } = linearFit(times, values)
  if (Math.abs(r) < RISER_R_MIN) return null

  const duration = times[times.length - 1]
  const startValue = intercept
  const endValue = intercept + slope * duration
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const relativeChange = mean > 0 ? (endValue - startValue) / mean : 0
  return { r, relativeChange, rising: endValue > startValue }
}

/**
 * Risers on the `other` stem, every section: a run of both rising RMS *and*
 * rising centroid into the section's own boundary, agreeing with each other,
 * per the module brief's "require both features to agree and gate hard".
 *
 * `sweeps` (this section's own `detectFilterSweeps` output) is consulted so a
 * section already carrying a whole-section sweep is not *also* scored as a
 * riser: a section-length rising sweep and a last-bars rising riser are the
 * same physical trend seen at two different window sizes, and re-detecting
 * it as a second, separate effect would double the emission for one cause.
 *
 * `emit` is `false` when the qualifying window is shorter than the section
 * itself - this pipeline has a verified idiom for "ramp across this whole
 * section" (`arrange()` resets each entry's own pattern to cycle zero - see
 * this module's sibling `emit.mjs` wiring) but none, checked directly against
 * a probe of `arrange()`'s own semantics, for "ramp across only the last few
 * bars of a longer one" without either misaligning the ramp's phase or
 * risking clipping mid-note. Per this module's own "omit rather than invent":
 * a detected-but-unscopable riser is reported (`detected: true, emit: false`)
 * rather than emitted onto the wrong span.
 */
export function detectRisers(otherBuf, grid, sections, sweeps) {
  const audio = decodeWav(otherBuf)
  return sections.map((section, i) => {
    if (sweeps[i]) return null
    const windowBars = Math.min(RISER_WINDOW_BARS_MAX, section.bars)
    const toSec = grid.barAt(section.startBar + section.bars)
    const fromSec = grid.barAt(section.startBar + section.bars - windowBars)

    const rms = rmsTrend(audio, fromSec, toSec)
    if (!rms || !rms.rising || Math.abs(rms.relativeChange) < RISER_MIN_RELATIVE_RISE) return null

    const { times, centroids } = centroidSeries(audio, fromSec, toSec)
    const centroidTrend = trendFromCentroid(times, centroids, { rMin: RISER_R_MIN, minRelativeChange: RISER_MIN_RELATIVE_RISE })
    if (!centroidTrend || !centroidTrend.rising) return null
    const mapped = mappedLpfRange(centroidTrend.startHz, centroidTrend.endHz)
    if (!mapped) return null

    return {
      windowBars,
      rmsR: round3(rms.r),
      rmsRelativeChange: round3(rms.relativeChange),
      startHz: Math.round(centroidTrend.startHz),
      endHz: Math.round(centroidTrend.endHz),
      lpfStart: mapped.lpfStart,
      lpfEnd: mapped.lpfEnd,
      centroidR: round3(centroidTrend.r),
      emit: windowBars === section.bars,
    }
  })
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Every detector, run once over a rebuild's stems and sections.
 *
 * `drums`/`bass`/`other` are the raw stem WAV buffers `separate()` produces
 * (matching `profileStems`'s own `{ drums, bass, other }` shape). Kick onsets
 * are computed once here, from the drum stem, and shared across both
 * `detectSidechainStem` calls - `bass` and `other` are scored against the
 * exact same kicks, per the module brief ("kick onsets are already trusted").
 */
export function detectDynamics({ drums, bass, other, grid, sections }) {
  const drumAudio = decodeWav(drums)
  const kickOnsetsSeconds = detectDrumHits(drumAudio, grid).kick.map((hit) => hit.seconds)

  const sweeps = detectFilterSweeps(other, grid, sections)
  const risers = detectRisers(other, grid, sections, sweeps)

  return {
    sidechain: {
      bass: detectSidechainStem(bass, kickOnsetsSeconds, grid, sections),
      other: detectSidechainStem(other, kickOnsetsSeconds, grid, sections),
    },
    sweeps,
    risers,
  }
}

// ============================================================================
// Emission
// ============================================================================

/** Matches the-chase's own `mkKeys`/`mkHeld`/`mkPad`/`mkLead` orbit - reused
 *  rather than invented, so a rebuilt track's duck bus matches the house
 *  idiom `checkDucking` (scripts/check.mjs) already validates against. */
const ORBIT_OTHER = 2
/** the-chase never puts bass on a duck-target orbit (bass/sub carry no duck
 *  at all), so this has no hand-authored precedent to match - the next
 *  integer after `ORBIT_OTHER`, kept out of the drums' and the default (1)
 *  orbit's way. */
const ORBIT_BASS = 3

const STEM_LAYERS = { bass: ['bass', 'sub'], other: ['chords', 'lead'] }
const STEM_ORBIT = { bass: ORBIT_BASS, other: ORBIT_OTHER }

/**
 * One section's dynamics, as `{ layers, summary }` or `null` if nothing was
 * detected for this section. `layers[name]` is `{ chain }` for duckorbit/
 * orbit (a ready-to-splice string) and/or `{ sweepLpf: { lpfStart, lpfEnd } }`
 * for a sweep/riser (raw numbers - see the sweep block below for why this
 * one is not a pre-built chain string). `presentLayers` is the section's own
 * (post-hearing-check) `LAYERS.filter(l => section.loops[l])` - only a layer
 * actually present may carry `.orbit()`, and `.duckorbit()` on the kick only
 * ever targets an orbit that has something on it this section, or
 * `checkDucking`'s own `duck-missing-orbit` rule fires (`.duckorbit(N)`
 * targeting nothing is a silent no-op with a console warning, per that
 * rule's own comment).
 */
function dynamicsForSectionEmission(dynamics, position, presentLayers) {
  const present = new Set(presentLayers)
  const layers = {}
  const notes = []
  const duckTargets = []
  const duckDepths = []
  const duckAttacks = []

  // `.orbit(N)` on a target layer only means something if `kick` (the only
  // layer this pipeline ever puts `.duckorbit()` on) is actually present to
  // carry the duck this section - if kick failed its own hearing check, its
  // const is never emitted at all (`present` comes from the same post-drop
  // `section.loops` emit.mjs's arrange loop reads), and a target layer left
  // sitting on orbit 2 with nothing duckorbit-ing it is dead wiring: no
  // ducking happens, but the summary would still claim it did.
  const kickPresent = present.has('kick')

  for (const stem of ['other', 'bass']) {
    const pump = dynamics.sidechain[stem][position]
    const stemLayers = STEM_LAYERS[stem].filter((layer) => present.has(layer))
    if (!pump || stemLayers.length === 0 || !kickPresent) continue
    const orbit = STEM_ORBIT[stem]
    for (const layer of stemLayers) {
      layers[layer] = { chain: `.orbit(${orbit})` }
    }
    duckTargets.push(orbit)
    duckDepths.push(pump.depth)
    duckAttacks.push(pump.recoverySeconds)
    notes.push(
      `duck: ${stem} dips ${Math.round(pump.depth * 100)}% and recovers in ${Math.round(pump.recoverySeconds * 1000)}ms ` +
        `(${pump.kicksMeasured}/${pump.kicksInSection} kicks, ${Math.round(pump.consistency * 100)}% phase-locked)`,
    )
  }
  if (duckTargets.length > 0) {
    // Strudel's multi-orbit form is a colon-separated *string*
    // (`.duckorbit("2:3")`, per `@strudel/core/controls.mjs`'s own
    // `duckorbit`/`duckdepth`/`duckattack` doc examples); the single-target
    // form the-chase itself uses is a bare number (`.duckorbit(2)`).
    const join = (values, fmt) => (values.length > 1 ? `"${values.map(fmt).join(':')}"` : fmt(values[0]))
    layers.kick = {
      chain: `.duckorbit(${join(duckTargets, String)}).duckdepth(${join(duckDepths, round2)}).duckattack(${join(duckAttacks, round3)})`,
    }
  }

  // Both sweep and riser only ever target `chords`/`lead` (the `other` stem's
  // layers). A section can measure a real trend there and still have neither
  // layer survive the hearing check (see the-chase's own section 2: a real,
  // measured centroid trend, but no chords or lead confidently heard) - the
  // note is only worth printing when there is a layer left to attach the
  // chain to, or it reads as a claim about an effect nothing carries.
  const otherPresent = STEM_LAYERS.other.filter((l) => present.has(l))

  // Sweep/riser are exposed as raw `{lpfStart, lpfEnd}` numbers, not a
  // pre-built `.lpf(saw.range(...))` chain string - unlike duckorbit/orbit,
  // a sweep's `saw` oscillator has to be `.slow()`-ed by exactly this
  // section's own bar count *divided by* whatever `.slow()` the layer's own
  // loop already applies (a held loop crossing bars already stretches
  // everything nested inside its own `.lpf()` argument by that same factor -
  // checked directly against the runtime, not assumed), and only
  // `emit.mjs`'s `layerExpression` knows that ratio (`section.bars` and the
  // loop's own `slow` are both local to it). Baking a fixed `.slow()` in
  // here would be wrong for every loop shape except a plain 1-bar one.
  const sweep = dynamics.sweeps[position]
  if (sweep && otherPresent.length > 0) {
    for (const layer of otherPresent) {
      layers[layer] = { ...layers[layer], sweepLpf: { lpfStart: sweep.lpfStart, lpfEnd: sweep.lpfEnd } }
    }
    notes.push(`sweep: other centroid ${sweep.startHz}→${sweep.endHz}Hz (r=${sweep.r})`)
  }

  const riser = dynamics.risers[position]
  if (riser?.emit && otherPresent.length > 0) {
    for (const layer of otherPresent) {
      layers[layer] = { ...layers[layer], sweepLpf: { lpfStart: riser.lpfStart, lpfEnd: riser.lpfEnd } }
    }
    notes.push(`riser: other rises into the boundary (rms r=${riser.rmsR}, centroid r=${riser.centroidR})`)
  } else if (riser && otherPresent.length > 0) {
    notes.push(
      `riser: detected in the last ${riser.windowBars} bar(s) but not emitted - shorter than the section itself, ` +
        `and this pipeline has no verified idiom for ramping only part of a longer one`,
    )
  }

  if (notes.length === 0) return null
  return { layers, summary: notes.join(' · ') }
}

/**
 * `detectDynamics`'s output, reshaped into what `emit.mjs` needs to splice
 * into each section's own `arrange()` line: a plain object keyed by section
 * index (not a `Map` - `transcription.sections[i].index` round-trips through
 * `JSON.stringify` as a number key here the same way `emission.json` and
 * every other artifact in this pipeline already keys objects by index).
 *
 * `sections` must carry each section's `loops` (i.e. `transcription.sections`
 * after the hearing-check drop, not `reference.json`'s own `sections`) - see
 * `dynamicsForSectionEmission`'s own comment for why layer presence gates
 * `.orbit()`/`.duckorbit()`.
 */
export function dynamicsForEmission(dynamics, transcriptionSections, layerNames) {
  const result = {}
  transcriptionSections.forEach((section, position) => {
    const present = layerNames.filter((layer) => section.loops?.[layer])
    const entry = dynamicsForSectionEmission(dynamics, position, present)
    if (entry) result[section.index] = entry
  })
  return result
}
