/**
 * Lead line transcription from the harmony stem.
 *
 * `detectMelody` below is the original pipeline: track the single strongest
 * pitch in the lead register with `trackF0` (YIN), gate on how much of a line
 * there is, and discard any line that turns out to be the chords' own top
 * voice. It produced zero false positives on the real track (`the-chase`) -
 * every section it emitted a lead for genuinely had the sax playing - but
 * measured directly against the true part (task-9-report.md's addendum) the
 * *notes* barely correlated with it even in sections that passed every gate:
 * aggregate exact-MIDI agreement of 9/129 (~7%), chance level. The cause is
 * structural, not a threshold: YIN finds *the* periodicity of a signal, and a
 * stem holding a sax over an electric piano, a sawtooth and other pitched
 * layers at once has no single periodicity - the tracker follows whichever
 * voice's period dominates the window that frame, silently switching voices
 * frame to frame with no way to tell it did. Spectrally subtracting the
 * already-known chord tones from the stem before tracking (synthesised
 * partials, least-squares scaled, verified as real cancellation up to 100% at
 * the targeted bins) did not move the result at all - the confound is not
 * chord energy this pipeline can subtract its way out of in the pitch domain,
 * it is a genuine polyphony problem. `detectMelody` and its tests stay
 * because the gates and the chord-tone check are correct on their own terms,
 * but nothing calls it anymore.
 *
 * `detectMelodySalience` below is the replacement: harmonic-summation
 * salience (`salience.mjs`) in place of a single-periodicity tracker. Its own
 * doc comment covers why that structurally sidesteps YIN's failure - it
 * scores every candidate pitch independently instead of searching for one, so
 * a pad and a lead each produce their own visible peak. Measured against the
 * same 462-event ground truth this module's predecessor was measured
 * against: 8 of 12 sections emit a lead (up from 5/12), 214 notes emitted,
 * 109 land on a real sax onset (50.9%), 64 get the pitch class right (29.9%),
 * 33 get the exact MIDI note right (15.4% - more than double the ~7%
 * baseline, on the same ground truth). Independently, on Bicep's "Glue" (a
 * synth record with no ground truth, so a different check): for 690 emitted
 * notes, the original mix's own spectral energy at the emitted fundamental
 * (no harmonics, so an octave error cannot hide behind them) beat the energy
 * an octave up, an octave down, and a fifth up 73.0% of the time - against a
 * 25% chance floor and the old pipeline's 27%. Both numbers are large,
 * decisive improvements over both the disabled baseline and chance, on two
 * tracks in different genres, one scored against real ground truth and one
 * against an independent spectral check that cannot be gamed by the same
 * bias the extractor itself might have. That is what justifies calling
 * `detectMelodySalience` from `transcribeMelody` below.
 *
 * It is not a solved problem, and the numbers above say so plainly: most
 * individual notes are still not exactly right (29.9% pitch-class, 15.4%
 * exact-MIDI), and per-section performance is uneven - some sections on
 * `the-chase` score 60%+ exact-MIDI, others land at zero even where the true
 * part plays continuously throughout. See melody-salience-report.md for the
 * full per-section breakdown and the parameter sweep this shipped
 * configuration came from.
 *
 * One gap found in review and deliberately left open rather than
 * band-aided: `detectMelody`'s `isChordTopVoice` check (a stem with no real
 * lead can still produce a clean, well-separated pitch line that is nothing
 * but the chord progression's own top note) was ported to
 * `detectMelodySalience` and measured directly against the reference track's
 * real, already-detected harmony. Result: it destroyed real accuracy rather
 * than protecting it - both of the two most accurate sections (67% and 64%
 * exact-MIDI) were rejected, driving the whole-track score to 0%, because
 * this pipeline's genuinely correct sax notes carry a chord-tone fraction
 * (0.92-0.93) sitting *inside* the range of its clearly-wrong sections
 * (0.87-0.99) - real tonal melodies lean on chord tones too, and there is no
 * threshold in that range that separates the two. The check was reverted,
 * not recalibrated, because the data shows no calibration exists to find:
 * see melody-salience-report.md for the full measurement. A stem with
 * nothing sounding but a chord progression can still produce a fake "lead"
 * here - a known, accepted limitation, not a silently unhandled one.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { bandNovelty, pickBandOnsets } from './bands.mjs'
import { CHORD_TEMPLATES } from './chords.mjs'
import { midiToHz, segmentNotes, trackF0 } from './f0.mjs'
import { foldToLoop, sectionRange, stepAt, stepDrift, stepSeconds } from './quantize.mjs'
import { computeMelodyContour, SALIENCE_RANGE } from './salience.mjs'

/** Above the bass, below where cymbal wash dominates. */
export const LEAD_RANGE = Object.freeze({ minHz: 150, maxHz: 2000 })

