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
  const notes = segmentNotes(track)
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
