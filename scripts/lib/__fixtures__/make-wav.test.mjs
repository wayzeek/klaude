import { describe, expect, it } from 'vitest'
import { synthClip, writeWavBuffer } from './make-wav.mjs'

describe('writeWavBuffer', () => {
  it('produces a parseable 16-bit stereo RIFF header', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 0])
    const right = Float32Array.from([0, -0.5, 0.5, 0])
    const buf = writeWavBuffer({ sampleRate: 44100, channels: 2, float32: false, samples: [left, right] })

    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
    // 4 frames x 2 channels x 2 bytes
    expect(buf.length).toBe(44 + 16)
  })
})

describe('synthClip', () => {
  it('is deterministic: the same arguments give byte-identical output', () => {
    const a = synthClip({ seconds: 2, bpm: 120, key: 'A minor' })
    const b = synthClip({ seconds: 2, bpm: 120, key: 'A minor' })
    expect(a.equals(b)).toBe(true)
  })

  it('produces the requested duration', () => {
    const buf = synthClip({ seconds: 2, bpm: 120, key: 'A minor', sampleRate: 44100, channels: 2 })
    const frames = (buf.length - 44) / (2 * 2)
    expect(frames).toBe(2 * 44100)
  })
})
