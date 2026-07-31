import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KEY_VOID_FALLBACK_CONFIDENCE, MIN_MATCH_CONFIDENCE, identityMatches, lookupTrack, parseArtistTitle, reconcileKey, scoreMatch } from './metadata.mjs'

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

const EMPTY_RESULT = { bpm: null, key: null, source: null, matchConfidence: 0, bpmMatchConfidence: 0, keyMatchConfidence: 0, keyConfidence: null }

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
// `key_strength` is Essentia's own correlation strength for the fitted key
// profile - a real field in AcousticBrainz's low-level schema, independent of
// `score` (MusicBrainz's recording-match text score, used above for
// `matchConfidence`). 0.72 is an arbitrary but plausible value chosen only to
// be clearly distinguishable from every `matchConfidence` figure in this file.
const AB_LOWLEVEL_GLUE = { rhythm: { bpm: 129.98 }, tonal: { key_key: 'D', key_scale: 'major', key_strength: 0.72 } }

// The pre-key_strength AcousticBrainz response shape (or an older cached
// lookup) - still a valid key report, just with no independent confidence
// signal of its own.
const AB_LOWLEVEL_GLUE_NO_STRENGTH = { rhythm: { bpm: 129.98 }, tonal: { key_key: 'D', key_scale: 'major' } }

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

  it('cannot cross MIN_MATCH_CONFIDENCE on title + duration alone with the wrong artist', () => {
    // The demonstrated false positive this closes: 0.5 (title) + 0.1
    // (duration) = 0.6, exactly the old threshold, with a completely
    // different artist. Duration must not be able to do this any more - see
    // `identityMatches`' own doc comment.
    const score = scoreMatch(
      { artist: 'A Totally Different Artist', title: 'Glue', duration: 269 },
      { artist: 'Bicep', title: 'Glue', duration: 270 },
    )
    expect(score).toBeLessThan(MIN_MATCH_CONFIDENCE)
  })
})

