import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MIN_MATCH_CONFIDENCE, lookupTrack, parseArtistTitle, reconcileKey, scoreMatch } from './metadata.mjs'

// --- fetch mocking -----------------------------------------------------------

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

/**
 * A fetch stand-in keyed by URL substring, so a test only has to describe the
 * endpoints it cares about. Anything unmatched 404s, which - via `fetchJson`
 * inside metadata.mjs - is indistinguishable from "no route configured" and
 * from a real unknown-endpoint 404, which is exactly the point: this module
 * must not need to tell those apart.
 */
function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    for (const [substring, respond] of routes) {
      if (url.includes(substring)) {
        if (typeof respond === 'function') return respond(url)
        return respond
      }
    }
    return jsonResponse(null, 404)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const reject = (error) => () => Promise.reject(error)

const EMPTY_RESULT = { bpm: null, key: null, source: null, matchConfidence: 0, bpmMatchConfidence: 0, keyMatchConfidence: 0 }

// Real payload shapes, captured live against the target track (Bicep -
// "Glue") on 2026-07-28. Deezer was reachable end to end; MusicBrainz was not
// (see metadata.mjs's doc comment and the coverage report) - the MusicBrainz
// and AcousticBrainz fixtures below follow their long-stable, documented
// response schemas rather than a live capture of this exact track.
const DEEZER_SEARCH_GLUE = {
  data: [
    { id: 389034231, title: 'Glue', duration: 269, artist: { name: 'Bicep' } },
    { id: 795642332, title: 'Glue (Mixed)', duration: 240, artist: { name: 'Bicep' } },
  ],
}
const DEEZER_TRACK_GLUE = { id: 389034231, title: 'Glue', duration: 269, bpm: 130.01, artist: { name: 'Bicep' } }

// Measured live: Deezer's own bpm field, unpopulated for a real, well-known track.
const DEEZER_SEARCH_OMT = { data: [{ id: 3135553, title: 'One More Time', duration: 320, artist: { name: 'Daft Punk' } }] }
const DEEZER_TRACK_OMT = { id: 3135553, title: 'One More Time', duration: 320, bpm: 0, artist: { name: 'Daft Punk' } }

const MB_SEARCH_GLUE = {
  recordings: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Glue', score: 100, length: 269000, 'artist-credit': [{ name: 'Bicep' }] },
  ],
}
const AB_LOWLEVEL_GLUE = { rhythm: { bpm: 129.98 }, tonal: { key_key: 'D', key_scale: 'major' } }

describe('parseArtistTitle', () => {
  it('splits on a pipe, measured live against the target track', () => {
    // yt-dlp --simulate --print against https://www.youtube.com/watch?v=A7ZxRs45tTg
    expect(parseArtistTitle({ title: 'BICEP | GLUE (Official Video)', artist: 'BICEP' })).toEqual({ artist: 'BICEP', title: 'GLUE' })
  })

  it('splits on a plain dash', () => {
    expect(parseArtistTitle({ title: 'Daft Punk - One More Time (Official Audio)' })).toEqual({
      artist: 'Daft Punk',
      title: 'One More Time',
    })
  })

  it('splits on en and em dashes', () => {
    expect(parseArtistTitle({ title: 'Justice – D.A.N.C.E' })).toEqual({ artist: 'Justice', title: 'D.A.N.C.E' })
    expect(parseArtistTitle({ title: 'Justice — D.A.N.C.E' })).toEqual({ artist: 'Justice', title: 'D.A.N.C.E' })
  })

  it('falls back to the (cleaned) uploader when the title has no separator', () => {
    expect(parseArtistTitle({ title: 'Glue (Official Video)', artist: 'Bicep - Topic' })).toEqual({ artist: 'Bicep', title: 'Glue' })
  })

  it('returns a null artist when there is neither a separator nor an uploader', () => {
    expect(parseArtistTitle({ title: 'Glue (Official Video)' })).toEqual({ artist: null, title: 'Glue' })
  })

  it('strips cosmetic upload tags but leaves musically meaningful ones alone', () => {
    // "Live" and "Remix" can describe a genuinely different recording with
    // its own tempo; stripping them risks matching a live version's title
    // to a studio release's database entry and inheriting the wrong tempo.
    expect(parseArtistTitle({ title: 'Artist - Song (Live at Glastonbury)' })).toEqual({
      artist: 'Artist',
      title: 'Song (Live at Glastonbury)',
    })
    expect(parseArtistTitle({ title: 'Artist - Song (Radio Edit)' })).toEqual({ artist: 'Artist', title: 'Song (Radio Edit)' })
  })

  it('strips multiple cosmetic tags and lyric/visualizer variants', () => {
    expect(parseArtistTitle({ title: 'Artist - Song [Official Music Video] (4K)' })).toEqual({ artist: 'Artist', title: 'Song' })
    expect(parseArtistTitle({ title: 'Artist - Song (Lyric Video)' })).toEqual({ artist: 'Artist', title: 'Song' })
  })

  it('handles missing or explicitly null input without throwing', () => {
    expect(parseArtistTitle({})).toEqual({ artist: null, title: null })
    expect(parseArtistTitle()).toEqual({ artist: null, title: null })
    // Distinct from the undefined case above: a default parameter does not
    // apply to an explicit null, only to a genuinely missing argument.
    expect(parseArtistTitle(null)).toEqual({ artist: null, title: null })
  })
})

