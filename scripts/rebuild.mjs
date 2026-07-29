#!/usr/bin/env node
/**
 * Rebuild a song from a link.
 *
 * Fetch, decode, profile, find the grid and the sections, split into stems,
 * transcribe drums/bass/harmony/melody, check what was heard against the
 * stems it came from, then emit a moltek track and check what was written
 * against the transcription. Everything lands in `.moltek/rebuilds/<hash>/`.
 *
 * Usage:
 *   node scripts/rebuild.mjs <url-or-file> [--analyze-only] [--transcribe-only] [--out <file>] [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import { toWav } from './lib/rebuild/decode.mjs'
import { emitTrack } from './lib/rebuild/emit.mjs'
import { UnsupportedSourceError, resolveSource } from './lib/rebuild/fetch.mjs'
import { LowConfidenceGridError, detectGrid } from './lib/rebuild/grid.mjs'
import { contentHash, ensureRunDir, stagingDir } from './lib/rebuild/paths.mjs'
import { profileReference } from './lib/rebuild/profile.mjs'
import { findSections } from './lib/rebuild/sections.mjs'
import { separate, stemPaths } from './lib/rebuild/separate.mjs'
import { MissingToolError } from './lib/rebuild/tools.mjs'
import { transcribeBass } from './lib/rebuild/transcribe/bass.mjs'
import { transcribeDrums } from './lib/rebuild/transcribe/drums.mjs'
import { transcribeHarmony } from './lib/rebuild/transcribe/harmony.mjs'
import { transcribeMelody } from './lib/rebuild/transcribe/melody.mjs'
import { LAYERS } from './lib/rebuild/transcribe/quantize.mjs'
import { verifyEmission } from './lib/rebuild/verify-emission.mjs'
import { verifyHearing } from './lib/rebuild/verify-hearing.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const analyzeOnly = args.includes('--analyze-only')
const transcribeOnly = args.includes('--transcribe-only')
const outFlag = args.indexOf('--out')
const outPath = outFlag >= 0 ? args[outFlag + 1] : null
// The first bare token that isn't `--out`'s own value - excluding that one
// index specifically (guarded: `outFlag` is -1 when `--out` is absent, and
// -1 + 1 === 0 would otherwise exclude a legitimate index-0 input), rather
// than every non-`--` token, so a path given before `--out` (the documented
// order) still wins, and `--out <file>` given before the input (e.g.
// `--out foo.js song.wav`) doesn't mistake the output path for the input.
const input = args.find((a, i) => !a.startsWith('--') && (outFlag < 0 || i !== outFlag + 1))

if (!input) {
  console.error(
    'usage: node scripts/rebuild.mjs <url-or-file> ' +
      '[--analyze-only] [--transcribe-only] [--out <file>] [--json]',
  )
  process.exit(1)
}

const say = (message) => {
  if (!asJson) console.log(message)
}

async function main() {
  // The run directory is keyed by content, which is only knowable after the
  // fetch, so fetch into a staging directory first. Each invocation gets its
  // own subdirectory (see stagingDir), and it is removed once the content
  // hash and decode have gone through - win or lose, since a local file is
  // used in place and was never copied there, so cleanup never touches it.
  const staging = stagingDir()
  await fs.promises.mkdir(staging, { recursive: true })

  let source
  let hash
  let dirs
  let wavPath
  let wavBuf
  try {
    say(`fetching ${input}`)
    source = await resolveSource(input, staging)

    hash = contentHash(await fs.promises.readFile(source.path))
    dirs = await ensureRunDir(hash)
    say(`run ${hash}`)

    wavPath = path.join(dirs.source, 'mix.wav')
    say('decoding')
    await toWav(source.path, wavPath)
    wavBuf = await fs.promises.readFile(wavPath)
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

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

  if (analyzeOnly || !stems) {
    // Nothing to transcribe without stems.
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    printSections(sections, dirs)
    return
  }

  say('transcribing')
  const paths = stemPaths(dirs.stems)
  const drumBuf = await fs.promises.readFile(paths.drums)
  const bassBuf = await fs.promises.readFile(paths.bass)
  const otherBuf = await fs.promises.readFile(paths.other)

  const drums = transcribeDrums(drumBuf, grid, sections)
  const bass = transcribeBass(bassBuf, grid, sections)
  const chords = transcribeHarmony(otherBuf, grid, sections, { key: profile.key?.name })
  const lead = transcribeMelody(otherBuf, grid, sections)

  const transcription = {
    grid: result.grid,
    key: { name: profile.key?.name ?? null, confidence: profile.key?.confidence ?? 0 },
    stepsPerBeat: 4,
    sections: sections.map((section, i) => ({
      index: section.index,
      startBar: section.startBar,
      bars: section.bars,
      label: section.label,
      sameAs: section.sameAs,
      loops: {
        kick: drums.kick[i],
        snare: drums.snare[i],
        hats: drums.hats[i],
        bass: bass[i],
        chords: chords[i],
        lead: lead[i],
      },
    })),
  }
  const present = transcription.sections.reduce(
    (count, section) => count + LAYERS.filter((layer) => section.loops[layer]).length,
    0,
  )
  say(`  ${present} layers across ${transcription.sections.length} sections`)

  say('checking what we heard')
  const hearing = verifyHearing(transcription, { drums: drumBuf, bass: bassBuf, other: otherBuf })
  await fs.promises.writeFile(path.join(dirs.root, 'hearing.json'), `${JSON.stringify(hearing, null, 2)}\n`)
  say(`  overall ${hearing.overall.toFixed(3)}`)

  // A layer that failed its hearing check is omitted rather than emitted wrong.
  let dropped = 0
  for (const section of transcription.sections) {
    const scored = hearing.sections.find((entry) => entry.index === section.index)
    for (const layer of LAYERS) {
      if (scored?.layers?.[layer] && !scored.layers[layer].pass) {
        section.loops[layer] = null
        dropped++
      }
    }
  }
  if (dropped) say(`  dropped ${dropped} layers below threshold`)

  // Written only now, after the drop. Persisting it before this point would
  // save a transcription the delivered track does not match, and the round-trip
  // measurement reads this file - it would be scoring something that was never
  // emitted.
  await fs.promises.writeFile(
    path.join(dirs.root, 'transcription.json'),
    `${JSON.stringify(transcription, null, 2)}\n`,
  )

  if (transcribeOnly) {
    if (asJson) {
      console.log(JSON.stringify({ ...result, transcription, hearing }, null, 2))
      return
    }
    printSections(sections, dirs)
    return
  }

  say('emitting')
  const code = emitTrack(transcription, { title: source.title, source: input })
  const trackPath = outPath ?? path.join(dirs.root, 'track.js')
  await fs.promises.writeFile(trackPath, `${code}\n`)

  say('checking what we wrote')
  const emission = await verifyEmission(code, transcription)
  await fs.promises.writeFile(path.join(dirs.root, 'emission.json'), `${JSON.stringify(emission, null, 2)}\n`)
  if (emission.ok) {
    say('  clean')
  } else {
    say(`  ${emission.defects.length} defects`)
    for (const defect of emission.defects.slice(0, 10)) {
      say(`    section ${defect.section ?? '-'} ${defect.layer ?? ''}: ${defect.message}`)
    }
  }

  result.transcription = transcription
  result.hearing = hearing
  result.emission = emission
  result.track = trackPath

  // The emission check is deterministic repair that should converge in one
  // pass, so a defect means the emitter is broken, not that the record was
  // hard. The track stays on disk for inspection, but the run does not report
  // success - exit 5 distinguishes it from the tool and grid failures above.
  if (!emission.ok) {
    if (asJson) console.log(JSON.stringify(result, null, 2))
    console.error(`\nemission check failed with ${emission.defects.length} defects: ${emission.defects[0].message}`)
    process.exitCode = 5
    return
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  printSections(sections, dirs)
  console.log(`written to ${trackPath}`)
}

function printSections(sections, dirs) {
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