/** A section needs this many distinct notes before it counts as having a lead.
 *  Three notes in eight bars is a texture, not a hook. */
const MIN_NOTES = 4
/** And they have to be reasonably clear. Higher than the bass threshold,
 *  because the stem this reads is far more contaminated. */
const MIN_CLARITY = 0.55
/** And the section has to be voiced at least this often. */
const MIN_VOICED_FRACTION = 0.2
/** A line with fewer distinct pitches than this is a drone or a pad's top
 *  voice, not a melody. */
const MIN_DISTINCT_PITCHES = 2
/** If this share of the line's notes are chord tones of the chord sounding
 *  underneath, the "lead" is the harmony's top voice and gets dropped. */
const MAX_CHORD_TONE_FRACTION = 0.9

/**
 * The real entry point. Calls `detectMelodySalience` - see the module doc
 * comment for the measurement that justifies enabling it (a large, measured
 * improvement over both the old YIN pipeline and chance, on two tracks in
 * different genres). `detectMelodySalience` takes its own options should a
 * future task need to override the tuned defaults; `transcribeMelody` itself
 * takes none, matching every other layer's `transcribe*` entry point. Unlike
 * `detectMelody`, it does not take `chords` - see the module doc comment for
 * why the chord-top-voice rejection does not carry over to this pipeline.
 */
export function transcribeMelody(wavBuf, grid, sections) {
  return detectMelodySalience(wavBuf, grid, sections)
}

/** The original detection pipeline (YIN). Not called by `transcribeMelody`
 *  any more - see the module doc comment. Kept, and still tested, because the
 *  gates and the chord-tone check are correct on their own terms; the
 *  problem was upstream of them. */
export function detectMelody(wavBuf, grid, sections, { chords = [] } = {}) {
  const audio = decodeWav(wavBuf)
  const track = trackF0(audio, { ...LEAD_RANGE, windowSize: 2048, hop: 512 })
  const notes = segmentNotes(track, { minFrames: 3, semitoneTolerance: 0.7 })
  const perStep = stepSeconds(grid)

  const events = notes
    .filter((note) => (note.endSec - note.startSec) / perStep >= 0.5)
    .map((note) => ({
      step: stepAt(grid, note.startSec),
      length: Math.max(1, Math.round((note.endSec - note.startSec) / perStep)),
      velocity: 0.7,
      confidence: note.clarity,
      midi: Math.round(note.midi),
      symbol: null,
      driftSteps: stepDrift(grid, note.startSec),
      clarity: note.clarity,
    }))

  return sections.map((section, sectionIndex) => {
    const range = sectionRange(grid, section)
    const inSection = events.filter((event) => event.step >= range.fromStep && event.step < range.toStep)
    if (inSection.length < MIN_NOTES) return null

    const distinct = new Set(inSection.map((event) => event.midi)).size
    if (distinct < MIN_DISTINCT_PITCHES) return null

    const meanClarity = inSection.reduce((sum, event) => sum + event.clarity, 0) / inSection.length
    if (meanClarity < MIN_CLARITY) return null

    const voicedFraction = voicedFractionIn(track, range.fromSec, range.toSec)
    if (voicedFraction < MIN_VOICED_FRACTION) return null

    if (isChordTopVoice(inSection, chords[sectionIndex], section, grid)) return null

    // The lead is single-voice too - same reasoning as bass.mjs's own
    // `oneEventPerStep`. A monophonic pitch tracker cannot honestly report
    // two notes at once, so a step-collision here is two repetitions
    // disagreeing, and one of them has to lose deliberately.
    const folded = foldToLoop(
      inSection.map(({ clarity, ...event }) => event),
      section,
      grid,
      { oneEventPerStep: true },
    )
    if (folded.events.length < MIN_DISTINCT_PITCHES) return null

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: meanClarity * Math.max(folded.agreement, 0.25),
    }
  })
}

