/**
 * Drum transcription: three band-limited onset streams, quantised per section.
 *
 * Classification is per band rather than per onset, which is the only approach
 * that survives simultaneous hits. A single broadband novelty curve produces
 * one peak when a kick and a hat land on the same sixteenth, and no amount of
 * cleverness downstream can recover two events from one peak. Three curves
 * report the hit twice, once in each band, which is what actually happened.
 *
 * What this cannot do, per #41: toms, rides and claps have no home in moltek's
 * three drum roles. A tom lands in the snare band and is emitted as a snare; a
 * ride lands in the hats band. That is a deliberate approximation, not a bug.
 * Dense hi-hat work smears, because a 1024-point window at 44.1 kHz cannot
 * resolve two hits 20 ms apart.
 *
 * Every role uses `bandEnergyRise` (the rising edge of the band's own energy
 * envelope), not `bandNovelty` (magnitude-normalised flux). Task 3 built
 * `bandEnergyRise` for the kick band specifically, where normalised flux's
 * denominator (the band's own recent magnitude) shrinks through a decay and
 * lets ordinary jitter clear the floor for the whole tail: 26.6% precision at
 * 100% recall. Measuring the same ground-truth method against snare and hats
 * (task-4-report.md) shows the same failure mode, just smaller: on the real
 * drum stem's four-on-the-floor bars, normalised flux at its production
 * default floor (0.045) scores 11.3% precision on the snare band and 53.0% on
 * hats, against `bandEnergyRise` at a measured floor scoring 19.7% and 78.8%.
 * Raising flux's own floor closes most, not all, of that gap - it does not
 * close it, and using one mechanism for every role instead of two is simpler
 * and (since `bandEnergy` is already computed for velocity) cheaper. Each
 * role still names its detector and floor rather than a hardcoded branch,
 * because this happened to converge on the same mechanism for all three; it
 * is not assumed to generalise to different material.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { ONSET_HOP } from '../../dsp.mjs'
import { bandEnergy, bandEnergyRise, bandNovelty, pickBandOnsets } from './bands.mjs'
import { foldToLoop, sectionRange, stepAt, stepDrift } from './quantize.mjs'

/**
 * Onset detectors a role can name. Each takes the decoded audio, the role's
 * band, and the role's own `bandEnergy` output (already computed for
 * velocity, reused here rather than run twice) and returns the curve
 * `pickBandOnsets` picks peaks from.
 */
const DETECTORS = {
  flux: (audio, role) => bandNovelty(audio, role),
  energyRise: (_audio, _role, energy) => bandEnergyRise(energy),
}

/**
 * The three bands, one per moltek drum layer, each with the detector and
 * floor measured for it against the real drum stem (task-4-report.md).
 *
 * `kick` stops at 100 Hz rather than reaching up to 150: above that a bassline's
 * fundamental starts triggering the curve, and a bass note is not a kick. Its
 * floor of 10 is `bandEnergyRise`'s own calibration, carried over from Task 3.
 * `snare` is the body, not the crack - the crack sits in the hats band and
 * would double every snare as a hat without `suppressSnareCrack` below. The
 * same band also catches the kick's own broadband splatter; `suppressKickBleed`
 * exists because that bleed repeats every bar just like a real kick pattern
 * does, and a per-section confidence gate has no way to tell the two apart on
 * sharpness alone - it needed a second signal, not a stricter version of the
 * first one.
 * `hats` starts at 5 kHz, above where a snare's body ends.
 */
export const DRUM_ROLES = Object.freeze([
  Object.freeze({ name: 'kick', lo: 20, hi: 100, detector: 'energyRise', floor: 10 }),
  Object.freeze({ name: 'snare', lo: 180, hi: 1200, detector: 'energyRise', floor: 1 }),
  Object.freeze({ name: 'hats', lo: 5000, hi: 16000, detector: 'energyRise', floor: 0.12 }),
])

/** A role needs at least this many hits per section to be worth emitting. Below
 *  it, what we found is more likely bleed from another role than a real part. */
