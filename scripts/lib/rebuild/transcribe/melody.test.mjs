import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import {
  detectMelody,
  detectMelodySalience,
  selectMelodicLine,
  transcribeMelody,
  transcribeMelodyFromNotes,
} from './melody.mjs'
import { gridFromJson } from './quantize.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const grid = gridFromJson({
  bpm: BPM,
  beatSeconds: 60 / BPM,
  barSeconds: (60 / BPM) * 4,
  downbeatSeconds: 0,
  beatsPerBar: 4,
})
const BEAT = 60 / BPM

/** A monophonic line: [{ midi, beats }], plus an optional sustained pad
 *  underneath so the fixture resembles a real `other` stem. */
function leadClip(line, { padMidi = [], gain = 0.4, padGain = 0.12 } = {}) {
  const total = line.reduce((sum, note) => sum + note.beats, 0) * BEAT
  const frames = Math.ceil(total * SAMPLE_RATE)
  const out = new Float32Array(frames)

  for (const midi of padMidi) {
    const hz = midiToHz(midi)
    for (let i = 0; i < frames; i++) out[i] += padGain * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  }

  let cursor = 0
  for (const note of line) {
    const n = Math.floor(note.beats * BEAT * SAMPLE_RATE)
    if (note.midi !== null) {
      const hz = midiToHz(note.midi)
      const start = Math.floor(cursor * SAMPLE_RATE)
      for (let i = 0; i < n && start + i < frames; i++) {
        const fade = Math.min(1, i / (SAMPLE_RATE * 0.008), (n - i) / (SAMPLE_RATE * 0.008))
        out[start + i] +=
          gain * fade *
          (Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) +
            0.4 * Math.sin((2 * Math.PI * hz * 2 * i) / SAMPLE_RATE))
      }
    }
    cursor += note.beats * BEAT
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

const SECTION_4 = [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null }]
const NO_CHORDS = [null]

/** One bar of melody, repeated four times. */
const phrase = [
  { midi: 65, beats: 1 },
  { midi: 68, beats: 1 },
  { midi: 72, beats: 1 },
  { midi: 68, beats: 1 },
]
const fourBars = [...phrase, ...phrase, ...phrase, ...phrase]

// `detectMelody` is the full pitch-tracking pipeline. It is not what ships -
// see melody.mjs's module doc comment and task-9-report.md's addendum for the
// measurement that took it out of `transcribeMelody` - but the gates and the
// chord-tone check are correct on their own terms, so this suite still pins
// them down directly.
describe('detectMelody', () => {
  it('recovers a repeating phrase as a one-bar loop', () => {
    const loop = detectMelody(leadClip(fourBars), grid, SECTION_4, { chords: NO_CHORDS })[0]
    expect(loop).not.toBeNull()
    expect(loop.loopBars).toBe(1)
    expect(loop.events.map((e) => e.midi)).toEqual([65, 68, 72, 68])
  })

  it('keeps octaves', () => {
    const line = [
      { midi: 60, beats: 1 }, { midi: 72, beats: 1 }, { midi: 60, beats: 1 }, { midi: 72, beats: 1 },
    ]
    const loop = detectMelody(leadClip([...line, ...line, ...line, ...line]), grid, SECTION_4, {
      chords: NO_CHORDS,
    })[0]
    expect(loop.events.map((e) => e.midi)).toEqual([60, 72, 60, 72])
  })

  it('omits the layer when there is only a pad', () => {
    // A held triad and nothing else: harmony, not a lead.
    const held = [{ midi: null, beats: 16 }]
    const loop = detectMelody(leadClip(held, { padMidi: [53, 56, 60] }), grid, SECTION_4, {
      chords: NO_CHORDS,
    })[0]
    expect(loop).toBeNull()
  })

  it('omits the layer for silence', () => {
    const silent = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(Math.ceil(8 * SAMPLE_RATE))],
    })
    expect(detectMelody(silent, grid, SECTION_4, { chords: NO_CHORDS })[0]).toBeNull()
  })

  it('omits the layer when the line is too short to be a hook', () => {
    // Two notes in four bars is not a melody.
    const sparse = [{ midi: 65, beats: 1 }, { midi: null, beats: 14 }, { midi: 68, beats: 1 }]
    expect(detectMelody(leadClip(sparse), grid, SECTION_4, { chords: NO_CHORDS })[0]).toBeNull()
  })

  it('carries confidence and no chord symbol on every note', () => {
    const loop = detectMelody(leadClip(fourBars), grid, SECTION_4, { chords: NO_CHORDS })[0]
    for (const event of loop.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
      expect(event.symbol).toBeNull()
      expect(typeof event.midi).toBe('number')
    }
  })

  it('returns one entry per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const result = detectMelody(leadClip(fourBars), grid, sections, { chords: [null, null] })
    expect(result).toHaveLength(2)
  })

  it('drops a line that only ever plays the sounding chord’s own tones', () => {
    const chordLoop = {
      loopBars: 1,
      events: [
        { step: 0, length: 16, velocity: 0.7, confidence: 0.9, midi: null, symbol: 'Fm', driftSteps: 0 },
      ],
      confidence: 0.9,
      outOfKey: 0,
    }
    // F, Ab, C, Ab across each bar - all Fm chord tones, enough of them to
    // clear MIN_NOTES and MIN_DISTINCT_PITCHES so the chord-tone rule is what
    // actually rejects it. Without that the test would pass on a different
    // guard and prove nothing.
    const arp = [
      { midi: 65, beats: 1 }, { midi: 68, beats: 1 }, { midi: 72, beats: 1 }, { midi: 68, beats: 1 },
    ]
    const line = [...arp, ...arp, ...arp, ...arp]
    expect(detectMelody(leadClip(line), grid, SECTION_4, { chords: [chordLoop] })[0]).toBeNull()
  })

  it('keeps a line that leaves the chord', () => {
    // The same rhythm, but the third note is a G - not in Fm. Two of four notes
    // sit outside, well under MAX_CHORD_TONE_FRACTION, so this is a real line.
    const chordLoop = {
      loopBars: 1,
      events: [
        { step: 0, length: 16, velocity: 0.7, confidence: 0.9, midi: null, symbol: 'Fm', driftSteps: 0 },
      ],
      confidence: 0.9,
      outOfKey: 0,
    }
    const arp = [
      { midi: 65, beats: 1 }, { midi: 67, beats: 1 }, { midi: 70, beats: 1 }, { midi: 67, beats: 1 },
    ]
    const line = [...arp, ...arp, ...arp, ...arp]
    expect(detectMelody(leadClip(line), grid, SECTION_4, { chords: [chordLoop] })[0]).not.toBeNull()
  })
})