/** A section needs this many notes before a salience-derived lead counts as a
 *  hook rather than texture. Same floor as `detectMelody`'s `MIN_NOTES` - the
 *  question ("is this a line or a handful of stray notes") is identical. */
const SALIENCE_MIN_NOTES = 4
/**
 * How confident a section's notes have to be, on average, to keep the
 * section. `computeMelodyContour`'s `clarity` is not YIN's clarity - it is a
 * winning contour's own selection score, min-max normalised against the
 * loudest contour selected anywhere in the *track* - so this is not the same
 * number as `MIN_CLARITY` above and was re-measured against this pipeline's
 * own output rather than copied. See the report for the sweep.
 */
const SALIENCE_MIN_CLARITY = 0.15
/** And the section has to actually be voiced this often - silence with a
 *  couple of confident stray notes is not a hook either. */
const SALIENCE_MIN_VOICED_FRACTION = 0.15
/** A line with fewer distinct pitches than this is a drone, not a melody. */
const SALIENCE_MIN_DISTINCT_PITCHES = 2

/**
 * Predominant-melody extraction: harmonic-summation salience
 * (`computeMelodyContour`) in place of `detectMelody`'s single-periodicity
 * YIN track. Same downstream shape as `detectMelody` - `segmentNotes`,
 * per-section gates, `foldToLoop` - because that machinery was already
 * correct; only the pitch contour it consumes is new. See `salience.mjs`'s
 * own doc comment for why a monophonic tracker cannot do this job at all,
 * and the report this task produced for the measurement that justifies (or
 * fails to justify - see `transcribeMelody`) using this as the real answer.
 */
export function detectMelodySalience(
  wavBuf,
  grid,
  sections,
  {
    minNotes = SALIENCE_MIN_NOTES,
    minClarity = SALIENCE_MIN_CLARITY,
    minVoicedFraction = SALIENCE_MIN_VOICED_FRACTION,
    minDistinctPitches = SALIENCE_MIN_DISTINCT_PITCHES,
    ...salienceOptions
  } = {},
) {
  const audio = decodeWav(wavBuf)
  const track = computeMelodyContour(audio, salienceOptions)

  // Same reasoning as bass.mjs's own re-articulation handling: a pitch
  // contour alone cannot see a note re-struck at the same pitch with no gap,
  // so an amplitude attack in the lead register is measured separately and
  // handed to `segmentNotes` as a forced split point.
  const novelty = bandNovelty(audio, { lo: SALIENCE_RANGE.minHz, hi: SALIENCE_RANGE.maxHz })
  const onsets = novelty
    ? pickBandOnsets(novelty, track.hopSeconds, { threshold: 4.0, minSeparation: 0.05 }).map((onset) => onset.seconds)
    : []
  const notes = segmentNotes(track, { onsets })
  const perStep = stepSeconds(grid)

  const events = notes
    .filter((note) => (note.endSec - note.startSec) / perStep >= 0.5)
    .map((note) => ({
      step: stepAt(grid, note.startSec),
      length: Math.max(1, Math.round((note.endSec - note.startSec) / perStep)),
      velocity: 0.7,
      confidence: note.clarity,
      midi: Math.round(note.midi),
      symbol: null,
      driftSteps: stepDrift(grid, note.startSec),
      clarity: note.clarity,
    }))

  return sections.map((section) => {
    const range = sectionRange(grid, section)
    const inSection = events.filter((event) => event.step >= range.fromStep && event.step < range.toStep)
    if (inSection.length < minNotes) return null

    const distinct = new Set(inSection.map((event) => event.midi)).size
    if (distinct < minDistinctPitches) return null

    const meanClarity = inSection.reduce((sum, event) => sum + event.clarity, 0) / inSection.length
    if (meanClarity < minClarity) return null

    const voicedFraction = voicedFractionIn(track, range.fromSec, range.toSec)
    if (voicedFraction < minVoicedFraction) return null

    // No chord-top-voice rejection here - see the module doc comment. It was
    // tried (porting `detectMelody`'s `isChordTopVoice`/
    // `MAX_CHORD_TONE_FRACTION`) and measured out: unlike YIN's contaminated
    // track, this pipeline's genuinely correct notes also carry a high
    // chord-tone fraction (tonal melodies lean on chord tones), so the same
    // threshold that separates real from fake for YIN has no separating
    // power here and destroys real accuracy instead.

    const folded = foldToLoop(
      inSection.map(({ clarity, ...event }) => event),
      section,
      grid,
      { oneEventPerStep: true },
    )
    // Distinct pitches, not raw event count: `oneEventPerStep`'s collision
    // resolution can leave several surviving events that all settled on the
    // same MIDI note after competing pitches at other loop positions lost,
    // which would otherwise let a drone through a count-only check.
    const foldedDistinct = new Set(folded.events.map((event) => event.midi)).size
    if (foldedDistinct < minDistinctPitches) return null

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: meanClarity * Math.max(folded.agreement, 0.25),
    }
  })
}

