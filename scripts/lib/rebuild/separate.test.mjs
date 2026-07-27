import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { STEMS, demucsArgs, separate, stemPaths } from './separate.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-sep-'))

describe('STEMS', () => {
  it('does not include vocals, which are dropped on arrival', () => {
    expect(STEMS).toEqual(['drums', 'bass', 'other'])
    expect(STEMS).not.toContain('vocals')
  })
})

describe('demucsArgs', () => {
  it('writes WAV into the requested directory', () => {
    const args = demucsArgs('/in.wav', '/out')
    expect(args).toContain('-o')
    expect(args[args.indexOf('-o') + 1]).toBe('/out')
    // -o and --out are aliases; passing both is an error.
    expect(args).not.toContain('--out')
    // demucs has no explicit "wav" token: WAV is the default output unless
    // --mp3 or --flac is passed, so keeping WAV means omitting both.
    expect(args).not.toContain('--mp3')
    expect(args).not.toContain('--flac')
    expect(args[args.length - 1]).toBe('/in.wav')
  })
})

describe('stemPaths', () => {
  it('names one file per kept stem', () => {
    const paths = stemPaths('/stems')
    expect(paths.drums).toBe(path.join('/stems', 'drums.wav'))
    expect(paths.bass).toBe(path.join('/stems', 'bass.wav'))
    expect(paths.other).toBe(path.join('/stems', 'other.wav'))
    expect(paths.vocals).toBeUndefined()
  })
})

describe('separate', () => {
  it('returns the cached stems without running demucs when they already exist', async () => {
    const stemsDir = path.join(tmp, 'cached')
    fs.mkdirSync(stemsDir, { recursive: true })
    for (const stem of STEMS) {
      // Non-trivial size, so the cache check does not treat them as empty.
      fs.writeFileSync(path.join(stemsDir, `${stem}.wav`), Buffer.alloc(2048, 1))
    }

    const result = await separate(path.join(tmp, 'does-not-exist.wav'), stemsDir)
    expect(result.cached).toBe(true)
    expect(result.drums).toBe(path.join(stemsDir, 'drums.wav'))
  })

  it('does not treat a partial cache as complete', async () => {
    const stemsDir = path.join(tmp, 'partial')
    fs.mkdirSync(stemsDir, { recursive: true })
    fs.writeFileSync(path.join(stemsDir, 'drums.wav'), Buffer.alloc(2048, 1))

    // Missing bass and other, and the input does not exist, so this must fail
    // rather than silently report a cache hit.
    await expect(separate(path.join(tmp, 'does-not-exist.wav'), stemsDir)).rejects.toThrow()
  })
})
