/**
 * What public databases already know about a released record, used as a
 * prior and a cross-check against what the audio-only detectors in grid.mjs
 * and profile.mjs find - never as a silent replacement for them.
 *
 * Why this exists: tempo and key are the two hardest inferences in the whole
 * rebuild pipeline, and both have failed on real records. The tempo detector
 * originally picked 104 BPM for Bicep's "Glue" (true tempo 130); the key
 * detector reported "D major" at confidence 0.094 - barely better than a
 * coin flip - and nothing downstream noticed, because nothing checked. For a
 * released track, tempo and key are usually documented facts, not things
 * that must be guessed from a waveform. This module fetches them.
 *
 * Sources probed live before writing any of this:
 *
 *   - Deezer's public search/track API: keyless, no auth, WORKS. Its `bpm`
 *     field is a real, populated, usably accurate number for some tracks
 *     (Bicep "Glue" measured live at 130.01, matching the corrected
 *     detector's 130 exactly) and a bare 0 for others (Daft Punk's "One More
 *     Time", measured live) - so it is used, but its absence of a value is
 *     always possible and always handled. It never returns a musical key.
 *   - MusicBrainz's recording search: the documented way to resolve a
 *     (artist, title) pair to a stable MBID, which AcousticBrainz needs.
 *     Requires a descriptive User-Agent and at most one request per second -
 *     honoured below (in practice, at most one MusicBrainz request happens
 *     per `lookupTrack` call, so there is nothing to throttle between).
 *     Measured live from this project's own sandbox: completely unreachable
 *     (TLS resets on every request after one lucky initial success, and the
 *     same block reproduces against listenbrainz.org and coverartarchive.org
 *     - sibling MetaBrainz services - while unrelated hosts work fine), which
 *     looks like this sandbox's shared egress IP being on a MetaBrainz
 *     abuse-prevention blocklist, not an API change. This is exactly the
 *     failure shape the resilience requirement below exists for, and is
 *     treated identically to a timeout or a 404: the lookup returns null and
 *     the pipeline proceeds as it does today.
 *   - AcousticBrainz's low-level lookup by MBID: keyless, reachable
 *     (confirmed live - a bogus MBID gets a clean 404 JSON body, not a
 *     connection failure), and the only keyless source that reports a
 *     musical key at all. The project stopped collecting data in 2022, so
 *     coverage on anything released after that is expected to be sparse -
 *     this could not be measured end-to-end in this sandbox because it needs
 *     an MBID from MusicBrainz first, which was unreachable throughout.
 *   - GetSongBPM: reachable, but needs an API key this project does not have
 *     (confirmed live: HTTP 403 without one) and requires attribution.
 *     Deezer alone already resolved the flagship failing case (Glue), so per
 *     the brief this is not wired in. Not implemented, not a stub.
 *   - Spotify's audio-features endpoint and Tunebat-style scraping are both
 *     explicitly out of scope - the former closed to new applications in
 *     late 2024, the latter offers no API and scraping it is off-limits.
 *
 * Every network call in this file goes through `fetchJson`, which turns a
 * non-2xx status into the same `{ ok: false }` shape a caller already has to
 * handle for "no match". A timeout, a connection reset, or a malformed body
 * are real exceptions and are left to propagate out of `fetchJson` - `
 * lookupTrack` catches those per source (see its own doc comment for why the
 * catch belongs there and not inside `fetchJson`), so "the network is
 * unreachable" and "the track is not in this database" still degrade the
 * same way in the end, and a lookup failure can never halt a run.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { keysMatch, normalizeKeyName } from '../dsp.mjs'

const clamp01 = (value) => Math.max(0, Math.min(1, value))

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_USER_AGENT = 'moltek/0.1.0 ( https://github.com/wayzeek/moltek )'
const CACHE_FILENAME = 'metadata-lookup.json'

/**
 * How confident a search hit must be that it is the right recording before
 * its tempo/key are trusted at all.
 *
 * Below this, a lookup is treated as no match - the wrong song's tempo is
 * worse than no tempo, because downstream reconciliation (see grid.mjs's
 * `reconcileTempo` and this file's `reconcileKey`) treats a known value as
 * something to trust, not merely a hint. 0.6 requires both the artist AND
 * the title to have matched (0.4 + 0.5 in `scoreMatch` below); an artist-only
 * or title-only hit (a different song by the same artist, or a cover of the
 * same title by someone else) cannot cross it alone.
 */
