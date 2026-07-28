import { describe, expect, it } from 'vitest'
import { rhythmClip } from '../__fixtures__/make-wav.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty } from '../dsp.mjs'
import { LowConfidenceGridError, beatPhase, detectGrid, detectMeter, findTempo } from './grid.mjs'

function decodedOf(bpm, opts = {}) {
  const audio = decodeWav(rhythmClip({ seconds: 16, bpm, ...opts }))
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
  return { audio, novelty, hopSeconds }
}

describe('findTempo', () => {
  // 120 and 128 are the two measured regressions from the ratio-search design
  // this replaced: 120 is the clip on which the old estimateTempo+octave-fold
  // path locked onto a factor-of-three error (83.35 BPM), and 128 is the clip
  // on which the ratio search's per-beat MEAN scoring let a musically
  // meaningless 2/3 ratio (85.07 BPM) outscore the truth. 138/160 are the real
  // recording's tempo and the precision gap the old integer-hop autocorrelation
  // could not close (161.5 instead of 160). 90/100 are the double-time ties the
  // tempo prior below was added to resolve. The rest fill out the range this
  // module has to cover.
  const SWEEP_BPMS = [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]

  for (const bpm of SWEEP_BPMS) {
    it(`recovers ${bpm} BPM within 1 BPM, confidently`, () => {
      const { novelty, hopSeconds } = decodedOf(bpm)
      const tempo = findTempo(novelty, hopSeconds)
      expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
      expect(tempo.confidence).toBeGreaterThanOrEqual(0.25)
    })
  }

  it('halts rather than guessing when there is no rhythm to measure', () => {
    const { novelty, hopSeconds } = decodedOf(120)
    novelty.fill(0)
    const tempo = findTempo(novelty, hopSeconds)
    expect(tempo.confidence).toBe(0)
  })
})

describe('beatPhase', () => {
  it('places beat one on a kick, not between kicks', () => {
    const bpm = 120
    const { novelty, hopSeconds } = decodedOf(bpm)
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
   * Measured contrast, mirroring how the flux-based approach's blindness was
   * proven: the same clip, only `accentEvery` changed. Unaccented, every beat
   * is bit-identical, so low-band energy at each bar position should be
   * indistinguishable and confidence should sit near zero. Accented, the
   * downbeat genuinely carries more low-end energy (raw FFT magnitude scales
   * with amplitude, unlike normalised flux), so confidence should be
   * meaningfully higher. This is the demonstration that the representation
   * detectMeter is built on can actually carry an accent, where flux could not.
   */
  it('is confident about a downbeat only when the audio actually has one', () => {
    const bpm = 120
    const beatSeconds = 60 / bpm

    const plain = decodedOf(bpm)
    const plainPhase = beatPhase(plain.novelty, beatSeconds / plain.hopSeconds)
    const plainMeter = detectMeter(plain.audio, beatSeconds, plainPhase.offsetHops * plain.hopSeconds)

    const accented = decodedOf(bpm, { accentEvery: 4 })
    const accentedPhase = beatPhase(accented.novelty, beatSeconds / accented.hopSeconds)
    const accentedMeter = detectMeter(accented.audio, beatSeconds, accentedPhase.offsetHops * accented.hopSeconds)

    expect(plainMeter.confidence).toBeLessThan(0.2)
    expect(accentedMeter.confidence).toBeGreaterThan(0.25)
    expect(accentedMeter.confidence).toBeGreaterThan(plainMeter.confidence * 2)
  })

  it('finds the correct meter and downbeat position on an accented fixture', () => {
    const bpm = 120
    const accentEvery = 4
    const { audio, novelty, hopSeconds } = decodedOf(bpm, { accentEvery })
    const beatSeconds = 60 / bpm
    const phase = beatPhase(novelty, beatSeconds / hopSeconds)
    const phaseSeconds = phase.offsetHops * hopSeconds
    const meter = detectMeter(audio, beatSeconds, phaseSeconds)
    expect(meter.beatsPerBar).toBe(accentEvery)

    // Ground truth, independent of the module's own phase estimate: accented
    // kicks land at absolute times n * accentEvery * beatSeconds. The detected
    // downbeat should be near one of them, regardless of which one.
    const downbeatSeconds = phaseSeconds + meter.downbeatOffset * beatSeconds
    const barSeconds = beatSeconds * accentEvery
    const offsetIntoBar = ((downbeatSeconds % barSeconds) + barSeconds) % barSeconds
    const distanceToNearestAccent = Math.min(offsetIntoBar, barSeconds - offsetIntoBar)
    expect(distanceToNearestAccent).toBeLessThan(beatSeconds * 0.5)
  })
})

describe('detectGrid', () => {
  it('exposes a bar clock built from tempo, phase and meter', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.beatsPerBar).toBe(4)
    expect(grid.barSeconds).toBeCloseTo(grid.beatSeconds * 4, 3)
    expect(grid.beatAt(4) - grid.beatAt(0)).toBeCloseTo(grid.barSeconds, 3)
    expect(grid.barAt(1) - grid.barAt(0)).toBeCloseTo(grid.barSeconds, 3)
  })

  it('starts both clocks on a downbeat, not on an arbitrary beat of the bar', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.downbeatSeconds).toBeCloseTo(grid.phaseSeconds + grid.downbeatOffset * grid.beatSeconds, 6)
    expect(grid.beatAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.barAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.downbeatOffset).toBeGreaterThanOrEqual(0)
    expect(grid.downbeatOffset).toBeLessThan(grid.beatsPerBar)
  })

  it('converts a duration to bars', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.secondsToBars(grid.barSeconds * 8)).toBeCloseTo(8, 3)
  })

  it('reports a confidence for each of the three measurements', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    for (const field of ['tempo', 'phase', 'meter']) {
      expect(grid.confidence[field], field).toBeGreaterThanOrEqual(0)
      expect(grid.confidence[field], field).toBeLessThanOrEqual(1)
    }
  })

  // Same ten BPMs as the findTempo sweep, now through the full pipeline
  // including meter - which round 2 could not clear at 90 BPM (0.231,
  // just under the gate) until the metrical prior and the spread-based
  // contrast in this round gave it enough margin (0.308).
  for (const bpm of [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]) {
    it(`clears every gate end to end at ${bpm} BPM on an accented fixture`, () => {
      const grid = detectGrid(rhythmClip({ seconds: 16, bpm, accentEvery: 4 }))
      expect(grid.bpm).toBeCloseTo(bpm, 0)
      expect(grid.beatsPerBar).toBe(4)
      const barSeconds = grid.beatSeconds * 4
      const offsetIntoBar = ((grid.downbeatSeconds % barSeconds) + barSeconds) % barSeconds
      const distanceToNearestAccent = Math.min(offsetIntoBar, barSeconds - offsetIntoBar)
      expect(distanceToNearestAccent).toBeLessThan(grid.beatSeconds * 0.5)
    })
  }

  it('refuses to call a meter when the beat carries no real accent', () => {
    // Same clip, no accent: every beat is bit-identical, so there is nothing
    // for the low-band measurement to find either, and detectGrid must still
    // refuse rather than pick an arbitrary downbeat.
    expect(() => detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))).toThrow(LowConfidenceGridError)
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