const MIN_HITS_PER_SECTION = 2
/** And its mean onset confidence has to clear this. */
const MIN_ROLE_CONFIDENCE = 0.15
/** Velocity is normalised against this percentile of the role's own hits, so a
 *  quiet track is not transcribed as uniformly quiet. The top of the range is
 *  trimmed because one crash-loud hit would flatten everything else. */
const VELOCITY_PERCENTILE = 0.9
/**
 * A snare hit coinciding with a kick is that kick's own broadband splatter
 * when the snare band holds less than this share of the kick band's energy
 * at the same instant.
 *
 * Measured on the real drum stem, bars 8-39 (task-4-report.md): every snare
 * onset that lands on the same step as a kick onset and is confirmed a false
 * positive against ground truth has a snare/kick raw-level ratio between
 * 0.109 and 0.658 (median 0.255) - and, in the same window, not one of the
 * onsets confirmed a true positive coincides with a kick onset at all. The
 * two populations don't overlap, so this ratio isn't a compromise between two
 * competing distributions the way `CRACK_SUPPRESSION_RATIO` is - it only has
 * to clear the confirmed-bleed ceiling. Set to 0.7, just above that 0.658
 * ceiling: on the whole track this drops the snare role from 533 onsets to
 * 236 and raises bars-8-39 precision from 19.7% to 45.0% at unchanged recall
 * (97.8%, the same single miss as before - bar 37's one quiet syncopated
 * ghost hit, already lost to the kick detector's own floor in Task 3).
 */
const KICK_BLEED_RATIO = 0.7
/**
 * A hat coinciding with a snare is that snare's crack when the hat band holds
 * less than this share of the snare band's energy at the same instant.
 *
 * Compared on RAW band energy, not on velocity. Each role's velocity is
 * normalised against that role's own 90th percentile, so a loud snare and a
 * loud hat both come out near 1 and a ratio between them measures nothing.
 *
 * Measured on the real drum stem (task-4-report.md), against the snare set
 * `suppressKickBleed` has already cleaned: of every hat onset landing on the
 * same step as a (cleaned) snare onset - 210 of 589 hat onsets do, down from
 * 496 before that cleanup - the hat/snare raw energy ratio has median 0.214
 * and a 5th percentile of 0.1011, because 180-1200 Hz naturally carries far
 * more energy than 5-16 kHz in any mixed track - the reference profile's own
 * band tilt is -25 to -32 dB up there. There is no gap in that distribution
 * separating "this hat is really the snare's crack" from "this hat is real
 * and the mix just has more low-mid energy right now": a placeholder of 0.35
 * sits well above the 90th percentile (0.405) and would drop most hat hits in
 * the whole track, the great majority of them real. Set to 0.10, matching the
 * measured 5th percentile (0.1011): on the whole track this drops 10 of the
 * 210 coincident pairs - 1.7% of all hat onsets - rather than the 74% the
 * placeholder would have cost.
 */
const CRACK_SUPPRESSION_RATIO = 0.1

/**
 * Every hit in every band, quantised to the grid.
 *
 * Exported separately from `transcribeDrums` so the hearing check and any
 * future debugging can see the raw detections before folding discards
 * anything.
 */
export function detectDrumHits(audio, grid) {
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const hits = {}

  for (const role of DRUM_ROLES) {
    // Computed once per role: every detector needs it for velocity, and
    // `energyRise` reuses it directly instead of a second FFT pass.
    const energy = bandEnergy(audio, role)
    const curve = DETECTORS[role.detector](audio, role, energy)
    const onsets = pickBandOnsets(curve, hopSeconds, role.floor == null ? {} : { floor: role.floor })

    // Velocity from band energy at the hit, not from the detection curve.
    // Flux/rise measure how abruptly the sound started; velocity is how loud
    // it is, and a soft hit with a sharp attack is still a soft hit.
    const levels = onsets.map((onset) => {
      const hop = Math.min(energy ? energy.length - 1 : 0, Math.round(onset.seconds / hopSeconds))
      return energy ? energy[hop] : 0
    })
    const reference = percentile(levels, VELOCITY_PERCENTILE) || 1

    hits[role.name] = onsets.map((onset, i) => ({
      seconds: onset.seconds,
      step: stepAt(grid, onset.seconds),
      driftSteps: stepDrift(grid, onset.seconds),
      velocity: Math.max(0.05, Math.min(1, levels[i] / reference)),
      confidence: onset.confidence,
      strength: onset.strength,
      // Raw band energy, kept unnormalised so it can be compared across bands.
      level: levels[i],
    }))
  }

  // Order matters: clean the snare role of kick bleed first, then let
  // `suppressSnareCrack` judge hats against that cleaned set rather than one
  // still full of onsets that were never a snare in the first place.
  suppressKickBleed(hits)
  suppressSnareCrack(hits)
  return hits
}

