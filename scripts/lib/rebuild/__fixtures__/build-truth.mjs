#!/usr/bin/env node
/**
 * Freeze the ground truth for the-chase.
 *
 * `recordings/2026-07-24T20-04-10-342-the-chase-1ba9.wav` is a render of
 * `tracks/MINUIT/02-the-chase.md`. That makes the track source an exact answer
 * key for everything the transcribers try to recover from the audio: the
 * tempo, the section boundaries and every single note.
 *
 * Loading Strudel is slow and swaps process-wide globals, so the answer key is
 * extracted once here and committed as JSON. Tests read the JSON.
 *
 * Regenerate with:
 *   node scripts/lib/rebuild/__fixtures__/build-truth.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../paths.mjs'
import { extractCode } from '../../../check.mjs'
import { loadStrudel, midiOf, queryEvents } from '../../strudel-node.mjs'

const TRACK = 'tracks/MINUIT/02-the-chase.md'
const OUT = path.join(REPO_ROOT, 'scripts/lib/rebuild/__fixtures__/the-chase-truth.json')

async function main() {
  const file = path.join(REPO_ROOT, TRACK)
  const code = extractCode(fs.readFileSync(file, 'utf8'), file)
  const strudel = await loadStrudel()
  const track = await strudel.evaluateTrack(code)
  if (track.error) throw track.error

  const beatsPerBar = 4
  const cps = track.cps
  const bpm = Math.round(cps * 60 * beatsPerBar)

  // `arrange()` records each entry's bar count as a plain number, so
  // track.sections is [4, 4, 6, ...] and not a list of objects.
  const sectionBars = [...track.sections]
  const boundaries = []
  let cursor = 0
  for (const bars of sectionBars) {
    boundaries.push(cursor)
    cursor += bars
  }
  const bars = cursor

  // Events come from the arranged pattern, NOT from track.layers.
  //
  // `layers()` files every occurrence of a name under that name and stacks
  // them into one representative channel, every occurrence starting at cycle
  // zero - strudel-node.mjs says so in its own comment. That is right for
  // per-layer timbre analysis and useless as a timeline: querying
  // track.layers.get('kick') over 0..101 returns every kick in the track piled
  // onto the first few bars. track.pattern is the arrangement.
  const events = queryEvents(track.pattern, 0, bars)

  const all = []
  const bySound = {}
  for (const event of events) {
    const bar = Math.floor(event.begin)
    const step = Math.round((event.begin - bar) * 16)
    const sound = event.value.s ?? event.value.sound ?? '(note)'
    const record = { bar, step, midi: midiOf(event.value), sound, gain: event.value.gain ?? null }
    all.push(record)
    ;(bySound[sound] ??= []).push(record)
  }

  const truth = { source: TRACK, bpm, beatsPerBar, cps, bars, boundaries, sectionBars, bySound, events: all }
  fs.writeFileSync(OUT, `${JSON.stringify(truth, null, 2)}\n`)

  console.log(`${TRACK}: ${bpm} BPM, ${bars} bars, ${sectionBars.length} sections`)
  console.log(`boundaries: ${boundaries.join(' ')}`)
  console.log(`${all.length} events`)
  for (const [sound, list] of Object.entries(bySound).sort((a, b) => b[1].length - a[1].length)) {
    const pitched = list.filter((record) => record.midi !== null)
    const range = pitched.length
      ? ` midi ${Math.min(...pitched.map((r) => r.midi))}-${Math.max(...pitched.map((r) => r.midi))}`
      : ''
    console.log(`  ${sound.padEnd(16)} ${String(list.length).padStart(5)}${range}`)
  }
  console.log(`written to ${path.relative(REPO_ROOT, OUT)}`)
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
})
