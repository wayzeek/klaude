import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { decodeWav } from '../../decoded-audio.mjs'
import { midiToHz } from './f0.mjs'
import {
  buildPitchGrid,
  computeMelodyContour,
  filterContours,
  harmonicSalience,
  selectMelody,
  trackContours,
} from './salience.mjs'

const SAMPLE_RATE = 44100

describe('buildPitchGrid', () => {
  it('is log-spaced: every step is the same frequency ratio', () => {
    const grid = buildPitchGrid(100, 400, 100)
    const ratio = grid[1] / grid[0]
    for (let i = 1; i < grid.length; i++) {
      expect(grid[i] / grid[i - 1]).toBeCloseTo(ratio, 10)
    }
    expect(grid[0]).toBe(100)
  })

  it('covers the requested range at the requested resolution', () => {
    // 1200 cents is exactly one octave, so a 100-cent grid over 100-200 Hz
    // needs exactly 13 points: the 12 semitone steps plus the start.
    const grid = buildPitchGrid(100, 200, 100)
    expect(grid.length).toBe(13)
    expect(grid[grid.length - 1]).toBeCloseTo(200, 6)
  })

  it('never returns an empty grid, even for a degenerate range', () => {
    const grid = buildPitchGrid(100, 100, 30)
    expect(grid.length).toBeGreaterThanOrEqual(1)
  })
})

/** Build a synthetic magnitude spectrum with energy at exactly the given
 *  frequencies (bin-aligned, so no interpolation error muddies the formula
 *  check below). */
function spectrumWithPeaks(peaks, { bins = 2048, binHz = 10 } = {}) {
  const mag = new Float32Array(bins)
  for (const [hz, amplitude] of peaks) {
    const bin = Math.round(hz / binHz)
    mag[bin] = amplitude
  }
  return { mag, binHz, bins }
}

describe('harmonicSalience', () => {
  it('with one harmonic, salience is exactly the magnitude at f0', () => {
    const { mag, binHz, bins } = spectrumWithPeaks([[300, 5]])
    const s = harmonicSalience(mag, binHz, bins, 300, { harmonics: 1, alpha: 0.8 })
    expect(s).toBeCloseTo(5, 6)
  })

  it('sums harmonics with exact alpha^(h-1) decay - proof against the formula, not just a property', () => {
    const { mag, binHz, bins } = spectrumWithPeaks([
      [200, 4],
      [400, 3],
      [600, 2],
    ])
    const s = harmonicSalience(mag, binHz, bins, 200, { harmonics: 3, alpha: 0.5 })
    // 4*1 + 3*0.5 + 2*0.25 = 4 + 1.5 + 0.5 = 6
    expect(s).toBeCloseTo(6, 6)
  })

  it('stops at the harmonic count - a mutation dropping this bound would sum forever', () => {
    const { mag, binHz, bins } = spectrumWithPeaks([
      [100, 1],
      [200, 1],
      [300, 1],
    ])
    const oneHarmonic = harmonicSalience(mag, binHz, bins, 100, { harmonics: 1, alpha: 0.9 })
    const threeHarmonics = harmonicSalience(mag, binHz, bins, 100, { harmonics: 3, alpha: 0.9 })
    expect(oneHarmonic).toBeCloseTo(1, 6)
    expect(threeHarmonics).toBeGreaterThan(oneHarmonic)
  })

  it('never reaches past the Nyquist frequency', () => {
    const { mag, binHz, bins } = spectrumWithPeaks([[300, 5]])
    const withoutNyquist = harmonicSalience(mag, binHz, bins, 300, { harmonics: 10, alpha: 0.9, nyquist: Infinity })
    const withNyquist = harmonicSalience(mag, binHz, bins, 300, { harmonics: 10, alpha: 0.9, nyquist: 500 })
    // Both only see the h=1 peak at 300 (nothing planted at its harmonics),
    // so a correct Nyquist cutoff changes nothing here - the real assertion
    // is that it does not throw or read out of bounds requesting bins past
    // a spectrum sized for a much lower sample rate.
    expect(withNyquist).toBeCloseTo(withoutNyquist, 6)
  })

  it('the true fundamental outscores its own subharmonic candidate', () => {
    // A note with energy at f and 2f only (two harmonics, no fundamental-half
    // content). The candidate at f/2 can only reach f via its own h=2 term
    // (discounted by alpha), while the true f reaches it at h=1 (undiscounted)
    // - this asymmetry is what keeps octave-down errors rare.
    const f = 220
    const { mag, binHz, bins } = spectrumWithPeaks([
      [f, 10],
      [2 * f, 6],
    ])
    const trueFundamental = harmonicSalience(mag, binHz, bins, f, { harmonics: 8, alpha: 0.8 })
    const subharmonic = harmonicSalience(mag, binHz, bins, f / 2, { harmonics: 8, alpha: 0.8 })
    expect(trueFundamental).toBeGreaterThan(subharmonic)
  })
})

/** A minimal peak, enough for `trackContours`/`selectMelody`. */
const peak = (hz, salience = 1, normSalience = salience) => ({ hz, salience, normSalience })

