import { describe, expect, it } from 'vitest'
import { detectCrash, detectFill, detectVariation } from './fills.mjs'
import { foldToLoop, gridFromJson } from './quantize.mjs'

// 120 BPM, 4/4, downbeat at 0 - a plain grid, since fills.mjs's own arithmetic
// only ever needs stepsPerBar.
const GRID_JSON = { bpm: 120, beatSeconds: 0.5, barSeconds: 2, downbeatSeconds: 0, beatsPerBar: 4 }
const grid = gridFromJson(GRID_JSON)

const ev = (step, velocity = 0.8, confidence = 0.9) => ({
  step, length: 1, velocity, confidence, midi: null, symbol: null, driftSteps: 0,
})

describe('detectFill', () => {
  const section = { startBar: 0, bars: 4 }

  it('finds nothing when nothing was discarded', () => {
    const loop = { loopBars: 1, events: [ev(0), ev(4), ev(8), ev(12)] }
    expect(detectFill([], loop, section, grid)).toBeNull()
    expect(detectFill(undefined, loop, section, grid)).toBeNull()
  })

  it('requires several discarded events, not a single stray onset', () => {
    // Two discarded events in the closing bar (absolute steps 62, 63) - below
    // MIN_FILL_EVENTS even though they clearly exceed whatever baseline a
    // loopBars: 2 loop plays in that phase.
    const loop = { loopBars: 2, events: [ev(0), ev(16)] }
    const discarded = [ev(62), ev(63)]
    expect(detectFill(discarded, loop, section, grid)).toBeNull()
  })

  it('yields a fill when the section\'s final bar carries a real, dense burst of extra onsets', () => {
    // loopBars: 2, so the final bar (bar 3) sits at loop phase 1 (3 % 2), the
    // same phase bar 1 occupies - the loop plays two kept events there (steps
    // 16 and 20). Three discarded onsets in bar 3 (steps 60, 62, 63) clear
    // both MIN_FILL_EVENTS (3) and the loop's own baseline (2) there.
    const loop = { loopBars: 2, events: [ev(0), ev(4), ev(16), ev(20)] }
    const discarded = [ev(60, 0.5), ev(62, 0.6), ev(63, 0.7)]
    const fill = detectFill(discarded, loop, section, grid)
    expect(fill).not.toBeNull()
    expect(fill.kind).toBe('fill')
    expect(fill.bar).toBe(3)
    // Relative to the bar itself (60 - 3*16 = 12), not the absolute section step.
    expect(fill.events.map((e) => e.step)).toEqual([12, 14, 15])
    expect(fill.events.every((e) => e.midi === null && e.symbol === null)).toBe(true)
    expect(fill.events.map((e) => e.velocity)).toEqual([0.5, 0.6, 0.7])
    expect(fill.note).toMatch(/3 discarded events in bar 3/)
  })

  it('a uniform section with nothing discarded yields no fill', () => {
    const loop = { loopBars: 1, events: [ev(0), ev(4), ev(8), ev(12)] }
    expect(detectFill([], loop, section, grid)).toBeNull()
  })

  it('does not count a burst concentrated in an earlier bar, even a large one', () => {
    // A loop sparse enough (one kept event) that the burst below would clear
    // MIN_FILL_EVENTS and the baseline gate if it were wrongly counted - so
    // this only stays null if the closing-bar restriction itself is doing
    // the work, not a coincidence of the density gate rejecting it anyway.
    // All three extra onsets sit in bar 1 (steps 16-19), not the section's
    // own final bar (bar 3) - #23 restricts detection to the closing bar
    // specifically, and a real fill one bar early is a disclosed, accepted
    // miss, not something this file widens its window to catch.
    const loop = { loopBars: 1, events: [ev(0)] }
    const discarded = [ev(17), ev(18), ev(19)]
    expect(detectFill(discarded, loop, section, grid)).toBeNull()
  })

  it('requires the burst to be DENSER than what the loop already plays at that phase', () => {
    // loopBars: 1, so the final bar's own phase is the whole loop - the loop
    // already plays 4 events there. 3 discarded events (>= MIN_FILL_EVENTS)
    // do not exceed that baseline, so this must not read as a fill: it is
    // not adding more than the loop's own normal content in that bar.
    const loop = { loopBars: 1, events: [ev(0), ev(4), ev(8), ev(12)] }
    const discarded = [ev(3 * 16 + 1), ev(3 * 16 + 5), ev(3 * 16 + 9)]
    expect(detectFill(discarded, loop, section, grid)).toBeNull()
  })

  it('does not let three detections of the identical step masquerade as three distinct fill events', () => {
    // Real-audio shape found via independent review: a section's closing
    // bar can produce several raw onset detections that all quantise to the
    // SAME step (ordinary jitter, not several different hits). Naively
    // counting raw members would clear MIN_FILL_EVENTS (3) here and hand
    // `emit.mjs` three "events" at the identical local step - which its
    // slot array can only hold one of, silently dropping the other two
    // while the note still claimed three. Deduplicated to one real onset,
    // this must not read as a fill at all.
    const loop = { loopBars: 2, events: [ev(0), ev(4), ev(16), ev(20)] }
    const discarded = [ev(60, 0.5), ev(60, 0.6), ev(60, 0.7)]
    expect(detectFill(discarded, loop, section, grid)).toBeNull()
  })

  it('keeps only one merged event per step even when a genuine fill also carries a duplicated detection', () => {
    const loop = { loopBars: 2, events: [ev(0), ev(4), ev(16), ev(20)] }
    // Three distinct steps clear the fill; one of them (63) was also
    // detected twice - the merged event must survive exactly once, at the
    // louder of its two readings.
    const discarded = [ev(60, 0.5), ev(62, 0.6), ev(63, 0.4), ev(63, 0.9)]
    const fill = detectFill(discarded, loop, section, grid)
    expect(fill).not.toBeNull()
    expect(fill.events).toHaveLength(3)
    const last = fill.events.find((e) => e.step === 15)
    expect(last.velocity).toBe(0.9)
  })

  it('yields a fill once the burst exceeds that same baseline by even one event', () => {
    const loop = { loopBars: 1, events: [ev(0), ev(4), ev(8), ev(12)] }
    const discarded = [ev(3 * 16 + 1), ev(3 * 16 + 3), ev(3 * 16 + 5), ev(3 * 16 + 9), ev(3 * 16 + 11)]
    const fill = detectFill(discarded, loop, section, grid)
    expect(fill).not.toBeNull()
    expect(fill.events).toHaveLength(5)
  })
})

