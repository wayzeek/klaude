import { describe, expect, it } from 'vitest'
import { rhythmClip } from '../__fixtures__/make-wav.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty } from '../dsp.mjs'
import { LowConfidenceGridError, beatPhase, detectGrid, detectMeter, findTempo } from './grid.mjs'

function noveltyOf(bpm, opts = {}) {
  const audio = decodeWav(rhythmClip({ seconds: 16, bpm, ...opts }))
  const hopSeconds = ONSET_HOP / audio.sampleRate
  return { novelty: computeNovelty(audio.readSample, audio.numFrames, audio.channels), hopSeconds }
}

describe('findTempo', () => {
  // 120 and 128 are the two measured regressions from the ratio-search design
  // this replaced: 120 is the clip on which the old estimateTempo+octave-fold
  // path locked onto a factor-of-three error (83.35 BPM), and 128 is the clip
  // on which the ratio search's per-beat MEAN scoring let a musically
  // meaningless 2/3 ratio (85.07 BPM) outscore the truth. 138/160 are the real
  // recording's tempo and the precision gap the old integer-hop autocorrelation
  // could not close (161.5 instead of 160). The rest fill out the range this
  // module has to cover.
  const SWEEP_BPMS = [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]

  for (const bpm of SWEEP_BPMS) {
    it(`recovers ${bpm} BPM within 1 BPM`, () => {
      const { novelty, hopSeconds } = noveltyOf(bpm)
      const tempo = findTempo(novelty, hopSeconds)
      expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
    })
  }

  /**
   * Measured, not hypothetical: at 90 and 100 BPM, the candidate at exactly
   * double the tempo (180, 200) falls back inside the 60-200 search range and
   * scores nearly as well as the truth - 22.99 vs 19.0 at 90 BPM, 22.0 vs 21.95
   * at 100 BPM. This is a different ambiguity than the ratio bug above:
   * rhythmClip puts a kick on literally every beat with no gaps, so a
   * candidate at exactly double the period lands on every real kick (same
   * on-beat total as the truth) and its own midpoints are exactly as silent as
   * the truth's midpoints are, so totals cannot separate them - this is a
   * property of the fixture's uniformity, not a scoring defect. It only bites
   * when the double is itself in range, i.e. true tempo <= 100 BPM (110 BPM
   * and up have their double excluded by MAX_BPM, and clear 0.25 comfortably
   * in the sweep above). The BPM value is still exactly right; only the
   * confidence - correctly - refuses to call it.
   */
  it('has low confidence at 90 and 100 BPM, where the exact double falls back in range', () => {
    const t90 = findTempo(noveltyOf(90).novelty, noveltyOf(90).hopSeconds)
    const t100 = findTempo(noveltyOf(100).novelty, noveltyOf(100).hopSeconds)
    expect(t90.bpm).toBeCloseTo(90, 0)
    expect(t90.confidence).toBeLessThan(0.25)
    expect(t100.bpm).toBeCloseTo(100, 0)
    expect(t100.confidence).toBeLessThan(0.25)
  })

  it('halts rather than guessing when there is no rhythm to measure', () => {
    const { novelty, hopSeconds } = noveltyOf(120)
    novelty.fill(0)
    const tempo = findTempo(novelty, hopSeconds)
    expect(tempo.confidence).toBe(0)
  })
})

describe('beatPhase', () => {
  it('places beat one on a kick, not between kicks', () => {
    const bpm = 120
    const { novelty, hopSeconds } = noveltyOf(bpm)
    const beatSeconds = 60 / bpm
    const beatHops = beatSeconds / hopSeconds
    const phase = beatPhase(novelty, beatHops)
    const phaseSeconds = phase.offsetHops * hopSeconds
    // The generator puts a kick at frame 0, so the phase should be near a
    // whole beat, not near a half beat.
    const offBeat = Math.abs((phaseSeconds % beatSeconds) - beatSeconds / 2)
    expect(offBeat).toBeGreaterThan(beatSeconds * 0.25)
  })
})

