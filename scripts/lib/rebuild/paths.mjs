/**
 * Where a rebuild run keeps its working files.
 *
 * Everything lives under .moltek/, which is already gitignored. Runs are keyed
 * by the content hash of the source audio rather than by URL or title, so the
 * same record fetched twice from different places reuses one set of stems, and
 * separation (the slowest stage by a distance) runs once.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd(), '.moltek', 'rebuilds')

export function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

export function runDir(hash) {
  return path.join(ROOT, hash)
}

export async function ensureRunDir(hash) {
  const root = runDir(hash)
  const dirs = {
    root,
    source: path.join(root, 'source'),
    stems: path.join(root, 'stems'),
    attempts: path.join(root, 'attempts'),
  }
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })
  return dirs
}
