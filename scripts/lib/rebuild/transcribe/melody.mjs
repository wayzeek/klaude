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
 * against: 9 of 12 sections emit a lead (up from 5/12), 208 notes emitted,
 * 110 land on a real sax onset (52.9%), 65 get the pitch class right (31.3%),
 * 33 get the exact MIDI note right (15.9% - more than double the ~7%
 * baseline, on the same ground truth). Independently, on Bicep's "Glue" (a
 * synth record with no ground truth, so a different check): for 666 emitted
 * notes, the original mix's own spectral energy at the emitted fundamental
 * (no harmonics, so an octave error cannot hide behind them) beat the energy
 * an octave up, an octave down, and a fifth up 70.1% of the time - against a
 * 25% chance floor and the old pipeline's 27%. Both numbers are large,
 * decisive improvements over both the disabled baseline and chance, on two
 * tracks in different genres, one scored against real ground truth and one
 * against an independent spectral check that cannot be gamed by the same
 * bias the extractor itself might have. That is what justifies calling
 * `detectMelodySalience` from `transcribeMelody` below.
 *
 * It is not a solved problem, and the numbers above say so plainly: most
 * individual notes are still not exactly right (31.3% pitch-class, 15.9%
 * exact-MIDI), and per-section performance is uneven - some sections on
 * `the-chase` score 60%+ exact-MIDI, others land at zero even where the true
 * part plays continuously throughout. See melody-salience-report.md for the
 * full per-section breakdown and the parameter sweep this shipped
 * configuration came from.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { bandNovelty, pickBandOnsets } from './bands.mjs'
import { CHORD_TEMPLATES } from './chords.mjs'
import { segmentNotes, trackF0 } from './f0.mjs'
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
 * takes none, matching every other layer's `transcribe*` entry point.
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

    const folded = foldToLoop(
      inSection.map(({ clarity, ...event }) => event),
      section,
      grid,
      { oneEventPerStep: true },
    )
    if (folded.events.length < minDistinctPitches) return null

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
