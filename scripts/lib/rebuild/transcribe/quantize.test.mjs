import { describe, expect, it } from 'vitest'
import {
  LAYERS,
  STEPS_PER_BEAT,
  foldToLoop,
  gridFromJson,
  sectionRange,
  stepAt,
  stepDrift,
  stepSeconds,
  stepsPerBar,
} from './quantize.mjs'

// 138 BPM, 4/4, downbeat at 0.348s - the-chase's measured grid.
const GRID_JSON = {
  bpm: 138,
  beatSeconds: 60 / 138,
  barSeconds: (60 / 138) * 4,
  downbeatSeconds: 0.3482993197278912,
  beatsPerBar: 4,
}
const grid = gridFromJson(GRID_JSON)

describe('step maths', () => {
  it('freezes the six layer names in order', () => {
    expect(LAYERS).toEqual(['kick', 'snare', 'hats', 'bass', 'chords', 'lead'])
    expect(Object.isFrozen(LAYERS)).toBe(true)
  })

  it('divides a beat into four steps', () => {
    expect(stepSeconds(grid)).toBeCloseTo(60 / 138 / 4, 10)
    expect(stepsPerBar(grid)).toBe(16)
  })

  it('places the downbeat at step zero', () => {
    expect(stepAt(grid, grid.downbeatSeconds)).toBe(0)
    expect(stepDrift(grid, grid.downbeatSeconds)).toBeCloseTo(0, 10)
  })

  it('counts steps forward from the downbeat', () => {
    const oneBar = grid.downbeatSeconds + grid.barSeconds
    expect(stepAt(grid, oneBar)).toBe(16)
    expect(stepAt(grid, oneBar + stepSeconds(grid) * 3)).toBe(19)
  })

  it('reports signed drift within half a step', () => {
    const late = grid.downbeatSeconds + stepSeconds(grid) * 0.3
    expect(stepAt(grid, late)).toBe(0)
    expect(stepDrift(grid, late)).toBeCloseTo(0.3, 6)

    const early = grid.downbeatSeconds + stepSeconds(grid) * 0.8
    expect(stepAt(grid, early)).toBe(1)
    expect(stepDrift(grid, early)).toBeCloseTo(-0.2, 6)
  })

  it('rehydrates the grid functions reference.json drops', () => {
    expect(typeof grid.beatAt).toBe('function')
    expect(grid.beatAt(0)).toBeCloseTo(GRID_JSON.downbeatSeconds, 10)
    expect(grid.beatAt(4)).toBeCloseTo(GRID_JSON.downbeatSeconds + GRID_JSON.barSeconds, 10)
    expect(grid.barAt(2)).toBeCloseTo(GRID_JSON.downbeatSeconds + 2 * GRID_JSON.barSeconds, 10)
    expect(grid.secondsToBars(GRID_JSON.barSeconds * 3)).toBeCloseTo(3, 10)
  })

  it('gives a section its absolute step range', () => {
    const range = sectionRange(grid, { startBar: 4, bars: 6 })
    expect(range.fromStep).toBe(64)
    expect(range.toStep).toBe(160)
    expect(range.steps).toBe(96)
    expect(range.fromSec).toBeCloseTo(grid.barAt(4), 10)
    expect(range.toSec).toBeCloseTo(grid.barAt(10), 10)
  })
})

// Helper: an event at an absolute step, with optional pitch.
const ev = (step, midi = null) => ({
  step,
  length: 1,
  velocity: 0.8,
  confidence: 0.9,
  midi,
  symbol: null,
  driftSteps: 0,
})

describe('foldToLoop', () => {
  const section = { startBar: 0, bars: 4 }

  it('folds a one-bar pattern repeated four times into one bar', () => {
    const events = []
    for (let bar = 0; bar < 4; bar++) {
      for (const step of [0, 4, 8, 12]) events.push(ev(bar * 16 + step))
    }
    const folded = foldToLoop(events, section, grid)
    expect(folded.loopBars).toBe(1)
    expect(folded.events.map((e) => e.step)).toEqual([0, 4, 8, 12])
    expect(folded.agreement).toBeCloseTo(1, 6)
  })

  it('needs two bars when every other bar carries a variation', () => {
    const events = []
    for (let bar = 0; bar < 4; bar++) {
      for (const step of [0, 4, 8, 12]) events.push(ev(bar * 16 + step))
      if (bar % 2 === 1) for (const step of [13, 14, 15]) events.push(ev(bar * 16 + step))
    }
    const folded = foldToLoop(events, section, grid)
    expect(folded.loopBars).toBe(2)
    expect(folded.events.map((e) => e.step)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 29, 30, 31])
  })

  it('treats a different pitch on the same step as disagreement', () => {
    // Same rhythm every bar, but the note alternates. Rhythm alone would fold
    // to one bar; pitch makes two the honest answer.
    const events = []
    for (let bar = 0; bar < 4; bar++) events.push(ev(bar * 16, bar % 2 === 0 ? 41 : 43))
    const folded = foldToLoop(events, section, grid)
    expect(folded.loopBars).toBe(2)
    expect(folded.events.map((e) => e.midi)).toEqual([41, 43])
  })

  it('falls back to the longest candidate when nothing repeats', () => {
    // A different step in every bar: no candidate can explain it.
    const events = [ev(0), ev(17), ev(35), ev(54)]
    const folded = foldToLoop(events, section, grid)
    expect(folded.loopBars).toBe(4)
    expect(folded.events).toHaveLength(4)
    expect(folded.agreement).toBeLessThan(0.7)
  })

  it('scales confidence by how many repetitions agreed', () => {
    // Step 0 in all four bars, step 8 in only one. `candidates` is pinned so
    // this tests the merge rule rather than the loop-length choice.
    const events = [ev(0), ev(8), ev(16), ev(32), ev(48)]
    const folded = foldToLoop(events, section, grid, { candidates: [1] })
    const byStep = new Map(folded.events.map((e) => [e.step, e]))
    expect(byStep.get(0).confidence).toBeCloseTo(0.9, 6)
    expect(byStep.has(8)).toBe(false) // present in 1 of 4 reps, below the half rule
  })

  it('discounts confidence for a position most but not all repetitions had', () => {
    // Step 0 in all four bars, step 8 in three of them.
    const events = [ev(0), ev(8), ev(16), ev(24), ev(32), ev(40), ev(48)]
    const folded = foldToLoop(events, section, grid, { candidates: [1] })
    const byStep = new Map(folded.events.map((e) => [e.step, e]))
    expect(byStep.get(0).confidence).toBeCloseTo(0.9, 6)
    expect(byStep.get(8).confidence).toBeCloseTo(0.9 * 0.75, 6)
  })

  it('uses the whole section when it is shorter than the smallest candidate', () => {
    const folded = foldToLoop([ev(0), ev(4)], { startBar: 0, bars: 1 }, grid)
    expect(folded.loopBars).toBe(1)
    expect(folded.events.map((e) => e.step)).toEqual([0, 4])
  })

  it('returns an empty loop for no events rather than throwing', () => {
    const folded = foldToLoop([], section, grid)
    expect(folded.events).toEqual([])
    expect(folded.agreement).toBe(0)
  })

  it('rejects a section length no candidate divides, by using the section', () => {
    // 6 bars: 1 and 2 divide it, 4 does not. A 4-bar loop would drop bars 4-5.
    const events = []
    for (let bar = 0; bar < 6; bar++) events.push(ev(bar * 16))
    const folded = foldToLoop(events, { startBar: 0, bars: 6 }, grid)
    expect([1, 2]).toContain(folded.loopBars)
  })
})
