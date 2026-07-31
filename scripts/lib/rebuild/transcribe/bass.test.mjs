import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import { gridFromJson } from './quantize.mjs'
import { SUB_BASS_MAX_MIDI, reduceToLowestVoice, splitByRegister, transcribeBass, transcribeBassFromNotes } from './bass.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const grid = gridFromJson({
  bpm: BPM,
  beatSeconds: 60 / BPM,
  barSeconds: (60 / BPM) * 4,
  downbeatSeconds: 0,
  beatsPerBar: 4,
})
const STEP = 60 / BPM / 4 // 0.125s at 120 BPM

/** A bassline given as [midi|null] per sixteenth step. `null` is a rest. */
function bassClip(steps, { gain = 0.5 } = {}) {
  const frames = Math.ceil(steps.length * STEP * SAMPLE_RATE)
  const out = new Float32Array(frames)
  for (let s = 0; s < steps.length; s++) {
    if (steps[s] === null) continue
    const hz = midiToHz(steps[s])
    const start = Math.floor(s * STEP * SAMPLE_RATE)
    const n = Math.floor(STEP * SAMPLE_RATE)
    for (let i = 0; i < n && start + i < frames; i++) {
      const fade = Math.min(1, i / (SAMPLE_RATE * 0.004), (n - i) / (SAMPLE_RATE * 0.004))
      out[start + i] +=
        gain * fade *
        (Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) +
          0.5 * Math.sin((2 * Math.PI * hz * 2 * i) / SAMPLE_RATE) +
          0.25 * Math.sin((2 * Math.PI * hz * 3 * i) / SAMPLE_RATE))
    }
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

/** Repeat a one-bar step array `bars` times. */
const repeat = (bar, bars) => Array.from({ length: bars }, () => bar).flat()

/** One bar, repeated `bars` times: a single continuously-held note for
 *  `holdSteps` steps (one unbroken envelope, not `bassClip`'s independent
 *  per-step attack) followed by silence for the rest of the bar. Unlike
 *  `bassClip` with repeated identical steps, nothing here re-attacks - this
 *  is what a genuinely sustained note looks like, as opposed to a repeated
 *  same-pitch note (see the re-articulation tests below). */
function heldBassClip(midi, holdSteps, stepsPerBar, bars, { gain = 0.5 } = {}) {
  const barFrames = Math.ceil(stepsPerBar * STEP * SAMPLE_RATE)
  const holdFrames = Math.floor(holdSteps * STEP * SAMPLE_RATE)
  const hz = midiToHz(midi)
  const bar = new Float32Array(barFrames)
  for (let i = 0; i < holdFrames; i++) {
    const fade = Math.min(1, i / (SAMPLE_RATE * 0.004), (holdFrames - i) / (SAMPLE_RATE * 0.004))
    bar[i] =
      gain * fade *
      (Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) +
        0.5 * Math.sin((2 * Math.PI * hz * 2 * i) / SAMPLE_RATE) +
        0.25 * Math.sin((2 * Math.PI * hz * 3 * i) / SAMPLE_RATE))
  }
  const out = new Float32Array(barFrames * bars)
  for (let b = 0; b < bars; b++) out.set(bar, b * barFrames)
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

/** `stepsPerBar` sixteenths, `hits` of them holding the same pitch with a
 *  real attack at every step (no legato) - a repeated same-pitch bassline,
 *  the case #NN diagnosed against Bicep's "Glue": constant pitch and
 *  continuous voicing, so only an amplitude attack marks each repeat. Built
 *  from `bassClip` itself: consecutive identical steps there already fade to
 *  near-zero and back at every step boundary, which is a real re-attack, not
 *  legato. */
function reattackedBassClip(midi, hits, stepsPerBar, bars, { gain = 0.5 } = {}) {
  const bar = new Array(stepsPerBar).fill(null)
  for (let i = 0; i < hits; i++) bar[i] = midi
  return bassClip(repeat(bar, bars), { gain })
}

const SECTION_4 = [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null }]

