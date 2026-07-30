/**
 * Bass transcription: a pitch track becomes one quantised note loop per section.
 *
 * Demucs does not guarantee a monophonic bass stem. Layered basses, distortion
 * and bleed from the kick all produce ambiguous fundamentals, and the honest
 * response is to say so rather than pick one confidently. That is what the
 * confidence values and the omission rule are for: a section whose bass cannot
 * be heard clearly produces no bass layer, and the hearing check in Task 11
 * gets a second chance to catch what slips through.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { bandNovelty, pickBandOnsets } from './bands.mjs'
import { segmentNotes, trackF0 } from './f0.mjs'
import { foldToLoop, sectionRange, stepAt, stepDrift, stepSeconds } from './quantize.mjs'

/** Where a bass lives. The top is 400 Hz rather than 200 because basslines
 *  reach into the low mids and a tracker that cannot follow them there reports
 *  the octave below when they do. */
export const BASS_RANGE = Object.freeze({ minHz: 30, maxHz: 400 })

/**
 * `trackF0`'s own default (4096) is not usable here: 4096 samples is 92.9ms,
 * and a short bass hit surrounded by silence (a plucked or gated note, exactly
 * what a step sequencer produces) has most of that window sitting in silence
 * right up until the note starts. YIN's difference function scores a
 * zero-vs-zero pair as a perfect match at every lag, so a mostly-silent window
 * reports artificially low difference - and therefore high clarity - as soon
 * as *any* of the window has slid onto the note, well before the window is
 * centred on it. The effect is a systematic early bias on note onsets, not
 * jitter: measured directly (`scripts/lib/rebuild/transcribe/bass.test.mjs`'s
 * single-note fixtures), a note's detected `startSec` at windowSize 4096
 * lands 0.6-0.7 sixteenth-steps early, which is enough to round to the wrong
 * grid step on more than half the notes in a bar of eighth-note hits - not a
 * rare edge case.
 *
 * Swept windowSize on that same fixture: every value up to 3300 samples
 * quantises all eight notes to their correct step; 3350 and above start
 * missing steps, and 4096 (the default) gets every step but the first wrong.
 *
 * That upper bound (3300) and `BASS_RANGE.minHz`'s own floor - a window must
 * be at least twice the longest period being searched, per `f0.mjs`'s own doc
 * comment, so 2 x 44100/30 = 2940 samples - leave a genuinely narrow gap to
 * pick from, and where in it matters: 2940 exactly clears the floor by only
 * 132 samples (4.5%), and `BASS_RANGE` is a general-purpose constant, not one
 * fitted to this one recording, so that margin has to hold on material this
 * track doesn't contain. 3200 was chosen from inside the verified-safe range
 * - comfortably short of the 3350 failure point, confirmed against the full
 * test file rather than the single assertion the sweep checked - to double
 * that margin to 260 samples (8.8%) without giving any of it back to the
 * onset-timing bug above.
 *
 * Raising `minHz` instead - the other way to widen this margin - was
 * measured and rejected: matching `f0.mjs`'s own default margin ratio (4096
 * against a 2940 floor, 39%) needs `minHz` near 40 Hz, which would exclude
 * this track's own lowest roots (C1 at 32.7 Hz, Db1 at 34.6 Hz - both under
 * 40) and break real coverage measured in `task-6-report.md`. `BASS_RANGE`
 * stays at `minHz: 30`.
 *
 * On the real bass stem this also modestly helps, not just the synthetic
 * fixture: transcribing all twelve sections of `the-chase` and scoring every
 * emitted note against ground truth (`task-6-report.md`), 3200 matches
 * 4096's real-stem accuracy within a fraction of a point while fixing the
 * synthetic fixture's onset-quantisation failures outright.
 */
const NOTE_WINDOW = 3200

