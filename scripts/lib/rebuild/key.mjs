/**
 * Key detection from Basic Pitch's transcribed notes, not the whole-clip FFT
 * chroma `dsp.mjs`'s `detectKey` reads.
 *
 * Why this exists: on the one real record measured end to end (Bicep's
 * "Glue"), the chroma detector returned its answer at 0.094 confidence -
 * barely above a coin flip - and the reconstruction's harmony sounded wrong.
 * Two separate weaknesses compound there. First, audio chroma is a
 * whole-spectrum energy read: a kick's fundamental and low harmonics, a
 * snare's broadband hit, a bass note's own harmonic series above its
 * fundamental, all land in the same twelve bins as the notes actually being
 * played, and nothing about an FFT can tell "this bin is C4's energy" from
 * "this bin is the bleed-through of a bass note's third harmonic, which also
 * happens to be C". Basic Pitch has already solved that problem upstream -
 * it estimates the discrete notes actually sounding, one pitch class per
 * note rather than one blurred energy read per frequency bin - so building
 * the histogram from its notes instead of from chroma removes the whole
 * failure mode at the source, not by tuning around it.
 *
 * Second, and independently: Krumhansl-Kessler profiles are well documented
 * to perform worse on minor keys than major (see the source comment on
 * `ALBRECHT_SHANAHAN_MAJOR_PROFILE` below for the measured comparison), and
 * electronic music of the kind this pipeline targets skews heavily minor.
 * Swapping in Albrecht & Shanahan's corpus-trained profiles - built
 * specifically to correct that asymmetry - fixes this independently of the
 * chroma-vs-notes question above; either fix alone would leave the other
 * failure mode in place.
 *
 * Drums carry no pitch, so only the bass and other stems' notes are read
 * here. A note's contribution is weighted by its own duration - a sustained
 * pad tells you more about the key than a passing sixteenth-note ghost - the
 * same duration-weighted-histogram method Krumhansl's own probe-tone work
 * and most corpus-based key-profile research since has used on symbolic
 * (note-level) data, which is exactly the kind of input Basic Pitch now
 * provides.
 */

import { PITCH_NAMES, correlate } from '../dsp.mjs'

/**
 * Albrecht & Shanahan (2013) key profiles: the probability of each scale
 * degree sounding in C major / C minor, trained on a 982-piece Humdrum
 * **kern corpus specifically to correct Krumhansl-Kessler's well-documented
 * major-mode bias (KK profiles are tuned on major/minor probe-tone ratings
 * collected mostly from major-key contexts, and correlate noticeably worse
 * against real minor-key corpora than they do against major-key ones).
 *
 * Source: Albrecht, J., & Shanahan, D. (2013). "The Use of Large Corpora to
 * Train a New Type of Key-Finding Algorithm: An Improved Treatment of the
 * Minor Mode." Music Perception, 31(1), 59-67. The paper itself does not put
 * the profile in a web-searchable table; these exact values (three-decimal
 * probabilities, summing to 1.000 for major and 0.998 for minor - the same
 * rounding a printed probability table would show) are reproduced verbatim
 * from `optimizer/key_profiles.py`'s `albrecht_shanahan1` entry in
 * github.com/napulen/justkeydding, the reference implementation released
 * alongside Nápoles López, Arthur & Fujinaga, "Key-Finding Based on a Hidden
 * Markov Model and Key Profiles" (DLfM 2019), which cites Albrecht & Shanahan
 * 2013 as its source for this profile and lists it by name in that paper's
 * Table 3 (major/minor/overall accuracy 92.7%/85.5%/90.0%, next to
 * Krumhansl-Schmuckler's 69.0%/83.2%/74.2% on the same evaluation - KK's own
 * minor accuracy is not disastrous in that particular harness, but its major
 * accuracy is, which is the opposite asymmetry from the folk wisdom and a
 * reminder that "KK is bad at minor" is a property of the correlation-based
 * audio pipelines this module lives in, not universal). That same
 * distribution's `albrecht_shanahan2` entry carries the same two profiles
 * re-normalised to more decimal places; not used here because the 1 entry's
 * exact rounding is the stronger evidence of being the literal published
 * table rather than a later re-fit.
 *
 * Index 0 is the tonic, in the same "semitones above the tonic" layout
 * `MAJOR_PROFILE`/`MINOR_PROFILE` in dsp.mjs already use - confirmed by
 * where the mass sits: index 0 (tonic) and index 7 (fifth) are the two
 * largest entries in both vectors, exactly as in the Krumhansl-Kessler pair.
 */
