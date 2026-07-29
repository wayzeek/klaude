/**
 * Lead line transcription from the harmony stem's residual.
 *
 * This is the most likely of the four transcribers to produce nothing usable,
 * and that is an acceptable outcome. Omitting the layer is always better than
 * inventing a melody: a wrong hook is immediately obvious and a missing one is
 * not. Every threshold below is set to omit when unsure.
 *
 * "Residual" here does not mean spectral subtraction - that would need the
 * chords rendered back to audio, which is Task 10's job and circular here.
 * It means: track the strongest pitch in the lead register, then discard any
 * line that turns out to be the chords' own top voice rather than a part.
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

export function transcribeMelody(wavBuf, grid, sections, { chords = [] } = {}) {
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