/**
 * `segmentNotes` on its own only ever splits a note on a pitch change or a
 * voicing drop. A bassline that repeats the same pitch - most of dance music
 * - produces neither: the note is re-struck, but the pitch track cannot see
 * that, so the whole run collapses into one held tone. Measured directly on
 * two real bass stems with almost identical voiced time (Bicep's "Glue"
 * against this repo's own "the-chase" fixture track): 386 notes against 78,
 * a third of Glue's notes over a second long, the longest spanning two full
 * bars. the-chase escapes only by accident - its line moves pitch on nearly
 * every step, so `semitoneTolerance` alone happens to catch every
 * re-articulation there.
 *
 * The fix needs a signal the pitch track does not carry: an amplitude attack.
 * Two were measured against the real Glue stem before picking one.
 *
 * `trackF0`'s own per-frame `rms` was tried first, since it is already
 * computed and would need no new import. Rejected: its window is 3200
 * samples (72ms, sized for a 30Hz fundamental - see `NOTE_WINDOW` above), and
 * at that width the windowed RMS ripples on its own as the window slides
 * across the beating pattern of the note's own harmonics, producing local
 * peaks every 15-25ms with no relationship to any real event. On a section
 * with a genuinely held two-bar pedal tone under a sidechain pump, this
 * produced over 1000 "onsets" track-wide - denser than the loudest real
 * sixteenth-note groove has any business being.
 *
 * `bandEnergyRise` on a dedicated bass-band FFT (23ms window, matched to
 * `dsp.mjs`'s onset hop) resolves fast re-articulations without that
 * artifact, but its absolute magnitude scales with the stem's own gain
 * staging - the two stems' peak values differed by 1.6x for reasons that have
 * nothing to do with rhythm. A floor picked as a percentile of one stem's own
 * distribution does not transfer: high enough to leave the-chase's already-
 * correct segmentation alone, it was too conservative to touch more than a
 * couple of Glue's merged notes; low enough to fix Glue, it fragmented
 * the-chase's short, correct notes into meaningless slivers (median duration
 * dropped from 0.197s to 0.081s).
 *
 * `bandNovelty` - the self-normalised flux-over-magnitude ratio already used
 * for drum onsets - solved both problems at once, because the ratio cancels
 * out exactly the gain difference the raw magnitude carried. Its own default
 * threshold (1.4, tuned for a percussive hit against a near-silent
 * background) still fired on the pump ripple: `bandNovelty`'s numerator is
 * zero on every frame where energy is falling, so even a small ripple's rise
 * looks locally significant against neighbours that are mostly zero. Swept
 * against both real stems together: 4.0 is where the-chase's own numbers
 * stop moving in any way that matters (386 -> 398 notes, but the median
 * duration, the count over a bar, and the longest note are all identical to
 * baseline) while Glue's worst symptom keeps improving (sections with a note
 * over a bar: 24 -> 19; notes over a second: 27 -> 23). The result was stable
 * across floor 0.1-0.3 and threshold 3.5-4.5, not a knife-edge fit to one
 * value.
 */
const REATTACK_THRESHOLD = 4.0
/** Below `segmentNotes`' own `DEFAULT_MIN_FRAMES` (4 frames = 46.4ms at this
 *  hop) a forced split produces two fragments too short to survive, silently
 *  deleting real content instead of splitting it. `pickBandOnsets`' own
 *  default (30ms) is under that; this clears it with margin. */
const REATTACK_MIN_SEPARATION = 0.05

/** A section needs this many notes to be worth emitting a bass layer for. */
const MIN_NOTES_PER_SECTION = 2
/** And the mean clarity of those notes has to clear this, or what we are
 *  hearing is more likely a smeared low end than a line. */
const MIN_CLARITY = 0.5
/** Notes shorter than this fraction of a step are quantisation debris. */
const MIN_LENGTH_STEPS = 0.5