describe('detectCrash', () => {
  const loop = { loopBars: 1, events: [ev(0, 0.5), ev(4, 0.5), ev(8, 0.5), ev(12, 0.5)] }

  it('finds nothing when nothing was discarded', () => {
    expect(detectCrash([], loop)).toBeNull()
  })

  it('finds a crash: exactly one discarded event on the first downbeat, louder than the loop\'s own loudest hit', () => {
    const crash = detectCrash([ev(0, 0.9)], loop)
    expect(crash).not.toBeNull()
    expect(crash.kind).toBe('crash')
    expect(crash.bar).toBe(0)
    expect(crash.events).toEqual([{ step: 0, length: 1, velocity: 0.9, confidence: 0.9, midi: null, symbol: null }])
    expect(crash.note).toMatch(/1 discarded event at bar 0 step 0/)
  })

  it('rejects a discarded event elsewhere in the section - only step 0 counts', () => {
    expect(detectCrash([ev(16, 0.9)], loop)).toBeNull()
    expect(detectCrash([ev(1, 0.9)], loop)).toBeNull()
  })

  it('rejects a quiet discarded event at step 0 - a crash must be louder than the loop, not merely present', () => {
    expect(detectCrash([ev(0, 0.4)], loop)).toBeNull()
    expect(detectCrash([ev(0, 0.5)], loop)).toBeNull() // exactly equal does not clear it
  })

  it('merges two discarded detections of the identical step into one before deciding, keeping the louder', () => {
    // Two raw onset detections quantising to the same step are one physical
    // instant read twice (measured directly on the real reference track - a
    // role's closing bar produced exactly this shape from ordinary detection
    // jitter, not two genuinely simultaneous hits, which this mini-notation
    // scheme cannot even express as two events on one step anyway), not a
    // burst - so this must merge to one candidate and judge it on the
    // louder reading, not reject it outright for looking like "more than one".
    const crash = detectCrash([ev(0, 0.6), ev(0, 0.95)], loop)
    expect(crash).not.toBeNull()
    expect(crash.events[0].velocity).toBe(0.95)
  })

  it('still rejects when even the louder of two duplicate-step detections is not loud enough', () => {
    expect(detectCrash([ev(0, 0.4), ev(0, 0.45)], loop)).toBeNull()
  })
})

