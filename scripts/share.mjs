#!/usr/bin/env node
/**
 * Generate a strudel.cc share link for a code file or the current REPL code.
 *
 * Usage:
 *   node scripts/share.mjs [file]     # no file: shares what's in the REPL now
 *
 * Encoding matches @strudel/core's code2hash: base64 of the UTF-8 bytes,
 * URI-encoded, in the URL fragment. Caveats: strudel.cc runs the latest
 * Strudel (behavior can drift from the pinned local version), and local
 * samples from this machine won't resolve there.
 */

import fs from 'node:fs'

const BASE = process.env.MOLTEK_URL ?? 'http://localhost:3000'
const file = process.argv[2]

async function main() {
  let code
  if (file) {
    code = fs.readFileSync(file, 'utf8')
  } else {
    try {
      const res = await fetch(`${BASE}/api/code`)
      code = (await res.json()).code
    } catch {
      console.error(`FAIL: server unreachable at ${BASE} - pass a file or start the server`)
      process.exit(1)
    }
  }

  const hash = encodeURIComponent(Buffer.from(code, 'utf8').toString('base64'))
  console.log(`https://strudel.cc/#${hash}`)
}

main()
