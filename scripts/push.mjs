#!/usr/bin/env node
/**
 * Push a Strudel code file to the REPL - no shell escaping, ever.
 *
 * Usage:
 *   node scripts/push.mjs <file> [--play] [--no-check]
 *   node scripts/push.mjs - [--play]        # read code from stdin
 *
 * With --play, waits for the browser to evaluate the push and reports the
 * result, so the caller knows whether the code actually made sound.
 *
 * Before pushing, the code is checked headlessly for the faults that make no
 * noise and raise no error - a chord spelling that voices to silence, a
 * sidechain pointed at its own bus, a sample pack that was never loaded.
 * Warnings are printed and the push continues; errors stop it, because pushing
 * a track whose harmony is missing wastes the listen that follows. --no-check
 * skips this.
 *
 * Base URL via MOLTEK_URL (default http://localhost:3000).
 */

import fs from 'node:fs'

const BASE = process.env.MOLTEK_URL ?? 'http://localhost:3000'
const EVAL_TIMEOUT_MS = 6000
const EVAL_POLL_MS = 300

const args = process.argv.slice(2)
const play = args.includes('--play')
const skipCheck = args.includes('--no-check')
const file = args.find((a) => !a.startsWith('--'))

if (!file) {
  console.error('Usage: node scripts/push.mjs <file|-> [--play] [--no-check]')
  process.exit(2)
}

const code = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Lint the code before it leaves. Loading the headless Strudel runtime is the
 * slow part, so it is imported lazily and never blocks a --no-check push.
 * A check that cannot run must not stop a push: the REPL is the authority.
 */
async function precheck(code) {
  let strudel
  let checkFile
  try {
    ;[{ loadStrudel: strudel }, { checkFile }] = await Promise.all([
      import('./lib/strudel-node.mjs'),
      import('./check.mjs'),
    ])
    strudel = await strudel()
  } catch (err) {
    console.error(`WARN: pre-push check unavailable (${err instanceof Error ? err.message : err})`)
    return true
  }

  const { findings } = await checkFile(strudel, '(push)', code)
  const errors = findings.items.filter((i) => i.severity === 'error')
  const warnings = findings.items.filter((i) => i.severity === 'warn')

  for (const item of warnings) console.error(`WARN  [${item.rule}] ${item.message}`)
  for (const item of errors) {
    console.error(`FAIL  [${item.rule}] ${item.message}`)
    if (item.detail) console.error(`      -> ${item.detail}`)
  }
  if (errors.length > 0) {
    console.error(`\nnot pushed - fix the ${errors.length} error(s) above, or pass --no-check to override`)
    return false
  }
  return true
}

async function main() {
  if (!skipCheck && !(await precheck(code))) process.exit(1)

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