export const MIN_MATCH_CONFIDENCE = 0.6

// --- string matching -------------------------------------------------------

function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The three raw signals `scoreMatch`/`identityMatches` below are both built
 * from, kept in one place so the two functions can never quietly disagree
 * about what "the artist matches" means.
 *
 * Substring matching only runs one direction for titles (candidate contains
 * query) because search results routinely carry a suffix moltek's query does
 * not ("Glue" vs "Glue (Mixed)"); the reverse would let a short, generic
 * query title match nearly anything.
 */
function matchSignals(candidate, query) {
  const cArtist = normalizeForMatch(candidate.artist)
  const qArtist = normalizeForMatch(query.artist)
  const cTitle = normalizeForMatch(candidate.title)
  const qTitle = normalizeForMatch(query.title)

  return {
    artistMatches:
      qArtist.length >= 2 && cArtist.length > 0 && (cArtist === qArtist || cArtist.includes(qArtist) || qArtist.includes(cArtist)),
    titleMatches: qTitle.length >= 2 && cTitle.length > 0 && (cTitle === qTitle || cTitle.includes(qTitle)),
    durationMatches:
      Number.isFinite(query.duration) && Number.isFinite(candidate.duration) && Math.abs(query.duration - candidate.duration) <= 5,
  }
}

/**
 * Does a candidate agree with the query on BOTH artist and title -
 * independent of duration or any per-source server score?
 *
 * This is the gate a candidate has to clear before duration or a server's
 * own relevance score may rank or boost it at all (see `lookupDeezer` and
 * `lookupMusicBrainzAcousticBrainz`). Without it, a completely different
 * recording that merely happens to share a title and land within 5 seconds
 * of the query's duration (measured live: a wrong Deezer artist, matching
 * title, matching duration - 0.5 title + 0.1 duration = 0.6, exactly
 * `MIN_MATCH_CONFIDENCE`) or a wrong title that a search engine's own
 * relevance score rates highly (measured live: a wrong MusicBrainz
 * recording's `score` averaged with a correct-artist-plus-duration partial
 * match - (1.0 + 0.5) / 2 = 0.75) could each cross the confidence floor on
 * evidence that was never actually about identifying the right song.
 */
export function identityMatches(candidate, query) {
  const { artistMatches, titleMatches } = matchSignals(candidate, query)
  return artistMatches && titleMatches
}

/**
 * How likely a search result is to actually be the track that was searched
 * for, independent of the specific database that returned it.
 *
 * Weighted so that artist alone (0.4) or title alone (0.5) cannot cross
 * `MIN_MATCH_CONFIDENCE` (0.6) on their own. Duration only ever adds to a
 * candidate that already agrees on BOTH artist and title (`identityMatches`)
 * - it breaks a tie among genuine matches, the same way a server's own
 * relevance score does for `lookupMusicBrainzAcousticBrainz` below, and
 * never contributes toward crossing the confidence floor by itself. See
 * `identityMatches`' own doc comment for the two demonstrated false
 * positives this closes.
 */
export function scoreMatch(candidate, query) {
  const { artistMatches, titleMatches, durationMatches } = matchSignals(candidate, query)

  let score = 0
  if (artistMatches) score += 0.4
  if (titleMatches) score += 0.5
  if (artistMatches && titleMatches && durationMatches) score += 0.1
  return clamp01(score)
}

// --- YouTube-style title normalisation --------------------------------------

/**
 * Bracketed/parenthesised noise that describes the UPLOAD, not the SONG.
 *
 * Deliberately narrow. "Live", "Remix", "Radio Edit", "Acoustic" and similar
 * are left alone even though they are also common in titles, because they
 * can describe a genuinely different recording with its own tempo - stripping
 * them could make a live version's title match a studio release's database
 * entry and silently borrow its tempo. Only tags that describe the hosting
 * medium rather than the music are stripped.
 */