// `detectMelodySalience` is the replacement for `detectMelody`'s YIN pitch
// track: harmonic-summation salience (`salience.mjs`) in place of a
// single-periodicity search, so a pad and a lead each get their own visible
// peak instead of the tracker silently following whichever one dominates a
// given frame. See melody.mjs's module doc comment for the measurement
// (462-event ground truth on the reference track, an independent spectral
// check on Bicep's "Glue") that justifies this being what `transcribeMelody`
// actually calls now.
describe('detectMelodySalience', () => {
  it('recovers a repeating phrase as a one-bar loop', () => {
    const loop = detectMelodySalience(leadClip(fourBars), grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.loopBars).toBe(1)
    expect(loop.events.map((e) => e.midi)).toEqual([65, 68, 72, 68])
  })

  it('recovers the lead over a sustained pad underneath it', () => {
    // The whole point of a salience-based extractor over YIN: the pad is
    // real, simultaneous, harmonically-rich content, not a single sine wave
    // this test is dodging - and the lead still wins on register.
    const loop = detectMelodySalience(leadClip(fourBars, { padMidi: [53, 56, 60] }), grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.events.map((e) => e.midi)).toEqual([65, 68, 72, 68])
  })

  it('omits the layer when there is only a pad', () => {
    const held = [{ midi: null, beats: 16 }]
    const loop = detectMelodySalience(leadClip(held, { padMidi: [53, 56, 60] }), grid, SECTION_4)[0]
    expect(loop).toBeNull()
  })

  it('omits the layer for silence', () => {
    const silent = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(Math.ceil(8 * SAMPLE_RATE))],
    })
    expect(detectMelodySalience(silent, grid, SECTION_4)[0]).toBeNull()
  })

  it('omits the layer when the line is too short to be a hook', () => {
    const sparse = [{ midi: 65, beats: 1 }, { midi: null, beats: 14 }, { midi: 68, beats: 1 }]
    expect(detectMelodySalience(leadClip(sparse), grid, SECTION_4)[0]).toBeNull()
  })

  it('carries confidence and no chord symbol on every note', () => {
    const loop = detectMelodySalience(leadClip(fourBars), grid, SECTION_4)[0]
    for (const event of loop.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
      expect(event.symbol).toBeNull()
      expect(typeof event.midi).toBe('number')
    }
  })

  it('returns one entry per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const result = detectMelodySalience(leadClip(fourBars), grid, sections)
    expect(result).toHaveLength(2)
  })

  it('rejects a section when a gate option is tightened past what the line clears', () => {
    const strict = detectMelodySalience(leadClip(fourBars), grid, SECTION_4, { minNotes: 100 })[0]
    expect(strict).toBeNull()
  })

  // detectMelodySalience deliberately does NOT check the chord-tone rule
  // detectMelody uses (see the module doc comment): porting it with the same
  // threshold was tried and measured to destroy real accuracy on the
  // reference track, because this pipeline's genuinely correct notes also
  // carry a high chord-tone fraction. A stem with literally nothing sounding
  // but a chord progression (no separate lead voice at all) can still
  // produce a "lead" that is really the chords' own top note - a known,
  // documented limitation, not silently unhandled.

  it('forwards salience-specific options through to computeMelodyContour, not just its own gates', () => {
    // `minNotes` above is consumed by detectMelodySalience itself before
    // `...salienceOptions` is ever built, so it would pass even if that
    // spread were silently dropped. `rmsFloor` is not one of
    // detectMelodySalience's own options - it only means anything to
    // computeMelodyContour - so this only returns null if the pass-through
    // actually reaches it. An RMS floor of 10 is unreachable by any real
    // waveform (samples are bounded to [-1, 1]), so every frame reads as
    // silent regardless of the fixture, which is `fourBars` - the exact clip
    // the first test above recovers cleanly with no override.
    const silenced = detectMelodySalience(leadClip(fourBars), grid, SECTION_4, { rmsFloor: 10 })[0]
    expect(silenced).toBeNull()
  })
})

