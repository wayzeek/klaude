import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import { detectMelody, transcribeMelody } from './melody.mjs'
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

// `transcribeMelody` is what the rebuild pipeline actually calls. Measured
// (task-9-report.md's addendum): even where `detectMelody` clears every gate,
// its notes barely correlate with the true lead - aggregate exact-MIDI
// agreement of 9/129 (~7%, chance level) against the real sax part, and one
// section emitted 18 notes against a single true one. A wrong hook is worse
// than a missing one, so this function omits unconditionally until a future
// task gives it a real separated source to read instead of a shared stem.
describe('transcribeMelody', () => {
  it('omits every section regardless of how strong the underlying line is', () => {
    // fourBars is the exact fixture detectMelody recovers cleanly as a loop
    // (see the first `detectMelody` test above) - proof this is a deliberate
    // override, not a fixture that would fail to find anything anyway.
    const result = transcribeMelody(leadClip(fourBars), grid, SECTION_4)
    expect(result).toEqual([null])
  })

  it('returns one null per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const result = transcribeMelody(leadClip(fourBars), grid, sections)
    expect(result).toEqual([null, null])
  })
})