describe('scoreMatch', () => {
  it('scores an exact artist + title + close duration at 1', () => {
    expect(scoreMatch({ artist: 'Bicep', title: 'Glue', duration: 269 }, { artist: 'BICEP', title: 'GLUE', duration: 270 })).toBe(1)
  })

  it('cannot cross MIN_MATCH_CONFIDENCE on artist alone', () => {
    expect(scoreMatch({ artist: 'Bicep', title: 'Isles' }, { artist: 'Bicep', title: 'Glue' })).toBeLessThan(MIN_MATCH_CONFIDENCE)
  })

  it('cannot cross MIN_MATCH_CONFIDENCE on title alone', () => {
    expect(scoreMatch({ artist: 'Some Other Artist', title: 'Glue' }, { artist: 'Bicep', title: 'Glue' })).toBeLessThan(MIN_MATCH_CONFIDENCE)
  })

  it('clears MIN_MATCH_CONFIDENCE on artist + title even with no duration', () => {
    expect(scoreMatch({ artist: 'Bicep', title: 'Glue' }, { artist: 'Bicep', title: 'Glue' })).toBeGreaterThanOrEqual(MIN_MATCH_CONFIDENCE)
  })

  it('matches a candidate title that carries an extra suffix ("Glue (Mixed)" vs "Glue")', () => {
    expect(scoreMatch({ artist: 'Bicep', title: 'Glue (Mixed)' }, { artist: 'Bicep', title: 'Glue' })).toBeGreaterThanOrEqual(MIN_MATCH_CONFIDENCE)
  })
})

