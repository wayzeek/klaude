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

  it('gives the kick real arrangement-driven gaps, not a periodic pile', () => {
    // The tell for the track.layers trap: layers() hands back the raw,
    // un-arranged pattern, which is periodic and repeats forever once queried.
    // Over a wide arc that does NOT collapse into the first few bars (Strudel
    // replays a periodic pattern across the whole query range) - so a maximum-
    // bar check alone cannot catch it. What a layers() read erases is the
    // arrangement's actual shape: the real track drops the kick out for its
    // outro (bars 91-100) and only fires it in 78 of 101 bars. Measured by
    // querying track.layers.get('kick') the wrong way over the same [0, 101)
    // range: 6220 events (vs the true 428), covering all 101 bars including
    // every bar of that outro, because the isolated pattern has no memory of
    // where in the arrangement it belongs.
    const bdBars = new Set(truth.bySound.bd.map((e) => e.bar))
    expect(bdBars.size).toBeLessThan(90) // true fixture: 78/101 - real margin either side of the cut
    const outro = Array.from({ length: 10 }, (_, i) => 91 + i)
    expect(outro.filter((bar) => bdBars.has(bar))).toEqual([]) // the outro is genuinely kickless
    expect(truth.bySound.bd.length).toBeLessThan(truth.bars * truth.beatsPerBar * 2) // true fixture: 428, well under 808
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