const UPLOAD_NOISE_RE = /\b(official(?:\s+(music|lyric)?s?\s*video)?|music\s*video|lyrics?\s*video|visuali[sz]er|audio|video|hd|4k)\b/i

function stripUploadNoise(text) {
  return text
    .replace(/[([][^()[\]]*[)\]]/g, (bracketed) => (UPLOAD_NOISE_RE.test(bracketed) ? '' : bracketed))
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** The first "Artist <sep> Title"-shaped split, or null if none is present. */
const ARTIST_TITLE_SEPARATOR_RE = /\s+[-–—|]\s+|\s+::\s+/

function splitArtistTitle(title) {
  const match = title.match(ARTIST_TITLE_SEPARATOR_RE)
  if (!match) return null
  const artist = title.slice(0, match.index).trim()
  const rest = title.slice(match.index + match[0].length).trim()
  if (!artist || !rest) return null
  return { artist, title: rest }
}

/**
 * Turn a raw YouTube/SoundCloud title and uploader into a search-ready
 * (artist, title) pair.
 *
 * YouTube titles are inconsistent by convention, not by accident: "Artist -
 * Title (Official Video)", "Artist | Title", auto-generated per-artist
 * "Topic" channels, re-uploads with extra decoration. This handles the
 * common shapes and falls back to the uploader as the artist when the title
 * has no separator at all - measured live against the target track: yt-dlp
 * reports the title as "BICEP | GLUE (Official Video)" and the uploader as
 * "BICEP", and this recovers `{ artist: "BICEP", title: "GLUE" }` from
 * either field alone.
 */
export function parseArtistTitle(input) {
  const { title, artist } = input ?? {}
  const cleanedTitle = stripUploadNoise(String(title ?? ''))
  const split = splitArtistTitle(cleanedTitle)
  if (split) return split

  const cleanedUploader = artist ? String(artist).replace(/\s*-\s*topic$/i, '').trim() : ''
  return {
    artist: cleanedUploader || null,
    title: cleanedTitle || null,
  }
}

// --- network -----------------------------------------------------------------

/**
 * One fetch. Deliberately does NOT catch its own exceptions (a rejected
 * fetch - a timeout via `AbortSignal.timeout` firing, a connection reset
 * like the one measured live against MusicBrainz from this project's own
 * sandbox, malformed JSON) and lets them propagate.
 *
 * An earlier version of this function caught them here too, and it was
 * wrong: `lookupTrack` below already wraps each source in its own
 * `.catch(() => null)`, both to isolate one source's failure from the other
 * (a broken MusicBrainz must not stop Deezer from being tried) and to catch
 * bugs in this file's own post-fetch processing, which a catch inside
 * `fetchJson` cannot see at all. With both catches present, mutating either
 * one away changed nothing observable - every "never throws" test still
 * passed, because the other catch silently absorbed it. That is a test that
 * cannot fail, the exact thing this project's own history flags as the most
 * common review finding. Removing this one leaves exactly one place, per
 * source, responsible for "a lookup failure must never halt a run" - and
 * mutating that one now does fail this file's tests (see the `.catch`
 * lines in `lookupTrack`).
 */
async function fetchJson(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) return { ok: false, status: response.status, data: null }
  return { ok: true, status: response.status, data: await response.json() }
}

/**
 * Deezer's `bpm` field is measured live to be real but inconsistently
 * populated (130.01 for Bicep's "Glue", 0 for Daft Punk's "One More Time") -
 * a 0 is treated as absent, not as a genuine zero-tempo track.
 */
async function lookupDeezer({ artist, title, duration }, opts) {
  const query = `artist:"${artist}" track:"${title}"`
  const search = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`, opts)
  const candidates = search.ok && Array.isArray(search.data?.data) ? search.data.data : []
  if (!candidates.length) return null

  let best = null
  for (const candidate of candidates) {
    const confidence = scoreMatch({ artist: candidate.artist?.name, title: candidate.title, duration: candidate.duration }, { artist, title, duration })
    if (!best || confidence > best.confidence) best = { id: candidate.id, confidence }
  }
  if (!best || best.confidence < MIN_MATCH_CONFIDENCE) return null

  const track = await fetchJson(`https://api.deezer.com/track/${best.id}`, opts)
  const bpm = Number(track.data?.bpm)
  if (!track.ok || !Number.isFinite(bpm) || bpm <= 0) return null

  return { bpm, key: null, source: 'deezer', matchConfidence: best.confidence }
}

