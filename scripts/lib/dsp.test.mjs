import { describe, expect, it } from 'vitest'
import {
  computeChroma,
  computeNovelty,
  detectKey,
  estimateTempo,
  fft,
  keysMatch,
  makeHann,
  normalizeKeyName,
  pickOnsets,
  ONSET_HOP,
} from './dsp.mjs'
import { decodeWav } from './decoded-audio.mjs'
import { synthClip } from './__fixtures__/make-wav.mjs'

describe('fft', () => {
  it('puts a pure tone in the expected bin', () => {
    const n = 1024
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    // Exactly 8 cycles across the frame, so all energy lands in bin 8.
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n)
    fft(re, im)

    const magnitude = (bin) => Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    expect(magnitude(8)).toBeGreaterThan(magnitude(7) * 50)
    expect(magnitude(8)).toBeGreaterThan(magnitude(9) * 50)
  })
})

describe('makeHann', () => {
  it('is zero at the edges and one in the middle', () => {
    const w = makeHann(1024)
    expect(w[0]).toBeCloseTo(0, 6)
    expect(w[1023]).toBeCloseTo(0, 6)
    expect(w[512]).toBeCloseTo(1, 3)
  })

  it('returns the same cached array for the same size', () => {
    expect(makeHann(256)).toBe(makeHann(256))
  })
})

describe('computeNovelty and pickOnsets', () => {
  it('finds one onset per beat on a clip with a kick on every beat', () => {
    const audio = decodeWav(synthClip({ seconds: 8, bpm: 120, key: 'A minor' }))
    const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
    const onsets = pickOnsets(novelty, ONSET_HOP / audio.sampleRate)

    // 8 seconds at 120 BPM is 16 beats. Allow slack for edge frames.
    expect(onsets.length).toBeGreaterThanOrEqual(14)
    expect(onsets.length).toBeLessThanOrEqual(18)
  })

  it('returns null for a clip too short to analyse', () => {
    const audio = decodeWav(synthClip({ seconds: 0.01, bpm: 120, key: 'A minor' }))
    expect(computeNovelty(audio.readSample, audio.numFrames, audio.channels)).toBeNull()
  })
})

describe('estimateTempo', () => {
  it('recovers 120 BPM from a 120 BPM clip', () => {
    const audio = decodeWav(synthClip({ seconds: 12, bpm: 120, key: 'A minor' }))
    const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
    const tempo = estimateTempo(novelty, ONSET_HOP / audio.sampleRate)
    expect(tempo.bpm).toBeCloseTo(120, 0)
    expect(tempo.confidence).toBeGreaterThan(0)
  })
})

describe('computeChroma and detectKey', () => {
  it('names a key whose scale contains the triad it was given', () => {
    const audio = decodeWav(synthClip({ seconds: 12, bpm: 120, key: 'A minor' }))
    const chroma = computeChroma(audio.readSample, audio.numFrames, audio.channels, audio.sampleRate)
    const key = detectKey(chroma)
    // An A minor triad is shared by several keys; assert compatibility, not identity.
    expect(keysMatch(normalizeKeyName(key.best.name), 'A minor')).toBe(true)
  })
})

describe('normalizeKeyName', () => {
  it('normalises the spellings the codebase actually produces', () => {
    expect(normalizeKeyName('F minor')).toBe('F minor')
    expect(normalizeKeyName('Fm')).toBe('F minor')
    expect(normalizeKeyName('f:minor')).toBe('F minor')
    expect(normalizeKeyName('C')).toBe('C major')
    expect(normalizeKeyName('')).toBeNull()
  })
})

describe('keysMatch', () => {
  it('treats relative major and minor as the same', () => {
    expect(keysMatch('C major', 'A minor')).toBe(true)
  })

  it('separates keys whose note sets genuinely diverge', () => {
    expect(keysMatch('C major', 'F# major')).toBe(false)
  })
})
