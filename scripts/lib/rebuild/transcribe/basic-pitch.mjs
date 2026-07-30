/**
 * Optional polyphonic transcription via Spotify's Basic Pitch.
 *
 * The DSP transcribers elsewhere in this directory (YIN, harmonic-summation
 * salience, beat-synchronous chroma) top out at 15.4% exact-MIDI against the
 * reference track's 462-event ground truth for the lead - that is the ceiling
 * of classical single-pitch/chroma methods on a stem holding several pitched
 * instruments at once. Basic Pitch, a small polyphonic transcription model,
 * measures 47.8% on the same stem, same events - not a marginal improvement
 * but a different tier of accuracy, because it is not fighting the same
 * structural problem: it estimates the whole vertical set of active notes,
 * not one dominant periodicity. See basic-pitch-report.md for the full
 * measurement, including the null (transposed-pitch) control.
 *
 * This module owns exactly the boundary with that external tool: whether it
 * is installed, how to invoke it, and how to parse and cache what it prints.
 * It is deliberately free of grid/section/selection logic - see bass.mjs's
 * `reduceToLowestVoice`/`transcribeBassFromNotes` and melody.mjs's
 * `selectMelodicLine`/`transcribeMelodyFromNotes` for what each layer does
 * with the notes this returns. It must never throw for a missing binary: an
 * optional tool that isn't installed is an ordinary result, not an error, and
 * every caller falls back to the existing DSP path exactly as it did before
 * this module existed.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { TOOLS, probe } from '../tools.mjs'

/**
 * `output_dir audio_paths...` positionally, per `basic-pitch --help` - no
 * flag for either. `--save-note-events` is the CSV this module parses;
 * `--model-serialization onnx` is required because this pipeline's install
 * instructions only ask for the onnx backend (see `TOOLS.basicPitch.install`)
 * - without it, Basic Pitch tries its serialization auto-detection order
 * (tensorflow, coreml, tensorflow-lite, onnx) and fails outright on an
 * install that only has onnxruntime.
 */
export function basicPitchArgs(outDir, wavPath) {
  return [outDir, wavPath, '--save-note-events', '--model-serialization', 'onnx']
}

/**
 * Where the CSV lands. Basic Pitch names its own output
 * `<input-basename>_basic_pitch.csv` inside `outDir` - not configurable, so
 * this has to match its convention exactly rather than pick a name of its
 * own, both to find the file after a run and to recognise a cache hit before
 * one.
 */
export function basicPitchCsvPath(outDir, wavPath) {
  const base = path.basename(wavPath, path.extname(wavPath))
  return path.join(outDir, `${base}_basic_pitch.csv`)
}

/**
 * Parse Basic Pitch's `--save-note-events` CSV.
 *
 * The header is `start_time_s,end_time_s,pitch_midi,velocity,pitch_bend` -
 * but `pitch_bend` is not one column, it is every remaining column: one
 * sample per analysis frame the note spans, so two notes of different
 * lengths produce rows of different widths. Splitting on `,` and reading a
 * fixed column count would either throw on the long rows or silently read
 * only the first pitch-bend sample as if it were the whole field; this reads
 * only the first four fields by position and ignores everything after,
 * which is correct for both a two-frame grace note and a four-bar pad chord.
 *
 * `velocity` arrives 0-127 (MIDI convention, confirmed against real output);
 * every other velocity/confidence value in this codebase is 0-1, so it is
 * rescaled here rather than carrying a different unit downstream.
 */
export function parseNoteEvents(csvText) {
  const lines = csvText.split('\n')
  const notes = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const comma1 = line.indexOf(',')
    const comma2 = line.indexOf(',', comma1 + 1)
    const comma3 = line.indexOf(',', comma2 + 1)
    let comma4 = line.indexOf(',', comma3 + 1)
    if (comma4 < 0) comma4 = line.length
    if (comma1 < 0 || comma2 < 0 || comma3 < 0) continue

    const startSec = Number(line.slice(0, comma1))
    const endSec = Number(line.slice(comma1 + 1, comma2))
    const midi = Math.round(Number(line.slice(comma2 + 1, comma3)))
    const velocity = Number(line.slice(comma3 + 1, comma4)) / 127
    if (![startSec, endSec, midi, velocity].every(Number.isFinite)) continue
    if (endSec <= startSec) continue

    notes.push({ startSec, endSec, midi, velocity })
  }
  return notes
}

/**
 * A cached CSV is one that exists and holds at least one data row beyond its
 * header - the same shape of guarantee `separate.mjs`'s `cacheComplete` gives
 * for stems, for the same reason: an empty or truncated file from an
 * interrupted run must not read as a cache hit. A byte-size floor alone is
 * not enough here - the header line itself is already 53 bytes - so this
 * counts non-blank lines instead.
 */
export function cacheComplete(csvPath) {
  if (!fs.existsSync(csvPath)) return false
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter((line) => line.trim())
  return lines.length > 1
}

/**
 * Run Basic Pitch on one stem and return its notes - or `null` if the tool
 * is not installed, which every caller must treat as "use the DSP path
 * instead," never as an error. Caches its own CSV: inference is cheap (~9s
 * for a three-minute stem, measured) but not free, and re-running a rebuild
 * on a stem already transcribed should not repeat it.
 *
 * Cache is checked before the tool-presence probe, matching `separate.mjs`'s
 * own ordering: a cache produced by a machine that has since had the tool
 * removed (or never had it - a cache directory copied over) should still be
 * usable without requiring the tool to be present a second time.
 */
export async function transcribeWithBasicPitch(wavPath, outDir) {
  const csvPath = basicPitchCsvPath(outDir, wavPath)
  if (cacheComplete(csvPath)) return parseNoteEvents(await fsp.readFile(csvPath, 'utf8'))

  const { present } = await probe('basicPitch', TOOLS.basicPitch)
  if (!present) return null

  if (!fs.existsSync(wavPath)) throw new Error(`Cannot transcribe, file not found: ${wavPath}`)
  await fsp.mkdir(outDir, { recursive: true })

  await new Promise((resolve, reject) => {
    const child = spawn('basic-pitch', basicPitchArgs(outDir, wavPath), { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const note = (chunk) => {
      tail = `${tail}${chunk}`.slice(-2000)
    }
    child.stdout.on('data', note)
    child.stderr.on('data', note)
    child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('basic-pitch vanished mid-run') : error))
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`basic-pitch exited ${code}\n${tail.trim().split('\n').slice(-5).join('\n')}`))
    })
  })

  if (!cacheComplete(csvPath)) throw new Error(`basic-pitch finished but did not produce ${csvPath}`)
  return parseNoteEvents(await fsp.readFile(csvPath, 'utf8'))
}