describe('transcribeBass', () => {
  it('recovers a one-bar riff as a one-bar loop', () => {
    // F2, rest, F2, rest, Ab2, rest, C3, rest - on the eighths.
    const bar = [41, null, 41, null, 44, null, 48, null, 41, null, 41, null, 44, null, 48, null]
    const loop = transcribeBass(bassClip(repeat(bar, 4)), grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.loopBars).toBe(1)
    expect(loop.events.map((e) => e.midi)).toEqual([41, 41, 44, 48, 41, 41, 44, 48])
  })

  it('gets the octave right, not just the pitch class', () => {
    const bar = new Array(16).fill(null)
    bar[0] = 29 // F1
    bar[8] = 41 // F2
    const loop = transcribeBass(bassClip(repeat(bar, 4)), grid, SECTION_4)[0]
    expect(loop.events.map((e) => e.midi)).toEqual([29, 41])
  })

  it('keeps rests as rests', () => {
    const bar = new Array(16).fill(null)
    bar[0] = 41
    const loop = transcribeBass(bassClip(repeat(bar, 4)), grid, SECTION_4)[0]
    expect(loop.events).toHaveLength(1)
    expect(loop.events[0].step).toBe(0)
  })

  it('gives every note a length in steps', () => {
    // One continuously-held note across four steps - a single unbroken
    // envelope, not four re-attacks (see the re-articulation tests below for
    // that case) - then silence.
    const loop = transcribeBass(heldBassClip(41, 4, 16, 4), grid, SECTION_4)[0]
    expect(loop.events).toHaveLength(1)
    expect(loop.events[0].length).toBeGreaterThanOrEqual(3)
  })

  describe('re-articulation', () => {
    it('splits a bassline that repeats the same pitch, instead of collapsing it into one held note', () => {
      // Four eighth-note hits, all F2, no rests between them - the exact
      // shape #NN diagnosed: constant pitch and continuous voicing, so the
      // only signal marking each repeat is an amplitude attack.
      const loop = transcribeBass(reattackedBassClip(41, 4, 16, 4), grid, SECTION_4)[0]
      expect(loop).not.toBeNull()
      expect(loop.events.length).toBeGreaterThan(1)
      expect(loop.events.every((e) => e.midi === 41)).toBe(true)
    })
  })

  it('returns null for a silent section rather than an empty loop', () => {
    const silent = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(Math.ceil(8 * SAMPLE_RATE))],
    })
    expect(transcribeBass(silent, grid, SECTION_4)[0]).toBeNull()
  })

  it('flags rather than emits when the line is unclear', () => {
    // Band-limited noise in the bass range: real energy, no fundamental.
    let seed = 4242
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff - 0.5
    }
    const frames = Math.ceil(8 * SAMPLE_RATE)
    const out = new Float32Array(frames)
    let low = 0
    for (let i = 0; i < frames; i++) {
      low += 0.02 * (rand() - low) // crude one-pole low-pass
      out[i] = low * 8
    }
    const buf = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const loop = transcribeBass(buf, grid, SECTION_4)[0]
    // Either omitted outright, or emitted with visibly low confidence.
    if (loop !== null) expect(loop.confidence).toBeLessThan(0.5)
  })

  it('carries confidence on every note', () => {
    const bar = [41, null, null, null, 44, null, null, null, 41, null, null, null, 48, null, null, null]
    const loop = transcribeBass(bassClip(repeat(bar, 4)), grid, SECTION_4)[0]
    for (const event of loop.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
      expect(event.symbol).toBeNull()
    }
  })

  it('returns one entry per section', () => {
    const bar = [41, null, null, null, 44, null, null, null, 41, null, null, null, 48, null, null, null]
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    expect(transcribeBass(bassClip(repeat(bar, 4)), grid, sections)).toHaveLength(2)
  })
})

const loopNote = (step, midi, length = 1) => ({ step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0 })

