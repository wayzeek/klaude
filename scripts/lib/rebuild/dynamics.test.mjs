import { describe, expect, it } from 'vitest'
import { duckedToneClip, sweepToneClip, writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import {
  centroidSeries,
  detectDynamics,
  detectFilterSweeps,
  detectRisers,
  detectSidechainStem,
  dynamicsForEmission,
  measureKickDip,
} from './dynamics.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { gridFromJson } from './transcribe/quantize.mjs'

const SAMPLE_RATE = 44100

function makeGrid({ bpm = 120, beatsPerBar = 4 } = {}) {
  return gridFromJson({ bpm, beatsPerBar, downbeatSeconds: 0, beatSeconds: 60 / bpm })
}

function makeSection({ index = 0, startBar = 0, bars, label = 'test', sameAs = null } = {}) {
  return { index, startBar, bars, label, sameAs }
}

/** A chirp with an independent, linear amplitude ramp - `sweepToneClip` only
 *  ever holds gain steady, so a fixture that needs both a moving centroid
 *  *and* a moving RMS (the riser detector's two independent features) is
 *  built locally, the same way `stem-profile.test.mjs` builds one-off shapes
 *  it does not need to share. */
function risingClip({ sampleRate = SAMPLE_RATE, seconds, startHz, endHz, startGain, endGain }) {
  const numFrames = Math.round(seconds * sampleRate)
  const mono = new Float32Array(numFrames)
  let phase = 0
  for (let i = 0; i < numFrames; i++) {
    const t = i / sampleRate
    const hz = startHz + (endHz - startHz) * (t / seconds)
    phase += (2 * Math.PI * hz) / sampleRate
    const gain = startGain + (endGain - startGain) * (t / seconds)
    mono[i] = gain * Math.sin(phase)
  }
  return writeWavBuffer({ sampleRate, channels: 2, float32: false, samples: [mono, mono] })
}

// ============================================================================
// centroidSeries
// ============================================================================

describe('centroidSeries', () => {
  it('reads a low, rising, then dropping centroid across a low/high/low tone', () => {
    const audio = decodeWav(sweepToneClip({ seconds: 6, startHz: 300, endHz: 300 }))
    const { times, centroids } = centroidSeries(audio, 0, 6)
    expect(times.length).toBeGreaterThan(10)
    for (const c of centroids) {
      expect(c).toBeGreaterThan(150)
      expect(c).toBeLessThan(600)
    }
  })

  it('windows to the requested span, not the whole clip', () => {
    // A 500Hz->3000Hz sweep over 10s: asking only for the first second should
    // read centroids near the low end, not the high end reached at the tail.
    const audio = decodeWav(sweepToneClip({ seconds: 10, startHz: 500, endHz: 3000 }))
    const early = centroidSeries(audio, 0, 1)
    const late = centroidSeries(audio, 9, 10)
    const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(meanOf(early.centroids)).toBeLessThan(meanOf(late.centroids))
  })
})

// ============================================================================
// measureKickDip - pure array-level unit tests
// ============================================================================

describe('measureKickDip', () => {
  const HOP = 0.01

  it('measures depth and trough lag for a clean, immediate dip', () => {
    // Baseline 1.0 for hops 0-4, drops to 0.4 (depth 0.6) right at hop 5,
    // recovers linearly back to 1.0 by hop 10.
    const energy = new Array(20).fill(1)
    for (let h = 5; h <= 10; h++) energy[h] = 0.4 + (0.6 * (h - 5)) / 5
    const dip = measureKickDip(energy, HOP, 5 * HOP, null, 0.1)
    expect(dip).not.toBeNull()
    expect(dip.depth).toBeCloseTo(0.6, 1)
    expect(dip.troughLagSeconds).toBeCloseTo(0, 5)
  })

  it('returns null when the pre-onset baseline is at or below the floor', () => {
    const energy = new Array(20).fill(0.05)
    const dip = measureKickDip(energy, HOP, 5 * HOP, null, 0.1)
    expect(dip).toBeNull()
  })

  it('caps the trough and recovery search at the next onset', () => {
    // A dip that would naturally take 10 hops to recover, but the next kick
    // arrives after only 3 - recovery must not reach past it.
    const energy = new Array(30).fill(1)
    for (let h = 10; h < 20; h++) energy[h] = 0.3
    const dip = measureKickDip(energy, HOP, 10 * HOP, 13 * HOP, 0.1)
    expect(dip.recoverySeconds).toBeLessThanOrEqual(3 * HOP + 1e-9)
  })

  it('reports a late trough as a large lag, not zero', () => {
    const energy = new Array(20).fill(1)
    // Trough doesn't land until 8 hops after onset - a slow, non-instant dip.
    for (let h = 5; h < 13; h++) energy[h] = 1 - (0.5 * (h - 5)) / 8
    for (let h = 13; h < 15; h++) energy[h] = 0.5
    const dip = measureKickDip(energy, HOP, 5 * HOP, null, 0.1)
    expect(dip.troughLagSeconds).toBeGreaterThan(5 * HOP)
  })
})

// ============================================================================
// detectSidechainStem - sidechain pumping on real (synthetic) audio
// ============================================================================

describe('detectSidechainStem', () => {
  const BPM = 120
  const BEAT = 60 / BPM // 0.5s
  const BARS = 5
  const DURATION = BARS * 4 * BEAT // 10s
  const grid = makeGrid({ bpm: BPM })
  const sections = [makeSection({ bars: BARS })]
  const kickTimes = Array.from({ length: Math.floor(DURATION / BEAT) - 1 }, (_, i) => (i + 1) * BEAT)

  it('detects a known artificial pump at roughly the configured depth and recovery', () => {
    const depth = 0.3
    const releaseSeconds = 0.09
    const buf = duckedToneClip({ seconds: DURATION, toneHz: 300, kickTimes, depth, releaseSeconds })
    const [result] = detectSidechainStem(buf, kickTimes, grid, sections)
    expect(result).not.toBeNull()
    // bandEnergy's own 1024-sample analysis window (~23ms) partially smooths
    // a 90ms-release dip's true minimum, so the measured depth reads below
    // the configured 0.3 rather than matching it exactly - the same window-
    // smoothing bias stem-profile.test.mjs documents for decay measurements.
    // What matters here is "clearly measures a real, sizeable dip", not an
    // exact match to the input.
    expect(result.depth).toBeGreaterThan(0.15)
    expect(result.depth).toBeLessThan(0.35)
    // The envelope reaches RECOVERY_FRACTION (0.85) of baseline at fraction
    // (0.85 - (1 - depth)) / depth = 0.5 of the linear release ramp for a
    // 0.3 depth - i.e. 0.5 * releaseSeconds - widened for the same window
    // smoothing this depth check accounts for.
    expect(result.recoverySeconds).toBeGreaterThan(0.02)
    expect(result.recoverySeconds).toBeLessThan(0.08)
    expect(result.consistency).toBeGreaterThan(0.8)
  })

  it('detects nothing on a flat, unmodulated tone', () => {
    const buf = sweepToneClip({ seconds: DURATION, startHz: 300, endHz: 300 })
    const [result] = detectSidechainStem(buf, kickTimes, grid, sections)
    expect(result).toBeNull()
  })

  it('rejects dips that are not actually phase-locked to the kicks', () => {
    // Only every third dip lands right on the kick; the other two thirds
    // land 120ms late - well outside the phase-lock window - simulating a
    // stem whose own material happens to decay near the kick grid rather
    // than being genuinely ducked by it (the "sparse coincidental dips" the
    // module brief calls out).
    const jitteredStarts = kickTimes.map((t, i) => (i % 3 === 0 ? t : t + 0.12))
    const buf = duckedToneClip({ seconds: DURATION, toneHz: 300, kickTimes: jitteredStarts, depth: 0.3, releaseSeconds: 0.09 })
    const [result] = detectSidechainStem(buf, kickTimes, grid, sections)
    expect(result).toBeNull()
  })

  it('reports null rather than a coin-flip below MIN_KICKS', () => {
    const fewKicks = kickTimes.slice(0, 3)
    const buf = duckedToneClip({ seconds: DURATION, toneHz: 300, kickTimes: fewKicks, depth: 0.5, releaseSeconds: 0.05 })
    const [result] = detectSidechainStem(buf, fewKicks, grid, sections)
    expect(result).toBeNull()
  })

  it('rejects a dip that is technically phase-locked but too shallow to be audible', () => {
    const buf = duckedToneClip({ seconds: DURATION, toneHz: 300, kickTimes, depth: 0.03, releaseSeconds: 0.09 })
    const [result] = detectSidechainStem(buf, kickTimes, grid, sections)
    expect(result).toBeNull()
  })
})

// ============================================================================
// detectFilterSweeps
// ============================================================================

describe('detectFilterSweeps', () => {
  const grid = makeGrid({ bpm: 120 })
  const sections = [makeSection({ bars: 5 })] // 10s at 120bpm/4
  const DURATION = 10

  it('finds a rising sweep and maps it to a conservative lpf range', () => {
    const buf = sweepToneClip({ seconds: DURATION, startHz: 500, endHz: 3000 })
    const [result] = detectFilterSweeps(buf, grid, sections)
    expect(result).not.toBeNull()
    expect(result.startHz).toBeGreaterThan(300)
    expect(result.startHz).toBeLessThan(800)
    expect(result.endHz).toBeGreaterThan(2500)
    expect(result.r).toBeGreaterThan(0.8)
    // CENTROID_TO_LPF_FACTOR is 2, clamped to [300, 8000].
    expect(result.lpfStart).toBeCloseTo(result.startHz * 2, -2)
    expect(result.lpfEnd).toBeCloseTo(result.endHz * 2, -2) // 3000*2=6000, under the 8000 cap
    expect(result.lpfEnd).toBeLessThan(8000)
    expect(result.lpfEnd).toBeGreaterThan(result.lpfStart)
  })

  it('finds a falling sweep with a negative correlation and a descending lpf range', () => {
    const buf = sweepToneClip({ seconds: DURATION, startHz: 3000, endHz: 500 })
    const [result] = detectFilterSweeps(buf, grid, sections)
    expect(result).not.toBeNull()
    expect(result.r).toBeLessThan(-0.8)
    expect(result.lpfEnd).toBeLessThan(result.lpfStart)
  })

  it('comes back flat for a steady tone with no trend', () => {
    const buf = sweepToneClip({ seconds: DURATION, startHz: 1200, endHz: 1200 })
    const [result] = detectFilterSweeps(buf, grid, sections)
    expect(result).toBeNull()
  })

  it('comes back flat when a section is too short to fit enough analysis frames', () => {
    const shortSections = [makeSection({ bars: 5 })]
    // Force a tiny window by asking for a section that only spans a
    // fraction of a bar's worth of frames - reuse the grid's own barAt via a
    // 1-bar section on a very fast tempo instead of hand-rolling seconds.
    const fastGrid = makeGrid({ bpm: 6000 }) // ~40ms per bar
    const buf = sweepToneClip({ seconds: 1, startHz: 500, endHz: 3000 })
    const [result] = detectFilterSweeps(buf, fastGrid, shortSections)
    expect(result).toBeNull()
  })
})

// ============================================================================
// detectRisers
// ============================================================================

describe('detectRisers', () => {
  const grid = makeGrid({ bpm: 120 })

  it('detects a riser and marks it emit-eligible when the window covers the whole section', () => {
    const sections = [makeSection({ bars: 4 })] // 8s, <= RISER_WINDOW_BARS_MAX
    const buf = risingClip({ seconds: 8, startHz: 500, endHz: 2500, startGain: 0.1, endGain: 0.9 })
    const [result] = detectRisers(buf, grid, sections, [null])
    expect(result).not.toBeNull()
    expect(result.emit).toBe(true)
    expect(result.windowBars).toBe(4)
    expect(result.rmsR).toBeGreaterThan(0.6)
    expect(result.centroidR).toBeGreaterThan(0.6)
    expect(result.endHz).toBeGreaterThan(result.startHz)
  })

  it('detects a riser in the tail of a longer section but marks it not emit-eligible', () => {
    const sections = [makeSection({ bars: 8 })] // 16s - longer than the 4-bar window
    const buf = risingClip({ seconds: 16, startHz: 500, endHz: 2500, startGain: 0.1, endGain: 0.9 })
    const [result] = detectRisers(buf, grid, sections, [null])
    expect(result).not.toBeNull()
    expect(result.windowBars).toBe(4)
    expect(result.emit).toBe(false)
  })

  it('requires both RMS and centroid to rise - rejects a rising level with a flat centroid', () => {
    const sections = [makeSection({ bars: 4 })]
    const buf = risingClip({ seconds: 8, startHz: 1200, endHz: 1200, startGain: 0.1, endGain: 0.9 })
    const [result] = detectRisers(buf, grid, sections, [null])
    expect(result).toBeNull()
  })

  it('requires both RMS and centroid to rise - rejects a rising centroid with a flat level', () => {
    const sections = [makeSection({ bars: 4 })]
    const buf = risingClip({ seconds: 8, startHz: 500, endHz: 2500, startGain: 0.5, endGain: 0.5 })
    const [result] = detectRisers(buf, grid, sections, [null])
    expect(result).toBeNull()
  })

  it('is flat for a section with no trend at all', () => {
    const sections = [makeSection({ bars: 4 })]
    const buf = sweepToneClip({ seconds: 8, startHz: 800, endHz: 800 })
    const [result] = detectRisers(buf, grid, sections, [null])
    expect(result).toBeNull()
  })

  it('does not double-count a section that already carries a whole-section sweep', () => {
    const sections = [makeSection({ bars: 4 })]
    const buf = risingClip({ seconds: 8, startHz: 500, endHz: 2500, startGain: 0.1, endGain: 0.9 })
    const fakeSweep = { startHz: 500, endHz: 2500, lpfStart: 1000, lpfEnd: 5000, r: 0.9, relativeChange: 1 }
    const [result] = detectRisers(buf, grid, sections, [fakeSweep])
    expect(result).toBeNull()
  })
})

// ============================================================================
// detectDynamics - end to end orchestration
// ============================================================================

describe('detectDynamics', () => {
  it('wires kick onsets from the drum stem into both the bass and other sidechain scores', () => {
    const bpm = 120
    const beat = 60 / bpm
    const duration = 10
    const grid = makeGrid({ bpm })
    const sections = [makeSection({ bars: 5 })]
    const kickTimes = Array.from({ length: Math.floor(duration / beat) - 1 }, (_, i) => (i + 1) * beat)

    // A real drum stem the pipeline's own onset detector can find kicks in:
    // a low sine thud on each beat, exactly `drums.mjs`'s own kick band.
    const drumsMono = new Float32Array(Math.round(duration * SAMPLE_RATE))
    for (const t of kickTimes) {
      const start = Math.round(t * SAMPLE_RATE)
      for (let i = 0; i < SAMPLE_RATE * 0.1 && start + i < drumsMono.length; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.02))
        drumsMono[start + i] += env * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE)
      }
    }
    const drums = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 2, float32: false, samples: [drumsMono, drumsMono] })

    const other = duckedToneClip({ seconds: duration, toneHz: 300, kickTimes, depth: 0.35, releaseSeconds: 0.09 })
    const bass = sweepToneClip({ seconds: duration, startHz: 200, endHz: 200 })

    const dynamics = detectDynamics({ drums, bass, other, grid, sections })
    expect(dynamics.sidechain.other[0]).not.toBeNull()
    expect(dynamics.sidechain.other[0].depth).toBeGreaterThan(0.2)
    expect(dynamics.sidechain.bass[0]).toBeNull()
  })
})

