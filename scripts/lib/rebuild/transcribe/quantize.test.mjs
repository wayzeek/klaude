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
  it('freezes the seven layer names in order', () => {
    expect(LAYERS).toEqual(['kick', 'snare', 'hats', 'bass', 'sub', 'chords', 'lead'])
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

  it('does not turn two non-recurring hits into a fabricated whole-section loop', () => {
    // Same forced-fold path as the test above (5 bars is prime, only the
    // 1-bar candidate divides it), but two isolated hits that share neither
    // position nor pitch are the other thing a zero-fold result can mean: a
    // couple of hits that correctly failed to recur, not a real line that
    // simply had nowhere to fold. Density here is 2/5 = 0.4, below
    // `MIN_FALLBACK_DENSITY` (0.5) - unlike the test above's 3/3 = 1.0 - so
    // this must stay empty rather than come back as a fabricated "loop".
    const events = [ev(0, 41), ev(70, 43)]
    const folded = foldToLoop(events, { startBar: 0, bars: 5 }, grid)
    expect(folded.events).toEqual([])
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

  describe('oneEventPerStep', () => {
    // The real bug (section 19 of Bicep's "Glue"): a monophonic bass fold
    // produced two events at step 0 - midi 24 and midi 36, an octave apart -
    // because a 1-bar section is its own single repetition (reps=1), and
    // KEEP_FRACTION's filter is a no-op whenever `reps > 1` is false. Every
    // bucket survives unfiltered, pitch collisions included. This is the
    // reproduction: it must fail against today's code, which has no
    // `oneEventPerStep` option to ask for the fix.
    it('reproduces the real bug: two pitches surviving at step 0 in a 1-bar section', () => {
      const events = [
        { ...ev(0, 24), length: 1, velocity: 0.8 },
        { ...ev(0, 36), length: 5, velocity: 0.8 },
      ]
      const section1Bar = { startBar: 0, bars: 1 }

      // Without asking for the constraint, today's (buggy) behaviour is
      // preserved: both survive. This is not the fix under test - it pins
      // down that the option is opt-in and does not silently change every
      // caller.
      const unconstrained = foldToLoop(events, section1Bar, grid, { candidates: [1] })
      expect(unconstrained.events).toHaveLength(2)

      // This is the actual reproduction: asking for at most one event per
      // step must leave exactly one event at step 0. Against today's code
      // (no `oneEventPerStep` support) this still comes back with 2.
      const constrained = foldToLoop(events, section1Bar, grid, { candidates: [1], oneEventPerStep: true })
      expect(constrained.events).toHaveLength(1)
    })

    it('picks the pitch more repetitions agreed on, even when it is the less confident one', () => {
      // 3 one-bar repetitions. midi 24 appears in all three (count 3);
      // midi 36 only appears in the first two (count 2). Both clear
      // KEEP_FRACTION (3/3 and 2/3), so both survive as separate buckets
      // without the constraint. 24 has broader support and must win even
      // though its detector confidence is much lower.
      const events = [
        { ...ev(0, 24), confidence: 0.5 },
        { ...ev(0, 36), confidence: 0.95 },
        { ...ev(16, 24), confidence: 0.5 },
        { ...ev(16, 36), confidence: 0.95 },
        { ...ev(32, 24), confidence: 0.5 },
      ]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [1], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].midi).toBe(24)
    })

    it('falls back to confidence when support is tied', () => {
      // 4 one-bar repetitions, both midi 24 and midi 36 present in every one
      // (count 4 each - a tie). Confidence breaks it: 36 is heard far more
      // clearly every time and must win.
      const events = []
      for (const bar of [0, 1, 2, 3]) {
        events.push({ ...ev(bar * 16, 24), confidence: 0.4 })
        events.push({ ...ev(bar * 16, 36), confidence: 0.9 })
      }
      const folded = foldToLoop(events, { startBar: 0, bars: 4 }, grid, { candidates: [1], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].midi).toBe(36)
    })

    it('resolves the same way for chord symbols, not just pitch', () => {
      // The mechanism is generic - `scoreFold` buckets on symbol exactly like
      // it buckets on midi - so `oneEventPerStep` resolves a symbol collision
      // the same way it resolves a pitch one. (harmony.mjs does not actually
      // pass this option: its own events are provably step-unique before
      // folding ever runs, so it cannot hit this case - see its own comment.
      // This test pins the shared mechanism in quantize.mjs regardless, for
      // whatever future caller does need it.)
      const events = [
        { ...ev(0), symbol: 'C', confidence: 0.5 },
        { ...ev(0), symbol: 'Dm', confidence: 0.9 },
      ]
      const folded = foldToLoop(events, { startBar: 0, bars: 1 }, grid, { candidates: [1], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].symbol).toBe('Dm')
    })

    it('never had two events per step to resolve on a pitchless layer', () => {
      // Drums have no pitch: every event's midi and symbol are both null, so
      // `scoreFold`'s bucket key (`position:midi:symbol`) can only ever
      // differ by position. Two hits on the same role at the same step are
      // structurally the same bucket, not a collision `oneEventPerStep` has
      // anything to resolve - proving the drum layers do not need the option.
      const events = [ev(0), ev(0), ev(16), ev(16), ev(32), ev(32)]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [1] })
      const steps = folded.events.map((e) => e.step)
      expect(new Set(steps).size).toBe(steps.length)
    })

    it('ranks by distinct repetitions represented, not raw member count', () => {
      // midi 24 has two detections, but both land in the *same* bar (a
      // glitch briefly splitting one note into two) - one repetition, not
      // two. midi 36 has one detection each in two *different* bars - two
      // repetitions. Both raw member counts are 2, a tie by member count
      // alone, but 36 has broader real support and must win outright, with
      // no help from confidence (24 is given the higher confidence here
      // specifically so a member-count-based tie-break would wrongly pick it).
      const events = [
        { ...ev(0, 24), confidence: 0.9 },
        { ...ev(0, 24), confidence: 0.9 },
        { ...ev(16, 36), confidence: 0.3 },
        { ...ev(32, 36), confidence: 0.3 },
      ]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [1], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].midi).toBe(36)
    })

    it('resolves collisions even when no candidate length divides the section', () => {
      // Pinning `candidates: [2]` against a 3-bar section makes `usable`
      // empty (2 does not divide 3) - the one path that used to return raw,
      // unresolved `local` events directly instead of routing through
      // `scoreFold`. Two events at the same step must still collapse to one.
      const events = [
        { ...ev(0, 24), confidence: 0.9 },
        { ...ev(0, 36), confidence: 0.5 },
      ]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [2], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].midi).toBe(24)
    })

    it('clamps a note that would otherwise run into the next one', () => {
      // Three one-bar repetitions of the same two-note bassline: a note at
      // step 0 that ran long in two of the three repetitions (an onset
      // landing a touch late, exactly what real re-articulation splits on
      // Bicep's "Glue" produced) and a second, distinct re-articulation at
      // step 4 present in two of the three. `mergeBucket` medians each
      // bucket's length independently, so step 0 medians to a length (10)
      // that reaches straight through step 4's own onset - `barToMini`
      // (emit.mjs) would then jump past step 4 entirely and silently drop
      // it, which is exactly what the emission check caught on the real
      // stem as "events missing", not an octave or pitch-class error.
      const events = [
        { ...ev(0, 24), length: 10 },
        { ...ev(4, 24), length: 1 },
        { ...ev(16, 24), length: 10 },
        { ...ev(20, 24), length: 1 },
        { ...ev(32, 24), length: 1 },
      ]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [1], oneEventPerStep: true })
      const byStep = new Map(folded.events.map((e) => [e.step, e]))
      expect(byStep.get(4)).toBeDefined()
      expect(byStep.get(0).length).toBeLessThanOrEqual(4)
    })

    it('wraps the clamp from the loop\'s last event back to its first', () => {
      // One event per one-bar loop, present in every repetition with a
      // length (20) longer than the loop itself (16 steps) - the boundary
      // case `clampToNextOnset` calls out: a length that outlives the loop's
      // own end collides with the next repetition's onset just as surely as
      // it would collide with a neighbour inside the same cycle.
      const events = [{ ...ev(0, 24), length: 20 }, { ...ev(16, 24), length: 20 }, { ...ev(32, 24), length: 20 }]
      const folded = foldToLoop(events, { startBar: 0, bars: 3 }, grid, { candidates: [1], oneEventPerStep: true })
      expect(folded.events).toHaveLength(1)
      expect(folded.events[0].length).toBeLessThanOrEqual(16)
    })
  })
})