describe('detectMeter', () => {
  /**
   * Measured: computeNovelty's flux is divided by the current frame's own
   * magnitude, so an isolated attack rising from near-silence reads close to
   * 1.0 almost independent of how loud it was - swept from 0.6x gain to 9.6x
   * (well past clipping) on the same clip, the peak novelty at every kick was
   * 1.0000 in every case, accented or not. `accentEvery`'s louder kick is
   * therefore invisible to detectMeter: there is no loudness signal left in
   * the novelty curve for it to find, on this fixture family, given the frozen
   * computeNovelty formula. This is measured directly, not inferred - locking
   * in the near-zero confidence so a future change to either function that
   * fixes it shows up as a test failure here rather than going unnoticed.
   */
  it('cannot find a downbeat from a louder kick, because computeNovelty normalises loudness away', () => {
    const bpm = 120
    const { novelty, hopSeconds } = noveltyOf(bpm, { accentEvery: 4 })
    const beatSeconds = 60 / bpm
    const beatHops = beatSeconds / hopSeconds
    const phase = beatPhase(novelty, beatHops)
    const meter = detectMeter(novelty, beatHops, phase.offsetHops)
    expect(meter.confidence).toBeLessThan(0.05)
  })
})

describe('detectGrid', () => {
  /**
   * Structural checks, not confidence claims: minConfidence is relaxed to 0
   * here specifically because meter's confidence is a separately measured,
   * open problem (see detectMeter above) - these assertions are about whether
   * the arithmetic that assembles beatAt/barAt/downbeatSeconds from
   * tempo+phase+meter is internally consistent, which does not depend on
   * whether the meter measurement backing it is trustworthy.
   */
  it('exposes a bar clock built from tempo, phase and meter', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }), { minConfidence: 0 })
    expect(grid.barSeconds).toBeCloseTo(grid.beatSeconds * grid.beatsPerBar, 3)
    expect(grid.beatAt(4) - grid.beatAt(0)).toBeCloseTo(grid.beatSeconds * 4, 3)
    expect(grid.barAt(1) - grid.barAt(0)).toBeCloseTo(grid.barSeconds, 3)
  })

  it('starts both clocks on a downbeat, not on an arbitrary beat of the bar', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }), { minConfidence: 0 })
    expect(grid.downbeatSeconds).toBeCloseTo(grid.phaseSeconds + grid.downbeatOffset * grid.beatSeconds, 6)
    expect(grid.beatAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.barAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.downbeatOffset).toBeGreaterThanOrEqual(0)
    expect(grid.downbeatOffset).toBeLessThan(grid.beatsPerBar)
  })

  it('converts a duration to bars', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }), { minConfidence: 0 })
    expect(grid.secondsToBars(grid.barSeconds * 8)).toBeCloseTo(8, 3)
  })

  it('reports a confidence for each of the three measurements', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120 }), { minConfidence: 0 })
    for (const field of ['tempo', 'phase', 'meter']) {
      expect(grid.confidence[field], field).toBeGreaterThanOrEqual(0)
      expect(grid.confidence[field], field).toBeLessThanOrEqual(1)
    }
  })

  /**
   * Gate 3, written to the specification rather than to the measured result:
   * this is expected to fail. detectMeter above proves why - a louder kick is
   * invisible to computeNovelty's loudness-normalised flux, so meter
   * confidence never clears 0.25 at the default threshold on this fixture
   * family, accented or not. Left failing on purpose rather than relaxed, per
   * the standing instruction to report a real algorithmic gap rather than tune
   * around it.
   */
  it('finds the downbeat when the audio actually has one', () => {
    const bpm = 120
    const accentEvery = 4
    const trueBeatSeconds = 60 / bpm
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm, accentEvery }))
    expect(grid.beatsPerBar).toBe(accentEvery)
    const barTrueSeconds = trueBeatSeconds * accentEvery
    const offsetIntoBar = ((grid.downbeatSeconds % barTrueSeconds) + barTrueSeconds) % barTrueSeconds
    const distanceToNearestAccent = Math.min(offsetIntoBar, barTrueSeconds - offsetIntoBar)
    expect(distanceToNearestAccent).toBeLessThan(trueBeatSeconds * 0.5)
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