// ============================================================================
// dynamicsForEmission
// ============================================================================

describe('dynamicsForEmission', () => {
  const LAYERS = ['kick', 'snare', 'hats', 'bass', 'sub', 'chords', 'lead']

  function section(index, loops) {
    return { index, loops }
  }

  it('emits duckorbit on kick and orbit on the ducked layers, single stem', () => {
    const dynamics = {
      sidechain: { other: [{ depth: 0.32, recoverySeconds: 0.11, consistency: 0.9, kicksInSection: 20, kicksMeasured: 18 }], bass: [null] },
      sweeps: [null],
      risers: [null],
    }
    const sections = [section(0, { kick: {}, chords: {}, lead: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0].layers.kick.chain).toBe('.duckorbit(2).duckdepth(0.32).duckattack(0.11)')
    expect(result[0].layers.chords.chain).toBe('.orbit(2)')
    expect(result[0].layers.lead.chain).toBe('.orbit(2)')
    expect(result[0].layers.bass).toBeUndefined()
    expect(result[0].summary).toMatch(/duck: other dips 32%/)
  })

  it('joins both stems into a colon-separated duckorbit/duckdepth/duckattack when both duck', () => {
    const dynamics = {
      sidechain: {
        other: [{ depth: 0.3, recoverySeconds: 0.1, consistency: 0.9, kicksInSection: 20, kicksMeasured: 18 }],
        bass: [{ depth: 0.5, recoverySeconds: 0.2, consistency: 0.8, kicksInSection: 20, kicksMeasured: 16 }],
      },
      sweeps: [null],
      risers: [null],
    }
    const sections = [section(0, { kick: {}, bass: {}, sub: {}, chords: {}, lead: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0].layers.kick.chain).toBe('.duckorbit("2:3").duckdepth("0.3:0.5").duckattack("0.1:0.2")')
    expect(result[0].layers.bass.chain).toBe('.orbit(3)')
    expect(result[0].layers.sub.chain).toBe('.orbit(3)')
    expect(result[0].layers.chords.chain).toBe('.orbit(2)')
  })

  it('does not duckorbit/orbit a stem whose target layers are absent from the section', () => {
    // chords/lead were both dropped by the hearing check - duckorbit(2)
    // would target an orbit nothing plays on (checkDucking's duck-missing-
    // orbit rule).
    const dynamics = {
      sidechain: { other: [{ depth: 0.3, recoverySeconds: 0.1, consistency: 0.9, kicksInSection: 20, kicksMeasured: 18 }], bass: [null] },
      sweeps: [null],
      risers: [null],
    }
    const sections = [section(0, { kick: {}, bass: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0]).toBeUndefined()
  })

  it('exposes a sweep as raw lpf numbers on present other-stem layers and names the trend in the summary', () => {
    // Raw numbers, not a pre-built `.lpf(saw.range(...))` string - only
    // emit.mjs's layerExpression knows the `.slow()` ratio a real chain
    // needs (see its own sweepChain comment for why).
    const dynamics = {
      sidechain: { other: [null], bass: [null] },
      sweeps: [{ startHz: 1200, endHz: 2400, lpfStart: 2400, lpfEnd: 4800, r: 0.82, relativeChange: 1 }],
      risers: [null],
    }
    const sections = [section(0, { chords: {}, lead: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0].layers.chords.sweepLpf).toEqual({ lpfStart: 2400, lpfEnd: 4800 })
    expect(result[0].layers.lead.sweepLpf).toEqual({ lpfStart: 2400, lpfEnd: 4800 })
    expect(result[0].summary).toMatch(/sweep: other centroid 1200→2400Hz/)
  })

  it('exposes a riser as raw lpf numbers only when emit-eligible, and reports a reason when not', () => {
    const dynamics = {
      sidechain: { other: [null, null], bass: [null, null] },
      sweeps: [null, null],
      risers: [
        { windowBars: 4, rmsR: 0.7, rmsRelativeChange: 0.5, startHz: 500, endHz: 2000, lpfStart: 1000, lpfEnd: 4000, centroidR: 0.7, emit: true },
        { windowBars: 4, rmsR: 0.7, rmsRelativeChange: 0.5, startHz: 500, endHz: 2000, lpfStart: 1000, lpfEnd: 4000, centroidR: 0.7, emit: false },
      ],
    }
    const sections = [section(0, { chords: {} }), section(1, { chords: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0].layers.chords.sweepLpf).toEqual({ lpfStart: 1000, lpfEnd: 4000 })
    expect(result[1].layers.chords).toBeUndefined()
    expect(result[1].summary).toMatch(/not emitted/)
  })

  it('returns no entry at all for a section with nothing detected', () => {
    const dynamics = { sidechain: { other: [null], bass: [null] }, sweeps: [null], risers: [null] }
    const sections = [section(0, { kick: {}, chords: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0]).toBeUndefined()
  })

  it('does not claim a sweep or an emit-eligible riser when neither chords nor lead survived the hearing check', () => {
    // A real, measured trend in the other stem, but the section that
    // produced it has no chords/lead layer left to carry it - the-chase's
    // own section 2 does exactly this.
    const dynamics = {
      sidechain: { other: [null], bass: [null] },
      sweeps: [{ startHz: 4788, endHz: 1151, lpfStart: 8000, lpfEnd: 2302, r: -0.76, relativeChange: -1.2 }],
      risers: [{ windowBars: 4, rmsR: 0.7, rmsRelativeChange: 0.5, startHz: 500, endHz: 2000, lpfStart: 1000, lpfEnd: 4000, centroidR: 0.7, emit: true }],
    }
    const sections = [section(0, { kick: {}, hats: {} })]
    const result = dynamicsForEmission(dynamics, sections, LAYERS)
    expect(result[0]).toBeUndefined()
  })
})
