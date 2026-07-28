/**
 * Where a rebuild run keeps its working files.
 *
 * Everything lives under .moltek/, which is already gitignored. Runs are keyed
 * by the content hash of the source audio rather than by URL or title, so the
 * same record fetched twice from different places reuses one set of stems, and
 * separation (the slowest stage by a distance) runs once.
 */

import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repo root, found by walking up from this file to the nearest package.json.
 *
 * Deliberately not `process.cwd()`. The ignore rule is `/.moltek/`, anchored to
 * the repo root, so a cwd-relative path writes into a directory git does not
 * ignore the moment anyone runs the CLI from a subdirectory. That turns stems
 * and downloaded audio into stageable files, which is the one thing this module
 * exists to prevent.
 */
function findRepoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (dir !== path.dirname(dir)) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not locate the repo root: no package.json above scripts/lib/rebuild/')
}

export const REPO_ROOT = findRepoRoot()
const ROOT = path.join(REPO_ROOT, '.moltek', 'rebuilds')

/**
 * Where a fetch lands before its content hash is known.
 *
 * Every call returns a fresh, unique subdirectory rather than one shared
 * path. yt-dlp always writes `source.%(ext)s`, so two runs started close
 * together would otherwise race on the same filename; a unique directory per
 * invocation makes that impossible. Callers own the lifetime - remove it once
 * the content hash and decode have both gone through, or the staged download
 * accumulates on disk forever. A local file passed directly is never copied
 * here, so it is never at risk from that cleanup.
 */
export function stagingDir() {
  return path.join(REPO_ROOT, '.moltek', 'staging', crypto.randomUUID())
}

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
