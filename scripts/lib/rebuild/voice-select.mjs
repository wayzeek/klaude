/**
 * Which synth voice a melodic layer gets, decided from measurement rather
 * than hardcoded.
 *
 * `emit.mjs`'s `SOUNDS` used to write every track's lead as `gm_tenor_sax`,
 * the reference track's own instrument, on every record this pipeline ever
 * rebuilds. On a record whose lead is a soft synth (Bicep's "Glue"), a
 * sustained GM sax patch reads as a car horn - not close to the same
 * instrument, not a defensible approximation, just wrong. This module
 * measures the source instead of assuming it.
 *
 * The method: isolate frames around the *selected lead notes'* own onsets in
 * the `other` stem (`stem-profile.mjs`'s `profileOnsetTimbre`, built for
 * exactly this), and read off a small, honest set of numbers - spectral
 * centroid, high-frequency energy relative to the fundamental region, attack
 * time, sustain length - none of which require a new FFT or a new onset
 * detector; both already exist and this only points them at different
 * instants than `sound-match.mjs`'s broadband stem reads do.
 *
 * What that CANNOT honestly establish, stated up front rather than
 * discovered by a bad call later: whether the source is a reed instrument at
 * all. A saxophone's conical bore produces close to a full harmonic series,
 * not the sharp odd/even asymmetry a clarinet's cylindrical one does, so
 * nothing in "brighter," "richer" or "faster attack" separates "this is a
 * sax" from "this is a bright synth lead" - both can measure identically, or
 * even the wrong way round, on every feature this module or any of its
 * primitives can compute from a mixed `other` stem. Measured directly on the
 * two tracks this module has ground truth or an independent check for (see
 * the voice-selection report): the reference track's real tenor sax reads
 * DARKER than Bicep's real soft synth on every single signal below -
 * centroid, brightness ratio and attack all point the same, wrong-for-a-
 * naive-assumption direction. No threshold in this feature space sends the
 * sax to a "reedy" bucket without also catching the synth, or catching
 * neither. Chasing one that happened to split these two examples anyway
 * would be fitting noise, not measuring an instrument family; see
 * `MAX_HARMONIC`/`oddEvenRatio` in stem-profile.mjs for the same honesty
 * applied to the one feature that looks like it should help and does not.
 *
 * The rule this module ships instead: `gm_tenor_sax` (or any sampled
 * "acoustic" patch) is never a selectable output of this decision, at any
 * measurement. The user's own standing rule for this pipeline's material is
 * that an acoustic patch reads as wrong on electronic material unless the
 * audio clearly says otherwise - and "clearly" is exactly what this
 * pipeline's measurements cannot say about reed instruments. What the
 * measurements CAN say - is this source bright and quick-attacked, or dark
 * and slow - is used instead, to choose between two synth waveforms already
 * unused by every other layer (`triangle`, mellow; `square`, bright - see
 * `LEAD_VOICES`), never to reach for the sax.
 *
 * Known, accepted cost: the reference track's lead regresses from
 * `gm_tenor_sax` (a genuinely good match for that one track) to a synth
 * voice under this rule. That is the deliberate trade the module doc comment
 * above describes, not an oversight - see the report for the numbers.
 */

import { profileOnsetTimbre } from './stem-profile.mjs'
import { gridFromJson, sectionRange, stepSeconds, stepsPerBar } from './transcribe/quantize.mjs'

/**
 * `lead`'s two selectable synth voices. Neither collides with another
 * layer's `sound` string (`bass` is `sawtooth`, `sub` is `sine`, `chords` is
 * `gm_epiano1`) - `verify-emission.mjs` sorts a queried event back into its
 * layer by matching `event.value.s` against each layer's own distinct
 * `sound`, so a lead voice that reused `sawtooth` or `sine` would have its
 * own events silently counted as bass's or sub's instead. No `.lpf()` is
 * baked into either suffix: `sound-match.mjs` already derives a per-track
 * `.lpf()` for the `lead` layer from the same `other` stem's broadband tilt
 * (see its own `deriveTrackEffects`), spliced in right after this suffix -
 * adding a second, competing cutoff here would fight that measurement
 * instead of composing with it.
 */
