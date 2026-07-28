import { describe, expect, it } from 'vitest'
import truth from './the-chase-truth.json' with { type: 'json' }

describe('the-chase ground truth', () => {
  it('matches the track header', () => {
    expect(truth.bpm).toBe(138)
    expect(truth.beatsPerBar).toBe(4)
    expect(truth.bars).toBe(101)
  })

  it('carries the arrangement the track file declares', () => {
    expect(truth.sectionBars).toEqual([4, 4, 6, 6, 6, 4, 10, 3, 8, 6, 6, 4, 4, 12, 8, 6, 4])
    expect(truth.boundaries).toEqual([0, 4, 8, 14, 20, 26, 30, 40, 43, 51, 57, 63, 67, 71, 83, 91, 97])
  })

  it('spans the whole arrangement, not just its first bars', () => {
    // The tell for the track.layers trap: if events were read from a stacked
    // per-layer channel they would all pile onto the first few bars.
    const lastBar = Math.max(...truth.events.map((e) => e.bar))
    expect(lastBar).toBeGreaterThan(truth.bars - 6)
  })

  it('has the sounds the transcribers try to recover', () => {
    for (const sound of ['bd', 'hh']) {
      expect(truth.bySound[sound], `missing sound ${sound}`).toBeDefined()
      expect(truth.bySound[sound].length).toBeGreaterThan(0)
    }
  })

  it('gives the kick four to the bar through the busy sections', () => {
    // Bar 10 sits inside the third arrange entry, where `kick` is the plain
    // four-on-the-floor pattern.
    const bar10 = truth.bySound.bd.filter((e) => e.bar === 10)
    expect([...new Set(bar10.map((e) => e.step))].sort((a, b) => a - b)).toEqual([0, 4, 8, 12])
  })

  it('parses pitched events into MIDI numbers, so octaves are checkable', () => {
    // Strudel emits `note` as a string; a fixture full of nulls here means the
    // builder is not using check.mjs's parser.
    const pitched = truth.events.filter((e) => e.midi !== null)
    expect(pitched.length).toBeGreaterThan(100)
  })

  it('carries low-register content for the bass transcriber to be judged against', () => {
    // Demucs' bass stem holds everything low, not just the layer named `bass`,
    // so the comparison target is register rather than layer name.
    const low = truth.events.filter((e) => e.midi !== null && e.midi <= 52)
    expect(low.length).toBeGreaterThan(50)
    expect(Math.min(...low.map((e) => e.midi))).toBeGreaterThan(20)
  })
})
