import { describe, expect, it } from 'vitest'
import { RESYNTH_SAMPLE_RATE, makeNoise, renderLoop, renderSection } from './resynth.mjs'
import { gridFromJson } from './transcribe/quantize.mjs'

const BPM = 120
const grid = gridFromJson({
  bpm: BPM,
  beatSeconds: 60 / BPM,
  barSeconds: (60 / BPM) * 4,
  downbeatSeconds: 0,
  beatsPerBar: 4,
})

const drumEvent = (step, velocity = 0.8) => ({
  step, length: 1, velocity, confidence: 0.9, midi: null, symbol: null, driftSteps: 0,
})
const noteEvent = (step, midi, length = 4) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0,
})
const chordEvent = (step, symbol, length = 16) => ({
  step, length, velocity: 0.7, confidence: 0.9, midi: null, symbol, driftSteps: 0,
})

const rms = (buffer) => Math.sqrt(buffer.reduce((sum, v) => sum + v * v, 0) / buffer.length)

describe('makeNoise', () => {
  it('is deterministic for a given seed', () => {
    const a = makeNoise(7)
    const b = makeNoise(7)
    for (let i = 0; i < 100; i++) expect(a()).toBe(b())
  })

  it('differs between seeds', () => {
    const a = makeNoise(1)
    const b = makeNoise(2)
    let same = 0
    for (let i = 0; i < 100; i++) if (a() === b()) same++
    expect(same).toBeLessThan(10)
  })

  it('stays in range', () => {
    const rand = makeNoise(99)
    for (let i = 0; i < 1000; i++) {
      const value = rand()
      expect(value).toBeGreaterThanOrEqual(-0.5)
      expect(value).toBeLessThanOrEqual(0.5)
    }
  })
})

describe('renderLoop', () => {
  const oneBarFrames = Math.round(grid.barSeconds * RESYNTH_SAMPLE_RATE)

  it('renders a bar of the requested length', () => {
    const loop = { loopBars: 1, events: [drumEvent(0)], confidence: 0.9 }
    const buffer = renderLoop(loop, 'kick', grid, { bars: 1 })
    expect(buffer.length).toBe(oneBarFrames)
  })

  it('repeats the loop to fill the requested bars', () => {
    const loop = { loopBars: 1, events: [drumEvent(0)], confidence: 0.9 }
    const buffer = renderLoop(loop, 'kick', grid, { bars: 4 })
    expect(buffer.length).toBe(oneBarFrames * 4)
    // Energy at the start of each bar, near silence just before each.
    for (let bar = 0; bar < 4; bar++) {
      const at = Math.round(bar * grid.barSeconds * RESYNTH_SAMPLE_RATE)
      expect(Math.abs(buffer[at + 100])).toBeGreaterThan(0.01)
    }
  })

  it('puts kick energy low and hat energy high', () => {
    const kick = renderLoop({ loopBars: 1, events: [drumEvent(0)], confidence: 1 }, 'kick', grid, { bars: 1 })
    const hats = renderLoop({ loopBars: 1, events: [drumEvent(0)], confidence: 1 }, 'hats', grid, { bars: 1 })
    // Zero-crossing rate separates a 60 Hz thud from a noise tick decisively.
    expect(zeroCrossings(hats)).toBeGreaterThan(zeroCrossings(kick) * 10)
  })

  it('scales amplitude with velocity', () => {
    const loud = renderLoop({ loopBars: 1, events: [drumEvent(0, 1)], confidence: 1 }, 'kick', grid, { bars: 1 })
    const soft = renderLoop({ loopBars: 1, events: [drumEvent(0, 0.2)], confidence: 1 }, 'kick', grid, { bars: 1 })
    expect(rms(loud)).toBeGreaterThan(rms(soft) * 2)
  })

  it('renders a pitched note at its own frequency', () => {
    const loop = { loopBars: 1, events: [noteEvent(0, 69, 16)], confidence: 1 } // A4, 440 Hz
    const buffer = renderLoop(loop, 'bass', grid, { bars: 1 })
    // 440 Hz over two seconds is ~1760 zero crossings; allow generous slack for
    // the envelope's edges.
    const seconds = buffer.length / RESYNTH_SAMPLE_RATE
    const estimated = zeroCrossings(buffer) / (2 * seconds)
    expect(estimated).toBeGreaterThan(400)
    expect(estimated).toBeLessThan(480)
  })

  it('renders a chord as more than one tone', () => {
    const buffer = renderLoop({ loopBars: 1, events: [chordEvent(0, 'Fm')], confidence: 1 }, 'chords', grid, { bars: 1 })
    expect(rms(buffer)).toBeGreaterThan(0)
    // A single sine has a constant envelope; three detuned partials beat.
    const firstHalf = rms(buffer.slice(0, buffer.length / 4))
    const secondHalf = rms(buffer.slice(buffer.length / 4, buffer.length / 2))
    expect(Math.abs(firstHalf - secondHalf)).toBeGreaterThan(0)
  })

  it('is deterministic', () => {
    const loop = { loopBars: 1, events: [drumEvent(0), drumEvent(4)], confidence: 1 }
    const a = renderLoop(loop, 'hats', grid, { bars: 2 })
    const b = renderLoop(loop, 'hats', grid, { bars: 2 })
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('renders silence for a null loop', () => {
    const buffer = renderLoop(null, 'kick', grid, { bars: 2 })
    expect(buffer.length).toBe(oneBarFrames * 2)
    expect(rms(buffer)).toBe(0)
  })
})

describe('renderSection', () => {
  it('returns a mix and every layer separately', () => {
    const section = {
      index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null,
      loops: {
        kick: { loopBars: 1, events: [drumEvent(0), drumEvent(8)], confidence: 0.9 },
        snare: null,
        hats: null,
        bass: { loopBars: 1, events: [noteEvent(0, 41, 8)], confidence: 0.8 },
        chords: null,
        lead: null,
      },
    }
    const { mix, layers } = renderSection(section, grid)
    expect(Object.keys(layers).sort()).toEqual(['bass', 'chords', 'hats', 'kick', 'lead', 'snare'])
    expect(rms(layers.kick)).toBeGreaterThan(0)
    expect(rms(layers.snare)).toBe(0)
    expect(rms(mix)).toBeGreaterThan(rms(layers.kick))
    expect(mix.length).toBe(Math.round(2 * grid.barSeconds * RESYNTH_SAMPLE_RATE))
  })

  it('never clips', () => {
    const loud = { loopBars: 1, events: [drumEvent(0, 1)], confidence: 1 }
    const section = {
      index: 0, startBar: 0, bars: 1, label: 'high', sameAs: null,
      loops: { kick: loud, snare: loud, hats: loud, bass: null, chords: null, lead: null },
    }
    const { mix } = renderSection(section, grid)
    for (const sample of mix) expect(Math.abs(sample)).toBeLessThanOrEqual(1)
  })
})

function zeroCrossings(buffer) {
  let count = 0
  for (let i = 1; i < buffer.length; i++) {
    if ((buffer[i - 1] < 0 && buffer[i] >= 0) || (buffer[i - 1] >= 0 && buffer[i] < 0)) count++
  }
  return count
}