export const ALBRECHT_SHANAHAN_MAJOR_PROFILE = [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081]
export const ALBRECHT_SHANAHAN_MINOR_PROFILE = [0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052]

/**
 * Total sounding duration per pitch class, in seconds, across any number of
 * Basic Pitch note lists.
 *
 * Velocity is deliberately not a factor: Basic Pitch's velocity is a
 * detection-confidence proxy more than a performed dynamic (see
 * basic-pitch.mjs's own doc comment on the 0-127 rescale), and folding it in
 * here would let a handful of loud, brief onsets outweigh a long sustained
 * tone that is much stronger evidence of the key. Duration alone is the
 * standard weighting for a symbolic pitch-class profile.
 */
export function pitchClassHistogram(...noteLists) {
  const histogram = new Array(12).fill(0)
  for (const notes of noteLists) {
    if (!notes) continue
    for (const note of notes) {
      const duration = note.endSec - note.startSec
      if (!(duration > 0)) continue
      histogram[((note.midi % 12) + 12) % 12] += duration
    }
  }
  return histogram
}

/** How many notes across any number of note lists have positive duration -
 *  the same filter `pitchClassHistogram` applies, kept separate because a
 *  count and a duration answer different questions (see the evidence floors
 *  below, which need both). */
function countUsableNotes(...noteLists) {
  let count = 0
  for (const notes of noteLists) {
    if (!notes) continue
    for (const note of notes) if (note.endSec - note.startSec > 0) count++
  }
  return count
}

/**
 * Minimum combined sounding duration (seconds), note count, and distinct
 * pitch classes before there is enough symbolic evidence to correlate
 * against a key profile at all.
 *
 * The only prior gate was total duration greater than zero, which a single
 * spurious note clears trivially - measured directly: a lone 10ms note
 * returned "C major" at confidence 0.0199. Duration and count alone are
 * each independently insufficient: many notes all sharing one pitch class
 * (a monophonic pedal tone) can rack up any amount of duration and count
 * while still describing no key at all - measured directly on a synthetic
 * 20-note, single-pitch-class fixture, which reaches the identical 0.0199
 * confidence the one spurious note does, regardless of its duration or
 * count. Requiring pitch-class diversity too closes that gap. None of these
 * three is tuned to a hard boundary case; they are sized to the smallest
 * evidence a real chord or melodic phrase - not a single note or a held
 * drone - would produce, and the real reference track's combined bass+other
 * notes clear all three by two orders of magnitude.
 */
const MIN_TOTAL_DURATION_SECONDS = 2
const MIN_NOTE_COUNT = 8
const MIN_PITCH_CLASS_DIVERSITY = 3

/**
 * Minimum confidence a note-based key must reach before it is trusted
 * enough to REPLACE the chroma-based key computed earlier in the pipeline
 * (see `rebuild.mjs`) - clearing the evidence floors above proves there was
 * something to correlate, not that the correlation is trustworthy. A short,
 * genuinely ambiguous passage can clear all three floors and still
 * correlate weakly against every key profile at once.
 *
 * Measured directly, on top of the 0.0199 the evidence floors above already
 * reject on their own:
 *   - A synthetic 24-note fixture spread evenly across all twelve pitch
 *     classes (maximally ambiguous, but comfortably clearing every evidence
 *     floor) scores 0.099 - genuinely atonal material, not spurious, and
 *     still not confident.
 *   - A plain eight-note diatonic scale run (unambiguously tonal, modest
 *     evidence) scores 0.194.
 *   - The real reference track's full combined bass+other notes score
 *     0.283, agreeing independently with its own chroma-detected key.
 *   - A clean, repeating eight-note synthetic triad scores 0.400.
 * 0.15 sits between the ambiguous-but-real (0.099) and diatonic (0.194)
 * measurements - the same single-recording caveat this pipeline's other
 * calibrated constants (`HEARING_THRESHOLDS`, `MARGIN_THRESHOLD`) already
 * carry openly.
 */
