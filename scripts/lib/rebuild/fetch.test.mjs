import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOURCES, UnsupportedSourceError, classify, parseYtdlpPrintLine, resolveSource } from './fetch.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-fetch-'))

describe('classify', () => {
  it('routes a local path to the local handler', () => {
    expect(classify('/some/where/track.wav').name).toBe('local')
    expect(classify('./relative.mp3').name).toBe('local')
  })

  it('routes YouTube and SoundCloud to the ripper', () => {
    expect(classify('https://www.youtube.com/watch?v=abc').name).toBe('ytdlp')
    expect(classify('https://youtu.be/abc').name).toBe('ytdlp')
    expect(classify('https://soundcloud.com/artist/track').name).toBe('ytdlp')
    expect(classify('https://artist.bandcamp.com/track/name').name).toBe('ytdlp')
  })

  it('routes a direct audio URL to plain HTTP', () => {
    expect(classify('https://example.com/track.mp3').name).toBe('http')
  })

  it('recognises Spotify so it can be refused specifically', () => {
    expect(classify('https://open.spotify.com/track/abc').name).toBe('spotify')
  })
})

describe('SOURCES', () => {
  it('is an ordered registry, so narrowing support is deleting entries', () => {
    expect(Array.isArray(SOURCES)).toBe(true)
    for (const source of SOURCES) {
      expect(typeof source.match).toBe('function')
      expect(typeof source.handler).toBe('function')
    }
  })

  it('puts spotify before the generic http handler, or it would never match', () => {
    const names = SOURCES.map((s) => s.name)
    expect(names.indexOf('spotify')).toBeLessThan(names.indexOf('http'))
  })
})

describe('resolveSource', () => {
  it('returns a local file as-is', async () => {
    const file = path.join(tmp, 'local.wav')
    fs.writeFileSync(file, Buffer.from('not really audio, but a real file'))
    const result = await resolveSource(file, tmp)
    expect(result.path).toBe(file)
    expect(result.source).toBe('local')
  })

  it('fails clearly on a local file that does not exist', async () => {
    await expect(resolveSource(path.join(tmp, 'missing.wav'), tmp)).rejects.toThrow(/not found/i)
  })

  it('refuses Spotify by name, explaining why rather than failing generically', async () => {
    await expect(resolveSource('https://open.spotify.com/track/abc', tmp)).rejects.toThrow(UnsupportedSourceError)
    await expect(resolveSource('https://open.spotify.com/track/abc', tmp)).rejects.toThrow(/cannot supply audio/i)
  })
})

describe('parseYtdlpPrintLine', () => {
  const SEP = '\x1f'
  const line = (...fields) => fields.join(SEP)

  it('parses a real print line, measured live against the target track', () => {
    // Exact live measurement: yt-dlp --simulate --print against
    // https://www.youtube.com/watch?v=A7ZxRs45tTg.
    const result = parseYtdlpPrintLine(line('/tmp/x/source.opus', 'BICEP | GLUE (Official Video)', 'BICEP', '285'))
    expect(result).toEqual({ path: '/tmp/x/source.opus', title: 'BICEP | GLUE (Official Video)', artist: 'BICEP', duration: 285 })
  })

  it('turns a missing field (yt-dlp prints the literal NA) into null, not the string "NA"', () => {
    const result = parseYtdlpPrintLine(line('/tmp/x/source.opus', 'NA', 'NA', 'NA'))
    expect(result.title).toBeNull()
    expect(result.artist).toBeNull()
    expect(result.duration).toBeNull()
  })

  it('tolerates a trailing newline, matching how execFile stdout is split', () => {
    const result = parseYtdlpPrintLine(`${line('/tmp/x/source.opus', 'Title', 'Artist', '200')}\n`)
    expect(result.duration).toBe(200)
  })

  it('falls back to null on a non-numeric duration rather than propagating NaN', () => {
    const result = parseYtdlpPrintLine(line('/tmp/x/source.opus', 'Title', 'Artist', 'garbage'))
    expect(result.duration).toBeNull()
  })

  it('treats a genuinely empty duration field as unknown, not as zero seconds', () => {
    // Number('') is 0, not NaN - without an explicit truthy guard this would
    // silently report a zero-second duration instead of "unknown".
    const result = parseYtdlpPrintLine(line('/tmp/x/source.opus', 'Title', 'Artist', ''))
    expect(result.duration).toBeNull()
  })
})