// `transcribeMelody` is what the rebuild pipeline actually calls. It now
// calls `detectMelodySalience` - see melody.mjs's module doc comment for the
// measurement that justifies it.
describe('transcribeMelody', () => {
  it('recovers a lead the same way detectMelodySalience does', () => {
    const result = transcribeMelody(leadClip(fourBars), grid, SECTION_4)
    expect(result[0]).not.toBeNull()
    expect(result[0].events.map((e) => e.midi)).toEqual([65, 68, 72, 68])
  })

  it('still omits a section with no real line', () => {
    const held = [{ midi: null, beats: 16 }]
    const result = transcribeMelody(leadClip(held, { padMidi: [53, 56, 60] }), grid, SECTION_4)
    expect(result).toEqual([null])
  })

  it('returns one entry per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const result = transcribeMelody(leadClip(fourBars), grid, sections)
    expect(result).toHaveLength(2)
  })
})

/** A Basic Pitch-shaped note: seconds and 0-1 velocity, not steps. */
const bpNote = (midi, startSec, endSec, velocity = 0.6) => ({ midi, startSec, endSec, velocity })

describe('selectMelodicLine', () => {
  it('returns an empty array for no notes', () => {
    expect(selectMelodicLine([])).toEqual([])
  })

  it('keeps every note of a single, non-overlapping monophonic line untouched', () => {
    const notes = [bpNote(65, 0, 0.5), bpNote(68, 0.5, 1.0), bpNote(72, 1.0, 1.5)]
    expect(selectMelodicLine(notes).map((n) => n.midi)).toEqual([65, 68, 72])
  })

  it('never returns two notes that overlap in time', () => {
    // A dense, heavily overlapping polyphonic mess: any valid selection must
    // still be monophonic.
    const notes = [
      bpNote(60, 0, 1.0, 0.3),
      bpNote(64, 0, 1.0, 0.3),
      bpNote(67, 0, 1.0, 0.3),
      bpNote(72, 0.2, 0.8, 0.9),
      bpNote(75, 0.4, 1.2, 0.5),
    ]
    const chain = selectMelodicLine(notes)
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const overlaps = chain[i].startSec < chain[j].endSec && chain[i].endSec > chain[j].startSec
        expect(overlaps).toBe(false)
      }
    }
  })

  it('prefers the louder of two candidates that would otherwise tie', () => {
    // Two notes, same register context, competing for the same time slot -
    // salience (velocity) is the only thing that tells them apart.
    const quiet = bpNote(60, 0, 1.0, 0.2)
    const loud = bpNote(64, 0, 1.0, 0.9)
    const chain = selectMelodicLine([quiet, loud], { registerWeight: 0 })
    expect(chain.map((n) => n.midi)).toEqual([64])
  })

  it('prefers the note sitting higher above the concurrently sounding pad', () => {
    // A held three-note pad, one candidate inside the pad's own register and
    // one well above it, all sounding through the same interval - equal
    // velocity throughout, so with salience switched off only register can
    // decide which of `low`/`high` gets the (single, since everything here
    // overlaps everything else) slot.
    const pad = [bpNote(48, 0, 1.0, 0.5), bpNote(52, 0, 1.0, 0.5), bpNote(55, 0, 1.0, 0.5)]
    const low = bpNote(53, 0, 1.0, 0.5) // inside the pad's own register
    const high = bpNote(79, 0, 1.0, 0.5) // well above the pad
    const chain = selectMelodicLine([...pad, low, high], { salienceWeight: 0 })
    expect(chain.map((n) => n.midi)).toEqual([79])
  })

  it('caps register credit so a quiet high overtone cannot beat a loud true note', () => {
    const loud = bpNote(65, 0, 1.0, 0.9)
    const quietOvertone = bpNote(89, 0, 1.0, 0.1) // two octaves higher, much quieter
    const chain = selectMelodicLine([loud, quietOvertone])
    expect(chain.map((n) => n.midi)).toEqual([65])
  })

  it('is deterministic: the same input always returns the same chain', () => {
    const notes = [
      bpNote(60, 0, 0.5, 0.4),
      bpNote(64, 0.1, 0.6, 0.6),
      bpNote(67, 0.5, 1.0, 0.5),
      bpNote(72, 0.6, 1.1, 0.55),
    ]
    const a = selectMelodicLine(notes).map((n) => n.midi)
    const b = selectMelodicLine(notes).map((n) => n.midi)
    expect(a).toEqual(b)
  })
})