function voicedFractionIn(track, fromSec, toSec) {
  const window = track.frames.filter((frame) => frame.seconds >= fromSec && frame.seconds < toSec)
  if (!window.length) return 0
  return window.filter((frame) => frame.voiced).length / window.length
}

/**
 * Is this "lead" just the chords' own top note?
 *
 * Each note is checked against the chord sounding *underneath it*, not against
 * the union of every chord in the section. The union is far too permissive: a
 * progression of four chords covers most of the twelve pitch classes between
 * them, so a real melody that happens to use notes found somewhere in the
 * progression would be thrown away.
 */
function isChordTopVoice(notes, chordLoop, section, grid) {
  if (!chordLoop?.events?.length) return false
  const perBar = grid.beatsPerBar * 4
  const loopSteps = chordLoop.loopBars * perBar
  const sectionStart = section.startBar * perBar

  // Which chord covers a given loop position.
  const tonesAt = (position) => {
    let covering = null
    for (const event of chordLoop.events) {
      if (position >= event.step && position < event.step + event.length) covering = event
    }
    if (!covering) return null
    const template = CHORD_TEMPLATES.find((candidate) => candidate.symbol === covering.symbol)
    if (!template) return null
    const tones = new Set()
    for (let pc = 0; pc < 12; pc++) if (template.vector[pc] > 0) tones.add(pc)
    return tones
  }

  let judged = 0
  let inside = 0
  for (const note of notes) {
    const tones = tonesAt((note.step - sectionStart) % loopSteps)
    if (!tones) continue
    judged++
    if (tones.has(((note.midi % 12) + 12) % 12)) inside++
  }
  return judged > 0 && inside / judged >= MAX_CHORD_TONE_FRACTION
}

