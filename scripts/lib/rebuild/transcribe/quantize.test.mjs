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

  it('does not drop a confident section to nothing when its bar count has no usable candidate above 1', () => {
    // 3 bars is prime: only the 1-bar candidate divides it, so every bar is
    // treated as a repetition of the same 1-bar loop. Each bar here carries a
    // different pitch on beat one - a real, confidently-heard line that
    // simply does not repeat on a 1-bar schedule. Before the fix, each
    // position/pitch bucket had only 1 of 3 repetitions (below the 50% keep
    // threshold), so every bucket was dropped and the section came back with
    // zero events - indistinguishable from "nothing was heard" even though
    // three notes were. The section's content must survive, even if that
    // means falling back to the whole section rather than a genuine loop.
    const events = [ev(0, 41), ev(16, 43), ev(32, 46)]
    const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid)
    expect(folded.events).toHaveLength(3)
    expect(folded.loopBars).toBe(3)
  })

  it('rejects a section length no candidate divides, by using the section', () => {
    // 6 bars: 1 and 2 divide it, 4 does not. A 4-bar loop would drop bars 4-5.
    const events = []
    for (let bar = 0; bar < 6; bar++) events.push(ev(bar * 16))
    const folded = foldToLoop(events, { startBar: 0, bars: 6 }, grid)
    expect([1, 2]).toContain(folded.loopBars)
  })

  it('keeps the true unrounded median velocity, not an integer', () => {
    // Same step every bar, differing velocity. Median of {0.2, 0.4, 0.6, 0.9}
    // is 0.5 - fractional, so a rounding implementation visibly fails, and
    // fed in scrambled order so an implementation that skips sorting and
    // reads members[0] (0.9) fails too.
    const velocities = [0.9, 0.2, 0.6, 0.4]
    const events = velocities.map((velocity, bar) => ({ ...ev(bar * 16), velocity }))
    const folded = foldToLoop(events, section, grid, { candidates: [1] })
    const merged = folded.events.find((e) => e.step === 0)
    expect(merged.velocity).toBeCloseTo(0.5, 6)
    expect(Number.isInteger(merged.velocity)).toBe(false)
  })

  it('keeps the correct whole-number median length', () => {
    // Same step every bar, differing length. True median of {1, 2, 3, 10} is
    // 2.5, which must round to 3 - not the mean (4) and not members[0] (10,
    // the scrambled first-inserted value).
    const lengths = [10, 1, 2, 3]
    const events = lengths.map((length, bar) => ({ ...ev(bar * 16), length }))
    const folded = foldToLoop(events, section, grid, { candidates: [1] })
    const merged = folded.events.find((e) => e.step === 0)
    expect(merged.length).toBe(3)
    expect(Number.isInteger(merged.length)).toBe(true)
  })

  it('averages driftSteps across repetitions, not the median', () => {
    // Same step every bar, differing drift. Mean of {1, 0, 0, 0} is 0.25;
    // the median of the same set is 0, so this fails if drift is merged by
    // median instead of mean, and fails if it reads members[0] (1) raw.
    const drifts = [1, 0, 0, 0]
    const events = drifts.map((driftSteps, bar) => ({ ...ev(bar * 16), driftSteps }))
    const folded = foldToLoop(events, section, grid, { candidates: [1] })
    const merged = folded.events.find((e) => e.step === 0)
    expect(merged.driftSteps).toBeCloseTo(0.25, 6)
  })
})