export function transcribeBass(wavBuf, grid, sections) {
  const audio = decodeWav(wavBuf)
  const track = trackF0(audio, { ...BASS_RANGE, windowSize: NOTE_WINDOW, hop: 512 })
  // Same hop as `track` (both default to `dsp.mjs`'s ONSET_HOP/trackF0's own
  // 512), so an onset's `seconds` lines up with a pitch frame one-to-one -
  // see `segmentNotes`' own doc comment for how it consumes this.
  const novelty = bandNovelty(audio, { lo: BASS_RANGE.minHz, hi: BASS_RANGE.maxHz })
  const onsets = pickBandOnsets(novelty, track.hopSeconds, {
    threshold: REATTACK_THRESHOLD,
    minSeparation: REATTACK_MIN_SEPARATION,
  }).map((onset) => onset.seconds)
  const notes = segmentNotes(track, { onsets })
  const perStep = stepSeconds(grid)

  const events = []
  for (const note of notes) {
    const lengthSteps = (note.endSec - note.startSec) / perStep
    if (lengthSteps < MIN_LENGTH_STEPS) continue
    events.push({
      step: stepAt(grid, note.startSec),
      length: Math.max(1, Math.round(lengthSteps)),
      velocity: 0.8,
      confidence: note.clarity,
      midi: Math.round(note.midi),
      symbol: null,
      driftSteps: stepDrift(grid, note.startSec),
      clarity: note.clarity,
    })
  }

  return sections.map((section) => {
    const range = sectionRange(grid, section)
    const inSection = events.filter((event) => event.step >= range.fromStep && event.step < range.toStep)
    if (inSection.length < MIN_NOTES_PER_SECTION) return null

    const meanClarity = inSection.reduce((sum, event) => sum + event.clarity, 0) / inSection.length
    if (meanClarity < MIN_CLARITY) return null

    // Bass is single-voice: a monophonic F0 tracker cannot legitimately
    // report two pitches sounding at once, so two events surviving at the
    // same step is two repetitions disagreeing, not a chord. `oneEventPerStep`
    // makes `foldToLoop` pick one deliberately instead of leaving both for
    // the emitter to silently drop whichever loses the mini-notation slot.
    const folded = foldToLoop(
      inSection.map(({ clarity, ...event }) => event),
      section,
      grid,
      { oneEventPerStep: true },
    )
    if (folded.events.length === 0) return null

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: meanClarity * Math.max(folded.agreement, 0.25),
    }
  })
}

/**
 * Reduce Basic Pitch's polyphonic note list to one bass voice by keeping the
 * lowest-pitched note among any group of notes that overlap in time.
 *
 * Not called by `transcribeBass` - see basic-pitch-report.md for the full
 * measurement. Summary: on the reference track's bass stem, Basic Pitch's
 * raw notes (no selection at all) score 54.7% exact-MIDI against ground
 * truth events at or below MIDI 52; this function's lowest-voice reduction
 * improves that to 59.2%; the existing `transcribeBass` (a YIN pitch tracker
 * tuned specifically for this register - see `NOTE_WINDOW`'s doc comment
 * above) scores 80.7% on the same stem. Unlike the `other` stem the lead
 * reads from, the bass stem is close to genuinely monophonic already, which
 * is exactly the condition a dedicated single-pitch tracker is good at and a
 * general polyphonic model has no particular advantage on. This is kept,
 * tested and exported - like `detectMelody` in melody.mjs - because the
 * judgement it implements (see below) is correct on its own terms even
 * though it does not beat the existing path here.
 *
 * The bass stem is largely monophonic - see the module doc comment for what
 * "largely" concedes (layered basses, distortion, kick bleed). When Basic
 * Pitch reports more than one pitch sounding at once on this stem, the extra
 * one is far more often the model hearing a harmonic partial, a doubled
 * octave, or floor bleed as its own note than a genuine second voice: the
 * fundamental is the lowest thing sounding. This is the same judgement the
 * task brief states directly ("selection is mostly taking the lowest
 * coherent voice"), so it is implemented as stated rather than re-derived.
 *
 * Overlap is transitive (interval-merge, not pairwise): a note that overlaps
 * the *cluster's* current extent joins it even if it does not overlap the
 * cluster's first member directly - the same rule merging overlapping
 * calendar events uses, and necessary here because three notes can each
 * overlap a neighbour without all three overlapping each other at once (a
 * held low note under two shorter higher ones in sequence).
 */
