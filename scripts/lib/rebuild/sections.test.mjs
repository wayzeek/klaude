import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { findSections, matchRepeats, similarityMatrix, structuralNovelty } from './sections.mjs'

/**
 * A clip in three parts: a quiet A, a loud B with a different triad, then A
 * again. The structure is known exactly, so boundary detection and repeat
 * matching can both be asserted rather than eyeballed.
 */
function threePartClip({ sampleRate = 44100, bpm = 120, barsPerPart = 8 } = {}) {
  const beatFrames = Math.round((60 / bpm) * sampleRate)
  const partFrames = beatFrames * 4 * barsPerPart
  const total = partFrames * 3
  const mono = new Float32Array(total)

  const parts = [
    { gain: 0.15, midis: [57, 60, 64] }, // A minor, quiet
    { gain: 0.45, midis: [53, 57, 60] }, // F major, loud
    { gain: 0.15, midis: [57, 60, 64] }, // A minor again
  ]

  parts.forEach((part, index) => {
    const from = index * partFrames
    for (const midi of part.midis) {
      const hz = 440 * Math.pow(2, (midi - 69) / 12)
      for (let i = 0; i < partFrames; i++) {
        mono[from + i] += part.gain * Math.sin((2 * Math.PI * hz * i) / sampleRate)
      }
    }
  })

  // Kick on every beat throughout. 150 Hz rather than 55 so the hits are
  // resolvable by the analysis window, same reason rhythmClip uses it.
  const decay = Math.round(0.03 * sampleRate)
  for (let start = 0; start < total; start += beatFrames) {
    for (let i = 0; i < decay && start + i < total; i++) {
      mono[start + i] += 0.6 * Math.exp(-6 * (i / decay)) * Math.sin((2 * Math.PI * 150 * i) / sampleRate)
    }
  }

  return writeWavBuffer({ sampleRate, channels: 2, float32: false, samples: [mono, mono] })
}

/**
 * The grid for threePartClip, built from what we generated rather than detected.
 *
 * These tests are about section detection, and handing them a detected grid
 * would couple them to a separate algorithm that this fixture is actively
 * hostile to: the clip's sustained triads swamp the onset curve with leakage,
 * which is precisely why the grid gets its own rhythm-only fixture. A section
 * test that fails because tempo detection wandered tells you nothing about
 * section detection.
 *
 * Field for field, this matches what detectGrid actually returns (see
 * scripts/lib/rebuild/grid.mjs): bpm, beatSeconds, phaseSeconds,
 * downbeatSeconds, beatsPerBar, downbeatOffset, barSeconds, a confidence
 * object keyed tempo/phase/meter, and the same three derived accessors.
 */
function knownGrid({ sampleRate = 44100, bpm = 120, beatsPerBar = 4 } = {}) {
  const beatSeconds = 60 / bpm
  const barSeconds = beatSeconds * beatsPerBar
  return {
    bpm,
    beatSeconds,
    phaseSeconds: 0,
    downbeatSeconds: 0,
    beatsPerBar,
    downbeatOffset: 0,
    barSeconds,
    confidence: { tempo: 1, phase: 1, meter: 1 },
    beatAt: (index) => index * beatSeconds,
    barAt: (index) => index * barSeconds,
    secondsToBars: (seconds) => seconds / barSeconds,
  }
}

describe('similarityMatrix', () => {
  it('is 1 on the diagonal and symmetric', () => {
    const vectors = [Float32Array.from([1, 0]), Float32Array.from([0, 1]), Float32Array.from([1, 0])]
    const m = similarityMatrix(vectors)
    expect(m[0 * 3 + 0]).toBeCloseTo(1, 5)
    expect(m[0 * 3 + 2]).toBeCloseTo(1, 5)
    expect(m[0 * 3 + 1]).toBeCloseTo(0, 5)
    expect(m[1 * 3 + 0]).toBeCloseTo(m[0 * 3 + 1], 5)
  })
})

describe('structuralNovelty', () => {
  it('peaks where the material changes', () => {
    // Ten beats of A then ten of B.
    const vectors = []
    for (let i = 0; i < 10; i++) vectors.push(Float32Array.from([1, 0]))
    for (let i = 0; i < 10; i++) vectors.push(Float32Array.from([0, 1]))
    const novelty = structuralNovelty(similarityMatrix(vectors), 20, 4)

    let peak = 0
    for (let i = 1; i < novelty.length; i++) if (novelty[i] > novelty[peak]) peak = i
    expect(Math.abs(peak - 10)).toBeLessThanOrEqual(2)
  })
})

describe('findSections', () => {
  const buf = threePartClip()
  const grid = knownGrid()
  const sections = findSections(buf, grid)

  it('finds roughly three sections in a three-part clip', () => {
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.length).toBeLessThanOrEqual(5)
  })

  it('gives every section a bar-aligned length', () => {
    for (const section of sections) {
      expect(section.bars).toBeGreaterThan(0)
      expect(Number.isInteger(section.bars)).toBe(true)
    }
  })

  it('labels the loud middle section as higher energy than the quiet ends', () => {
    const loudest = sections.reduce((a, b) => (b.energy > a.energy ? b : a))
    expect(loudest.index).not.toBe(0)
    expect(loudest.index).not.toBe(sections.length - 1)
  })

  it('recognises the returning section as a repeat of the first', () => {
    const last = sections[sections.length - 1]
    expect(last.sameAs).toBe(0)
  })

  it('leaves sameAs null when nothing matches confidently', () => {
    expect(sections[0].sameAs).toBeNull()
  })

  it('covers the whole clip without gaps', () => {
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].startSec).toBeCloseTo(sections[i - 1].endSec, 3)
    }
  })
})

describe('matchRepeats', () => {
  /**
   * A vector whose centroid, averaged over any number of identical beats,
   * is itself: one pitch class, one band, both already unit-length.
   */
  function flatVector() {
    const v = new Float32Array(18)
    v[0] = 1
    v[12] = 1
    return v
  }

  it('does not match a short section against a much longer one, however similar their averages', () => {
    // Section 0: 4 beats. Section 1: 16 beats, built from the exact same
    // vector, so its centroid is identical to section 0's - a length
    // mismatch (4x) that a real repeat could never have, on content that
    // gives centroid similarity nothing to disagree about (score 1.0).
    const vectors = []
    for (let i = 0; i < 20; i++) vectors.push(flatVector())
    const sections = [
      { startBeat: 0, endBeat: 4, sameAs: null, confidence: 0 },
      { startBeat: 4, endBeat: 20, sameAs: null, confidence: 0 },
    ]
    matchRepeats(sections, vectors, { threshold: 0.9 })
    expect(sections[1].sameAs).toBeNull()
  })

  it('still matches a section against an equal-length one, once a same-length candidate exists', () => {
    // Section 2 is added at the same length as section 0 (4 beats). Both
    // section 0 and section 1 score identically against it on centroid
    // similarity alone; only section 0 passes the length-ratio gate.
    const vectors = []
    for (let i = 0; i < 24; i++) vectors.push(flatVector())
    const sections = [
      { startBeat: 0, endBeat: 4, sameAs: null, confidence: 0 },
      { startBeat: 4, endBeat: 20, sameAs: null, confidence: 0 },
      { startBeat: 20, endBeat: 24, sameAs: null, confidence: 0 },
    ]
    matchRepeats(sections, vectors, { threshold: 0.9 })
    expect(sections[1].sameAs).toBeNull()
    expect(sections[2].sameAs).toBe(0)
  })
})
