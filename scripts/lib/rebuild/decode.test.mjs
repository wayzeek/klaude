import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeWav } from '../decoded-audio.mjs'
import { synthClip } from '../__fixtures__/make-wav.mjs'
import { TARGET, ffmpegArgs, toWav } from './decode.mjs'
import { probe, TOOLS } from './tools.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-decode-'))

// Module scope, not inside describe(). A `describe` callback is synchronous,
// so `await` inside it is a parse error and the whole file fails to collect.
// ESM top-level await is fine here and vitest handles it.
const hasFfmpeg = (await probe('ffmpeg', TOOLS.ffmpeg)).present

describe('ffmpegArgs', () => {
  it('normalises sample rate, channel count and encoding', () => {
    const args = ffmpegArgs('/in.mp3', '/out.wav')
    expect(args).toContain('-ar')
    expect(args[args.indexOf('-ar') + 1]).toBe(String(TARGET.sampleRate))
    expect(args[args.indexOf('-ac') + 1]).toBe(String(TARGET.channels))
    expect(args).toContain('pcm_s16le')
    // Overwrite without prompting, or a second run hangs forever.
    expect(args).toContain('-y')
    expect(args[args.length - 1]).toBe('/out.wav')
  })
})

describe('toWav', () => {
  it.skipIf(!hasFfmpeg)('round-trips a WAV through ffmpeg with the target format', async () => {
    const source = path.join(tmp, 'in.wav')
    const out = path.join(tmp, 'out.wav')
    fs.writeFileSync(source, synthClip({ seconds: 2, bpm: 120, key: 'A minor', sampleRate: 48000 }))

    await toWav(source, out)

    const audio = decodeWav(fs.readFileSync(out))
    expect(audio.sampleRate).toBe(TARGET.sampleRate)
    expect(audio.channels).toBe(TARGET.channels)
    expect(audio.duration).toBeCloseTo(2, 1)
  })

  it.skipIf(!hasFfmpeg)('fails clearly on a file that is not audio', async () => {
    const source = path.join(tmp, 'not-audio.bin')
    fs.writeFileSync(source, Buffer.from('this is not audio at all'))
    await expect(toWav(source, path.join(tmp, 'nope.wav'))).rejects.toThrow(/ffmpeg/i)
  })

  it.skipIf(!hasFfmpeg)('leaves nothing at the output path when the conversion fails', async () => {
    const source = path.join(tmp, 'not-audio-2.bin')
    const out = path.join(tmp, 'nope-2.wav')
    fs.writeFileSync(source, Buffer.from('this is not audio at all'))

    await expect(toWav(source, out)).rejects.toThrow(/ffmpeg/i)

    expect(fs.existsSync(out)).toBe(false)
    expect(fs.existsSync(`${out}.partial`)).toBe(false)
  })

  it.skipIf(!hasFfmpeg)('re-encodes rather than trusting a truncated earlier run', async () => {
    const source = path.join(tmp, 'in-2.wav')
    const out = path.join(tmp, 'out-2.wav')
    fs.writeFileSync(source, synthClip({ seconds: 2, bpm: 120, key: 'A minor', sampleRate: 48000 }))
    // Simulate a crash mid-encode: a stale partial file left behind by an
    // interrupted earlier run, with nothing at the final path. Nothing should
    // short-circuit on this - it sits at the temp path, not the cached one.
    fs.writeFileSync(`${out}.partial`, Buffer.alloc(2044, 1))

    await toWav(source, out)

    expect(() => decodeWav(fs.readFileSync(out))).not.toThrow()
  })
})
