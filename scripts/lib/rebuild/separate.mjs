/**
 * Split a record into stems with Demucs.
 *
 * The slowest stage in the pipeline by a wide margin, and the one most worth
 * caching: re-running a rebuild on a song already pulled apart should skip it
 * entirely.
 *
 * The vocal stem is discarded as soon as Demucs produces it. moltek has no
 * voice, and keeping it out means nothing of the original recording can reach
 * the output.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { TOOLS, requireTool } from './tools.mjs'

export const STEMS = ['drums', 'bass', 'other']

const MODEL = 'htdemucs'

export function demucsArgs(inputPath, outDir) {
  // `-o` and `--out` are the same option; passing both is an error.
  return ['-o', outDir, '-n', MODEL, '--filename', '{stem}.{ext}', inputPath]
}

export function stemPaths(stemsDir) {
  const paths = {}
  for (const stem of STEMS) paths[stem] = path.join(stemsDir, `${stem}.wav`)
  return paths
}

function cacheComplete(stemsDir) {
  return STEMS.every((stem) => {
    const file = path.join(stemsDir, `${stem}.wav`)
    return fs.existsSync(file) && fs.statSync(file).size > 1024
  })
}

export async function separate(wavPath, stemsDir, { onProgress } = {}) {
  if (cacheComplete(stemsDir)) return { ...stemPaths(stemsDir), cached: true }

  await requireTool('demucs', TOOLS.demucs)
  if (!fs.existsSync(wavPath)) throw new Error(`Cannot separate, file not found: ${wavPath}`)

  await fsp.mkdir(stemsDir, { recursive: true })

  await new Promise((resolve, reject) => {
    const child = spawn('demucs', demucsArgs(wavPath, stemsDir), { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const note = (chunk) => {
      const text = String(chunk)
      tail = `${tail}${text}`.slice(-2000)
      if (onProgress) onProgress(text)
    }
    child.stdout.on('data', note)
    child.stderr.on('data', note)
    child.on('error', (error) =>
      reject(error.code === 'ENOENT' ? new Error('demucs vanished mid-run') : error),
    )
    child.on('close', (code) => {
      if (code === 0) return resolve()
      if (/killed|out of memory|cannot allocate/i.test(tail)) {
        return reject(new Error(`demucs ran out of memory on ${path.basename(wavPath)}`))
      }
      reject(new Error(`demucs exited ${code}\n${tail.trim().split('\n').slice(-5).join('\n')}`))
    })
  })

  // Demucs nests output under <out>/<model>/<track>/. Flatten what we keep and
  // drop the rest, vocals included.
  const nested = path.join(stemsDir, MODEL)
  if (fs.existsSync(nested)) {
    const trackDirs = await fsp.readdir(nested)
    for (const dir of trackDirs) {
      for (const stem of STEMS) {
        const from = path.join(nested, dir, `${stem}.wav`)
        if (fs.existsSync(from)) await fsp.rename(from, path.join(stemsDir, `${stem}.wav`))
      }
    }
    await fsp.rm(nested, { recursive: true, force: true })
  }

  if (!cacheComplete(stemsDir)) {
    throw new Error(`demucs finished but did not produce every stem in ${stemsDir}`)
  }
  return { ...stemPaths(stemsDir), cached: false }
}
