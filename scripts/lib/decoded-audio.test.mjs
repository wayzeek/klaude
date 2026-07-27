import { describe, expect, it } from 'vitest'
import { decodeWav } from './decoded-audio.mjs'
import { writeWavBuffer } from './__fixtures__/make-wav.mjs'

describe('decodeWav', () => {
  it('reads header fields and frame count from a 16-bit stereo file', () => {
    const buf = writeWavBuffer({
      sampleRate: 48000,
      channels: 2,
      float32: false,
      samples: [Float32Array.from([0, 0.5, -0.5]), Float32Array.from([0, -0.5, 0.5])],
    })
    const audio = decodeWav(buf)
    expect(audio.sampleRate).toBe(48000)
    expect(audio.channels).toBe(2)
    expect(audio.numFrames).toBe(3)
    expect(audio.duration).toBeCloseTo(3 / 48000, 9)
  })

  it('reads samples back at roughly the value written', () => {
    const buf = writeWavBuffer({
      sampleRate: 44100,
      channels: 2,
      float32: false,
      samples: [Float32Array.from([0, 0.5]), Float32Array.from([0, -0.25])],
    })
    const audio = decodeWav(buf)
    // 16-bit quantisation, so exact equality is the wrong assertion.
    expect(audio.readSample(1, 0)).toBeCloseTo(0.5, 4)
    expect(audio.readSample(1, 1)).toBeCloseTo(-0.25, 4)
  })

  it('averages channels in readMono', () => {
    const buf = writeWavBuffer({
      sampleRate: 44100,
      channels: 2,
      float32: false,
      samples: [Float32Array.from([0.5]), Float32Array.from([-0.5])],
    })
    expect(decodeWav(buf).readMono(0)).toBeCloseTo(0, 4)
  })

  it('handles 32-bit float without quantisation', () => {
    const buf = writeWavBuffer({
      sampleRate: 44100,
      channels: 1,
      float32: true,
      samples: [Float32Array.from([0.123456])],
    })
    expect(decodeWav(buf).readSample(0, 0)).toBeCloseTo(0.123456, 6)
  })

  it('rejects a non-RIFF buffer', () => {
    expect(() => decodeWav(Buffer.alloc(100))).toThrow(/RIFF/)
  })

  it('rejects an unsupported channel count', () => {
    const buf = writeWavBuffer({
      sampleRate: 44100,
      channels: 2,
      float32: false,
      samples: [Float32Array.from([0]), Float32Array.from([0])],
    })
    buf.writeUInt16LE(6, 22) // claim 6 channels in the fmt chunk
    expect(() => decodeWav(buf)).toThrow(/channel count/)
  })
})