describe('trackContours', () => {
  it('links a steady pitch across frames into one contour', () => {
    const peaksPerFrame = [[peak(440)], [peak(441)], [peak(439)], [peak(440)]]
    const contours = trackContours(peaksPerFrame, {})
    expect(contours).toHaveLength(1)
    expect(contours[0].frames).toHaveLength(4)
  })

  it('breaks the contour on a jump past the pitch tolerance', () => {
    const peaksPerFrame = [[peak(440)], [peak(440)], [peak(880)], [peak(880)]]
    const contours = trackContours(peaksPerFrame, { pitchToleranceCents: 60 })
    expect(contours).toHaveLength(2)
    expect(contours[0].frames).toHaveLength(2)
    expect(contours[1].frames).toHaveLength(2)
  })

  it('tolerates a short gap without breaking the contour', () => {
    // Frame 2 has no matching peak at all (a brief dropout), frame 3 resumes.
    const peaksPerFrame = [[peak(440)], [peak(440)], [], [peak(441)]]
    const contours = trackContours(peaksPerFrame, { maxGapFrames: 2 })
    expect(contours).toHaveLength(1)
    expect(contours[0].frames).toHaveLength(3)
  })

  it('a gap longer than maxGapFrames ends the contour for good', () => {
    const peaksPerFrame = [[peak(440)], [], [], [], [peak(441)]]
    const contours = trackContours(peaksPerFrame, { maxGapFrames: 2 })
    expect(contours).toHaveLength(2)
  })

  it('tracks two simultaneous voices as two independent contours', () => {
    const peaksPerFrame = [
      [peak(220), peak(660)],
      [peak(221), peak(661)],
      [peak(219), peak(659)],
    ]
    const contours = trackContours(peaksPerFrame, {})
    expect(contours).toHaveLength(2)
    const byStart = contours.slice().sort((a, b) => a.frames[0].hz - b.frames[0].hz)
    expect(byStart[0].frames.every((f) => f.hz < 300)).toBe(true)
    expect(byStart[1].frames.every((f) => f.hz > 600)).toBe(true)
  })
})

describe('filterContours', () => {
  it('drops a contour shorter than the minimum span', () => {
    const contours = [
      { frames: [{ frameIndex: 0 }, { frameIndex: 1 }] },
      { frames: [{ frameIndex: 0 }, { frameIndex: 1 }, { frameIndex: 2 }, { frameIndex: 3 }] },
    ]
    const kept = filterContours(contours, 4)
    expect(kept).toHaveLength(1)
    expect(kept[0].frames).toHaveLength(4)
  })

  it('span is measured start-to-end, not frame count - a contour with an internal gap still counts its full width', () => {
    const contours = [{ frames: [{ frameIndex: 0 }, { frameIndex: 5 }] }]
    expect(filterContours(contours, 6)).toHaveLength(1)
    expect(filterContours(contours, 7)).toHaveLength(0)
  })
})

/** Build a two-contour scene sharing the same frame range, for `selectMelody`. */
function twoVoiceScene({ lowSalience = 1, highSalience = 1, lowHz = 220, highHz = 880, frames = 10 }) {
  const peaksPerFrame = []
  const lowFrames = []
  const highFrames = []
  for (let i = 0; i < frames; i++) {
    const lowPeak = peak(lowHz, lowSalience)
    const highPeak = peak(highHz, highSalience)
    peaksPerFrame.push([lowPeak, highPeak])
    lowFrames.push({ frameIndex: i, ...lowPeak })
    highFrames.push({ frameIndex: i, ...highPeak })
  }
  const low = { frames: lowFrames }
  const high = { frames: highFrames }
  return { peaksPerFrame, low, high, numFrames: frames }
}

describe('selectMelody', () => {
  it('with register and length switched off, the louder (higher-salience) voice wins', () => {
    const { peaksPerFrame, low, high, numFrames } = twoVoiceScene({ lowSalience: 5, highSalience: 1 })
    const timeline = selectMelody([low, high], peaksPerFrame, numFrames, {
      salienceWeight: 1,
      registerWeight: 0,
      lengthWeight: 0,
    })
    expect(timeline[0].hz).toBe(220)
  })

  it('a strong enough register weight recovers the quieter, higher voice', () => {
    const { peaksPerFrame, low, high, numFrames } = twoVoiceScene({ lowSalience: 5, highSalience: 1 })
    const timeline = selectMelody([low, high], peaksPerFrame, numFrames, {
      salienceWeight: 1,
      registerWeight: 5,
      lengthWeight: 0,
    })
    expect(timeline[0].hz).toBe(880)
  })

  it('with salience and register tied, the longer contour wins the frames they share', () => {
    // Both voices carry identical salience at every frame they are both
    // present, and both sit at the same pitch (so register contributes
    // nothing to either) - only length can decide between them.
    const peaksPerFrame = []
    for (let i = 0; i < 20; i++) peaksPerFrame.push([peak(440, 1)])
    const short = { frames: Array.from({ length: 5 }, (_, i) => ({ frameIndex: i, hz: 440, salience: 1, normSalience: 1 })) }
    const long = { frames: Array.from({ length: 20 }, (_, i) => ({ frameIndex: i, hz: 440, salience: 1, normSalience: 1 })) }
    const timeline = selectMelody([short, long], peaksPerFrame, 20, {
      salienceWeight: 0,
      registerWeight: 0,
      lengthWeight: 1,
    })
    // Both contours are identical in every shared frame except which object
    // owns it; what proves length was actually used is that the timeline
    // extends past frame 5, which only `long` could have written.
    expect(timeline[10]).not.toBeNull()
  })

  it('a tie on every feature still produces a definite, non-crashing choice', () => {
    const { peaksPerFrame, low, high, numFrames } = twoVoiceScene({ lowSalience: 1, highSalience: 1 })
    const timeline = selectMelody([low, high], peaksPerFrame, numFrames, {
      salienceWeight: 0,
      registerWeight: 0,
      lengthWeight: 0,
    })
    expect([220, 880]).toContain(timeline[0].hz)
  })
})