describe('lookupTrack', () => {
  it('returns nulls without making any network call when artist or title is missing', async () => {
    const fetchImpl = makeFetch([])
    expect(await lookupTrack({ title: 'Glue' }, { fetchImpl })).toEqual(EMPTY_RESULT)
    expect(await lookupTrack({}, { fetchImpl })).toEqual(EMPTY_RESULT)
    // An explicit null bypasses the `query = {}` default parameter entirely
    // (that only covers a genuinely missing argument), so this exercises a
    // distinct code path, not the same one as `{}` above.
    expect(await lookupTrack(null, { fetchImpl })).toEqual(EMPTY_RESULT)
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('resolves tempo from Deezer end to end (the real Bicep "Glue" case)', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
      ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
      ['musicbrainz.org', jsonResponse({ recordings: [] })],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl })
    expect(result.bpm).toBe(130.01)
    expect(result.source).toBe('deezer')
    expect(result.matchConfidence).toBeGreaterThanOrEqual(MIN_MATCH_CONFIDENCE)
    expect(result.key).toBeNull()
  })

  it('treats a real Deezer bpm of 0 as absent, not as a genuine zero-tempo track', async () => {
    // Measured live: Daft Punk's "One More Time" has a matched search result
    // but an unpopulated bpm field.
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse(DEEZER_SEARCH_OMT)],
      ['deezer.com/track/3135553', jsonResponse(DEEZER_TRACK_OMT)],
      ['musicbrainz.org', jsonResponse({ recordings: [] })],
    ])
    const result = await lookupTrack({ artist: 'Daft Punk', title: 'One More Time', duration: 320 }, { fetchImpl })
    expect(result.bpm).toBeNull()
    expect(result.source).toBeNull()
  })

  it('resolves both tempo and key through the MusicBrainz -> AcousticBrainz chain', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse(MB_SEARCH_GLUE)],
      ['acousticbrainz.org', jsonResponse(AB_LOWLEVEL_GLUE)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.bpm).toBeCloseTo(129.98, 2)
    expect(result.key).toBe('D major')
    expect(result.source).toBe('acousticbrainz')
  })

  it('prefers Deezer for tempo but still takes the key from AcousticBrainz when both resolve', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
      ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
      ['musicbrainz.org', jsonResponse(MB_SEARCH_GLUE)],
      ['acousticbrainz.org', jsonResponse(AB_LOWLEVEL_GLUE)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.bpm).toBe(130.01) // Deezer's, not AcousticBrainz's 129.98
    expect(result.key).toBe('D major')
    expect(result.source).toBe('deezer+acousticbrainz')
  })

  it('tracks tempo and key confidence separately - a strong match on one field cannot lend its confidence to a weak match on the other', async () => {
    // Deezer's match here is a perfect artist+title+duration hit (confidence
    // 1). MusicBrainz's is deliberately weaker: a textual score of 61 (its
    // own `score` field, out of 100) and no duration given, landing at
    // (0.61 + 0.9) / 2 = 0.755 - still over MIN_MATCH_CONFIDENCE, but clearly
    // below Deezer's. Before this fix, `matchConfidence` was a single
    // `Math.max` across both, so the key (from the WEAKER match) would have
    // been reported exactly as trustworthy as the tempo (from the STRONGER,
    // unrelated one).
    const weakerMbSearch = {
      recordings: [
        { id: 'bbbbbbbb-0000-0000-0000-000000000002', title: 'Glue', score: 61, 'artist-credit': [{ name: 'Bicep' }] },
      ],
    }
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
      ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
      ['musicbrainz.org', jsonResponse(weakerMbSearch)],
      ['acousticbrainz.org', jsonResponse(AB_LOWLEVEL_GLUE)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.bpmMatchConfidence).toBe(1)
    expect(result.keyMatchConfidence).toBeCloseTo(0.755, 3)
    expect(result.keyMatchConfidence).toBeLessThan(result.bpmMatchConfidence)
    // The summary field stays useful (the better of the two), but callers
    // that reconcile a specific field (grid.mjs, reconcileKey) must use the
    // per-field values above, not this one.
    expect(result.matchConfidence).toBe(1)
  })

  it('degrades to no match when nothing found it (a genuinely obscure track)', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse({ recordings: [] })],
    ])
    const result = await lookupTrack({ artist: 'Unknown Artist', title: 'Unknown Song' }, { fetchImpl })
    expect(result).toEqual(EMPTY_RESULT)
  })

  it('never throws when MusicBrainz is unreachable at the TLS layer (measured live from this sandbox)', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', reject(new TypeError('fetch failed'))],
    ])
    await expect(lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })).resolves.toEqual(EMPTY_RESULT)
  })

  it('never throws on a timeout (AbortSignal firing), a 404, or a rate-limit response', async () => {
    for (const failure of [reject(new DOMException('The operation was aborted.', 'AbortError')), jsonResponse(null, 404), jsonResponse(null, 429)]) {
      const fetchImpl = makeFetch([
        ['deezer.com', failure],
        ['musicbrainz.org', failure],
      ])
      await expect(lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })).resolves.toEqual(EMPTY_RESULT)
    }
  })

  it('never throws even if a source callback itself throws synchronously (a bug elsewhere in this file)', async () => {
    const fetchImpl = () => {
      throw new Error('boom')
    }
    await expect(lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })).resolves.toEqual(EMPTY_RESULT)
  })

  it('rejects a low-confidence search hit rather than trusting the wrong song', async () => {
    // Artist matches, title does not - scoreMatch computes 0.4, under 0.6.
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [{ id: 1, title: 'Isles (a different album)', duration: 200, artist: { name: 'Bicep' } }] })],
      ['deezer.com/track/1', jsonResponse({ bpm: 999, title: 'Isles' })],
      ['musicbrainz.org', jsonResponse({ recordings: [] })],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })
    expect(result.bpm).toBeNull()
  })

  it('sends a descriptive User-Agent to MusicBrainz', async () => {
    let sentHeaders = null
    const fetchImpl = async (url, init) => {
      if (url.includes('musicbrainz.org')) sentHeaders = init?.headers
      return jsonResponse(url.includes('deezer') ? { data: [] } : { recordings: [] })
    }
    await lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })
    expect(sentHeaders['User-Agent']).toMatch(/moltek/i)
    expect(sentHeaders['User-Agent']).not.toBe('')
  })

  describe('caching', () => {
    it('writes a cache file and does not re-query on a second call with the same cacheDir', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-'))
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const first = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()
      const callsAfterFirst = fetchImpl.mock.calls.length

      const second = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst) // no new calls
      expect(second).toEqual(first)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('does not cache across different run directories', async () => {
      const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-a-'))
      const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-b-'))
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir: dirA })
      const callsAfterFirst = fetchImpl.mock.calls.length
      await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir: dirB })
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)

      await fs.rm(dirA, { recursive: true, force: true })
      await fs.rm(dirB, { recursive: true, force: true })
    })

    it('skips caching gracefully when no cacheDir is given', async () => {
      const fetchImpl = makeFetch([
        ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
        ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
        ['musicbrainz.org', jsonResponse({ recordings: [] })],
      ])
      await expect(lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl })).resolves.toMatchObject({ bpm: 130.01 })
    })

    it('treats a malformed or hand-edited cache file as a miss rather than trusting it', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-bad-'))
      await fs.writeFile(path.join(cacheDir, 'metadata-lookup.json'), JSON.stringify({ result: { bpm: 'not-a-number', key: 42 } }))
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled() // re-queried rather than trusting the malformed cache
      expect(result.bpm).toBe(130.01)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a syntactically valid but non-JSON-object cache file as a miss', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-bad2-'))
      await fs.writeFile(path.join(cacheDir, 'metadata-lookup.json'), JSON.stringify({ result: 'garbage' }))
      const fetchImpl = vi.fn(makeFetch([['deezer.com/search', jsonResponse({ data: [] })], ['musicbrainz.org', jsonResponse({ recordings: [] })]]))
      await lookupTrack({ artist: 'Bicep', title: 'Glue' }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()

      await fs.rm(cacheDir, { recursive: true, force: true })
    })
  })
})

