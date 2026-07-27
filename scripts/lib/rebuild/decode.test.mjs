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

  it.skipIf(!hasFfmpeg)('produces a WAV the analysis can actually read', async () => {
    const source = path.join(tmp, 'good.wav')
    const out = path.join(tmp, 'recover.wav')
    fs.writeFileSync(source, synthClip({ seconds: 1, bpm: 120, key: 'A minor' }))
    await toWav(source, out)
    expect(() => decodeWav(fs.readFileSync(out))).not.toThrow()
    expect(fs.existsSync(`${out}.partial`)).toBe(false)
  })

  /**
   * This is the test that actually discriminates the fix from the bug.
   *
   * An earlier pair of tests here asserted true things that passed equally
   * against the broken implementation, which makes them decoration rather than
   * coverage. The property worth protecting is that the conversion goes through
   * a temp path, and the way to prove it is to sabotage that path.
   *
   * Blocking `<out>.partial` with a directory makes ffmpeg's write fail, so a
   * correct implementation rejects and leaves the final path empty. An
   * implementation that wrote straight to the final path would sail past the
   * obstruction and succeed, failing this test.
   */
  it.skipIf(!hasFfmpeg)('writes through a temp path, not straight to the output', async () => {
    const source = path.join(tmp, 'temp-path.wav')
    const out = path.join(tmp, 'blocked.wav')
    fs.writeFileSync(source, synthClip({ seconds: 1, bpm: 120, key: 'A minor' }))
    fs.mkdirSync(`${out}.partial`, { recursive: true })

    await expect(toWav(source, out)).rejects.toThrow()
    expect(fs.existsSync(out)).toBe(false)

    fs.rmSync(`${out}.partial`, { recursive: true, force: true })
  })
})
