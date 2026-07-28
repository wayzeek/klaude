import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import { gridFromJson } from './quantize.mjs'
import { transcribeBass } from './bass.mjs'

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
    // A note held for four steps, then silence.
    const bar = [41, 41, 41, 41, ...new Array(12).fill(null)]
    const loop = transcribeBass(bassClip(repeat(bar, 4)), grid, SECTION_4)[0]
    expect(loop.events).toHaveLength(1)
    expect(loop.events[0].length).toBeGreaterThanOrEqual(3)
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