describe('identityMatches', () => {
  it('is true only when both artist and title match', () => {
    expect(identityMatches({ artist: 'Bicep', title: 'Glue' }, { artist: 'Bicep', title: 'Glue' })).toBe(true)
  })

  it('is false when only the artist matches', () => {
    expect(identityMatches({ artist: 'Bicep', title: 'A Different Song' }, { artist: 'Bicep', title: 'Glue' })).toBe(false)
  })

  it('is false when only the title matches', () => {
    expect(identityMatches({ artist: 'A Totally Different Artist', title: 'Glue' }, { artist: 'Bicep', title: 'Glue' })).toBe(false)
  })

  it('does not consider duration - identity is artist and title only', () => {
    expect(identityMatches({ artist: 'Bicep', title: 'Glue', duration: 1 }, { artist: 'Bicep', title: 'Glue', duration: 999 })).toBe(true)
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
    // The key EVIDENCE's own confidence (AcousticBrainz's key_strength),
    // carried separately from the recording-match confidence below -
    // reconcileKey must never see one mislabelled as the other.
    expect(result.keyConfidence).toBeCloseTo(0.72, 2)
    expect(result.keyMatchConfidence).toBeGreaterThan(0.72) // a much stronger MusicBrainz match than 0.72
    expect(result.keyConfidence).not.toBe(result.keyMatchConfidence)
  })

  it('reports no key confidence when AcousticBrainz predates key_strength, rather than inventing one', async () => {
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse(MB_SEARCH_GLUE)],
      ['acousticbrainz.org', jsonResponse(AB_LOWLEVEL_GLUE_NO_STRENGTH)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.key).toBe('D major')
    expect(result.keyConfidence).toBeNull()
  })

  it('treats an explicit key_strength: null the same as a missing field, not as a measured zero', async () => {
    // `Number(null)` is `0` - a real, finite number - so a naive cast would
    // silently turn "this API explicitly reported nothing" into "this
    // algorithm measured zero confidence," which is a different claim.
    const ab = { rhythm: { bpm: 129.98 }, tonal: { key_key: 'D', key_scale: 'major', key_strength: null } }
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse(MB_SEARCH_GLUE)],
      ['acousticbrainz.org', jsonResponse(ab)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.key).toBe('D major')
    expect(result.keyConfidence).toBeNull()
  })

  it('treats a non-numeric key_strength as absent rather than throwing or coercing it', async () => {
    const ab = { rhythm: { bpm: 129.98 }, tonal: { key_key: 'D', key_scale: 'major', key_strength: 'high' } }
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse(MB_SEARCH_GLUE)],
      ['acousticbrainz.org', jsonResponse(ab)],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.key).toBe('D major')
    expect(result.keyConfidence).toBeNull()
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

  it('rejects a Deezer hit with a completely wrong artist even when title and duration both match', async () => {
    // The demonstrated false positive: matching title (0.5) + duration
    // within 5s (0.1) = 0.6, exactly the old MIN_MATCH_CONFIDENCE, with a
    // wrong artist. A probe against the pre-fix code returned bpm 211 from
    // exactly this shape of candidate.
    const fetchImpl = makeFetch([
      [
        'deezer.com/search',
        jsonResponse({ data: [{ id: 42, title: 'Glue', duration: 269, artist: { name: 'A Totally Different Artist' } }] }),
      ],
      ['deezer.com/track/42', jsonResponse({ id: 42, title: 'Glue', duration: 269, bpm: 211, artist: { name: 'A Totally Different Artist' } })],
      ['musicbrainz.org', jsonResponse({ recordings: [] })],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 270 }, { fetchImpl })
    expect(result.bpm).toBeNull()
    expect(result.source).toBeNull()
  })

  it('rejects a MusicBrainz hit with a completely wrong title even at a maximal server relevance score', async () => {
    // The demonstrated false positive: correct artist + duration (0.4 + 0.1
    // = 0.5) averaged with a maximal server `score` (1.0) = 0.75,
    // comfortably over MIN_MATCH_CONFIDENCE, with a wrong title. A probe
    // against the pre-fix code returned bpm 999 / key C major from exactly
    // this shape of candidate.
    const wrongTitleSearch = {
      recordings: [
        {
          id: 'cccccccc-0000-0000-0000-000000000003',
          title: 'A Completely Different Song',
          score: 100,
          length: 269000,
          'artist-credit': [{ name: 'Bicep' }],
        },
      ],
    }
    const fetchImpl = makeFetch([
      ['deezer.com/search', jsonResponse({ data: [] })],
      ['musicbrainz.org', jsonResponse(wrongTitleSearch)],
      ['acousticbrainz.org', jsonResponse({ rhythm: { bpm: 999 }, tonal: { key_key: 'C', key_scale: 'major' } })],
    ])
    const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 269 }, { fetchImpl })
    expect(result.bpm).toBeNull()
    expect(result.key).toBeNull()
    expect(result.source).toBeNull()
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

    it('accepts an old cache file written before keyConfidence existed, rather than treating the missing field as corruption', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-oldcache-'))
      const oldShapeResult = { bpm: 130.01, key: 'G# major', source: 'deezer+acousticbrainz', matchConfidence: 0.95, bpmMatchConfidence: 0.9, keyMatchConfidence: 0.95 }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: oldShapeResult }),
      )
      const fetchImpl = vi.fn(() => {
        throw new Error('must not query the network - a valid cache hit should short-circuit before any fetch')
      })
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(result.key).toBe('G# major')
      expect(result.keyConfidence).toBeUndefined() // the old cache genuinely never recorded one

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a cache file with a non-numeric bpmMatchConfidence as corrupt, not as a hit', async () => {
      // A hand-edited or corrupted cache carrying a non-numeric
      // bpmMatchConfidence must not pass the shape guard: `reconcileTempo`'s
      // own gate on the same field would otherwise compare a string against
      // a number, silently evaluate to `false`, and treat the corrupted
      // cache as having cleared a confidence bar it was never actually
      // measured against.
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-badcache-'))
      const corruptResult = {
        bpm: 999,
        key: 'C major',
        source: 'deezer+acousticbrainz',
        matchConfidence: 0.95,
        bpmMatchConfidence: 'garbage',
        keyMatchConfidence: 0.95,
      }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: corruptResult }),
      )
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      // The corrupt cache must be bypassed - a fresh lookup runs instead, and
      // its real result (Glue's actual bpm, not the cache's poisoned 999)
      // comes back.
      expect(fetchImpl).toHaveBeenCalled()
      expect(result.bpm).toBe(130.01)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a cache file with a non-numeric keyMatchConfidence as corrupt, not as a hit', async () => {
      // The symmetric case to the bpmMatchConfidence test above -
      // `reconcileKey` gates on `keyMatchConfidence` the same way
      // `reconcileTempo` gates on `bpmMatchConfidence` (see `rebuild.mjs`),
      // and the two are checked by two separate clauses in the shape guard -
      // a corrupt `bpmMatchConfidence` alone does not exercise this one.
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-badcache-key-'))
      const corruptResult = {
        bpm: 999,
        key: 'C major',
        source: 'deezer+acousticbrainz',
        matchConfidence: 0.95,
        bpmMatchConfidence: 0.9,
        keyMatchConfidence: 'garbage',
      }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: corruptResult }),
      )
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()
      expect(result.bpm).toBe(130.01)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a cache file with an out-of-range bpmMatchConfidence as corrupt, not as a hit', async () => {
      // A real number that is still nonsense as a confidence (a hand edit,
      // or a bug elsewhere writing a raw score instead of a clamped one) -
      // `typeof === 'number'` alone would accept this; only a [0, 1] range
      // check catches it.
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-badcache-range-'))
      const corruptResult = {
        bpm: 999,
        key: 'C major',
        source: 'deezer+acousticbrainz',
        matchConfidence: 0.95,
        bpmMatchConfidence: 5,
        keyMatchConfidence: 0.95,
      }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: corruptResult }),
      )
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()
      expect(result.bpm).toBe(130.01)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a cache file with a non-normalized key string as corrupt, not as a hit', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-badcache-keyname-'))
      const corruptResult = {
        bpm: 130.01,
        key: 'not a key at all',
        source: 'deezer+acousticbrainz',
        matchConfidence: 0.95,
        bpmMatchConfidence: 0.9,
        keyMatchConfidence: 0.95,
      }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: corruptResult }),
      )
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()
      expect(result.bpm).toBe(130.01)

      await fs.rm(cacheDir, { recursive: true, force: true })
    })

    it('treats a cache file with a non-positive bpm as corrupt, not as a hit', async () => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltek-metadata-badcache-bpm-'))
      const corruptResult = {
        bpm: 0,
        key: 'C major',
        source: 'deezer+acousticbrainz',
        matchConfidence: 0.95,
        bpmMatchConfidence: 0.9,
        keyMatchConfidence: 0.95,
      }
      await fs.writeFile(
        path.join(cacheDir, 'metadata-lookup.json'),
        JSON.stringify({ query: { artist: 'Bicep', title: 'Glue', duration: 285 }, result: corruptResult }),
      )
      const fetchImpl = vi.fn(
        makeFetch([
          ['deezer.com/search', jsonResponse(DEEZER_SEARCH_GLUE)],
          ['deezer.com/track/389034231', jsonResponse(DEEZER_TRACK_GLUE)],
          ['musicbrainz.org', jsonResponse({ recordings: [] })],
        ]),
      )
      const result = await lookupTrack({ artist: 'Bicep', title: 'Glue', duration: 285 }, { fetchImpl, cacheDir })
      expect(fetchImpl).toHaveBeenCalled()
      expect(result.bpm).toBe(130.01)

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
  // --- no-network: pure local, nothing to reconcile against ----------------

  it('passes the detected key through unchanged when there is no known key (no-network / no match)', () => {
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

  it('treats a known key with a missing matchConfidence as untrusted, never as maximally trusted', () => {
    // `?? 1` used to mean "no confidence reported? assume a perfect match" -
    // a caller (or a future field-shape change) that omits matchConfidence
    // entirely must not silently clear MIN_MATCH_CONFIDENCE.
    const result = reconcileKey({ name: 'D major', confidence: 0.094 }, { name: 'C major' })
    expect(result.agreement).toBe('none')
    expect(result.name).toBe('D major')
  })

  it('treats a known key with an out-of-range but finite matchConfidence as untrusted, not as a perfect match', () => {
    // A finite value outside [0, 1] (e.g. a bug elsewhere passing a raw,
    // un-clamped score) must not clear MIN_MATCH_CONFIDENCE just because
    // `Number.isFinite` alone would accept it.
    const result = reconcileKey({ name: 'D major', confidence: 0.094 }, { name: 'C major', matchConfidence: 5 })
    expect(result.agreement).toBe('none')
    expect(result.name).toBe('D major')
  })

  it('treats a known key with a non-finite matchConfidence as untrusted, not as clearing the gate by comparing false', () => {
    const result = reconcileKey({ name: 'D major', confidence: 0.094 }, { name: 'C major', matchConfidence: NaN })
    expect(result.agreement).toBe('none')
    expect(result.name).toBe('D major')
  })

  it('branch order: a weak match is rejected BEFORE the void-fill check runs, even with no local key at all', () => {
    // A local void (`detected` has no name) must not bypass the match-
    // confidence gate - "nothing to compare against" is not a reason to
    // trust a source that failed to prove it found the right recording in
    // the first place. This pins the branch order: match-confidence gating
    // happens first, void-fill only after a known key clears it.
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'C major', matchConfidence: 0.2, keyConfidence: 0.9 })
    expect(result.agreement).toBe('none')
    expect(result.name).toBeNull()
  })

  // --- external-agrees: corroboration raises confidence ---------------------

  it('external-agrees: raises confidence on an exact match, regardless of how unsure the detector was', () => {
    const result = reconcileKey({ name: 'F minor', confidence: 0.08 }, { name: 'F minor', matchConfidence: 0.9 })
    expect(result.agreement).toBe('agree')
    expect(result.name).toBe('F minor')
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('external-agrees: enharmonic/relative-mode-aware via keysMatch (relative minor, not a literal string match)', () => {
    // A minor is the relative minor of C major - keysMatch (dsp.mjs) already
    // treats this pair as indistinguishable from audio alone, and this
    // reconciliation must inherit that, not require an exact string match.
    const result = reconcileKey({ name: 'A minor', confidence: 0.3 }, { name: 'C major', matchConfidence: 0.9 })
    expect(result.agreement).toBe('agree')
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  // --- external-fills-void: no local key evidence at all ---------------------

  it('external-fills-void: uses the known key at its OWN evidence confidence when the source reports one', () => {
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'D major', matchConfidence: 0.9, keyConfidence: 0.72 })
    expect(result.agreement).toBe('known')
    expect(result.name).toBe('D major')
    // 0.72 (the source's own key-evidence confidence), not something derived
    // from 0.9 (the recording-match confidence) - the exact distinction the
    // bug below erased.
    expect(result.confidence).toBeCloseTo(0.72, 5)
  })

  it('external-fills-void: falls back to the documented flat confidence when the source reports no key-evidence confidence of its own', () => {
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'D major', matchConfidence: 0.9 })
    expect(result.agreement).toBe('known')
    expect(result.name).toBe('D major')
    expect(result.confidence).toBe(KEY_VOID_FALLBACK_CONFIDENCE)
    // In particular, NOT 0.5 + 0.5 * matchConfidence (0.95) - the old,
    // laundered formula this module used to compute here.
    expect(result.confidence).not.toBeCloseTo(0.95, 2)
  })

  it('external-fills-void: a non-finite keyConfidence (e.g. a malformed cache entry) falls back to the documented default instead of propagating NaN', () => {
    // `typeof NaN === 'number'` - a `typeof` check alone would let this
    // through, and `clamp01` cannot repair it (`Math.max`/`Math.min` both
    // propagate NaN). `JSON.stringify` silently turns a NaN confidence into
    // `null` wherever this result gets written, with no error anywhere.
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'D major', matchConfidence: 0.9, keyConfidence: NaN })
    expect(result.agreement).toBe('known')
    expect(result.confidence).toBe(KEY_VOID_FALLBACK_CONFIDENCE)
    expect(Number.isFinite(result.confidence)).toBe(true)
  })

  // --- external-disagrees: surfaced and nulled, never silently adopted -------

  it('external-disagrees: a confident detector disagreeing with a known key nulls the name rather than guessing', () => {
    const result = reconcileKey({ name: 'D major', confidence: 0.9 }, { name: 'Ab major', matchConfidence: 0.9, source: 'acousticbrainz' })
    expect(result.agreement).toBe('disagreement')
    expect(result.name).toBeNull()
    expect(result.confidence).toBe(0)
    expect(result.detected).toBe('D major')
    expect(result.known).toBe('Ab major')
  })

  it('external-disagrees: the exact regression this fix closes - a LOW-confidence local key must still be surfaced as a disagreement, not silently overridden', () => {
    // The real, disclosed bug: Bicep's "Glue" detected E minor from its own
    // transcribed notes at confidence 0.098 - not just unconfident but below
    // what the old code treated as its "unsure" gate (0.2) - and the old
    // reconcileKey used that low confidence as license to silently adopt
    // AcousticBrainz's "G# major" instead, at a confidence (0.975) computed
    // from the recording-match confidence (0.95), not from any evidence about
    // the key itself. E minor and G# major are not relative, parallel or
    // fifth-neighbour keys (keysMatch returns false for this pair) - a
    // genuine disagreement, not a close call. Neither key "wins" here -
    // the fixed behaviour is that the name is nulled (agreement:
    // 'disagreement'), not that E minor is emitted instead of G# major.
    const result = reconcileKey({ name: 'E minor', confidence: 0.098 }, { name: 'G# major', matchConfidence: 0.95, keyConfidence: 0.72 })
    expect(result.agreement).toBe('disagreement')
    expect(result.name).toBeNull()
    // Both original values are carried on the return object so a caller can
    // log/display the disagreement without re-deriving it - not this
    // module's mechanism for preserving them "for the record" (that's
    // rebuild.mjs's own independent `result.metadata.lookup`/`result.noteKey`,
    // unaffected by what this function returns; see reconcileKey's own doc
    // comment).
    expect(result.detected).toBe('E minor')
    expect(result.known).toBe('G# major')
  })

  it('handles a null detected key without throwing', () => {
    const result = reconcileKey({ name: null, confidence: 0 }, { name: 'D major', matchConfidence: 0.9 })
    expect(result.agreement).toBe('known')
    expect(result.name).toBe('D major')
  })
})
