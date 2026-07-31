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
 * not one dominant periodicity. Measured against the null (transposed-pitch)
 * control too, to confirm the gap is real signal, not an artefact of the
 * comparison.
 *
 * This module owns exactly the boundary with that external tool: whether it
 * is installed, how to invoke it, and how to parse and cache what it prints.
 * It is deliberately free of grid/section/selection logic - see bass.mjs's
 * `reduceToLowestVoice`/`transcribeBassFromNotes` and melody.mjs's
 * `selectMelodicLine`/`transcribeMelodyFromNotes` for what each layer does
 * with the notes this returns. It must never throw for the tool being
 * optional: a missing binary, a hung process, a broken install that exits
 * non-zero, or output in a shape this parser no longer recognises are all
 * ordinary results, not errors, and every caller falls back to the existing
 * DSP path exactly as it did before this module existed. The one path that
 * can still throw is a caller bug (the input WAV genuinely not existing on
 * disk) - reached only once the tool is confirmed present, since a missing
 * binary already returns `null` before that check runs, so "the tool is
 * unavailable" can never be the reason this throws. A missing WAV is this
 * pipeline being wrong about its own state, not basic-pitch being
 * unavailable, and degrading it the same way would hide a real defect behind
 * a quiet accuracy loss instead of a clear failure.
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
 * The first four column names `--save-note-events` is documented to
 * produce. Checked once, up front, rather than trusted implicitly - see
 * `parseNoteEvents`'s own doc comment for why a silent column reorder is
 * worse than an explicit failure here.
 */
const EXPECTED_HEADER_FIELDS = ['start_time_s', 'end_time_s', 'pitch_midi', 'velocity']

/** Thrown by `parseNoteEvents` when a CSV's header does not start with the
 *  four columns this parser assumes. Named so a caller can recognise "the
 *  tool's output shape changed" specifically, rather than treating it as an
 *  ordinary parse failure. */