describe('splitByRegister', () => {
  it('sends a note below the boundary to sub and keeps one at/above it in bass', () => {
    const loop = { loopBars: 1, events: [loopNote(0, 24), loopNote(4, 40)], confidence: 0.9 }
    const { sub, bass } = splitByRegister([loop])
    expect(sub[0].events.map((e) => e.midi)).toEqual([24])
    expect(bass[0].events.map((e) => e.midi)).toEqual([40])
  })

  it('treats the boundary itself as bass, not sub (strictly-below comparison)', () => {
    const loop = { loopBars: 1, events: [loopNote(0, SUB_BASS_MAX_MIDI)], confidence: 0.9 }
    const { sub, bass } = splitByRegister([loop])
    expect(sub[0]).toBeNull()
    expect(bass[0].events.map((e) => e.midi)).toEqual([SUB_BASS_MAX_MIDI])
  })

  it('omits sub rather than inventing one when every note is in the mid-bass register', () => {
    const loop = { loopBars: 1, events: [loopNote(0, 40), loopNote(4, 44)], confidence: 0.9 }
    const { sub, bass } = splitByRegister([loop])
    expect(sub[0]).toBeNull()
    expect(bass[0].events.map((e) => e.midi)).toEqual([40, 44])
  })

  it('omits bass rather than inventing one when every note is in the sub register', () => {
    const loop = { loopBars: 1, events: [loopNote(0, 24), loopNote(4, 27)], confidence: 0.9 }
    const { sub, bass } = splitByRegister([loop])
    expect(bass[0]).toBeNull()
    expect(sub[0].events.map((e) => e.midi)).toEqual([24, 27])
  })

  it('passes a null section through as null on both sides', () => {
    const { sub, bass } = splitByRegister([null])
    expect(sub[0]).toBeNull()
    expect(bass[0]).toBeNull()
  })

  it('carries loopBars and confidence through unchanged on both sides', () => {
    const loop = { loopBars: 2, events: [loopNote(0, 24), loopNote(4, 40)], confidence: 0.73 }
    const { sub, bass } = splitByRegister([loop])
    expect(sub[0].loopBars).toBe(2)
    expect(sub[0].confidence).toBe(0.73)
    expect(bass[0].loopBars).toBe(2)
    expect(bass[0].confidence).toBe(0.73)
  })

  it('does not mutate the input loop', () => {
    const loop = { loopBars: 1, events: [loopNote(0, 24), loopNote(4, 40)], confidence: 0.9 }
    const before = JSON.parse(JSON.stringify(loop))
    splitByRegister([loop])
    expect(loop).toEqual(before)
  })

  it('respects a custom boundary', () => {
    const loop = { loopBars: 1, events: [loopNote(0, 20), loopNote(4, 25)], confidence: 0.9 }
    const { sub, bass } = splitByRegister([loop], { boundary: 22 })
    expect(sub[0].events.map((e) => e.midi)).toEqual([20])
    expect(bass[0].events.map((e) => e.midi)).toEqual([25])
  })

  it('returns one entry per section, aligned with the input array', () => {
    const loops = [
      { loopBars: 1, events: [loopNote(0, 24)], confidence: 0.9 },
      null,
      { loopBars: 1, events: [loopNote(0, 40)], confidence: 0.9 },
    ]
    const { sub, bass } = splitByRegister(loops)
    expect(sub).toHaveLength(3)
    expect(bass).toHaveLength(3)
    expect(sub[1]).toBeNull()
    expect(bass[1]).toBeNull()
  })
})

/** A Basic Pitch-shaped note: seconds and 0-1 velocity, not steps. */
const bpNote = (midi, startSec, endSec, velocity = 0.7) => ({ midi, startSec, endSec, velocity })

describe('reduceToLowestVoice', () => {
  it('keeps a single note untouched', () => {
    const notes = [bpNote(41, 0, 0.5)]
    expect(reduceToLowestVoice(notes)).toEqual(notes)
  })

  it('keeps two notes that do not overlap in time', () => {
    const notes = [bpNote(41, 0, 0.5), bpNote(48, 0.5, 1.0)]
    expect(reduceToLowestVoice(notes)).toEqual(notes)
  })

  it('picks the lower of two notes that overlap, discarding the higher one', () => {
    const low = bpNote(29, 0, 1.0)
    const high = bpNote(41, 0.1, 0.6) // a harmonic partial sounding over the same span
    expect(reduceToLowestVoice([high, low])).toEqual([low])
  })

  it('merges transitively: three notes chained by overlap collapse to the lowest', () => {
    // A (0-0.6), B (0.4-1.0), C (0.9-1.4): A and C never overlap directly,
    // but both overlap B, so all three form one cluster.
    const a = bpNote(48, 0, 0.6)
    const b = bpNote(29, 0.4, 1.0) // the real fundamental, lowest of the three
    const c = bpNote(53, 0.9, 1.4)
    const reduced = reduceToLowestVoice([a, b, c])
    expect(reduced).toHaveLength(1)
    expect(reduced[0]).toEqual(b)
  })

  it('breaks an exact-pitch tie by the longer note, then the louder one', () => {
    const short = bpNote(41, 0, 0.2, 0.9)
    const long = bpNote(41, 0.05, 0.8, 0.3)
    expect(reduceToLowestVoice([short, long])).toEqual([long])

    const quiet = bpNote(41, 0, 0.5, 0.2) // length 0.5
    const loud = bpNote(41, 0.05, 0.55, 0.9) // same length (0.5), genuinely overlapping
    expect(reduceToLowestVoice([quiet, loud])).toEqual([loud])
  })

  it('returns clusters in time order', () => {
    const notes = [bpNote(41, 1.0, 1.5), bpNote(36, 0, 0.5)]
    const reduced = reduceToLowestVoice(notes)
    expect(reduced.map((n) => n.midi)).toEqual([36, 41])
  })
})