describe('transcribeMelodyFromNotes', () => {
  it('recovers a simple non-overlapping melody', () => {
    const stepSeconds = grid.beatSeconds / 4
    const notes = [
      bpNote(65, 0, 2 * stepSeconds, 0.7),
      bpNote(68, 2 * stepSeconds, 4 * stepSeconds, 0.7),
      bpNote(72, 4 * stepSeconds, 6 * stepSeconds, 0.7),
      bpNote(68, 6 * stepSeconds, 8 * stepSeconds, 0.7),
    ]
    const loop = transcribeMelodyFromNotes(notes, grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.events.map((e) => e.midi)).toEqual([65, 68, 72, 68])
    expect(loop.events.map((e) => e.step)).toEqual([0, 2, 4, 6])
  })

  it('returns null for a section with too few notes', () => {
    const notes = [bpNote(65, 0, 0.5), bpNote(68, 0.5, 1.0)]
    expect(transcribeMelodyFromNotes(notes, grid, SECTION_4)[0]).toBeNull()
  })

  it('returns null for a section with enough notes but too few distinct pitches', () => {
    const stepSeconds = grid.beatSeconds / 4
    const notes = Array.from({ length: 6 }, (_, i) => bpNote(65, i * 2 * stepSeconds, (i * 2 + 1) * stepSeconds, 0.7))
    expect(transcribeMelodyFromNotes(notes, grid, SECTION_4)[0]).toBeNull()
  })

  it('returns null (not throw) for an empty note list', () => {
    expect(transcribeMelodyFromNotes([], grid, SECTION_4)).toEqual([null])
  })

  it('picks the higher, louder voice out of a pad-plus-hook mixture', () => {
    const stepSeconds = grid.beatSeconds / 4
    // A held low three-note pad across the whole bar, plus a four-note hook
    // moving above it - `transcribeMelodyFromNotes` should recover the hook,
    // not the pad's own top note.
    const barSeconds = 16 * stepSeconds
    const pad = [
      bpNote(48, 0, barSeconds, 0.3),
      bpNote(52, 0, barSeconds, 0.3),
      bpNote(55, 0, barSeconds, 0.3),
    ]
    const hook = [
      bpNote(77, 0, 4 * stepSeconds, 0.8),
      bpNote(80, 4 * stepSeconds, 8 * stepSeconds, 0.8),
      bpNote(84, 8 * stepSeconds, 12 * stepSeconds, 0.8),
      bpNote(80, 12 * stepSeconds, 16 * stepSeconds, 0.8),
    ]
    const loop = transcribeMelodyFromNotes([...pad, ...hook], grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.events.map((e) => e.midi)).toEqual([77, 80, 84, 80])
  })

  it('returns one entry per section', () => {
    const stepSeconds = grid.beatSeconds / 4
    const notes = [
      bpNote(65, 0, 2 * stepSeconds),
      bpNote(68, 2 * stepSeconds, 4 * stepSeconds),
      bpNote(72, 4 * stepSeconds, 6 * stepSeconds),
      bpNote(68, 6 * stepSeconds, 8 * stepSeconds),
    ]
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    expect(transcribeMelodyFromNotes(notes, grid, sections)).toHaveLength(2)
  })
})