export class BasicPitchHeaderError extends Error {
  constructor(actualHeader) {
    super(
      `basic-pitch CSV header does not start with ${EXPECTED_HEADER_FIELDS.join(',')} (got "${actualHeader}") - ` +
        'the column layout this parser assumes may have changed in a newer basic-pitch release',
    )
    this.name = 'BasicPitchHeaderError'
  }
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
 * The first four fields are read positionally, by column *index*, not by
 * name - so before doing that at all, the header is checked to actually be
 * `EXPECTED_HEADER_FIELDS` in that order. Without this, a future Basic Pitch
 * version that reorders or inserts a column would have every row still pass
 * the `Number.isFinite`/`endSec > startSec` sanity checks below - the wrong
 * column just becomes a differently-shaped but equally plausible-looking
 * number - and wrong notes would flow into transcription with no error
 * anywhere. Checked once against the header, not per row: the shape either
 * holds for the whole file or it does not, and re-checking every row would
 * only add cost without adding any ability to catch something new.
 *
 * `velocity` arrives 0-127 (MIDI convention, confirmed against real output);
 * every other velocity/confidence value in this codebase is 0-1, so it is
 * rescaled here rather than carrying a different unit downstream.
 */
export function parseNoteEvents(csvText) {
  const lines = csvText.split('\n')
  const header = lines[0] ?? ''
  const headerFields = header.split(',').slice(0, EXPECTED_HEADER_FIELDS.length).map((field) => field.trim())
  if (!EXPECTED_HEADER_FIELDS.every((field, i) => field === headerFields[i])) {
    throw new BasicPitchHeaderError(header)
  }

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
 * How long to wait for one `basic-pitch` invocation before treating it as
 * hung and killing it. A reasoned ceiling, not a measurement of the worst
 * case: real runtime measures ~9s for a three-minute stem (see the module
 * doc comment), so this leaves roughly 30x headroom for a much longer track
 * on a slow, loaded machine, while still bounding a genuinely stuck process
 * (a wedged ONNX runtime has no other way to end) instead of hanging the
 * whole rebuild forever with no diagnostic - `probe`'s own tool-presence
 * check (`tools.mjs`) uses the same kind of hard ceiling for the same reason.
 */
const BASIC_PITCH_TIMEOUT_MS = 5 * 60 * 1000

/** Run one `basic-pitch` invocation to completion, or reject - on a non-zero
 *  exit, the process vanishing, or `timeoutMs` elapsing with nothing back.
 *  `timeoutMs` is a parameter (not just the module constant baked in
 *  directly) so a test can exercise the timeout path in milliseconds rather
 *  than actually waiting `BASIC_PITCH_TIMEOUT_MS`. */
function runBasicPitch(wavPath, outDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('basic-pitch', basicPitchArgs(outDir, wavPath), { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const note = (chunk) => {
      tail = `${tail}${chunk}`.slice(-2000)
    }
    child.stdout.on('data', note)
    child.stderr.on('data', note)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      // Reject immediately rather than waiting for the 'close' event below:
      // a genuinely hung process can have forked children that inherited the
      // same stdout/stderr pipes, which stay open (and 'close' with them)
      // even after this process itself is killed - waiting for it would
      // defeat the very timeout meant to bound the wait. A Promise only
      // settles once, so 'close' still firing later (whether from this kill
      // or a late, unrelated exit) is a harmless no-op against an
      // already-rejected promise.
      reject(new Error(`basic-pitch did not finish within ${timeoutMs}ms and was killed`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? new Error('basic-pitch vanished mid-run') : error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      reject(new Error(`basic-pitch exited ${code}\n${tail.trim().split('\n').slice(-5).join('\n')}`))
    })
  })
}

/**
 * Run Basic Pitch on one stem and return its notes - or `null` if the tool
 * is not usable at all, which every caller must treat as "use the DSP path
 * instead," never as an error. That covers a missing binary just as much as
 * one that is present but broken: an install that passes `probe()` (its
 * `--help` still prints a banner) but fails on the real invocation - a stale
 * checkpoint, an incompatible onnxruntime, a process that never exits, a CSV
 * shape this parser no longer recognises - must degrade exactly the same
 * way, per this module's own doc comment. The failure is not swallowed
 * silently, only downgraded from fatal to a logged warning, so a real,
 * fixable install problem stays visible without taking the whole rebuild
 * down with it.
 *
 * Caches its own CSV: inference is cheap (~9s for a three-minute stem,
 * measured) but not free, and re-running a rebuild on a stem already
 * transcribed should not repeat it.
 *
 * Cache is checked before the tool-presence probe, matching `separate.mjs`'s
 * own ordering: a cache produced by a machine that has since had the tool
 * removed (or never had it - a cache directory copied over) should still be
 * usable without requiring the tool to be present a second time. A cache
 * that fails to parse (the same header-drift or corruption a fresh run could
 * hit) degrades the same way as a fresh run failing, rather than throwing.
 */
export async function transcribeWithBasicPitch(wavPath, outDir, { timeoutMs = BASIC_PITCH_TIMEOUT_MS } = {}) {
  const csvPath = basicPitchCsvPath(outDir, wavPath)

  try {
    if (cacheComplete(csvPath)) return parseNoteEvents(await fsp.readFile(csvPath, 'utf8'))
  } catch (error) {
    console.error(`basic-pitch cache at ${csvPath} looks corrupt (${error.message}); continuing without it`)
    return null
  }

  const { present } = await probe('basicPitch', TOOLS.basicPitch)
  if (!present) return null

  if (!fs.existsSync(wavPath)) throw new Error(`Cannot transcribe, file not found: ${wavPath}`)
  await fsp.mkdir(outDir, { recursive: true })

  try {
    await runBasicPitch(wavPath, outDir, timeoutMs)
    if (!cacheComplete(csvPath)) throw new Error(`basic-pitch finished but did not produce ${csvPath}`)
    return parseNoteEvents(await fsp.readFile(csvPath, 'utf8'))
  } catch (error) {
    console.error(`basic-pitch is installed but failed (${error.message}); continuing without it`)
    return null
  }
}
