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
import { detectDynamics, dynamicsForEmission } from './lib/rebuild/dynamics.mjs'
import { emitTrack, resolveSounds } from './lib/rebuild/emit.mjs'
import { UnsupportedSourceError, resolveSource } from './lib/rebuild/fetch.mjs'
import { LowConfidenceGridError, detectGrid } from './lib/rebuild/grid.mjs'
import { detectKeyFromNotes } from './lib/rebuild/key.mjs'
import { lookupTrack, parseArtistTitle, reconcileKey } from './lib/rebuild/metadata.mjs'
import { contentHash, ensureRunDir, stagingDir } from './lib/rebuild/paths.mjs'
import { profileReference } from './lib/rebuild/profile.mjs'
import { findSections } from './lib/rebuild/sections.mjs'
import { separate, stemPaths } from './lib/rebuild/separate.mjs'
import { deriveTrackEffects } from './lib/rebuild/sound-match.mjs'
import { profileStems } from './lib/rebuild/stem-profile.mjs'
import { MissingToolError } from './lib/rebuild/tools.mjs'
import { transcribeWithBasicPitch } from './lib/rebuild/transcribe/basic-pitch.mjs'
import { splitByRegister, transcribeBass } from './lib/rebuild/transcribe/bass.mjs'
import { transcribeDrums } from './lib/rebuild/transcribe/drums.mjs'
import { transcribeHarmony, transcribeHarmonyFromNotes } from './lib/rebuild/transcribe/harmony.mjs'
import { transcribeMelody } from './lib/rebuild/transcribe/melody.mjs'
import { LAYERS } from './lib/rebuild/transcribe/quantize.mjs'
import { verifyEmission } from './lib/rebuild/verify-emission.mjs'
import { verifyHearing } from './lib/rebuild/verify-hearing.mjs'
import { deriveLeadVoice } from './lib/rebuild/voice-select.mjs'

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

  // A released record's tempo and key are usually documented facts, not
  // things that must be guessed from a waveform - see metadata.mjs. This is
  // a prior and a cross-check for detectGrid/profileReference below, never a
  // replacement: a lookup failure (no match, no network, a timeout) resolves
  // to nulls here and everything downstream runs exactly as it did before
  // this existed.
  say('looking up known tempo/key')
  const parsedTitle = parseArtistTitle({ title: source.title, artist: source.artist })
  const metadata = await lookupTrack(
    { artist: parsedTitle.artist, title: parsedTitle.title, duration: source.duration },
    { cacheDir: dirs.root },
  )
  say(
    metadata.source
      ? `  ${metadata.source}: bpm=${metadata.bpm ?? '?'} key=${metadata.key ?? '?'} (match ${metadata.matchConfidence.toFixed(2)})`
      : '  no match',
  )
  // Field-specific confidences, not the blended `metadata.matchConfidence` -
  // Deezer and MusicBrainz/AcousticBrainz are independent searches that can
  // each land on a different recording, so a strong tempo match must not
  // lend its confidence to an unrelated, weaker key match (or vice versa).
  const knownTempo = metadata.bpm != null ? { bpm: metadata.bpm, matchConfidence: metadata.bpmMatchConfidence, source: metadata.source } : null
  const knownKey =
    metadata.key != null
      ? { name: metadata.key, matchConfidence: metadata.keyMatchConfidence, keyConfidence: metadata.keyConfidence, source: metadata.source }
      : null

  say('profiling')
  const profile = profileReference(wavBuf, { title: source.title, url: input, source: source.source })
  // Chroma-based key, reconciled against the known-key lookup above. This is
  // the pipeline's only key signal until stems exist below - `analyzeOnly`
  // runs never get past this - and stays the final answer whenever Basic
  // Pitch is absent or finds nothing usable (see `noteKey` further down,
  // which overrides it and reconciles again).
  let key = reconcileKey(profile.key, knownKey)

  say('finding the grid')
  const grid = detectGrid(wavBuf, { knownTempo })
  say(`  ${grid.bpm.toFixed(1)} BPM, ${grid.beatsPerBar}/4, downbeat at ${grid.downbeatSeconds.toFixed(3)}s (tempo ${grid.tempoAgreement})`)

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
    // What lookupTrack returned and how it was reconciled with the detected
    // key - the detected tempo's own reconciliation lives on `grid` itself
    // (`tempoAgreement`), since a disagreement there throws before this
    // object is even built.
    metadata: { query: parsedTitle, lookup: metadata, keyAgreement: key.agreement, keySource: 'chroma' },
    grid: {
      bpm: grid.bpm,
      beatSeconds: grid.beatSeconds,
      phaseSeconds: grid.phaseSeconds,
      downbeatSeconds: grid.downbeatSeconds,
      downbeatOffset: grid.downbeatOffset,
      beatsPerBar: grid.beatsPerBar,
      barSeconds: grid.barSeconds,
      confidence: grid.confidence,
      tempoAgreement: grid.tempoAgreement,
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

  // What the record's own drums/bass/harmony actually sound like - band
  // balance, stereo width, decay - measured against each stem rather than
  // the finished mix, so it isolates exactly what moltek's dry palette is
  // missing. `deriveTrackEffects` turns that into per-layer `.room`/`.lpf`/
  // `.pan`/gain-trim parameters for `emitTrack` below; see sound-match.mjs
  // for the measurement behind each.
  say('measuring the stems against the dry palette')
  const stemProfile = profileStems({ drums: drumBuf, bass: bassBuf, other: otherBuf })
  await fs.promises.writeFile(path.join(dirs.root, 'stem-profile.json'), `${JSON.stringify(stemProfile, null, 2)}\n`)
  const soundMatch = deriveTrackEffects(stemProfile)

  // Time-varying effects the static soundMatch pass above cannot see:
  // sidechain pumping on bass/other, filter sweeps and risers on other -
  // measured against the raw stems and the grid/sections, independent of
  // the note transcription below. See dynamics.mjs for the measurement
  // behind each; `dynamicsForEmission` (further down, once the hearing
  // check has dropped whatever it could not confirm) turns this into the
  // per-section chains emitTrack splices onto the arrangement.
  say('measuring time-varying effects')
  const dynamics = detectDynamics({ drums: drumBuf, bass: bassBuf, other: otherBuf, grid, sections })
  await fs.promises.writeFile(path.join(dirs.root, 'dynamics.json'), `${JSON.stringify(dynamics, null, 2)}\n`)
  const duckedSectionCount = sections.filter((_, i) => dynamics.sidechain.bass[i] || dynamics.sidechain.other[i]).length
  say(
    `  sidechain: ${duckedSectionCount}/${sections.length} sections · ` +
      `sweeps: ${dynamics.sweeps.filter(Boolean).length} · risers: ${dynamics.risers.filter(Boolean).length}`,
  )

  const drums = transcribeDrums(drumBuf, grid, sections)
  // One transcribed bass line, then a register split into a sustained sub
  // voice and the mid-bass line proper - see `splitByRegister`'s own doc
  // comment for where the boundary comes from and why it recolours the same
  // notes by pitch rather than inventing a second voice.
  const { sub, bass } = splitByRegister(transcribeBass(bassBuf, grid, sections))
  const lead = transcribeMelody(otherBuf, grid, sections)

  // Basic Pitch is optional (see tools.mjs). Where installed, it changes two
  // things: the chords layer (below), and, ahead of that, which key the
  // whole track is anchored to. A missing binary, or Basic Pitch producing
  // nothing usable, leaves both exactly as if the tool had never been tried.
  const bassNotes = await transcribeWithBasicPitch(paths.bass, path.join(dirs.root, 'basic-pitch', 'bass'))
  const otherNotes = await transcribeWithBasicPitch(paths.other, path.join(dirs.root, 'basic-pitch', 'other'))

  // Key from the actual transcribed notes, ahead of the whole-clip chroma
  // correlation `profile`/`key` above used: chroma smears bass, harmonics
  // and percussion into one pitch-class estimate, and Krumhansl-Kessler's
  // own profiles are documented to fit minor keys worse than major - see
  // key.mjs's doc comment for both. `detectKeyFromNotes` returns `null` when
  // there is nothing to detect from (no tool, or a bass+other pair with no
  // usable pitched content), in which case `key` is left exactly as the
  // chroma-reconciled value computed above. When it does find something, it
  // goes through the same `reconcileKey` disagreement handling the chroma
  // path already went through, so a metadata mismatch is surfaced the same
  // way regardless of which detector produced the disagreeing answer.
  const noteKey = detectKeyFromNotes(bassNotes ?? [], otherNotes ?? [])
  if (noteKey) {
    key = reconcileKey(noteKey, knownKey)
    // The raw detection, not just the reconciled outcome - mirrors
    // `result.profile.key` (the chroma path's own raw detection, which stays
    // on `result` unconditionally). Without this, a 'disagreement' result
    // (which zeroes `key.name` - see reconcileKey's own doc comment) would
    // leave `reference.json` with no record of what the note-based detector
    // actually found, only that it disagreed with something.
    result.noteKey = noteKey
    result.metadata.keyAgreement = key.agreement
    result.metadata.keySource = 'notes'
    await fs.promises.writeFile(path.join(dirs.root, 'reference.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
  say(`  key: ${key.name ?? '(disagreement - see metadata)'} (confidence ${key.confidence.toFixed(3)}, ${key.agreement}, from ${noteKey ? 'notes' : 'chroma'})`)

  // Measured against the reference track's 462-event ground truth: a
  // note-derived chord read (`transcribeHarmonyFromNotes`) beats the
  // FFT-chroma path
  // (`transcribeHarmony`) on both accuracy and coverage, but the same
  // exercise for bass and lead did not clear their existing DSP paths, so
  // those two are untouched here regardless of whether the tool is present.
  const chords = otherNotes
    ? transcribeHarmonyFromNotes(otherNotes, grid, sections, { key: key.name })
    : transcribeHarmony(otherBuf, grid, sections, { key: key.name })

  const transcription = {
    grid: result.grid,
    key: { name: key.name, confidence: key.confidence },
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
        sub: sub[i],
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

  // Reshaped only now, against the post-hearing-check `transcription.sections`
  // - a layer dynamics measured ducking/sweeping on could still have been
  // dropped above for failing its own hearing check, and `dynamicsForEmission`
  // is what keeps `.orbit()`/`.duckorbit()` off an orbit nothing plays on.
  const dynamicsMatch = dynamicsForEmission(dynamics, transcription.sections, LAYERS)

  // Which synth voice the lead actually gets, measured against the SAME
  // post-hearing-check lead onsets that are about to be emitted - see
  // voice-select.mjs for the measurement and why it never reaches for
  // gm_tenor_sax. `soundMatch.lead.notes` already exists (`deriveTrackEffects`
  // above always fills it for chords/lead), so the voice's own notes join it
  // rather than opening a second header block - `emitTrack`'s
  // `soundMatchHeader` prints exactly one per layer already.
  say('picking the lead voice')
  const leadVoice = deriveLeadVoice(transcription, otherBuf)
  say(`  ${leadVoice.sound} - ${leadVoice.notes[0]}`)
  soundMatch.lead.notes.push(...leadVoice.notes)
  const sounds = resolveSounds({ lead: { sound: leadVoice.sound, suffix: leadVoice.suffix } })
  await fs.promises.writeFile(path.join(dirs.root, 'voice-select.json'), `${JSON.stringify(leadVoice, null, 2)}\n`)

  say('emitting')
  const code = emitTrack(transcription, { title: source.title, source: input, soundMatch, dynamics: dynamicsMatch, sounds })
  const trackPath = outPath ?? path.join(dirs.root, 'track.js')
  await fs.promises.writeFile(trackPath, `${code}\n`)

  say('checking what we wrote')
  const emission = await verifyEmission(code, transcription, { soundMatch, sounds })
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
  result.stemProfile = stemProfile
  result.soundMatch = soundMatch
  result.dynamics = dynamics
  result.voiceSelection = leadVoice

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