export const NOTE_KEY_MIN_CONFIDENCE = 0.15

/** The pitch-class index of a key name in this module's own output, e.g.
 *  "F minor" -> 5. Only ever called on names this file itself generated
 *  (`${PITCH_NAMES[tonic]} major/minor`), so an exact match against
 *  `PITCH_NAMES` is enough - no enharmonic normalisation to worry about. */
function tonicPitchClass(keyName) {
  return PITCH_NAMES.indexOf(keyName.split(' ')[0])
}

/**
 * Is this pair exactly a relative major/minor (e.g. "C major" / "A minor"),
 * the one case pitch-class content alone can never resolve because the two
 * keys share all seven scale members? Narrower than `keysMatch` in dsp.mjs,
 * which also folds in fifth-neighbours and parallel keys for a different
 * purpose (deciding whether two answers are "close enough to not be a real
 * disagreement"); this is used below only to decide whether the bass-root
 * tiebreak applies, and firing it on a fifth-neighbour pair - which DO differ
 * by one pitch class and so are not actually indistinguishable - would be
 * using a tiebreak the note data does not justify.
 */
function isRelativePair(nameA, nameB) {
  const [, modeA] = nameA.split(' ')
  const [, modeB] = nameB.split(' ')
  if (modeA === modeB) return false
  const minorTonic = modeA === 'minor' ? tonicPitchClass(nameA) : tonicPitchClass(nameB)
  const majorTonic = modeA === 'major' ? tonicPitchClass(nameA) : tonicPitchClass(nameB)
  return (minorTonic + 3) % 12 === majorTonic
}

/**
 * How close the top two correlation scores must be, relative to the best
 * one, before they count as a genuine tie rather than one candidate clearly
 * winning.
 *
 * Sized well below the confidence margins this module and its neighbours
 * report on real, unambiguous material (the-chase's chroma-based key, for
 * comparison, sits at 0.085 - see metadata.mjs's `reconcileKey` doc comment
 * for why a low detector confidence like that is not, by itself, treated as
 * license to defer to an external source) and well above numerical noise, so
 * it only fires on the specific case it exists for: a relative major/minor
 * pair whose weighted pitch-class content is genuinely, not just
 * superficially, ambiguous.
 */
const RELATIVE_TIE_MARGIN = 0.02

/**
 * Break a relative-major/minor near-tie using which tonic the bass line
 * actually treats as home, rather than leaving the correlation's arbitrary
 * pick.
 *
 * Relative keys share every scale degree, so a duration-weighted histogram
 * of ALL notes cannot distinguish "the tonic is C" from "the tonic is A" when
 * the piece leans on scale members roughly evenly between them - that is
 * what makes them relative. The bass line does not have this problem: a
 * functional bassline in a given key spends most of its own duration on that
 * key's tonic and dominant, so whichever of the two rival tonics holds more
 * total bass-note duration is the more likely tonal centre. This is
 * deliberately not applied when the top two scores are already clearly
 * separated - see `RELATIVE_TIE_MARGIN` - because a confident correlation
 * result already reflects real asymmetry in scale-degree usage (Albrecht &
 * Shanahan's major and minor profiles are not identical even when rotated to
 * share a pitch-class set) that this coarser, bass-only signal should not
 * overrule.
 *
 * `tiebreak` on the returned object is `'bass-root'` only when the bass
 * actually supplied differentiating evidence (whichever candidate's tonic it
 * favours, including confirming the correlation's own pick) - not merely
 * whenever this near-tie path ran. Equal tonic durations, which is also what
 * an empty/absent bass list produces, is "no evidence either way," and
 * reporting a tiebreak that was not actually backed by anything would be a
 * diagnostic lie: a caller reading `tiebreak: 'bass-root'` should be able to
 * trust that the bass line, not the coin flip a near-tied correlation
 * already is, is why this name won.
 */