/**
 * Selecting the lead from Basic Pitch's polyphonic notes.
 *
 * Not called by `transcribeMelody` - see basic-pitch-report.md for the full
 * measurement. Summary: Basic Pitch's raw notes on the reference track's
 * `other` stem are far more accurate than anything the DSP path can produce
 * (an oracle that could perfectly pick out only the notes exactly matching
 * ground truth reaches 81% exact-MIDI on what's available), but every
 * selection strategy tried here - the one shipped below, several weight
 * combinations swept against it, a fragment-merge preprocessing pass, and a
 * "snap the DSP path's own onsets to the nearest concurrent Basic Pitch
 * note" hybrid - tops out around 12-14% exact-MIDI on the same 462-event
 * ground truth, below `detectMelodySalience`'s already-shipped 15.4%. The
 * underlying notes are good; this module's selection of *which* of several
 * simultaneously correct notes is the melody is not yet good enough to
 * replace the existing path, and this file says so rather than shipping a
 * regression. It is kept, tested and exported - like `detectMelody` above -
 * because the ideas it embodies (see the two bullets below) are correct on
 * their own terms and it is a reasonable base for future work.
 *
 * `detectMelody`/`detectMelodySalience`'s two ideas carry over conceptually,
 * not as ported code:
 *
 * - Salience: `salience.mjs`'s `selectMelody` scores a contour partly by
 *   loudness relative to the *other candidates in the same call*
 *   (`normSalience`, min-max normalised against them - "loudest among the
 *   current candidates" is the only meaningful reading available for a
 *   number with no fixed scale). `salienceScore` below applies the same
 *   min-max normalisation to Basic Pitch's own per-note velocity, over the
 *   same section's candidate notes. Measured directly on the reference
 *   track's `other` stem: notes that land on a real, correctly-pitched sax
 *   onset average velocity 0.570; notes that match no true onset at all
 *   average 0.493 - a real, if modest, gap.
 * - Register: `selectMelody` also scores a contour by how far above what
 *   else is sounding *at that instant* it sits (a lead over a bass stab an
 *   octave down should not need to also out-register a soprano pad), not
 *   against a fixed frequency band. `registerScore` below is the same idea
 *   applied to a discrete note instead of a per-frame salience peak: it
 *   measures against the velocity-weighted mean pitch of every note whose
 *   interval overlaps this one, credits only being above it, and caps the
 *   credit at one octave for the same reason `salience.mjs` does - otherwise
 *   a real instrument's own quiet high overtone can outscore the true note
 *   it belongs to just by sitting further above the room.
 * A third idea was tried and measured rather than assumed, and does *not*
 * pull its weight: `continuityScore` rewards two *chosen* notes sitting close in
 * pitch, the discrete-note analogue of `trackContours`' pitch-tolerance
 * linking, on the theory that it would let the DP lock onto one smoothly-
 * moving voice instead of hopping between competing instruments note to
 * note. Swept against the real ground truth with salience/register held at
 * the values below: `continuityWeight: 0` (off) scores 12.6% exact-MIDI;
 * 0.5 scores 10.1%; higher values were worse still in every combination
 * tried. Unlike per-frame salience contours - continuous, so a genuinely
 * wandering pad can still look locally smooth - Basic Pitch's discrete notes
 * make "close in pitch to the last pick" cheap for a chain to satisfy by
 * drifting through whichever nearby wrong notes happen to be adjacent, which
 * is apparently worse than just re-deciding independently at every note.
 * `continuityWeight` defaults to `0`; the machinery (and the option) stays,
 * because the DP's non-overlap constraint is still exactly the monophonic
 * reduction this selection needs regardless of whether the bonus is used.
 *
 * What else does not carry over, measured and rejected rather than assumed:
 *
 * - `selectMelody`'s third signal, contour *length* (more frames of
 *   consistent evidence is stronger evidence), does not translate to a
 *   per-note *duration* reward the way it first looks like it should. A
 *   contour's frame count measures how long a single coherent voice
 *   persisted - the analogue here is how many notes the DP's chain ends up
 *   containing, which the DP already prefers automatically (every
 *   non-negative-weight note added to a compatible chain can only raise its
 *   total score, so a longer coherent chain always beats stopping short of
 *   it - no explicit reward needed). A note's own individual sustain is a
 *   different quantity, and on this reference track it points the *wrong*
 *   way: notes landing on a real sax onset average 0.330s; notes matching no
 *   true onset average 0.458s - the held pad and keys chords are longer than
 *   the moving melodic line sitting over them, not shorter. An early version
 *   of this module rewarded individual note duration directly and it pulled
 *   selection toward long sustained chord tones (observed directly: a test
 *   section's chosen chain topped out at MIDI 96, an octave-plus above the
 *   section's real 65-92 sax range). `durationWeight` defaults to `0` and
 *   exists only for a future track where sustain does point the right way;
 *   nothing in this pipeline currently sets it.
 * - `detectMelody`'s `isChordTopVoice` rejection. The module doc comment
 *   above explains why porting it to the salience pipeline was measured and
 *   reverted twice - a real, well-selected melody in tonal music leans on
 *   chord tones just as heavily as a fake one built from nothing but the
 *   chord progression's own top note, so no threshold on that fraction
 *   separates them. Nothing here re-introduces it.
 */

/** How many octaves above the local "room" a note can be credited for
 *  sitting - same cap and same reasoning as `salience.mjs`'s
 *  `registerCapOctaves`: one octave already separates a lead from its own
 *  accompaniment in every case measured, and letting an outlier climb higher
 *  rewards "furthest above the room" over "actually the melody." */
const REGISTER_CAP_OCTAVES = 1

/** Seconds a note's own duration is compared against when turning length
 *  into a 0..1 score (`duration / (duration + DURATION_NORM_SECONDS)`), for
 *  the optional, off-by-default `durationWeight` - see the section doc
 *  comment above for why this is not part of the shipped weighting. */
const DURATION_NORM_SECONDS = 0.3

/** Off by default - see the section doc comment for the sweep that found
 *  every non-zero value tried made real-track accuracy worse, not better. */
const CONTINUITY_WEIGHT = 0

/** A gap this small between one selected note ending and the next starting
 *  is legato/quantisation slop, not evidence the two cannot be the same
 *  voice - notes that overlap by more than this are genuinely concurrent and
 *  the DP's non-overlap constraint (correctly) treats them as competitors,
 *  not a sequence. */
