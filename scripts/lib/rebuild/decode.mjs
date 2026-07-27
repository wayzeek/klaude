/**
 * Normalise any audio to the WAV shape the analysis expects.
 *
 * This is where analyze.mjs's "pure Node, no dependencies" property stops being
 * true for the rebuild path. Deliberate: writing an MP3 and Opus decoder in
 * Node to preserve a claim in a header comment would be a poor trade.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { TOOLS, requireTool } from './tools.mjs'

export const TARGET = Object.freeze({ sampleRate: 44100, channels: 2, bitsPerSample: 16 })

export function ffmpegArgs(inputPath, outputPath) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-ar', String(TARGET.sampleRate),
    '-ac', String(TARGET.channels),
    '-c:a', 'pcm_s16le',
    outputPath,
  ]
}

export async function toWav(inputPath, outputPath) {
  await requireTool('ffmpeg', TOOLS.ffmpeg)

  // Already converted on an earlier run: nothing to do.
  try {
    const stat = await fs.stat(outputPath)
    if (stat.size > 44) return outputPath
  } catch {
    // Not there yet, which is the normal case.
  }

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ffmpegArgs(inputPath, outputPath), (error, _stdout, stderr) => {
      if (error) {
        const detail = stderr.trim().split('\n').slice(-3).join('\n')
        return reject(new Error(`ffmpeg could not decode ${inputPath}\n${detail}`))
      }
      resolve()
    })
  })

  return outputPath
}