/**
 * Drop snare detections that are really a kick's own broadband splatter.
 *
 * A kick's attack has energy well above its own band - the same mechanism
 * that made `bandNovelty` over-trigger on the kick band in Task 3, just seen
 * from the neighbouring band instead of the kick's own. Left alone, this
 * track's kick pattern (four-on-the-floor almost everywhere) gets echoed into
 * the snare role as a confident, densely-repeating loop, even though this
 * track's real snare-role content is a near-silent ghost pattern. A role that
 * cannot be heard confidently must come out `null`, not a wrong loop that
 * happens to repeat every bar because the kick driving it does.
 */
function suppressKickBleed(hits) {
  if (!hits.kick?.length || !hits.snare?.length) return
  const kickByStep = new Map()
  for (const hit of hits.kick) {
    const existing = kickByStep.get(hit.step)
    if (!existing || hit.level > existing.level) kickByStep.set(hit.step, hit)
  }
  hits.snare = hits.snare.filter((snare) => {
    const kick = kickByStep.get(snare.step)
    if (!kick) return true
    return snare.level > kick.level * KICK_BLEED_RATIO
  })
}

/**
 * Drop hat detections that are really a snare's high-frequency crack.
 *
 * A snare has energy from 200 Hz to well past 8 kHz, so it fires the hats band
 * too. Left alone, every backbeat is transcribed as a snare AND a hat, which
 * is audibly wrong on playback and quietly wrong in the hearing check.
 */
function suppressSnareCrack(hits) {
  if (!hits.snare?.length || !hits.hats?.length) return
  const snareByStep = new Map()
  for (const hit of hits.snare) {
    const existing = snareByStep.get(hit.step)
    if (!existing || hit.level > existing.level) snareByStep.set(hit.step, hit)
  }
  hits.hats = hits.hats.filter((hat) => {
    const snare = snareByStep.get(hat.step)
    if (!snare) return true
    // Raw energies, so the two bands are measured in the same units.
    return hat.level > snare.level * CRACK_SUPPRESSION_RATIO
  })
}

/**
 * One quantised loop per role per section.
 *
 * Returns an object keyed by role, each an array parallel to `sections`. A
 * `null` entry means the role was not heard confidently in that section and
 * must be omitted rather than emitted wrong.
 */
export function transcribeDrums(wavBuf, grid, sections) {
  const audio = decodeWav(wavBuf)
  const hits = detectDrumHits(audio, grid)
  const result = {}

  for (const role of DRUM_ROLES) {
    result[role.name] = sections.map((section) => {
      const range = sectionRange(grid, section)
      const inSection = hits[role.name].filter((hit) => hit.step >= range.fromStep && hit.step < range.toStep)

      if (inSection.length < MIN_HITS_PER_SECTION) return null
      const meanConfidence = inSection.reduce((sum, hit) => sum + hit.confidence, 0) / inSection.length
      if (meanConfidence < MIN_ROLE_CONFIDENCE) return null

      const events = inSection.map((hit) => ({
        step: hit.step,
        length: 1,
        velocity: hit.velocity,
        confidence: hit.confidence,
        midi: null,
        symbol: null,
        driftSteps: hit.driftSteps,
      }))
      const folded = foldToLoop(events, section, grid)
      if (folded.events.length === 0) return null

      return {
        loopBars: folded.loopBars,
        events: folded.events,
        // The loop is only as trustworthy as its weakest half: how sure we are
        // of the individual hits, and how well the section actually repeated.
        confidence: meanConfidence * Math.max(folded.agreement, 0.25),
      }
    })
  }
  return result
}

function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}