export const LEAD_VOICES = Object.freeze({
  mellow: Object.freeze({ sound: 'triangle', suffix: '.s("triangle")' }),
  bright: Object.freeze({ sound: 'square', suffix: '.s("square")' }),
})

/** Fewer onsets than this and there is nothing to measure a timbre from -
 *  matches `stem-profile.mjs`'s own `MIN_TIMBRE_ONSETS`, restated here (not
 *  imported) for the same reason `sound-match.mjs` restates
 *  `MIN_DECAY_ONSETS`: this module needs it to explain a default to a human
 *  reader, not as an implementation detail of the measurement itself. */
const MIN_VOICE_ONSETS = 3

/** A spectral centroid at or above this reads as "bright" rather than
 *  "dark." Spectral-centroid brightness studies commonly place the
 *  dark/bright divide for a melodic voice somewhere in the 1-2kHz presence
 *  region, below the "air" band and above the "mid" band `analyze.mjs`
 *  already names (BANDS: mid 400-2000Hz, high-mid 2000-6000Hz) - this sits
 *  at the boundary between them, not fitted to either example track's own
 *  measured value (see the module doc comment for why that fitting would be
 *  the wrong move). */
const CENTROID_BRIGHT_HZ = 2000
/** `brightRatio` at or above this - energy above 3kHz reaching at least a
 *  third of the fundamental region's own energy - reads as harmonically rich
 *  rather than a near-pure tone. A plain sine has almost none of this; a
 *  buzzy, harmonically dense tone has a great deal. One third is the
 *  midpoint of "barely present" and "comparable to the fundamental region
 *  itself," not a value chosen to split the two example tracks. */
const BRIGHT_RATIO_THRESHOLD = 0.33
/** An attack at or under this reads as fast/articulated rather than a slow
 *  pad swell - roughly the boundary a plucked or struck attack sits inside
 *  and a bowed/blown crescendo sits outside, in general terms independent of
 *  either example track's own number. */
const FAST_ATTACK_SECONDS = 0.035

/**
 * Onset seconds (and known MIDI, when the layer has one) for every event a
 * layer's loops actually produce, expanded across every section and every
 * repetition inside it.
 *
 * This is deliberately a second, independent expansion of the same loops
 * `emit.mjs`'s `loopToPatterns` and `verify-emission.mjs`'s per-section
 * comparison already expand, not a shared call into either - both of those
 * build mini-notation strings or structural comparisons, and pulling just
 * "when did this event start, and at what pitch" out of them would be a
 * larger, riskier coupling than reimplementing the handful of lines that
 * answer only that question. `transcription.grid` is the plain JSON shape
 * `emitTrack`/`verifyEmission` both take, not a runtime grid - reconstructed
 * with `gridFromJson` here for the same reason they do it themselves.
 */
export function layerOnsets(transcription, layer) {
  const grid = gridFromJson(transcription.grid)
  const perBar = stepsPerBar(grid)
  const perStep = stepSeconds(grid)
  const onsets = []

  for (const section of transcription.sections) {
    const loop = section.loops?.[layer]
    if (!loop) continue
    const range = sectionRange(grid, section)
    const loopSteps = loop.loopBars * perBar
    const repetitions = Math.ceil(section.bars / loop.loopBars)
    for (let rep = 0; rep < repetitions; rep++) {
      for (const event of loop.events) {
        const step = rep * loopSteps + event.step
        if (step >= section.bars * perBar) continue
        onsets.push({ seconds: range.fromSec + step * perStep, midi: event.midi ?? null })
      }
    }
  }
  return onsets
}

/** One human-readable line per measured signal, plus whether it read bright
 *  or dark - shared by `selectLeadVoice`'s decision and its own notes so the
 *  two can never independently disagree about what was measured. */
function describeSignal(label, value, formatValue, threshold, formatThreshold, isBright) {
  const reads = isBright ? 'bright' : 'dark'
  return `lead: ${label} ${formatValue(value)} (reads ${reads}, threshold ${formatThreshold(threshold)})`
}

/**
 * Lead voice from measured timbre features (`stem-profile.mjs`'s
 * `profileOnsetTimbre` shape), never `gm_tenor_sax` - see the module doc
 * comment for why that exclusion is the point, not a gap.
 *
 * Each of up to three signals (centroid, brightness ratio, attack speed)
 * votes bright or dark independently; the voice is `bright` only on a strict
 * majority of the signals actually measured. Missing signals do not vote, and
 * a tie (equally split, or nothing measured at all) resolves to `mellow` - the
 * more conservative synth-family default, on the theory that overshooting
 * brightness reads worse (harsher, more likely to clash) than undershooting
 * it.
 */