/**
 * MusicBrainz to resolve an MBID, then AcousticBrainz's low-level features
 * keyed by that MBID. One MusicBrainz request per call, so the "at most one
 * request per second" rule has nothing to throttle against within a single
 * lookup; the descriptive User-Agent MusicBrainz asks for is always sent.
 */
async function lookupMusicBrainzAcousticBrainz({ artist, title, duration }, opts) {
  const query = `artist:"${artist}" AND recording:"${title}"`
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5`
  const search = await fetchJson(url, { ...opts, headers: { 'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT, Accept: 'application/json' } })
  const recordings = search.ok && Array.isArray(search.data?.recordings) ? search.data.recordings : []
  if (!recordings.length) return null

  let best = null
  for (const recording of recordings) {
    const recordingArtist = recording['artist-credit']?.map((credit) => credit.name).join(' ') ?? ''
    const recordingDuration = Number.isFinite(recording.length) ? recording.length / 1000 : null
    const candidate = { artist: recordingArtist, title: recording.title, duration: recordingDuration }
    // MusicBrainz's own `score` is a text-relevance rating, not evidence
    // about identity - averaging it into `confidence` for a candidate that
    // does not even agree on artist and title is exactly how a wrong
    // recording with a high server score used to outrank a genuine one (see
    // `identityMatches`' own doc comment for the measured case). A
    // candidate failing this gate is skipped outright, never scored.
    if (!identityMatches(candidate, { artist, title, duration })) continue
    const textScore = typeof recording.score === 'number' ? clamp01(recording.score / 100) : 0.5
    const matchScore = scoreMatch(candidate, { artist, title, duration })
    const confidence = clamp01((textScore + matchScore) / 2)
    if (!best || confidence > best.confidence) best = { mbid: recording.id, confidence }
  }
  if (!best || best.confidence < MIN_MATCH_CONFIDENCE) return null

  // Not throttled by a real delay: this is the only MusicBrainz request this
  // function makes, so there is no second request to space out from it.
  const lowLevel = await fetchJson(`https://acousticbrainz.org/api/v1/${best.mbid}/low-level`, opts)
  if (!lowLevel.ok) return null // Frequently a 404 - the project stopped collecting in 2022.

  const bpm = Number(lowLevel.data?.rhythm?.bpm)
  const key = normalizeKeyName(`${lowLevel.data?.tonal?.key_key ?? ''} ${lowLevel.data?.tonal?.key_scale ?? ''}`)
  const bpmValid = Number.isFinite(bpm) && bpm > 0
  if (!bpmValid && !key) return null

  // Essentia's key extractor (what AcousticBrainz ran to produce `key_key`/
  // `key_scale`) also reports `key_strength` alongside them: its own
  // correlation strength for the fitted key profile, in [0, 1]. This is
  // "how confident is this ALGORITHM in this KEY" - a completely different
  // question from `best.confidence` above, which is "did we find the right
  // RECORDING". `reconcileKey` (below) must never see the latter mislabelled
  // as the former - see its own doc comment for why that mislabelling was a
  // real, shipped bug. `null`, not 0, when the field is missing OR explicitly
  // `null` in the response: a real measured strength of 0 is informative
  // (this algorithm found no key at all); no reported value is not evidence
  // of anything. `typeof ... === 'number'` (not `Number.isFinite` on the raw
  // JSON value directly) matters here: `Number(null)` is `0`, a real finite
  // number, so a naive `Number(...)` cast would silently turn an explicit
  // `key_strength: null` into a fake zero-confidence reading.
  const rawKeyStrength = lowLevel.data?.tonal?.key_strength
  const keyConfidence = key && typeof rawKeyStrength === 'number' && Number.isFinite(rawKeyStrength) ? clamp01(rawKeyStrength) : null

  return { bpm: bpmValid ? bpm : null, key, keyConfidence, source: 'acousticbrainz', matchConfidence: best.confidence }
}

// --- caching -----------------------------------------------------------------