const OVERLAP_TOLERANCE_SECONDS = 0.03

/**
 * Min-max range of a set of notes' velocities, for `salienceScore` to
 * normalise against - computed once per `selectMelodicLine` call over every
 * candidate note in the section, not per-instant, matching how
 * `salience.mjs` rescales `normSalience` against "the other contours in this
 * call" rather than a fixed or per-frame range.
 */
function velocityRange(notes) {
  let min = Infinity
  let max = -Infinity
  for (const note of notes) {
    if (note.velocity < min) min = note.velocity
    if (note.velocity > max) max = note.velocity
  }
  return [min, max]
}

/** A flat velocity range (every candidate equally loud, including a single
 *  candidate) carries no discriminating information - scored as 1 rather
 *  than dividing by zero, the same convention `salience.mjs`'s own
 *  `normalize` uses for the identical situation. */
function salienceScore(note, [min, max]) {
  if (!(max > min)) return 1
  return (note.velocity - min) / (max - min)
}

/** How far above the velocity-weighted mean pitch of everything sounding at
 *  the same time this note sits, in octaves, clamped to `[0,
 *  REGISTER_CAP_OCTAVES]` and credited only when positive - see the section
 *  doc comment above for why this is measured relative to the moment rather
 *  than a fixed band. `overlapping` must include `note` itself: excluding it
 *  would make a single loud, isolated note score against its own absence
 *  rather than against silence around it. */
function registerScore(note, overlapping) {
  let weightSum = 0
  let logSum = 0
  for (const other of overlapping) {
    const weight = Math.max(other.velocity, 0.001)
    weightSum += weight
    logSum += weight * Math.log2(midiToHz(other.midi))
  }
  const referenceLogHz = weightSum > 0 ? logSum / weightSum : Math.log2(midiToHz(note.midi))
  const aboveOctaves = Math.log2(midiToHz(note.midi)) - referenceLogHz
  return Math.max(0, Math.min(REGISTER_CAP_OCTAVES, aboveOctaves)) / REGISTER_CAP_OCTAVES
}

/** Off by default - see the section doc comment for the measurement that
 *  keeps `durationWeight` at `0` in every caller today. */
function durationScore(note) {
  const duration = note.endSec - note.startSec
  return duration / (duration + DURATION_NORM_SECONDS)
}

/**
 * How closely `candidate` continues `previous`'s pitch, 0..1: an exact repeat
 * scores 1, an octave or more apart scores 0, linear in between. The caller
 * scales this by its own continuity weight - this returns the same
 * normalised value regardless of that weight, the same separation of
 * concerns `registerScore`/`durationScore` keep (each already 0..1, scaled
 * by a weight at the call site, never baking a weight into the raw score).
 */
function continuityScore(previous, candidate) {
  const semitones = Math.abs(candidate.midi - previous.midi)
  return Math.max(0, 1 - semitones / 12)
}

/**
 * Pick the single best monophonic melodic line out of a set of (possibly
 * heavily overlapping) polyphonic notes.
 *
 * This is weighted interval scheduling - the classic "select a maximum-
 * weight subset of intervals such that no two overlap" DP - with one twist:
 * the weight of extending the chain with note `i` after note `j` is not just
 * `weight(i)`, it also depends on which specific `j` precedes it
 * (`continuityScore`, off by default - see the section doc comment), so
 * `dp[i]` cannot be computed from a single running maximum the way plain
 * weighted interval scheduling allows even when that term is zero for every
 * pair (the code path is the same either way). With notes scored per-section
 * (at most a few hundred), the resulting O(n^2) is a negligible cost for the
 * guarantee it buys: the returned notes never overlap in time (this *is* the
 * monophonic reduction the lead needs) and the chain found is the one whose
 * combined weight is highest, not merely "the loudest thing playing" or "the
 * highest note at each instant" - either of which a pad or a stab can win
 * outright on its own.
 *
 * Default weights (`salienceWeight: 3, registerWeight: 1`) are the best
 * simple combination found in the sweep described above: 12.6% exact-MIDI
 * against the reference track's 462-event ground truth, `onset` 48.6%,
 * `pitch class` 23.3% (see basic-pitch-report.md for the full table,
 * including why this stops short of `detectMelodySalience`'s shipped 15.4%
 * and is therefore not called by `transcribeMelody`).
 */