function breakRelativeTie(best, runnerUp, bassNotes) {
  if (!isRelativePair(best.name, runnerUp.name)) return { best, runnerUp, tiebreak: null }
  const margin = best.score > 0 ? (best.score - runnerUp.score) / best.score : 0
  if (margin >= RELATIVE_TIE_MARGIN) return { best, runnerUp, tiebreak: null }

  const bassHistogram = pitchClassHistogram(bassNotes)
  const bestTonicDuration = bassHistogram[tonicPitchClass(best.name)]
  const runnerTonicDuration = bassHistogram[tonicPitchClass(runnerUp.name)]
  if (runnerTonicDuration === bestTonicDuration) return { best, runnerUp, tiebreak: null }
  if (runnerTonicDuration > bestTonicDuration) return { best: runnerUp, runnerUp: best, tiebreak: 'bass-root' }
  return { best, runnerUp, tiebreak: 'bass-root' }
}

/**
 * Best-matching key from transcribed notes, plus the runner-up and how it
 * was reached - the note-stream analogue of `detectKey` in dsp.mjs, scored
 * against the Albrecht-Shanahan profiles above instead of Krumhansl-Kessler,
 * over a duration-weighted note histogram instead of FFT chroma.
 *
 * Returns the same `{ name, confidence }` shape `reconcileKey` in
 * metadata.mjs already expects from a detected key (see `profile.key` in
 * profile.mjs, which is the chroma-based value this function is meant to
 * outrank) - callers reconcile this result against a known key from
 * `lookupTrack` exactly the way they already reconcile the chroma one, so a
 * metadata disagreement is surfaced the same way regardless of which
 * detector produced the disagreeing answer.
 *
 * `null` when there is nothing to detect from - no notes in either stem,
 * every note has zero/negative duration, or the combined evidence does not
 * clear `MIN_TOTAL_DURATION_SECONDS`/`MIN_NOTE_COUNT`/
 * `MIN_PITCH_CLASS_DIVERSITY` (see that constant's own doc comment) - which
 * every caller must treat as "fall back to the chroma-based key," identically
 * to how a missing Basic Pitch binary is handled everywhere else in this
 * pipeline. Clearing those floors is necessary, not sufficient, for a caller
 * to actually trust the answer - see `NOTE_KEY_MIN_CONFIDENCE`'s own doc
 * comment for the separate bar `rebuild.mjs` applies before using this to
 * replace the chroma-based key.
 */
export function detectKeyFromNotes(bassNotes, otherNotes) {
  const histogram = pitchClassHistogram(bassNotes, otherNotes)
  const total = histogram.reduce((a, b) => a + b, 0)
  const noteCount = countUsableNotes(bassNotes, otherNotes)
  const diversity = histogram.filter((value) => value > 0).length
  if (total < MIN_TOTAL_DURATION_SECONDS || noteCount < MIN_NOTE_COUNT || diversity < MIN_PITCH_CLASS_DIVERSITY) return null
  const normalized = histogram.map((value) => value / total)

  const scored = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = normalized.map((_, i) => normalized[(i + tonic) % 12])
    scored.push({ name: `${PITCH_NAMES[tonic]} major`, score: correlate(rotated, ALBRECHT_SHANAHAN_MAJOR_PROFILE) })
    scored.push({ name: `${PITCH_NAMES[tonic]} minor`, score: correlate(rotated, ALBRECHT_SHANAHAN_MINOR_PROFILE) })
  }
  scored.sort((a, b) => b.score - a.score)

  const { best, runnerUp, tiebreak } = breakRelativeTie(scored[0], scored[1], bassNotes)
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, (best.score - runnerUp.score) / best.score)) : 0

  return { name: best.name, runnerUp: runnerUp.name, confidence, histogram: normalized, tiebreak }
}