/** Is `value` a real number usable as a confidence - finite and in [0, 1]?
 *  `typeof value === 'number'` alone accepts `NaN` (its `typeof` is still
 *  `'number'`) and any out-of-range value a hand-edited cache file can
 *  express (JSON itself cannot encode `NaN`/`Infinity`, but nothing stops a
 *  edited file from writing `"bpmMatchConfidence": 5`) - both would
 *  otherwise pass a bare `typeof` check and then feed a downstream gate a
 *  number that looks real but was never actually measured against anything. */
function isUnitConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Is this shaped like a real result this module produced, rather than a
 * corrupted file, a hand-edited one, or a cache written by an earlier,
 * different version of this module? A cache hit that fails this is treated
 * as a miss (re-query), not trusted as-is - the whole point of this file is
 * not trusting data without checking its provenance, and a cache file is
 * data too.
 */
function looksLikeResult(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value.bpm === null || (typeof value.bpm === 'number' && Number.isFinite(value.bpm) && value.bpm > 0)) &&
    // Round-tripped through the same normaliser this module uses to produce
    // a key in the first place: a non-canonical or garbled string (a stray
    // cache-editing typo, a value written by some future/past format this
    // module never produced) fails to reproduce itself and is rejected,
    // rather than trusted as-is because it happened to be *a* string.
    (value.key === null || (typeof value.key === 'string' && normalizeKeyName(value.key) === value.key)) &&
    // `undefined` is accepted, not just `null`/a valid confidence: a cache
    // file written before this field existed must still be trusted (it is
    // not corrupted, just older), rather than forcing a re-query that may
    // hit an unreachable network - see `reconcileKey`'s fallback for the
    // same field.
    (value.keyConfidence === undefined || value.keyConfidence === null || isUnitConfidence(value.keyConfidence)) &&
    (value.source === null || typeof value.source === 'string') &&
    isUnitConfidence(value.matchConfidence) &&
    // No `undefined` grandfather clause for these two, unlike `keyConfidence`
    // above: they are what the confidence-laundering fix (9ac6726) actually
    // introduced, and `reconcileTempo`/`reconcileKey` gate on them directly
    // (see `rebuild.mjs`). A cache written before they existed predates that
    // fix and must not be trusted as-is; without this, `bpmMatchConfidence:
    // "garbage"` (or simply absent, or a real number outside [0, 1]) would
    // pass a bare `typeof` guard, and reconciliation's own gate on the same
    // field would then compare against a value that was never actually
    // measured. Reconciliation itself no longer defaults a missing/invalid
    // confidence to full trust either (see `reconcileKey` and grid.mjs's
    // `reconcileTempo`) - this validates the cache boundary, that fixes the
    // reconciliation boundary, and neither substitutes for the other.
    isUnitConfidence(value.bpmMatchConfidence) &&
    isUnitConfidence(value.keyMatchConfidence)
  )
}

async function readCache(cacheDir) {
  if (!cacheDir) return null
  try {
    const raw = await fs.readFile(path.join(cacheDir, CACHE_FILENAME), 'utf8')
    const result = JSON.parse(raw)?.result
    return looksLikeResult(result) ? result : null
  } catch {
    return null
  }
}

async function writeCache(cacheDir, query, result) {
  if (!cacheDir) return
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(path.join(cacheDir, CACHE_FILENAME), `${JSON.stringify({ query, result, lookedUpAt: new Date().toISOString() }, null, 2)}\n`)
  } catch {
    // Caching is an optimisation on top of a lookup that already succeeded;
    // a read-only filesystem or a full disk must not turn that into a failure.
  }
}

function emptyResult() {
  return { bpm: null, key: null, source: null, matchConfidence: 0, bpmMatchConfidence: 0, keyMatchConfidence: 0, keyConfidence: null }
}

/**
 * Known tempo and key for a track, from Deezer and/or the MusicBrainz ->
 * AcousticBrainz chain. Never throws: every failure mode (missing input, no
 * network, a timeout, a 404, a rate-limit response, an unreachable host, no
 * match found) returns `emptyResult()`, identical to what a caller got before
 * this module existed.
 *
 * Cached in `options.cacheDir` (the run directory) when given, because the
 * facts this returns are stable and re-running the same content should not
 * re-query - the cache is keyed by nothing but its location, since one run
 * directory holds exactly one track.
 */