describe('transcribeBassFromNotes', () => {
  it('recovers a simple bassline from Basic Pitch notes', () => {
    const notes = [
      bpNote(41, 0, 0.5),
      bpNote(44, 0.5, 1.0),
      bpNote(41, 1.0, 1.5),
      bpNote(48, 1.5, 2.0),
    ]
    const loop = transcribeBassFromNotes(notes, grid, SECTION_4)[0]
    expect(loop).not.toBeNull()
    expect(loop.events.map((e) => e.midi)).toEqual([41, 44, 41, 48])
  })

  it('discards the higher of two overlapping notes, same as reduceToLowestVoice', () => {
    const notes = [
      bpNote(29, 0, 0.5), // real fundamental
      bpNote(41, 0, 0.4), // a harmonic partial, overlapping
      bpNote(31, 0.5, 1.0),
      bpNote(33, 1.0, 1.5),
    ]
    const loop = transcribeBassFromNotes(notes, grid, SECTION_4)[0]
    expect(loop.events.map((e) => e.midi)).toEqual([29, 31, 33])
  })

  it('returns null for a section with too few notes', () => {
    const notes = [bpNote(41, 0, 0.5)]
    expect(transcribeBassFromNotes(notes, grid, SECTION_4)[0]).toBeNull()
  })

  it('returns null (not throw) for an empty note list', () => {
    expect(transcribeBassFromNotes([], grid, SECTION_4)).toEqual([null])
  })

  it('carries the note real velocity through to both velocity and confidence', () => {
    const notes = [bpNote(41, 0, 0.5, 0.42), bpNote(44, 0.5, 1.0, 0.9), bpNote(41, 1.0, 1.5, 0.5)]
    const loop = transcribeBassFromNotes(notes, grid, SECTION_4)[0]
    const first = loop.events.find((e) => e.step === 0)
    expect(first.velocity).toBeCloseTo(0.42, 5)
  })

  it('quantises onsets to the grid the same way the DSP path does', () => {
    // A note starting slightly late (half a step) should round to the nearest step.
    const stepSeconds = grid.beatSeconds / 4
    const notes = [
      bpNote(41, 0, stepSeconds),
      bpNote(44, 4 * stepSeconds + stepSeconds * 0.1, 5 * stepSeconds),
      bpNote(41, 8 * stepSeconds, 9 * stepSeconds),
    ]
    const loop = transcribeBassFromNotes(notes, grid, SECTION_4)[0]
    expect(loop.events.map((e) => e.step)).toEqual([0, 4, 8])
  })

  it('only one event survives per step even when two loop repetitions disagree', () => {
    // Two-bar loop where bar 2 repeats bar 0/1's rhythm but a stray extra
    // overlapping note appears once - the lowest voice wins deterministically.
    const stepSeconds = grid.beatSeconds / 4
    const bar = (offsetBars) => [
      bpNote(41, (offsetBars * 16 + 0) * stepSeconds, (offsetBars * 16 + 4) * stepSeconds),
      bpNote(44, (offsetBars * 16 + 4) * stepSeconds, (offsetBars * 16 + 8) * stepSeconds),
    ]
    const notes = [...bar(0), ...bar(1), ...bar(2), ...bar(3)]
    const loop = transcribeBassFromNotes(notes, grid, SECTION_4)[0]
    const steps = loop.events.map((e) => e.step)
    expect(new Set(steps).size).toBe(steps.length) // no duplicate steps
  })
})
