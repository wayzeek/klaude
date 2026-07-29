/**
 * Lead line transcription from the harmony stem - disabled by default.
 *
 * `detectMelody` below is the full pipeline: track the strongest pitch in the
 * lead register, gate on how much of a line there is, and discard any line
 * that turns out to be the chords' own top voice rather than a part. It works
 * exactly as designed and produces zero false positives on the real track
 * (`the-chase`): every section it emits a lead for genuinely has the sax
 * playing, and every section with no sax stays silent.
 *
 * It is not, however, what ships. Measured directly (task-9-report.md's
 * addendum): the emitted notes barely correlate with the true part even in
 * the sections that pass every gate. Section 9 has 180 real sax events and
 * this pipeline surfaces 2 notes, exact-MIDI agreement 0%. Section 8 has one
 * real sax note in five bars and this pipeline emits eighteen, chasing
 * whatever else is loud in the stem - onset match against the true part 5%.
 * Aggregate exact-MIDI agreement across every emitted section: 9 of 129, ~7%,
 * chance level. A lead in the right place playing uncorrelated notes is
 * exactly the wrong hook #44 says is worse than silence, and the gates above
 * cannot fix it: MIN_NOTES/MIN_CLARITY/MIN_VOICED_FRACTION only ask "is there
 * a clear pitched line," which the epiano and sawtooth sharing this stem
 * satisfy as well as the sax does, and MAX_CHORD_TONE_FRACTION only catches
 * the specific case where that other content is also the detected chord's own
 * tones.
 *
 * The suspected cause - this stem carries several pitched instruments at
 * once and the tracker follows whichever is loudest, not necessarily the lead
 * - was tested directly. Chord tones already known from `transcribeHarmony`
 * were synthesised (summed sine partials across three octaves) and spectrally
 * subtracted from the stem per analysis frame, least-squares scaled to best
 * explain each frame before subtracting. Verified this was real cancellation,
 * not a no-op: up to 100% reduction at the targeted bins in a chord-heavy
 * frame, 72% of that frame's total energy removed, 6-16% of RMS energy
 * removed across the two sections measured end to end. It did not move the
 * result: section 9's detected pitches were byte-identical before and after
 * (Ab4, F3 either way), section 8's were the same scattered, uncorrelated set
 * either way, and neither section's onset/pitch-class/exact-MIDI agreement
 * against ground truth changed at all. The confound is not chord energy this
 * module can subtract its way out of in the pitch domain - it is a tenor sax
 * sharing a stem with an electric piano and other pitched layers this module
 * has no way to tell apart, which is a source-separation problem, not a
 * thresholding one.
 *
 * So `transcribeMelody`, the function anything downstream actually calls,
 * omits every section unconditionally. `detectMelody` and its tests stay: the
 * gates and the chord-tone check are correct on their own terms and worth
 * keeping if a future task adds real separation for this stem (a different
 * technique than the pitch-domain residual tried here, which was ruled out
 * above) rather than a threshold change - `transcribeMelody` is the one line
 * to change to point back at it.
 *
 * That one-line change re-enables the call path, not the calibration.
 * `MIN_CLARITY` and `MIN_VOICED_FRACTION` were set for input this comment
 * itself calls "far more contaminated" than the bass stem - a properly
 * separated source would be cleaner, and thresholds sized for contamination
 * would then likely be too permissive on it. Whoever brings real separation
 * to this stem needs to re-measure both constants against it before trusting
 * `detectMelody`'s output, not just flip the call back on.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { CHORD_TEMPLATES } from './chords.mjs'
import { segmentNotes, trackF0 } from './f0.mjs'
import { foldToLoop, sectionRange, stepAt, stepDrift, stepSeconds } from './quantize.mjs'

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
 * The real entry point. Always omits - see the module doc comment for the
 * measurement that justifies it. Keeps `detectMelody`'s signature so
 * re-enabling it later (once this stem has real separation to run on) is a
 * one-line change here, not a caller-side change.
 */
export function transcribeMelody(wavBuf, grid, sections) {
  return sections.map(() => null)
}

/** The full detection pipeline. Not called by `transcribeMelody` - see the
 *  module doc comment. Kept, and still tested, because the gates and the
 *  chord-tone check are correct on their own terms; the problem is upstream
 *  of them. */
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

    const folded = foldToLoop(
      inSection.map(({ clarity, ...event }) => event),
      section,
      grid,
    )
    if (folded.events.length < MIN_DISTINCT_PITCHES) return null

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