export async function lookupTrack(query = {}, options = {}) {
  // `query = {}` only covers a genuinely missing (`undefined`) argument - an
  // explicit `lookupTrack(null)` would otherwise throw while destructuring,
  // which this function's whole contract says it must not do.
  const { artist, title, duration = null } = query ?? {}
  if (!artist || !title) return emptyResult()

  const cached = await readCache(options.cacheDir)
  if (cached) return cached

  const fetchOpts = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  }
  const lookupQuery = { artist, title, duration }

  const result = emptyResult()
  const sources = []

  // `bpmMatchConfidence` and `keyMatchConfidence` are tracked separately, not
  // folded into one shared `matchConfidence`, because Deezer and the
  // MusicBrainz/AcousticBrainz chain are two INDEPENDENT searches that can
  // each land on a different recording. Collapsing them (e.g. `Math.max`)
  // would let a strong match on one field lend its confidence to a weak,
  // unrelated match on the other - a wrong key from a barely-over-the-floor
  // MusicBrainz hit would be reported as trustworthy as long as Deezer's
  // completely separate tempo search found the right song. `matchConfidence`
  // below is kept as a simple summary (the better of the two, for display and
  // for callers that only care "did anything match well") but reconciliation
  // in grid.mjs/rebuild.mjs must use the per-field values.
  const deezer = await lookupDeezer(lookupQuery, fetchOpts).catch(() => null)
  if (deezer?.bpm != null) {
    result.bpm = deezer.bpm
    result.bpmMatchConfidence = deezer.matchConfidence
    sources.push(deezer.source)
  }

  const mbab = await lookupMusicBrainzAcousticBrainz(lookupQuery, fetchOpts).catch(() => null)
  if (mbab) {
    const contributedBpm = result.bpm == null && mbab.bpm != null
    if (contributedBpm) {
      result.bpm = mbab.bpm
      result.bpmMatchConfidence = mbab.matchConfidence
    }
    if (mbab.key) {
      result.key = mbab.key
      result.keyMatchConfidence = mbab.matchConfidence
      result.keyConfidence = mbab.keyConfidence
    }
    if (contributedBpm || mbab.key) sources.push(mbab.source)
  }

  result.matchConfidence = Math.max(result.bpmMatchConfidence, result.keyMatchConfidence)
  result.source = sources.length ? sources.join('+') : null

  await writeCache(options.cacheDir, lookupQuery, result)
  return result
}

// --- reconciliation: key -----------------------------------------------------

/** Confidence reported when the detector and a known key agree. */
const KEY_AGREEMENT_CONFIDENCE = 0.9

/**
 * Confidence used when a known key fills a void - there is no local key
 * evidence at all to compare it against - and the source itself did not
 * report how confident IT is in that key (e.g. a cache file written before
 * this module captured AcousticBrainz's own `key_strength`, or a future
 * source with no key-quality signal). A flat, documented default for "trust
 * a named source outright when there is nothing else to go on" when no real
 * per-source number exists - not a floor applied on top of a reported value
 * (a genuinely low `keyConfidence`, e.g. 0.1, is used as-is, not raised to
 * this), and not a measured probability. Deliberately NOT derived from
 * `matchConfidence` - see this function's own doc comment for why "the right
 * recording" and "the right key" are different questions.
 */
export const KEY_VOID_FALLBACK_CONFIDENCE = 0.6