describe('reconcileKey', () => {
  it('passes the detected key through unchanged when there is no known key', () => {
    // The exact real, disclosed case this exists to guard against: Bicep's
    // "Glue" reports D major at confidence 0.094, and with no known key
    // available to cross-check against, this module does not invent a floor
    // that would also reject moltek's OWN correct "the-chase" key detection
    // (F minor at confidence 0.085 - lower than Glue's wrong answer).
    expect(reconcileKey({ name: 'D major', confidence: 0.094 }, null)).toEqual({ name: 'D major', confidence: 0.094, agreement: 'none' })
  })

  it('treats a known key below MIN_MATCH_CONFIDENCE as no known key at all', () => {
    const result = reconcileKey({ name: 'D major', confidence: 0.094 }, { name: 'C major', matchConfidence: 0.2 })
    expect(result.agreement).toBe('none')
    expect(result.name).toBe('D major')
  })

  it('case 1: agrees (via keysMatch) and raises confidence', () => {
    const result = reconcileKey({ name: 'F minor', confidence: 0.08 }, { name: 'F minor', matchConfidence: 0.9 })
    expect(result.agreement).toBe('agree')
    expect(result.name).toBe('F minor')
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('case 2: trusts the known key outright when the detector is unsure (the real Glue case)', () => {
    const result = reconcileKey({ name: 'D major', confidence: 0.094 }, { name: 'Ab major', matchConfidence: 0.9, source: 'acousticbrainz' })
    expect(result.agreement).toBe('known')
    expect(result.name).toBe('Ab major')
    expect(result.confidence).toBeGreaterThan(0.094)
  })

  it('case 3: a confident detector disagreeing with a known key nulls the name rather than guessing', () => {
    const result = reconcileKey({ name: 'D major', confidence: 0.9 }, { name: 'Ab major', matchConfidence: 0.9, source: 'acousticbrainz' })
    expect(result.agreement).toBe('disagreement')
    expect(result.name).toBeNull()
    expect(result.detected).toBe('D major')
    expect(result.known).toBe('Ab major')
  })

  it('handles a null detected key without throwing', () => {
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'D major', matchConfidence: 0.9 })
    expect(result.agreement).toBe('known')
    expect(result.name).toBe('D major')
  })
})