export function selectLeadVoice(features) {
  const notes = []

  if (!features || features.count < MIN_VOICE_ONSETS) {
    const seen = features?.count ?? 0
    notes.push(
      `lead: defaulted to ${LEAD_VOICES.mellow.sound} - only ${seen} onset(s) with a usable window in the other stem, fewer than the ${MIN_VOICE_ONSETS} needed to trust a timbre measurement`,
    )
    return { sound: LEAD_VOICES.mellow.sound, suffix: LEAD_VOICES.mellow.suffix, notes }
  }

  let brightVotes = 0
  let signals = 0

  if (features.centroidHz != null) {
    signals++
    const isBright = features.centroidHz >= CENTROID_BRIGHT_HZ
    if (isBright) brightVotes++
    notes.push(
      describeSignal(
        'onset-aligned spectral centroid',
        features.centroidHz,
        (v) => `${Math.round(v)}Hz`,
        CENTROID_BRIGHT_HZ,
        (v) => `${v}Hz`,
        isBright,
      ),
    )
  }

  if (features.brightRatio != null) {
    signals++
    const isBright = features.brightRatio >= BRIGHT_RATIO_THRESHOLD
    if (isBright) brightVotes++
    notes.push(
      describeSignal(
        'energy above 3kHz vs the 400-2000Hz fundamental region',
        features.brightRatio,
        (v) => `${Math.round(v * 100)}%`,
        BRIGHT_RATIO_THRESHOLD,
        (v) => `${Math.round(v * 100)}%`,
        isBright,
      ),
    )
  }

  if (features.attack?.seconds != null) {
    signals++
    const isBright = features.attack.seconds <= FAST_ATTACK_SECONDS
    if (isBright) brightVotes++
    notes.push(
      `lead: mean attack ${Math.round(features.attack.seconds * 1000)}ms across ${features.attack.count} onsets (reads ${isBright ? 'fast' : 'slow'}, threshold ${Math.round(FAST_ATTACK_SECONDS * 1000)}ms)`,
    )
  } else {
    notes.push('lead: attack left unmeasured - too few onsets cleared the envelope window to trust a rise time')
  }

  if (features.sustain?.seconds != null) {
    notes.push(`lead: mean sustain (onset-aligned decay) ${Math.round(features.sustain.seconds * 1000)}ms across ${features.sustain.count} onsets - reported, not scored (see the module doc comment)`)
  }

  if (features.oddEvenRatio != null) {
    notes.push(
      `lead: odd/even harmonic energy ratio ${features.oddEvenRatio.toFixed(2)} at the transcribed notes' own fundamentals - a data point, not a decision input (see stem-profile.mjs's oddEvenRatio comment: a saxophone's conical bore does not produce the odd-harmonic skew that would make this diagnostic)`,
    )
  }

  const bright = signals > 0 && brightVotes > signals / 2
  const voice = bright ? LEAD_VOICES.bright : LEAD_VOICES.mellow
  notes.unshift(
    `lead: chosen ${voice.sound} (${bright ? 'bright' : 'mellow'} synth family, ${brightVotes}/${signals} measured signal(s) read bright) - never gm_tenor_sax; see the module doc comment for why a reed instrument cannot be earned from these measurements`,
  )
  return { sound: voice.sound, suffix: voice.suffix, notes }
}

/**
 * The pipeline's one entry point: measure the `other` stem at the
 * transcription's own selected lead onsets, and decide.
 *
 * `otherWavBuf` missing or no lead onsets at all both fall through to
 * `selectLeadVoice`'s own too-few-onsets default rather than being handled
 * specially here - one place decides what "not enough evidence" means.
 */
export function deriveLeadVoice(transcription, otherWavBuf) {
  const onsets = layerOnsets(transcription, 'lead')
  if (!otherWavBuf || onsets.length === 0) {
    return selectLeadVoice(null)
  }
  const features = profileOnsetTimbre(otherWavBuf, onsets)
  return selectLeadVoice(features)
}