/**
 * Combine a detected key with a known one from `lookupTrack`, as a prior and
 * a cross-check on a genuine disagreement, the same discipline
 * `reconcileTempo` (grid.mjs) already applies to tempo:
 *
 *   - agree (via `keysMatch`, which already treats relative major/minor and
 *     fifth-neighbours as indistinguishable from audio alone): the known
 *     key's spelling is adopted (not a "replacement" in the disagreement
 *     sense below - two independent measurements corroborating each other is
 *     exactly what should raise confidence and pick the more canonical name),
 *     at confidence raised to at least `KEY_AGREEMENT_CONFIDENCE`.
 *   - no local key at all (`detected` has no name): the known key fills the
 *     void, at the confidence of the key EVIDENCE itself (`known.keyConfidence`,
 *     e.g. AcousticBrainz's `key_strength`) - or `KEY_VOID_FALLBACK_CONFIDENCE`
 *     when the source did not report one - never at the recording-match
 *     confidence (see `KEY_VOID_FALLBACK_CONFIDENCE`'s doc comment).
 *   - disagree materially (`detected` names a genuinely different key that
 *     does not satisfy `keysMatch`): surfaced, not silently resolved into
 *     either answer, regardless of how low the detector's own confidence is.
 *     This used to have a fourth branch here - "detector unsure, trust the
 *     known key outright" - and it was a real, shipped bug: Bicep's "Glue"
 *     detected E minor from its own transcribed notes at confidence 0.098
 *     (below what felt like a reasonable "unsure" bar), so that branch fired
 *     and silently adopted AcousticBrainz's "G# major" - a genuinely
 *     different key, not a relative or enharmonic match - at a confidence
 *     (0.975) computed from `0.5 + 0.5 * matchConfidence`, i.e. "how sure are
 *     we this is the right recording" relabelled as "how sure are we this is
 *     the right key". A detector being unconfident is not evidence that a
 *     *different*, external answer is correct; it is only evidence the
 *     detector doesn't know. Unlike a tempo mismatch - which halts the whole
 *     run, because everything downstream is built on the beat grid - a key
 *     mismatch only affects the harmonic layer's chord anchor register (see
 *     emit.mjs's `anchor`/`prefersFlats`, which already fall back to C major
 *     on an empty key name), so this returns `name: null` rather than
 *     throwing: the emitter's existing neutral default is safer than
 *     guessing between two answers this module cannot adjudicate.
 *     `detected`/`known` are carried on the returned object so a caller that
 *     wants to log or display the disagreement can, without re-deriving it -
 *     they are not this module's mechanism for preserving the raw values
 *     for the record; a caller like `rebuild.mjs` already keeps its own copy
 *     of both (the raw `lookupTrack` result, the raw local detection) on
 *     `reference.json` independently of what this function returns.
 */
export function reconcileKey(detected, known, opts = {}) {
  const minMatch = opts.minMatchConfidence ?? MIN_MATCH_CONFIDENCE
  const detectedName = detected?.name ?? null
  const detectedConfidence = detected?.confidence ?? 0

  const knownName = known?.name ? normalizeKeyName(known.name) : null
  // A missing or invalid `matchConfidence` is untrusted, not maximally
  // trusted: `?? 1` here used to mean "no confidence reported? assume
  // perfect" - the opposite of what an absent or corrupt measurement should
  // imply. The range check (not just `Number.isFinite`) also rejects a
  // finite-but-nonsensical value (e.g. `5`) that a looser guard upstream let
  // through - `Number.isFinite` alone would let it clear `minMatch` outright
  // as if it were a genuinely high-confidence match.
  const knownMatchConfidence = Number.isFinite(known?.matchConfidence) && known.matchConfidence >= 0 && known.matchConfidence <= 1 ? known.matchConfidence : 0
  if (!knownName || knownMatchConfidence < minMatch) {
    return { name: detectedName, confidence: detectedConfidence, agreement: 'none' }
  }

  if (!detectedName) {
    // `Number.isFinite`, not `typeof === 'number'`: the latter also accepts
    // `NaN`, which `clamp01` cannot fix (`Math.max`/`Math.min` both propagate
    // it) - a malformed cache file or a direct caller passing a bad value
    // must fall back to the documented default, not silently confidence: NaN.
    const voidConfidence = Number.isFinite(known.keyConfidence) ? known.keyConfidence : KEY_VOID_FALLBACK_CONFIDENCE
    return { name: knownName, confidence: clamp01(voidConfidence), agreement: 'known' }
  }

  if (keysMatch(detectedName, knownName)) {
    return { name: knownName, confidence: clamp01(Math.max(detectedConfidence, KEY_AGREEMENT_CONFIDENCE)), agreement: 'agree' }
  }

  return { name: null, confidence: 0, agreement: 'disagreement', detected: detectedName, known: knownName }
}