export function reduceToLowestVoice(notes) {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec)
  const clusters = []
  for (const note of sorted) {
    const current = clusters[clusters.length - 1]
    if (current && note.startSec < current.endSec) {
      current.endSec = Math.max(current.endSec, note.endSec)
      current.members.push(note)
    } else {
      clusters.push({ endSec: note.endSec, members: [note] })
    }
  }
  return clusters.map((cluster) => lowestVoiceMember(cluster.members))
}

/** Lowest pitch wins; a tie is broken by the longer note, then the louder
 *  one, so a brief harmonic ghost sharing its fundamental's exact pitch
 *  (rare, but possible with a doubled octave landing on the same pitch
 *  class an octave apart is not a tie - only an *exact* pitch tie reaches
 *  this) does not arbitrarily displace the real note. */
function lowestVoiceMember(members) {
  return members.reduce((best, note) => {
    if (note.midi !== best.midi) return note.midi < best.midi ? note : best
    const noteLength = note.endSec - note.startSec
    const bestLength = best.endSec - best.startSec
    if (noteLength !== bestLength) return noteLength > bestLength ? note : best
    return note.velocity > best.velocity ? note : best
  })
}

/** A section needs this many notes, after reducing to one voice, before a
 *  Basic Pitch bass line counts as worth emitting. Same floor as the DSP
 *  path's `MIN_NOTES_PER_SECTION` - the question is identical, only the
 *  source of the notes differs. */
const NOTES_MIN_NOTES_PER_SECTION = MIN_NOTES_PER_SECTION

/**
 * Bass transcription from Basic Pitch's note events, in place of a pitch
 * tracker: reduce to the lowest voice (`reduceToLowestVoice`), quantise each
 * note's onset to the grid with the same `stepAt`/`stepDrift` every other
 * transcriber uses, and fold each section into a loop exactly as the DSP
 * path does. See basic-pitch-report.md for the measurement that justifies
 * this over `transcribeBass` where the tool is available.
 *
 * Confidence and output velocity both come from the note's own Basic Pitch
 * velocity (already rescaled to 0-1 by `parseNoteEvents`) rather than the
 * fixed `0.8`/pitch-tracker `clarity` the DSP path uses - a real per-note
 * loudness estimate is available here and there is no reason to discard it
 * for a constant.
 */
export function transcribeBassFromNotes(notes, grid, sections, { minNotesPerSection = NOTES_MIN_NOTES_PER_SECTION } = {}) {
  const perStep = stepSeconds(grid)
  const voice = reduceToLowestVoice(notes)
  const events = voice.map((note) => ({
    step: stepAt(grid, note.startSec),
    length: Math.max(1, Math.round((note.endSec - note.startSec) / perStep)),
    velocity: note.velocity,
    confidence: note.velocity,
    midi: note.midi,
    symbol: null,
    driftSteps: stepDrift(grid, note.startSec),
  }))

  return sections.map((section) => {
    const range = sectionRange(grid, section)
    const inSection = events.filter((event) => event.step >= range.fromStep && event.step < range.toStep)
    if (inSection.length < minNotesPerSection) return null

    // Single-voice, same reasoning as `transcribeBass` above: two survivors
    // at one step is two overlapping detections disagreeing, not a chord.
    const folded = foldToLoop(inSection, section, grid, { oneEventPerStep: true })
    if (folded.events.length === 0) return null

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: Math.max(folded.agreement, 0.25),
    }
  })
}
