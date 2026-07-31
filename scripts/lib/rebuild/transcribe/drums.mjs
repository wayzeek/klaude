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
 * shows the same failure mode, just smaller: on the real
 * drum stem's four-on-the-floor bars, normalised flux at its production
 * default floor (0.045) scores 11.3% precision on the snare band and 53.0% on
 * hats, against `bandEnergyRise` at a measured floor scoring 19.7% and 78.8%.
 * Raising flux's own floor closes most, not all, of that gap - it does not
 * close it, and using one mechanism for every role instead of two is simpler
 * and (since `bandEnergy` is already computed for velocity) cheaper. Each
 * role still names its detector and floor rather than a hardcoded branch,
 * because this happened to converge on the same mechanism for all three; it
 * is not assumed to generalise to different material.
 *
 * `foldToLoop` (below) drops anything that does not recur often enough to be
 * part of the loop - by construction, that includes real one-off content
 * like a fill or a crash. `fills.mjs` looks at exactly what got dropped and
 * reclaims it when (and only when) it clears a hard gate; see its own doc
 * comment.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { ONSET_HOP } from '../../dsp.mjs'
import { bandEnergy, bandEnergyRise, bandFlatness, bandNovelty, pickBandOnsets } from './bands.mjs'
import { detectVariation, extractPreFoldImpact } from './fills.mjs'
import { foldToLoop, sectionRange, stepAt, stepDrift, stepsPerBar } from './quantize.mjs'

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
 * floor measured for it against the real drum stem.
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
 *
 * `snare` also absorbs rim, stick and clap content by design, per #41's own
 * scope note at the top of this file: those have no home in moltek's three
 * roles, and the nearest one is the intended landing spot, not a bug. That
 * makes scoring the snare role against a single snare-family sound (e.g.
 * `crate_sd` ghost notes alone) understate it badly - a real, measured
 * example on the-chase: 37.9% precision against `crate_sd`
 * alone, 88.3% precision once `crate_stick` (rim/stick) is folded into the
 * reference too. Score this role against every percussion sound plausibly
 * living in 180-1200 Hz, not just the one named "snare" in the source.
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
 * A snare hit coinciding with a kick is that kick's own splatter, not a real
 * hit, when the snare band's content at that instant is more tonal than
 * broadband - `bandFlatness` below this.
 *
 * The first version of this rule compared raw levels across the kick and
 * snare bands (`snare.level > kick.level * ratio`), the same shape as
 * `suppressSnareCrack`. It shipped, then failed review: `bandEnergy` divides
 * by bin count, so a kick concentrated in ~2 bins reads a systematically
 * higher level than a snare spread across ~23, for reasons that have nothing
 * to do with which one is real. Checked whether comparing bandwidth-corrected
 * (total, not per-bin) energy fixes it - it cannot, and not by a small margin:
 * that correction is an exact multiplicative rescale by a fixed constant
 * (sqrt(23/2) ≈ 3.39, verified against the measured numbers to four
 * decimals), so it moves every ratio by the same factor and changes no
 * threshold decision at all. The actual problem sits one level down: a
 * synthetic backbeat snare - the standard kick-every-beat, snare-on-two-
 * and-four pattern this rule must not break - never gets its raw level
 * (in *either* unit) above the ceiling this recording's real kick bleed sets,
 * even at 8x its normal gain. A tonal kick's energy concentrates into a
 * couple of bins; a noise-based snare's spreads across many; no rescaling of
 * the *same* magnitude ratio changes that relationship, in any units.
 *
 * `bandFlatness` sidesteps the whole comparison: it never touches the kick
 * band at all. A kick's harmonics bleeding into the snare band are still a
 * few discrete tones there, and read as low flatness in the snare band on
 * their own terms; a real snare hit (or a real backbeat snare landing on a
 * kick step) is broadband noise in that band regardless of what else is
 * happening in a completely different band. Measured on the real drum stem's
 * bars 8-39, against `hits.kick` exactly as this module produces it (floor
 * 10, not a lower one - an earlier sweep used the wrong floor and looked
 * better than it is): precision is flat at 45.0% - the ratio rule's own
 * number - for every threshold from 0.68 to 0.84, with recall unchanged at
 * 97.8% across that whole range. The plateau's ceiling, not its exact value,
 * is what matters here: pushing the threshold higher stops helping because
 * the residual false positives left at 45.0% are themselves broadband
 * (most likely footstep bleed, left unaddressed), not
 * tonal, so flatness alone cannot tell them from a real hit either. 0.75 sits
 * in the middle of that plateau, comfortably clear of both a synthetic
 * backbeat snare's minimum (0.84-0.96) and confirmed kick splatter's maximum
 * (0.68) on one side, and this module's own dedicated bleed fixture (0.54-
 * 0.58) on the other.
 */
