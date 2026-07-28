#!/usr/bin/env node
/**
 * Rebuild a song from a link.
 *
 * At this stage the pipeline stops after describing the reference: stems on
 * disk, a profile, a grid and a section timeline. Transcription and emission
 * are a separate plan.
 *
 * Usage:
 *   node scripts/rebuild.mjs <url-or-file> [--analyze-only] [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import { toWav } from './lib/rebuild/decode.mjs'
import { UnsupportedSourceError, resolveSource } from './lib/rebuild/fetch.mjs'
import { LowConfidenceGridError, detectGrid } from './lib/rebuild/grid.mjs'
import { contentHash, ensureRunDir, stagingDir } from './lib/rebuild/paths.mjs'
import { profileReference } from './lib/rebuild/profile.mjs'
import { findSections } from './lib/rebuild/sections.mjs'
import { separate } from './lib/rebuild/separate.mjs'
import { MissingToolError } from './lib/rebuild/tools.mjs'

const args = process.argv.slice(2)
const input = args.find((a) => !a.startsWith('--'))
const asJson = args.includes('--json')
const analyzeOnly = args.includes('--analyze-only')

if (!input) {
  console.error('usage: node scripts/rebuild.mjs <url-or-file> [--analyze-only] [--json]')
  process.exit(1)
}

const say = (message) => {
  if (!asJson) console.log(message)
}

async function main() {
  // The run directory is keyed by content, which is only knowable after the
  // fetch, so fetch into a staging directory first.
  const staging = stagingDir()
  await fs.promises.mkdir(staging, { recursive: true })

  say(`fetching ${input}`)
  const source = await resolveSource(input, staging)

  const hash = contentHash(await fs.promises.readFile(source.path))
  const dirs = await ensureRunDir(hash)
  say(`run ${hash}`)

  const wavPath = path.join(dirs.source, 'mix.wav')
  say('decoding')
  await toWav(source.path, wavPath)
  const wavBuf = await fs.promises.readFile(wavPath)

  say('profiling')
  const profile = profileReference(wavBuf, { title: source.title, url: input, source: source.source })

  say('finding the grid')
  const grid = detectGrid(wavBuf)
  say(`  ${grid.bpm.toFixed(1)} BPM, ${grid.beatsPerBar}/4, downbeat at ${grid.downbeatSeconds.toFixed(3)}s`)

  say('finding sections')
  const sections = findSections(wavBuf, grid)
  say(`  ${sections.length} sections`)

  let stems = null
  if (!analyzeOnly) {
    say('separating stems (slow the first time)')
    stems = await separate(wavPath, dirs.stems, {
      onProgress: (text) => {
        if (!asJson) process.stderr.write(text)
      },
    })
    say(stems.cached ? '  cached' : '  done')
  }

  const result = {
    hash,
    dir: dirs.root,
    source: { ...source, input },
    profile,
    grid: {
      bpm: grid.bpm,
      beatSeconds: grid.beatSeconds,
      phaseSeconds: grid.phaseSeconds,
      downbeatSeconds: grid.downbeatSeconds,
      downbeatOffset: grid.downbeatOffset,
      beatsPerBar: grid.beatsPerBar,
      barSeconds: grid.barSeconds,
      confidence: grid.confidence,
    },
    sections,
    stems,
  }

  await fs.promises.writeFile(path.join(dirs.root, 'reference.json'), `${JSON.stringify(result, null, 2)}\n`)

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('')
  console.log(`SECTIONS   ${sections.length}`)
  for (const section of sections) {
    const repeat = section.sameAs === null ? '' : ` (same as ${section.sameAs})`
    console.log(
      `  ${String(section.index).padStart(2)}  bar ${String(section.startBar).padStart(3)}  ` +
        `${String(section.bars).padStart(3)} bars  ${section.label.padEnd(4)}${repeat}`,
    )
  }
  console.log('')
  console.log(`written to ${path.join(dirs.root, 'reference.json')}`)
}

main().catch((error) => {
  if (error instanceof MissingToolError) {
    console.error(`\n${error.message}`)
    process.exit(2)
  }
  if (error instanceof LowConfidenceGridError) {
    console.error(`\n${error.message}`)
    process.exit(3)
  }
  if (error instanceof UnsupportedSourceError) {
    console.error(`\n${error.message}`)
    process.exit(4)
  }
  console.error(`\nFAIL: ${error.message}`)
  process.exit(1)
})
