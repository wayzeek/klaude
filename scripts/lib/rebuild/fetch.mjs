/**
 * Turn whatever the user gave us into a local audio file.
 *
 * Every source is one entry in SOURCES. That is the control: if the licensing
 * posture ever needs to narrow, it is deleting entries from this array, not a
 * refactor, and nothing downstream knows or cares where the audio came from.
 *
 * Fetching copyrighted audio is the operator's call. yt-dlp is invoked as a
 * tool the operator installed; it is never bundled.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { TOOLS, requireTool } from './tools.mjs'

export class UnsupportedSourceError extends Error {
  constructor(source, message) {
    super(message)
    this.name = 'UnsupportedSourceError'
    this.source = source
  }
}

async function localHandler(input) {
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`)
  return { path: path.resolve(input), source: 'local', title: path.basename(input), artist: null, duration: null }
}

/**
 * yt-dlp's `NA` sentinel for a field it could not resolve, versus a value
 * genuinely absent from the print line (e.g. a truncated/blank field).
 */
const YTDLP_NA = 'NA'

/**
 * yt-dlp's output-template fields, one `--print` directive, one field
 * separator per line.
 *
 * All four fields are requested at the same `after_move` stage the original
 * code already used for `filepath`, so the existing "the print line is the
 * last line of stdout" parsing strategy is unchanged - only what is packed
 * into that line grows. `\x1f` (ASCII unit separator) is used rather than a
 * printable delimiter because it cannot appear in a real title or uploader
 * name, so splitting never mis-parses one because it happens to contain a
 * pipe or a dash - both of which real titles do contain (this project's own
 * probe of the target track: "BICEP | GLUE (Official Video)").
 * `%(uploader,channel,uploader_id)s` falls back through yt-dlp's own
 * alternate-field syntax so a source missing `uploader` (some SoundCloud
 * pages) still yields something rather than `NA`.
 */
const YTDLP_FIELD_SEP = '\x1f'
const YTDLP_PRINT_TEMPLATE = `after_move:%(filepath)s${YTDLP_FIELD_SEP}%(title)s${YTDLP_FIELD_SEP}%(uploader,channel,uploader_id)s${YTDLP_FIELD_SEP}%(duration)s`

/**
 * Parse the one line `YTDLP_PRINT_TEMPLATE` prints after the download moves
 * into place. Exported so the parsing itself - the part with a real
 * failure mode (missing fields, an `NA` sentinel, a non-numeric duration) -
 * is unit-testable without shelling out to a real binary.
 */
export function parseYtdlpPrintLine(line) {
  const [filepath, title, uploader, durationRaw] = line.trim().split(YTDLP_FIELD_SEP)
  const clean = (value) => (value && value !== YTDLP_NA ? value : null)
  const duration = Number(durationRaw)
  return {
    path: filepath,
    title: clean(title),
    artist: clean(uploader),
    // `Number('NA')` and `Number(undefined)` are both already NaN, so the
    // `Number.isFinite` check alone rejects the missing-field case; the
    // truthy guard on `durationRaw` is what is actually load-bearing here -
    // without it, an empty (as opposed to missing or "NA") field would parse
    // to the number 0 and be reported as a real, if unlikely, zero-second
    // duration rather than "unknown".
    duration: durationRaw && Number.isFinite(duration) ? duration : null,
  }
}

async function spotifyHandler() {
  throw new UnsupportedSourceError(
    'spotify',
    'Spotify cannot supply audio, and its tempo and key data was closed to new applications in late 2024.\n' +
      'Find the track elsewhere, or point moltek at a local file.',
  )
}

async function ytdlpHandler(input, destDir) {
  await requireTool('ytdlp', TOOLS.ytdlp)
  const template = path.join(destDir, 'source.%(ext)s')
  const args = ['--no-playlist', '-x', '--audio-format', 'best', '-o', template, '--print', YTDLP_PRINT_TEMPLATE, input]

  const printed = await new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: 600000 }, (error, stdout, stderr) => {
      if (!error) return resolve(parseYtdlpPrintLine(stdout.trim().split('\n').pop()))
      const text = `${stderr}`.toLowerCase()
      if (text.includes('video unavailable') || text.includes('has been removed')) {
        return reject(new Error(`That media is gone: ${input}`))
      }
      if (text.includes('not available in your country') || text.includes('geo')) {
        return reject(new Error(`Blocked in this region: ${input}`))
      }
      if (text.includes('unable to download') || text.includes('network') || text.includes('timed out')) {
        return reject(new Error(`Network problem fetching ${input}`))
      }
      reject(new Error(`yt-dlp failed on ${input}\n${stderr.trim().split('\n').slice(-3).join('\n')}`))
    })
  })

  return {
    path: printed.path,
    source: 'ytdlp',
    // Falls back to the filename on the rare source where yt-dlp cannot
    // resolve a title at all, matching what this returned before this field
    // existed, rather than surfacing `null` as a title.
    title: printed.title ?? path.basename(printed.path),
    artist: printed.artist,
    duration: printed.duration,
  }
}

async function httpHandler(input, destDir) {
  const response = await fetch(input)
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${input}`)
  const name = path.basename(new URL(input).pathname) || 'source.audio'
  const dest = path.join(destDir, name)
  await fsp.writeFile(dest, Buffer.from(await response.arrayBuffer()))
  return { path: dest, source: 'http', title: name, artist: null, duration: null }
}

/**
 * Ordered: the first match wins. Spotify has to precede the generic http
 * handler or its link would be treated as a direct download and fail
 * unhelpfully.
 */
export const SOURCES = [
  { name: 'local', match: (input) => !/^https?:\/\//i.test(input), handler: localHandler },
  { name: 'spotify', match: (input) => /(^|\.)spotify\.com\//i.test(input), handler: spotifyHandler },
  {
    name: 'ytdlp',
    match: (input) => /(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com)/i.test(input),
    handler: ytdlpHandler,
  },
  { name: 'http', match: () => true, handler: httpHandler },
]

export function classify(input) {
  return SOURCES.find((source) => source.match(input)) ?? null
}

export async function resolveSource(input, destDir) {
  const source = classify(input)
  if (!source) throw new UnsupportedSourceError('unknown', `Nothing can handle: ${input}`)
  return source.handler(input, destDir)
}
