#!/usr/bin/env node
/**
 * Listen to what's playing right now - record a short clip through the
 * browser, analyze it, report what it sounds like. The agent's live ears.
 *
 * Usage:
 *   node scripts/listen.mjs [seconds] [--keep]
 *   node scripts/listen.mjs 12 --expect-bpm 124 --expect-key "F minor"
 *
 * Records `seconds` (default 12) of the current output, prints the analysis,
 * and deletes the clip afterwards (it's a measurement, not a keepsake) unless
 * --keep is passed.
 *
 * State what the track is supposed to be with --expect-bpm / --expect-key and
 * the report says so when the audio disagrees. A key mismatch straight after
 * writing a progression usually means a chord voiced to silence, which
 * scripts/check.mjs will name exactly.
 *
 * Base URL via MOLTEK_URL (default http://localhost:3000).
 */

import fs from 'node:fs'
import path from 'node:path'
import { analyzeWavBuffer, formatReport } from './analyze.mjs'

const BASE = process.env.MOLTEK_URL ?? 'http://localhost:3000'
const POLL_MS = 400
const ACK_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 90_000

const args = process.argv.slice(2)
const keep = args.includes('--keep')

/** Read `--flag value` and `--flag=value` alike. */
function readOption(name) {
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const expectations = { bpm: readOption('expect-bpm'), key: readOption('expect-key') }
// An option's value must not be mistaken for the duration argument.
const optionValues = new Set([expectations.bpm, expectations.key].filter(Boolean))
const durationArg = args.find((a) => !a.startsWith('--') && !optionValues.has(a))
const seconds = Math.min(120, Math.max(3, Number(durationArg) || 12))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, init)
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

const getPhase = async () => (await api('/api/status')).body.recording

/** Best-effort stop so an aborted run can't leave the browser recording forever. */
let recordingStarted = false
async function emergencyStop() {
  if (!recordingStarted) return
  recordingStarted = false
  try {
    await api('/api/record/stop', { method: 'POST' })
  } catch {}
}

process.on('SIGINT', () => {
  emergencyStop().finally(() => process.exit(130))
})
process.on('SIGTERM', () => {
  emergencyStop().finally(() => process.exit(143))
})

async function main() {
  let status
  try {
    status = (await api('/api/status')).body
  } catch {
    console.error(`FAIL: server unreachable at ${BASE} - start it with: pnpm dev`)
    process.exit(1)
  }

  if (!status.browserConnected) {
    console.error('FAIL: no browser tab connected - open http://localhost:3000')
    process.exit(1)
  }
  if (!status.audioReady) {
    console.error('FAIL: audio not unlocked in the browser tab - it needs one click first')
    process.exit(1)
  }
  if (!status.actualPlaying) {
    console.error('WARN: nothing is playing - the clip would be silence. Start playback first.')
    process.exit(1)
  }

  const start = await api('/api/record/start', { method: 'POST' })
  if (!start.res.ok) {
    console.error(`FAIL: could not start recording: ${start.body.error ?? start.res.status}`)
    process.exit(1)
  }
  recordingStarted = true

  try {
    // Don't start the clock until the browser acknowledges it is actually
    // capturing - "starting" only means the command was issued.
    const ackDeadline = Date.now() + ACK_TIMEOUT_MS
    let phase = start.body.recording?.phase
    while (phase === 'starting' && Date.now() < ackDeadline) {
      await sleep(POLL_MS)
      phase = (await getPhase())?.phase
    }
    if (phase !== 'recording') {
      console.error(`FAIL: recording never started (phase: ${phase ?? 'unknown'})`)
      await emergencyStop()
      process.exit(1)
    }

    console.log(`listening for ${seconds}s...`)
    await sleep(seconds * 1000)

    recordingStarted = false
    const stop = await api('/api/record/stop', { method: 'POST' })
    if (!stop.res.ok) {
      console.error(`FAIL: could not stop recording: ${stop.body.error ?? stop.res.status}`)
      process.exit(1)
    }

    // Wait for the browser to encode and upload the WAV.
    const deadline = Date.now() + STOP_TIMEOUT_MS
    let recording = null
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      recording = await getPhase()
      if (recording?.phase === 'done' || recording?.phase === 'error') break
    }

    if (recording?.phase !== 'done') {
      console.error(
        `FAIL: recording never finished (${recording?.phase ?? 'unknown'}: ${recording?.error ?? 'timed out'})`,
      )
      process.exit(1)
    }

    // Fetch the clip over HTTP (works even when MOLTEK_URL points at a
    // server whose recordings/ is not our local filesystem).
    const name = path.basename(recording.file)
    const clipRes = await fetch(`${BASE}/api/recordings/${encodeURIComponent(name)}`)
    if (!clipRes.ok) {
      console.error(`FAIL: could not fetch ${recording.file} (${clipRes.status})`)
      process.exit(1)
    }
    const clip = Buffer.from(await clipRes.arrayBuffer())

    let report
    try {
      report = formatReport(analyzeWavBuffer(clip, expectations), `live clip (${seconds}s)`)
    } catch (err) {
      console.error(`FAIL: could not analyze ${recording.file}: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }

    console.log(report)

    if (keep) {
      console.log(`\nclip kept at ${recording.file}`)
    } else {
      // A measurement, not a keepsake - remove the local file when we can
      // see it (remote servers keep theirs; there is no delete endpoint).
      const localPath = path.join(process.cwd(), recording.file)
      if (fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath)
        } catch {}
      }
    }
  } finally {
    await emergencyStop()
  }
}

main().catch(async (err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`)
  await emergencyStop()
  process.exit(1)
})
