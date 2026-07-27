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
  return { path: path.resolve(input), source: 'local', title: path.basename(input) }
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
  const args = ['--no-playlist', '-x', '--audio-format', 'best', '-o', template, '--print', 'after_move:filepath', input]

  const filepath = await new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: 600000 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim().split('\n').pop())
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

  return { path: filepath, source: 'ytdlp', title: path.basename(filepath) }
}

async function httpHandler(input, destDir) {
  const response = await fetch(input)
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${input}`)
  const name = path.basename(new URL(input).pathname) || 'source.audio'
  const dest = path.join(destDir, name)
  await fsp.writeFile(dest, Buffer.from(await response.arrayBuffer()))
  return { path: dest, source: 'http', title: name }
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