export function selectMelodicLine(
  notes,
  {
    salienceWeight = 3,
    registerWeight = 1,
    durationWeight = 0,
    continuityWeight = CONTINUITY_WEIGHT,
    overlapToleranceSec = OVERLAP_TOLERANCE_SECONDS,
  } = {},
) {
  if (notes.length === 0) return []
  const sorted = [...notes].sort((a, b) => a.endSec - b.endSec || a.startSec - b.startSec)
  const n = sorted.length
  const velRange = velocityRange(sorted)

  const weight = sorted.map((note, i) => {
    const overlapping = sorted.filter((other) => other.startSec < note.endSec && other.endSec > note.startSec)
    return (
      salienceWeight * salienceScore(note, velRange) +
      registerWeight * registerScore(note, overlapping) +
      durationWeight * durationScore(note)
    )
  })

  const dp = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    dp[i] = weight[i]
    for (let j = 0; j < i; j++) {
      if (sorted[j].endSec > sorted[i].startSec + overlapToleranceSec) continue
      const bonus = continuityWeight * continuityScore(sorted[j], sorted[i])
      const candidate = dp[j] + weight[i] + bonus
      if (candidate > dp[i]) {
        dp[i] = candidate
        back[i] = j
      }
    }
  }

  let bestEnd = 0
  for (let i = 1; i < n; i++) if (dp[i] > dp[bestEnd]) bestEnd = i

  const chain = []
  for (let i = bestEnd; i !== -1; i = back[i]) chain.push(sorted[i])
  chain.reverse()
  return chain
}

/** Same floor as `detectMelodySalience`'s `SALIENCE_MIN_NOTES` - the question
 *  ("is this a line or a handful of stray notes") does not change with the
 *  source of the notes. */
const NOTES_MIN_NOTES = SALIENCE_MIN_NOTES
/** Same floor as `SALIENCE_MIN_DISTINCT_PITCHES` - a line with fewer distinct
 *  pitches than this is a drone, not a melody, regardless of how the notes
 *  were transcribed. */
const NOTES_MIN_DISTINCT_PITCHES = SALIENCE_MIN_DISTINCT_PITCHES

/**
 * Lead transcription from Basic Pitch's note events, in place of a pitch
 * contour: select the melodic line per section (`selectMelodicLine`),
 * quantise each chosen note's onset with the same `stepAt`/`stepDrift` every
 * other transcriber uses, and fold with `foldToLoop` exactly as
 * `detectMelodySalience` does. See basic-pitch-report.md for the measurement
 * that justifies this over `transcribeMelody` where the tool is available.
 *
 * A note is assigned to the section it *starts* in, matching how every other
 * transcriber in this file partitions events by onset rather than by any
 * part of the note that might fall outside the section's range.
 */
export function transcribeMelodyFromNotes(
  notes,
  grid,
  sections,
  { minNotes = NOTES_MIN_NOTES, minDistinctPitches = NOTES_MIN_DISTINCT_PITCHES, ...selectionOptions } = {},
) {
  const perStep = stepSeconds(grid)

  return sections.map((section) => {
    const range = sectionRange(grid, section)
    const inSection = notes.filter((note) => note.startSec >= range.fromSec && note.startSec < range.toSec)
    if (inSection.length < minNotes) return null

    const chain = selectMelodicLine(inSection, selectionOptions)
    if (chain.length < minDistinctPitches) return null

    const events = chain.map((note) => ({
      step: stepAt(grid, note.startSec),
      length: Math.max(1, Math.round((note.endSec - note.startSec) / perStep)),
      velocity: note.velocity,
      confidence: note.velocity,
      midi: note.midi,
      symbol: null,
      driftSteps: stepDrift(grid, note.startSec),
    }))

    const distinct = new Set(events.map((event) => event.midi)).size
    if (distinct < minDistinctPitches) return null

    // The lead is single-voice, same reasoning as everywhere else this option
    // is passed: `selectMelodicLine` already guarantees no two chosen notes
    // overlap, but folding several loop repetitions back on top of each other
    // can still put two disagreeing readings on the same step.
    const folded = foldToLoop(events, section, grid, { oneEventPerStep: true })
    const foldedDistinct = new Set(folded.events.map((event) => event.midi)).size
    if (foldedDistinct < minDistinctPitches) return null

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: Math.max(folded.agreement, 0.25),
    }
  })
}
