import { describe, expect, it } from 'vitest'
import { rhythmClip, synthClip } from '../__fixtures__/make-wav.mjs'
import { LowConfidenceGridError, detectGrid } from './grid.mjs'

describe('detectGrid', () => {
  it('recovers the tempo it was given', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    expect(grid.bpm).toBeCloseTo(120, 0)
    expect(grid.beatSeconds).toBeCloseTo(0.5, 2)
  })

  it('resolves a tempo the octave fold would otherwise halve', () => {
    // 160 BPM survives the fold, but its half (80) also correlates strongly.
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 160 }))
    expect(grid.bpm).toBeCloseTo(160, 0)
  })

  /**
   * This is the case that motivated periodScore, and it is measured rather
   * than hypothetical: on this exact clip, analyze.mjs's estimateTempo locks
   * three beats out and folds to 83.35 BPM. Task 3's characterisation test
   * freezes that wrong value on purpose.
   *
   * A candidate set of only [half, same, double] cannot reach 120 from 83.35,
   * because the error is a factor of three. If this test fails, the ratio
   * search or the midpoint scoring is broken — do not widen the tolerance.
   */
  it('recovers a tempo the old power-of-two fold could never reach', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    expect(grid.bpm).toBeCloseTo(120, 0)
    expect(grid.bpm).not.toBeCloseTo(83.35, 1)
  })

  it('does not mistake half-time for the beat when every beat carries a hit', () => {
    // A kick on every beat scores identically on-beat at the true period and
    // at double it. Only the midpoints tell them apart.
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 128 }))
    expect(grid.bpm).toBeCloseTo(128, 0)
  })

  it('places beat one on a kick, not between kicks', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    // The generator puts a kick at frame 0, so the phase should be near zero
    // or near a whole beat, not near a half beat.
    const offBeat = Math.abs((grid.phaseSeconds % grid.beatSeconds) - grid.beatSeconds / 2)
    expect(offBeat).toBeGreaterThan(grid.beatSeconds * 0.25)
  })

  it('exposes a bar clock built from tempo, phase and meter', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    expect(grid.beatsPerBar).toBe(4)
    expect(grid.barSeconds).toBeCloseTo(grid.beatSeconds * 4, 3)
    expect(grid.beatAt(4) - grid.beatAt(0)).toBeCloseTo(grid.barSeconds, 3)
    expect(grid.barAt(1) - grid.barAt(0)).toBeCloseTo(grid.barSeconds, 3)
  })

  it('starts both clocks on a downbeat, not on an arbitrary beat of the bar', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    // A grid that finds beats but not bar one would place every bar line at an
    // arbitrary offset, and nothing downstream could detect it.
    expect(grid.downbeatSeconds).toBeCloseTo(grid.phaseSeconds + grid.downbeatOffset * grid.beatSeconds, 6)
    expect(grid.beatAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.barAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.downbeatOffset).toBeGreaterThanOrEqual(0)
    expect(grid.downbeatOffset).toBeLessThan(grid.beatsPerBar)
  })

  it('reports a meter whose downbeat offset is inside the bar', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 140 }))
    expect(Number.isInteger(grid.downbeatOffset)).toBe(true)
    expect(grid.downbeatOffset).toBeLessThan(grid.beatsPerBar)
  })

  it('converts a duration to bars', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    expect(grid.secondsToBars(grid.barSeconds * 8)).toBeCloseTo(8, 3)
  })

  it('reports a confidence for each of the three measurements', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))
    for (const field of ['tempo', 'phase', 'meter']) {
      expect(grid.confidence[field], field).toBeGreaterThanOrEqual(0)
      expect(grid.confidence[field], field).toBeLessThanOrEqual(1)
    }
  })

  it('halts rather than guessing when there is no rhythm to measure', () => {
    // A sustained triad with no kick has nothing for the beat tracker.
    const silent = rhythmClip({ seconds: 16, bpm: 120 })
    // Zero out the whole data chunk: pure silence, no onsets at all.
    silent.fill(0, 44)
    expect(() => detectGrid(silent)).toThrow(LowConfidenceGridError)
  })

  it('names which measurement failed, so the message can be useful', () => {
    const silent = rhythmClip({ seconds: 16, bpm: 120 })
    silent.fill(0, 44)
    try {
      detectGrid(silent)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LowConfidenceGridError)
      expect(['tempo', 'phase', 'meter']).toContain(error.field)
    }
  })
})
