import { describe, expect, it } from 'vitest'
import { emitTrack } from './emit.mjs'
import { compareEvents, verifyEmission } from './verify-emission.mjs'

const GRID = { bpm: 120, beatSeconds: 0.5, barSeconds: 2, downbeatSeconds: 0, beatsPerBar: 4 }
const drum = (step) => ({ step, length: 1, velocity: 0.8, confidence: 0.9, midi: null, symbol: null, driftSteps: 0 })
const note = (step, midi, length = 4) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0,
})
const emptyLoops = () => ({ kick: null, snare: null, hats: null, bass: null, chords: null, lead: null })

function transcription(loops, bars = 4) {
  return {
    grid: GRID,
    key: { name: 'F minor', confidence: 0.5 },
    stepsPerBeat: 4,
    sections: [{ index: 0, startBar: 0, bars, label: 'mid', sameAs: null, loops }],
  }
}

describe('compareEvents', () => {
  const expected = [
    { step: 0, midi: 41 },
    { step: 4, midi: 44 },
    { step: 8, midi: 48 },
  ]

  it('matches an exact reproduction', () => {
    const result = compareEvents(expected, [...expected], { stepsPerBar: 16 })
    expect(result.matched).toBe(3)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.wrongPitch).toEqual([])
  })

  it('reports a dropped event as missing, not as wrong', () => {
    const result = compareEvents(expected, [expected[0], expected[2]], { stepsPerBar: 16 })
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0].step).toBe(4)
    expect(result.wrongPitch).toEqual([])
  })

  it('reports an added event as extra', () => {
    const result = compareEvents(expected, [...expected, { step: 12, midi: 41 }], { stepsPerBar: 16 })
    expect(result.extra).toHaveLength(1)
    expect(result.extra[0].step).toBe(12)
  })

  it('reports a changed note as wrong pitch, not as missing plus extra', () => {
    const result = compareEvents(expected, [
      { step: 0, midi: 41 },
      { step: 4, midi: 45 },
      { step: 8, midi: 48 },
    ], { stepsPerBar: 16 })
    expect(result.wrongPitch).toHaveLength(1)
    expect(result.wrongPitch[0]).toMatchObject({ step: 4, expected: 44, actual: 45 })
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it('reports timing drift separately from a missing event', () => {
    const result = compareEvents(expected, [
      { step: 0.2, midi: 41 },
      { step: 4, midi: 44 },
      { step: 8, midi: 48 },
    ], { stepsPerBar: 16 })
    expect(result.matched).toBe(3)
    expect(result.missing).toEqual([])
    expect(result.drift).toBeGreaterThan(0)
  })

  it('handles both sides empty', () => {
    const result = compareEvents([], [], { stepsPerBar: 16 })
    expect(result.matched).toBe(0)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })
})

describe('verifyEmission', () => {
  it('confirms a round trip through the emitter', async () => {
    const t = transcription({
      ...emptyLoops(),
      kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
      bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 },
    })
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
    expect(result.defects).toEqual([])
  })

  it('reports a defect when the code drops a layer', async () => {
    const t = transcription({
      ...emptyLoops(),
      kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
    })
    // Emit, then delete the kick from the arrange entry.
    const broken = emitTrack(t).replace(/kick: s0_kick/g, '')
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    expect(result.defects.length).toBeGreaterThan(0)
  })

  it('reports a thrown query as a defect, never as an empty layer', async () => {
    const t = transcription({
      ...emptyLoops(),
      bass: { loopBars: 1, events: [note(0, 41, 8)], confidence: 0.8 },
    })
    // `.add()` against silence was assumed to make a query throw and does
    // not - measured directly, it silently yields zero events instead, which
    // is exactly the false pass this test exists to rule out. An invalid
    // numeral argument reaching a mini-notation string genuinely throws when
    // the pattern is queried, which is the failure mode this sabotages.
    const broken = emitTrack(t).replace(
      /const s0_bass = (.*)$/m,
      'const s0_bass = note("c3").fast("not-a-number")',
    )
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages.toLowerCase()).toMatch(/threw|error/)
  })

  it('reports unparseable source as a defect rather than throwing', async () => {
    const t = transcription({ ...emptyLoops(), kick: { loopBars: 1, events: [drum(0)], confidence: 0.9 } })
    const result = await verifyEmission('this is not javascript ((((', t)
    expect(result.ok).toBe(false)
    expect(result.defects.length).toBeGreaterThan(0)
  })

  it('accepts a transcription with every layer omitted', async () => {
    const t = transcription(emptyLoops())
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
  })

  it('reports a defect when evaluation errors after a pattern was already built', async () => {
    // `evaluateTrack` assigns `pattern` before running any `all()`/`each()`
    // transform, so a transform that throws leaves `track.error` set on a
    // track whose `track.pattern` is a perfectly valid, non-null object -
    // `!track.pattern` alone would not catch this. Checking `track.error`
    // has to be a check of its own, not a stand-in for a null pattern.
    const t = transcription({ ...emptyLoops(), kick: { loopBars: 1, events: [drum(0)], confidence: 0.9 } })
    const broken = `${emitTrack(t)}\nall((pat) => { throw new Error('boom from an all() transform') })\n`
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages).toMatch(/boom from an all\(\) transform/)
  })
})