const SNARE_FLATNESS_THRESHOLD = 0.75
/**
 * A hat coinciding with a snare is that snare's crack when the hat band holds
 * less than this share of the snare band's energy at the same instant.
 *
 * Compared on RAW band energy, not on velocity. Each role's velocity is
 * normalised against that role's own 90th percentile, so a loud snare and a
 * loud hat both come out near 1 and a ratio between them measures nothing.
 *
 * Measured on the real drum stem, against the snare set
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
  const snareRole = DRUM_ROLES.find((role) => role.name === 'snare')
  const snareFlatness = snareRole ? bandFlatness(audio, snareRole) : null
  suppressKickBleed(hits, snareFlatness, hopSeconds)
  suppressSnareCrack(hits)
  return hits
}

/**
 * Drop snare detections that are really a kick's own splatter.
 *
 * A kick's attack has energy well above its own band - the same mechanism
 * that made `bandNovelty` over-trigger on the kick band in Task 3, just seen
 * from the neighbouring band instead of the kick's own. Left alone, this
 * track's kick pattern (four-on-the-floor almost everywhere) gets echoed into
 * the snare role as a confident, densely-repeating loop, even though this
 * track's real snare-role content is a near-silent ghost pattern. A role that
 * cannot be heard confidently must come out `null`, not a wrong loop that
 * happens to repeat every bar because the kick driving it does.
 *
 * Only a snare hit that lands on the *same step* as a kick hit is even
 * examined - a snare with no coincident kick has nothing to be suspicious
 * of. Among those, `bandFlatness` (see its own doc comment and
 * `SNARE_FLATNESS_THRESHOLD` above for why this replaced a raw-level ratio)
 * decides whether the snare band's content there looks like the kick's own
 * tonal bleed or like a genuine broadband hit.
 */
function suppressKickBleed(hits, snareFlatness, hopSeconds) {
  if (!hits.kick?.length || !hits.snare?.length || !snareFlatness) return
  const kickSteps = new Set(hits.kick.map((hit) => hit.step))
  hits.snare = hits.snare.filter((snare) => {
    if (!kickSteps.has(snare.step)) return true
    const hop = Math.min(snareFlatness.length - 1, Math.round(snare.seconds / hopSeconds))
    return snareFlatness[hop] >= SNARE_FLATNESS_THRESHOLD
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

      // A first-downbeat crash has to be pulled out before folding, not
      // after: `foldToLoop` buckets a drum role purely by step position, so
      // an ordinary recurring downbeat and one outlier-loud repetition of it
      // land in the same bucket and are kept or discarded together - see
      // fills.mjs's `extractPreFoldImpact` doc comment for the full case.
      const { events: foldable, extracted } = extractPreFoldImpact(events, range.fromStep, stepsPerBar(grid))
      // Extracting the impact can shave just enough agreement off the loop's
      // own downbeat bucket to push an otherwise genuinely repeating pattern
      // below foldToLoop's own agreement gate (four ordinary-looking
      // repetitions minus the one now-extracted crash score 3/4 = 0.75,
      // under the 0.9 the gate wants) - which would fold to a needlessly
      // long loop instead of the compact one the pattern actually is. The
      // natural loop length is determined from the UNMODIFIED events first,
      // then the real fold is forced to that exact length: `foldToLoop` with
      // a single candidate always returns that candidate's own fold, bypassing
      // the agreement gate entirely (see `foldAgainstCandidates`'s own
      // fallback), which is correct here - the length is already trusted,
      // only the bucket contents (now missing the extracted outlier) need
      // re-scoring.
      const naturalLoopBars = extracted ? foldToLoop(events, section, grid).loopBars : null
      const folded = foldToLoop(foldable, section, grid, naturalLoopBars ? { candidates: [naturalLoopBars] } : undefined)
      if (folded.events.length === 0) return null

      // What the fold discarded, reclaimed if (and only if) it is a genuine
      // fill or crash/impact - see fills.mjs's own doc comment for the gate.
      // `null` when nothing clears it, which is the expected, sanctioned
      // outcome for most sections: #23 asks for the machinery to ship even
      // when it emits nothing, not for a fill on every section.
      // `extracted` is re-localised the same way `foldToLoop` localises its
      // own `discarded` members (absolute step minus the section's own
      // start) before being folded in, so `detectCrash`'s `step === 0` check
      // means the same thing for both sources.
      const discarded = extracted ? [...folded.discarded, { ...extracted, step: extracted.step - range.fromStep }] : folded.discarded
      const variation = detectVariation(discarded, folded, section, grid)

      return {
        loopBars: folded.loopBars,
        events: folded.events,
        // The loop is only as trustworthy as its weakest half: how sure we are
        // of the individual hits, and how well the section actually repeated.
        confidence: meanConfidence * Math.max(folded.agreement, 0.25),
        variation,
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
