#!/usr/bin/env node
/**
 * Push a Strudel code file to the REPL - no shell escaping, ever.
 *
 * Usage:
 *   node scripts/push.mjs <file> [--play]
 *   node scripts/push.mjs - [--play]        # read code from stdin
 *
 * With --play, waits for the browser to evaluate the push and reports the
 * result, so the caller knows whether the code actually made sound.
 * Base URL via KLAUDE_URL (default http://localhost:3000).
 */

import fs from 'node:fs'

const BASE = process.env.KLAUDE_URL ?? 'http://localhost:3000'
const EVAL_TIMEOUT_MS = 6000
const EVAL_POLL_MS = 300

const args = process.argv.slice(2)
const play = args.includes('--play')
const file = args.find((a) => !a.startsWith('--'))

if (!file) {
  console.error('Usage: node scripts/push.mjs <file|-> [--play]')
  process.exit(2)
}

const code = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let res
  try {
    res = await fetch(`${BASE}/api/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(play ? { code, play: true } : { code }),
    })
  } catch {
    console.error(`FAIL: server unreachable at ${BASE} - start it with: pnpm dev`)
    process.exit(1)
  }

  const pushed = await res.json()
  if (!res.ok) {
    console.error(`FAIL: push rejected (${res.status}): ${pushed.error}`)
    process.exit(1)
  }

  console.log(`pushed revision ${pushed.revision} (${code.length} chars)${play ? ', playing...' : ''}`)

  if (!play) return

  // Wait for the browser to evaluate EXACTLY this push (matching the
  // revision and play epoch our POST returned - a concurrent push's result
  // must not be mistaken for ours).
  const deadline = Date.now() + EVAL_TIMEOUT_MS
  let status = null
  const isOurs = (e) => e && e.revision === pushed.revision && e.playEpoch === pushed.playEpoch
  while (Date.now() < deadline) {
    await sleep(EVAL_POLL_MS)
    status = await fetch(`${BASE}/api/status`).then((r) => r.json())
    if (isOurs(status.lastEval)) break
  }

  if (!status?.browserConnected) {
    console.error('WARN: no browser tab connected - nothing can play. Open http://localhost:3000')
    process.exit(1)
  }
  if (!isOurs(status.lastEval)) {
    console.error('WARN: browser has not evaluated this push yet (no matching eval report)')
    process.exit(1)
  }
  if (!status.lastEval.ok) {
    console.error(`FAIL: evaluation error: ${status.lastEval.error}`)
    process.exit(1)
  }
  console.log('OK: playing')
}

main()