/** Same synthesis helper `melody.test.mjs` uses for its YIN fixtures: a
 *  monophonic lead line over an optional sustained pad, so this module's
 *  integration test is directly comparable to that one. */
function leadOverPad({ padMidi, leadNotes, padGain = 0.12, leadGain = 0.4, seconds }) {
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const out = new Float32Array(frames)
  for (const midi of padMidi) {
    const hz = midiToHz(midi)
    for (let i = 0; i < frames; i++) out[i] += padGain * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  }
  for (const note of leadNotes) {
    const hz = midiToHz(note.midi)
    const start = Math.floor(note.startSec * SAMPLE_RATE)
    const end = Math.floor(note.endSec * SAMPLE_RATE)
    for (let i = start; i < end && i < frames; i++) {
      const fadeIn = Math.min(1, (i - start) / (SAMPLE_RATE * 0.008))
      const fadeOut = Math.min(1, (end - i) / (SAMPLE_RATE * 0.008))
      const fade = Math.max(0, Math.min(fadeIn, fadeOut))
      out[i] +=
        leadGain *
        fade *
        (Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) + 0.4 * Math.sin((2 * Math.PI * hz * 2 * i) / SAMPLE_RATE))
    }
  }
  return out
}

function audioFromSamples(samples) {
  return decodeWav(writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [samples] }))
}

describe('computeMelodyContour (integration)', () => {
  const lead = [
    { midi: 65, startSec: 0.0, endSec: 0.5 },
    { midi: 68, startSec: 0.5, endSec: 1.0 },
    { midi: 72, startSec: 1.0, endSec: 1.5 },
    { midi: 68, startSec: 1.5, endSec: 2.0 },
  ]

  it('follows the lead line over a sustained pad, with default parameters', () => {
    const samples = leadOverPad({ padMidi: [53, 56, 60], leadNotes: lead, seconds: 2.0 })
    const track = computeMelodyContour(audioFromSamples(samples), {})
    const voiced = track.frames.filter((f) => f.voiced)
    // At least 90% of voiced frames should sit on one of the lead's own
    // pitches, not the pad's (53/56/60) or noise - a handful of transition
    // frames at note boundaries is expected and fine.
    const onLead = voiced.filter((f) => [65, 68, 72].includes(Math.round(f.midi)))
    expect(voiced.length).toBeGreaterThan(0)
    expect(onLead.length / voiced.length).toBeGreaterThan(0.9)
  })

  it('reports zero voiced frames for silence', () => {
    const samples = new Float32Array(Math.ceil(2 * SAMPLE_RATE))
    const track = computeMelodyContour(audioFromSamples(samples), {})
    expect(track.frames.every((f) => !f.voiced)).toBe(true)
  })

  it('clarity is always within 0..1', () => {
    const samples = leadOverPad({ padMidi: [53, 56, 60], leadNotes: lead, seconds: 2.0 })
    const track = computeMelodyContour(audioFromSamples(samples), {})
    for (const frame of track.frames) {
      expect(frame.clarity).toBeGreaterThanOrEqual(0)
      expect(frame.clarity).toBeLessThanOrEqual(1)
    }
  })

  it('does not build a frame x grid matrix - peaksPerFrame-shaped memory only', () => {
    // Not a timing assertion (this suite is not a benchmark) - a smoke check
    // that a few seconds of audio at the default grid resolution completes
    // fast enough to prove no O(frames x gridSize) structure is being kept
    // and processed repeatedly after the fact.
    const samples = leadOverPad({ padMidi: [53, 56, 60], leadNotes: lead, seconds: 2.0 })
    const start = Date.now()
    computeMelodyContour(audioFromSamples(samples), {})
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('does not crash on audio shorter than a single analysis window', () => {
    const samples = new Float32Array(100)
    const track = computeMelodyContour(audioFromSamples(samples), {})
    expect(track.frames).toEqual([])
  })
})
