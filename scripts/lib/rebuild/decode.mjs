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
    // Container format, set explicitly rather than sniffed from the output
    // extension. The output path is a `.partial` temp file during encoding
    // (see toWav), and ffmpeg cannot infer a muxer from that suffix.
    '-f', 'wav',
    outputPath,
  ]
}

/**
 * Convert to WAV, caching the result.
 *
 * The output is written to a temp path and renamed into place only after
 * ffmpeg exits cleanly. That ordering is the whole point, and it is not
 * defensive padding: ffmpeg writes its output incrementally, so a run killed
 * partway through leaves a truncated file that is still far larger than a
 * header. A cache check based on existence or size would then accept that
 * corpse forever, never re-encoding and never erroring, until something
 * downstream fails on a file with no data chunk. Rename is atomic within a
 * filesystem, so a partial conversion can never appear at the final path.
 */
export async function toWav(inputPath, outputPath) {
  // Already converted on an earlier run: nothing to do. Safe to trust, because
  // nothing reaches this path until a conversion has fully succeeded.
  try {
    const stat = await fs.stat(outputPath)
    if (stat.size > 44) return outputPath
  } catch {
    // Not there yet, which is the normal case.
  }

  await requireTool('ffmpeg', TOOLS.ffmpeg)

  const tempPath = `${outputPath}.partial`
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ffmpegArgs(inputPath, tempPath), (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').slice(-3).join('\n')
          return reject(new Error(`ffmpeg could not decode ${inputPath}\n${detail}`))
        }
        resolve()
      })
    })
    await fs.rename(tempPath, outputPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true })
    throw error
  }

  return outputPath
}