describe('detectVariation', () => {
  const section = { startBar: 0, bars: 4 }

  it('returns null when neither a fill nor a crash clears its gate', () => {
    const loop = { loopBars: 1, events: [ev(0), ev(4), ev(8), ev(12)] }
    expect(detectVariation([], loop, section, grid)).toBeNull()
  })

  it('returns a fill when only fill-shaped content is present', () => {
    const loop = { loopBars: 2, events: [ev(0), ev(4), ev(16), ev(20)] }
    const discarded = [ev(60, 0.5), ev(62, 0.6), ev(63, 0.7)]
    expect(detectVariation(discarded, loop, section, grid).kind).toBe('fill')
  })

  it('falls back to a crash when only crash-shaped content is present', () => {
    const loop = { loopBars: 1, events: [ev(0, 0.5), ev(4, 0.5), ev(8, 0.5), ev(12, 0.5)] }
    expect(detectVariation([ev(0, 0.9)], loop, section, grid).kind).toBe('crash')
  })

  it('prefers a fill over a crash when a section shows both shapes at once', () => {
    const loop = { loopBars: 2, events: [ev(0), ev(4), ev(16), ev(20)] }
    const discarded = [ev(0, 0.9), ev(60, 0.5), ev(62, 0.6), ev(63, 0.7)]
    expect(detectVariation(discarded, loop, section, grid).kind).toBe('fill')
  })
})

describe('integration with foldToLoop', () => {
  // The hermetic end-to-end shape #23 asks for: a synthetic section whose
  // final bar carries extra onsets yields a fill; a uniform section yields
  // none - built through the real foldToLoop -> detectVariation pipeline,
  // not hand-assembled `discarded`/`loop` objects like the tests above.
  const section = { startBar: 0, bars: 4 }

  it('a synthetic section whose final bar carries extra onsets yields a fill', () => {
    const events = []
    // A real two-bar groove: a busy bar (six hits) alternating with a sparse
    // one (one hit) - bars 0 and 2 share the busy phase, bars 1 and 3 the
    // sparse one, so the fold settles on a 2-bar loop with real agreement.
    for (const bar of [0, 2]) {
      for (const step of [0, 2, 4, 6, 8, 10]) events.push(ev(bar * 16 + step))
    }
    events.push(ev(16))
    // The section's own closing bar (3) repeats that same sparse hit, plus a
    // genuine fill: three extra onsets that appear nowhere else in the loop.
    events.push(ev(3 * 16))
    events.push(ev(3 * 16 + 12, 0.6))
    events.push(ev(3 * 16 + 14, 0.7))
    events.push(ev(3 * 16 + 15, 0.8))

    const folded = foldToLoop(events, section, grid)
    expect(folded.loopBars).toBe(2)
    const variation = detectVariation(folded.discarded, folded, section, grid)
    expect(variation).not.toBeNull()
    expect(variation.kind).toBe('fill')
    expect(variation.bar).toBe(3)
    expect(variation.events.map((e) => e.step)).toEqual([12, 14, 15])
  })

  it('a uniform section (no discarded content at all) yields no variation', () => {
    const events = []
    for (let bar = 0; bar < 4; bar++) {
      for (const step of [0, 4, 8, 12]) events.push(ev(bar * 16 + step))
    }
    const folded = foldToLoop(events, section, grid)
    expect(folded.discarded).toEqual([])
    expect(detectVariation(folded.discarded, folded, section, grid)).toBeNull()
  })
})
