#!/usr/bin/env node
/**
 * API smoke test against a RUNNING klaude server (pnpm dev).
 *
 * Exercises the server-side protocol: push/revision, history/restore, gain,
 * nowplaying, play/stop epochs, and input validation. Restores previous code
 * and gain when done. Browser-dependent behavior (eval reports, recording)
 * needs a connected tab and is covered by the browser end-to-end pass.
 *
 * Note: if a browser tab is connected and playing, the test pushes briefly
 * change what's audible before the original code is restored.
 *
 * Usage: node scripts/smoke.mjs
 */

const BASE = process.env.KLAUDE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' }
const post = (url, body) =>
  fetch(`${BASE}${url}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
const get = (url) => fetch(`${BASE}${url}`)

async function main() {
  let initial
  try {
    initial = await get('/api/status').then((r) => r.json())
  } catch {
    console.error(`server unreachable at ${BASE} - start it with: pnpm dev`)
    process.exit(1)
  }

  console.log('status:')
  check('status has revision', typeof initial.revision === 'number')
  check('status has desiredPlaying', typeof initial.desiredPlaying === 'boolean')
  check('status has actualPlaying', typeof initial.actualPlaying === 'boolean')
  check('status has clients array', Array.isArray(initial.clients))
  check('status has recording phase', typeof initial.recording?.phase === 'string')
  check(
    'status has mix state',
    Array.isArray(initial.mix?.muted) && Array.isArray(initial.mix?.soloed) && typeof initial.mix?.seq === 'number',
  )
  check('status has layers array', Array.isArray(initial.layers))

  console.log('code push:')
  const marker = `// smoke-test ${Math.random().toString(36).slice(2)}\n$: s("bd")`
  const pushRes = await post('/api/code', { code: marker })
  const pushBody = await pushRes.json()
  check('push accepted', pushRes.ok)
  check('revision bumped', pushBody.revision === initial.revision + 1, `got ${pushBody.revision}`)

  const afterPush = await get('/api/code').then((r) => r.json())
  check('GET /api/code returns pushed code', afterPush.code === marker)

  console.log('validation:')
  const badJson = await fetch(`${BASE}/api/code`, { method: 'POST', headers: jsonHeaders, body: '{nope' })
  check('malformed JSON is 400', badJson.status === 400)
  const badCode = await post('/api/code', { code: 42 })
  check('non-string code is 400', badCode.status === 400)
  const badGain = await post('/api/gain', {})
  check('gain without level is 400', badGain.status === 400)
  const missingRev = await get('/api/history?revision=99999999')
  check('unknown history revision is 404', missingRev.status === 404)

  console.log('history:')
  const history = await get('/api/history').then((r) => r.json())
  check('history lists entries', Array.isArray(history.entries) && history.entries.length >= 1)
  check(
    'history contains pushed revision',
    history.entries.some((e) => e.revision === pushBody.revision),
  )
  const restoreRes = await post('/api/history', { revision: initial.revision })
  const restoreBody = await restoreRes.json()
  check('restore accepted', restoreRes.ok)
  check('restore creates new revision', restoreBody.revision > pushBody.revision)
  const afterRestore = await get('/api/code').then((r) => r.json())
  check('restored code matches original', afterRestore.code === initial.code)

  console.log('gain:')
  const gainRes = await post('/api/gain', { level: 0.5, rampMs: 100 }).then((r) => r.json())
  check('gain seq bumped', gainRes.gain.seq === initial.gain.seq + 1)
  check('gain level clamped/stored', gainRes.gain.level === 0.5)
  const gainClamp = await post('/api/gain', { level: 7 }).then((r) => r.json())
  check('gain clamps above 1', gainClamp.gain.level === 1)

  console.log('nowplaying:')
  const npRes = await post('/api/nowplaying', { title: 'Smoke Test', section: 'verify' }).then((r) => r.json())
  check('nowplaying set', npRes.nowPlaying?.title === 'Smoke Test')
  check('nowplaying stamps since', typeof npRes.nowPlaying?.since === 'number')
  check('nowplaying starts trail', npRes.nowPlaying?.trail?.length === 1)
  const npPatch = await post('/api/nowplaying', { section: 'done' }).then((r) => r.json())
  check('nowplaying patch keeps title', npPatch.nowPlaying?.title === 'Smoke Test')
  check('nowplaying patch updates section', npPatch.nowPlaying?.section === 'done')
  check('section change extends trail', npPatch.nowPlaying?.trail?.length === 2)
  check('section change keeps since', npPatch.nowPlaying?.since === npRes.nowPlaying?.since)
  const npNew = await post('/api/nowplaying', { title: 'Another Piece', section: 'intro' }).then((r) => r.json())
  check('new title resets trail', npNew.nowPlaying?.trail?.length === 1)
  const npClear = await fetch(`${BASE}/api/nowplaying`, { method: 'DELETE' }).then((r) => r.json())
  check('nowplaying cleared', npClear.nowPlaying === null)

  console.log('mix:')
  const mix0 = await get('/api/mix').then((r) => r.json())
  check('GET /api/mix returns mix + layers', Array.isArray(mix0.mix?.muted) && Array.isArray(mix0.layers))
  const mixSet = await post('/api/mix', { muted: ['bass'], soloed: ['hats'] }).then((r) => r.json())
  check('mix set bumps seq', mixSet.mix.seq === mix0.mix.seq + 1)
  check('mix stores muted', mixSet.mix.muted.includes('bass'))
  check('mix stores soloed', mixSet.mix.soloed.includes('hats'))
  const badMix = await post('/api/mix', { muted: 'bass' })
  check('non-array mix field is 400', badMix.status === 400)
  const emptyMix = await post('/api/mix', {})
  check('empty mix patch is 400', emptyMix.status === 400)
  await post('/api/code', { code: marker + '\n// mix probe' })
  const mixAfter = await get('/api/mix').then((r) => r.json())
  check('push clears solo', mixAfter.mix.soloed.length === 0)
  check('push preserves mutes', mixAfter.mix.muted.includes('bass'))
  check('push bumps mix seq (solo cleared)', mixAfter.mix.seq > mixSet.mix.seq)
  await post('/api/mix', { muted: mix0.mix.muted, soloed: [] })
  await post('/api/history', { revision: initial.revision })

  console.log('reactions:')
  const preReactions = await get('/api/reactions').then((r) => r.json())
  const reactRes = await post('/api/reactions', { kind: 'fire' })
  const reactBody = await reactRes.json()
  check('reaction accepted', reactRes.ok && reactBody.reaction?.kind === 'fire')
  check('reaction tagged with revision', typeof reactBody.reaction?.revision === 'number')
  const badReact = await post('/api/reactions', { kind: 'nonsense' })
  check('invalid reaction kind is 400', badReact.status === 400)
  const reactList = await get('/api/reactions').then((r) => r.json())
  check(
    'reactions listed',
    Array.isArray(reactList.reactions) && reactList.reactions.some((x) => x.at === reactBody.reaction.at),
  )
  const statusReactions = await get('/api/status').then((r) => r.json())
  check('status includes recentReactions', Array.isArray(statusReactions.recentReactions))
  if (preReactions.reactions.length === 0) {
    // The room was empty before the test - clean up our fake reaction so an
    // agent can't mistake it for listener feedback. (With real reactions
    // present we leave everything: clearing would erase them too.)
    const clearRes = await fetch(`${BASE}/api/reactions`, { method: 'DELETE' })
    const cleared = await clearRes.json()
    check('reactions cleared', clearRes.ok && cleared.reactions.length === 0)
  }

  console.log('play/stop:')
  const playRes = await post('/api/play', {}).then((r) => r.json())
  check('play sets desiredPlaying', playRes.desiredPlaying === true)
  const playAgain = await post('/api/play', {}).then((r) => r.json())
  check('repeat play bumps epoch (forces re-eval)', playAgain.playEpoch === playRes.playEpoch + 1)
  const stopRes = await post('/api/stop', {}).then((r) => r.json())
  check('stop clears desiredPlaying', stopRes.desiredPlaying === false)
  const afterStop = await get('/api/status').then((r) => r.json())
  check('stop cleared nowPlaying', afterStop.nowPlaying === null)

  console.log('recordings:')
  const recList = await get('/api/recordings').then((r) => r.json())
  check('recordings lists', Array.isArray(recList.recordings))
  const recNoClient = await post('/api/record/stop', {})
  check('record stop while idle is 409', recNoClient.status === 409)
  const recTraversal = await get('/api/recordings/..%2F..%2Fpackage.json')
  check('recording file traversal is 400', recTraversal.status === 400)
  const recMissing = await get('/api/recordings/nope-not-here.wav')
  check('missing recording file is 404', recMissing.status === 404)
  if (recList.recordings.length > 0) {
    // Check headers only, then abort - recordings can be tens of MB
    const ctl = new AbortController()
    const first = recList.recordings[0]
    const recFile = await fetch(`${BASE}/api/recordings/${encodeURIComponent(first.name)}`, {
      signal: ctl.signal,
    })
    check(
      'recording file streams as wav',
      recFile.ok && recFile.headers.get('content-type') === 'audio/wav',
    )
    ctl.abort()
  }

  // Restore starting state
  await post('/api/gain', { level: initial.gain.level })
  if (initial.desiredPlaying) await post('/api/play', {})

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
