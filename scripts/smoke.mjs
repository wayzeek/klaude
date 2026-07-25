#!/usr/bin/env node
/**
 * API smoke test against a RUNNING moltek server (pnpm dev).
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

import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.MOLTEK_URL ?? 'http://localhost:3000'

/** Smallest valid 16-bit stereo WAV - stands in for a real bounce. */
function silentWav(frames = 64) {
  const bytes = frames * 4
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(44100 * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)
  return buf
}

let passed = 0
let failed = 0
let skipped = 0

/** Coverage that did not run. Not a failure, but never silently a pass. */
function skip(name, why) {
  skipped++
  console.log(`  SKIP  ${name} - ${why}`)
}

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

/** Open an SSE stream and hold it, so the server counts a live connection. */
async function openStream(clientId) {
  const ctl = new AbortController()
  const res = await fetch(`${BASE}/api/events?clientId=${clientId}`, { signal: ctl.signal })
  const reader = res.body.getReader()
  void reader.read().catch(() => {})
  return {
    close: async () => {
      ctl.abort()
      // give the route's cancel() a moment to run unregisterClient
      await new Promise((r) => setTimeout(r, 250))
    },
  }
}

/**
 * Open an SSE stream and keep the frames it receives. openStream above
 * deliberately discards what it reads, since its job is only to make the server
 * count a live connection. The route sends state as `data: {...}\n\n`, plus
 * `: heartbeat\n\n` comments which are not frames and are skipped.
 */
async function collectFrames(clientId) {
  const ctl = new AbortController()
  const res = await fetch(`${BASE}/api/events?clientId=${clientId}`, { signal: ctl.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          if (chunk.startsWith('data:')) frames.push(chunk.slice(5).trim())
        }
      }
    } catch {
      // aborted on close
    }
  })()
  return {
    frames,
    close: async () => {
      ctl.abort()
      await new Promise((resolve) => setTimeout(resolve, 250))
    },
  }
}

/**
 * A long recording outlives the identity the browser had when it started:
 * the tab's clientId is minted per React mount, so a remount (or an SSE
 * teardown) replaces it. The take is still buffered in the tab, so stopping
 * must still reach it. Regression test for takes lost to
 * "Recording tab disconnected".
 */
async function recordingSurvivesIdentityChange() {
  const before = await get('/api/status').then((r) => r.json())
  if (before.recording.phase === 'starting' || before.recording.phase === 'recording') {
    skip('recording survives an identity change', 'a recording is already in progress')
    return
  }

  const oldId = `smoke-old-${Date.now()}`
  const newId = `smoke-new-${Date.now()}`
  const oldStream = await openStream(oldId)
  let newStream
  let uploaded = null
  try {
    // Make the fake tab the freshest audioReady client so record-start picks it
    // rather than a real browser tab (whose heartbeat is up to 10s stale).
    await post('/api/clients', { clientId: oldId, editorReady: true, audioReady: true })
    const started = await post('/api/record/start', {})
    if (!started.ok) {
      skip('recording survives an identity change', `record start unavailable (${started.status})`)
      return
    }
    // A real tab could have won the pick; stopping it would capture actual
    // audio and leave a stray WAV, so only continue if we own the take.
    const owner = (await started.json()).recording?.clientId
    if (owner !== oldId) {
      skip('recording survives an identity change', 'a real browser tab owns this recording')
      await post('/api/record/stop', {}).catch(() => {})
      return
    }

    // The tab remounts: a new identity appears, the old stream goes away.
    newStream = await openStream(newId)
    await post('/api/clients', { clientId: newId, editorReady: true, audioReady: true })
    await oldStream.close()

    const gone = await get('/api/status').then((r) => r.json())
    check(
      'the starting client id is no longer registered',
      !gone.clients.some((c) => c.id === oldId),
    )

    const stopped = await post('/api/record/stop', {})
    const stopBody = await stopped.json().catch(() => null)
    check(
      'record stop reaches the tab after an identity change',
      stopped.ok,
      `got ${stopped.status}: ${JSON.stringify(stopBody)}`,
    )
    // Not just "some client was found" - it must be the surviving identity,
    // and the recording must now name it so its ack validates.
    check(
      'stop is re-routed to the surviving identity',
      stopBody?.recording?.clientId === newId,
      `recording.clientId is ${stopBody?.recording?.clientId}`,
    )

    // Finish the handshake the way a real tab does. This also leaves the
    // recording state machine idle - a stop that nobody honors would sit in
    // "stopping" and block the next recording until it times out.
    // While the take is still in flight, a tab that does not own it must not
    // be able to complete it. This has to run before the real upload, or the
    // phase check would reject it and prove nothing.
    const foreign = await fetch(`${BASE}/api/recordings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Recording-Name': 'smoke-foreign',
        'X-Recording-Client': 'someone-elses-tab',
      },
      body: silentWav(),
    })
    check('an upload from another tab is refused', foreign.status === 409)

    const unclaimed = await fetch(`${BASE}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Recording-Name': 'smoke-unclaimed' },
      body: silentWav(),
    })
    check('an upload that claims no owner is refused', unclaimed.status === 409)

    const upload = await fetch(`${BASE}/api/recordings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Recording-Name': 'smoke-test',
        'X-Recording-Client': newId,
      },
      body: silentWav(),
    })
    check('the finished take uploads', upload.ok)
    if (upload.ok) {
      const { file } = await upload.json()
      uploaded = file
      const done = await get('/api/status').then((r) => r.json())
      check('recording ends in done, not wedged', done.recording.phase === 'done')
    }
  } finally {
    if (newStream) await newStream.close()
    await oldStream.close().catch(() => {})
    // Don't leave the test's placeholder WAV in the user's recordings/
    if (uploaded) {
      try {
        fs.unlinkSync(path.join(process.cwd(), uploaded))
      } catch {
        console.log(`  note  could not remove ${uploaded}`)
      }
    }
  }
}

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
  // setMix no longer bumps seq for a patch that changes nothing, so this block
  // cannot assume anything about the server's current mix. Reset, then read.
  await post('/api/mix', { muted: [], soloed: [] })
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
  const badToggle = await post('/api/mix', { toggleMuted: 42 })
  check('non-string toggle is 400', badToggle.status === 400)
  // Toggles flip against server state - two toggles from the same snapshot both land
  const tog1 = await post('/api/mix', { toggleMuted: 'kick' }).then((r) => r.json())
  const tog2 = await post('/api/mix', { toggleMuted: 'pad' }).then((r) => r.json())
  check('first toggle lands', tog2.mix.muted.includes('kick'))
  check('second toggle lands alongside', tog2.mix.muted.includes('pad'))
  const tog3 = await post('/api/mix', { toggleMuted: 'kick' }).then((r) => r.json())
  check('re-toggle removes the name', !tog3.mix.muted.includes('kick') && tog3.mix.muted.includes('pad'))
  check('toggles bump seq each time', tog3.mix.seq === tog1.mix.seq + 2)
  // Solo and mute are exclusive per layer - toggling one on kicks the other off
  const excl1 = await post('/api/mix', { toggleSoloed: 'pad' }).then((r) => r.json())
  check('soloing a muted layer unmutes it', excl1.mix.soloed.includes('pad') && !excl1.mix.muted.includes('pad'))
  const excl2 = await post('/api/mix', { toggleMuted: 'pad' }).then((r) => r.json())
  check('muting a soloed layer unsolos it', excl2.mix.muted.includes('pad') && !excl2.mix.soloed.includes('pad'))
  // restore the state the push checks below expect
  await post('/api/mix', { muted: ['bass'], soloed: ['hats'] })
  await post('/api/code', { code: marker + '\n// mix probe' })
  const mixAfter = await get('/api/mix').then((r) => r.json())
  check('push clears solo', mixAfter.mix.soloed.length === 0)
  check('push preserves mutes', mixAfter.mix.muted.includes('bass'))
  check('push bumps mix seq (solo cleared)', mixAfter.mix.seq > mixSet.mix.seq)
  await post('/api/mix', { muted: mix0.mix.muted, soloed: [] })
  await post('/api/history', { revision: initial.revision })

  console.log('trims:')
  // Deterministic starting point. Persisted state means we cannot assume neutral.
  await post('/api/mix', { muted: [], soloed: [] })
  await post('/api/mix', { resetAllTrims: true })
  const t0 = await get('/api/mix').then((r) => r.json())
  // Use layer names the loaded track actually contains. A connected browser
  // prunes trims for names that are not in the track, which would delete these
  // fixtures mid-test and emit an extra SSE frame - so hardcoded names make
  // these checks pass only while no tab is attached.
  const [layerA, layerB] = t0.layers.length >= 2 ? t0.layers : ['bass', 'keys']
  check('mix exposes trims', t0.mix.trims !== null && typeof t0.mix.trims === 'object')
  check('mix exposes structuralSeq', typeof t0.mix.structuralSeq === 'number')

  // A value-only patch moves seq but NOT structuralSeq. This is the check that
  // protects the live fader: a moving structuralSeq means re-evaluation.
  const vol = await post('/api/mix', { trim: { layer: layerA, volume: 0.5 } }).then((r) => r.json())
  check('trim stores the value', vol.mix.trims[layerA]?.volume === 0.5, JSON.stringify(vol.mix.trims[layerA]))
  check('trim leaves other values neutral', vol.mix.trims[layerA]?.tone === 0)
  check('value trim bumps seq', vol.mix.seq === t0.mix.seq + 1)
  check(
    'value trim does not bump structuralSeq',
    vol.mix.structuralSeq === t0.mix.structuralSeq,
    `${t0.mix.structuralSeq} -> ${vol.mix.structuralSeq}`,
  )

  // A structural patch moves both.
  const swung = await post('/api/mix', { trim: { layer: layerA, swing: 0.5 } }).then((r) => r.json())
  check('swing trim bumps structuralSeq', swung.mix.structuralSeq === vol.mix.structuralSeq + 1)
  check('swing trim preserves the earlier volume', swung.mix.trims[layerA]?.volume === 0.5)

  // A no-op patch moves neither counter.
  const noop = await post('/api/mix', { trim: { layer: layerA, volume: 0.5 } }).then((r) => r.json())
  check('no-op trim does not bump seq', noop.mix.seq === swung.mix.seq, `${swung.mix.seq} -> ${noop.mix.seq}`)
  check('no-op trim does not bump structuralSeq', noop.mix.structuralSeq === swung.mix.structuralSeq)

  // Out-of-range clamps, junk is refused.
  const clamped = await post('/api/mix', { trim: { layer: layerA, volume: 99, tone: -99 } }).then((r) => r.json())
  check('volume clamps to 2', clamped.mix.trims[layerA]?.volume === 2)
  check('tone clamps to -1', clamped.mix.trims[layerA]?.tone === -1)
  const badTrim = await post('/api/mix', { trim: { layer: layerA, volume: 'loud' } })
  check('non-numeric trim value is 400', badTrim.status === 400)
  const noLayer = await post('/api/mix', { trim: { volume: 0.5 } })
  check('trim without a layer is 400', noLayer.status === 400)
  const unknownControl = await post('/api/mix', { trim: { layer: layerA, wobble: 0.5 } })
  check('unknown trim control is 400', unknownControl.status === 400)

  // One request may carry a trim and a mute together, as ONE mutation with ONE
  // SSE emission. Counting seq cannot show that, so watch the stream.
  const stream = await collectFrames('smoke-combined')
  await new Promise((resolve) => setTimeout(resolve, 300)) // let the initial snapshot land
  const framesBefore = stream.frames.length
  const combined = await post('/api/mix', {
    trim: { layer: layerB, space: 0.5 },
    toggleMuted: layerB,
  }).then((r) => r.json())
  check('combined patch stores the trim', combined.mix.trims[layerB]?.space === 0.5)
  check('combined patch applies the mute', combined.mix.muted.includes(layerB))
  check('combined patch bumps seq once', combined.mix.seq === clamped.mix.seq + 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(
    'combined patch emits once',
    stream.frames.length === framesBefore + 1,
    `${stream.frames.length - framesBefore} frames`,
  )
  await stream.close()

  // Reset drops the record entirely, and so does returning every value to neutral.
  const reset = await post('/api/mix', { resetTrim: layerA }).then((r) => r.json())
  check('reset drops the record', reset.mix.trims[layerA] === undefined, JSON.stringify(reset.mix.trims))
  const backToNeutral = await post('/api/mix', { trim: { layer: layerB, space: 0 } }).then((r) => r.json())
  check('returning to neutral drops the record', backToNeutral.mix.trims[layerB] === undefined)

  // Solo wins over mute, so a name must never be stored in both. A wholesale
  // POST naming the same layer in each would otherwise leave it audible (solo
  // takes precedence at playback) while its row showed it muted and struck
  // through, and clearing the solo later would silence it for a reason the
  // listener never chose.
  const both = await post('/api/mix', { muted: [layerA], soloed: [layerA] }).then((r) => r.json())
  check('solo removes the name from muted', !both.mix.muted.includes(layerA), JSON.stringify(both.mix))
  check('solo itself is kept', both.mix.soloed.includes(layerA))
  await post('/api/mix', { muted: [], soloed: [] })

  // soloOnly is the exclusive-solo gesture: it MOVES the solo rather than
  // accumulating, so one call isolates a layer whatever else was soloed. The
  // console's button is the additive toggle instead - solo there stacks.
  await post('/api/mix', { soloed: [] })
  const soloA = await post('/api/mix', { soloOnly: layerA }).then((r) => r.json())
  check('soloOnly isolates one layer', soloA.mix.soloed.join(',') === layerA, JSON.stringify(soloA.mix.soloed))
  const soloB = await post('/api/mix', { soloOnly: layerB }).then((r) => r.json())
  check('soloOnly moves rather than accumulates', soloB.mix.soloed.join(',') === layerB, JSON.stringify(soloB.mix.soloed))
  const soloOff = await post('/api/mix', { soloOnly: layerB }).then((r) => r.json())
  check('soloOnly on the lone soloed layer clears it', soloOff.mix.soloed.length === 0)
  // A muted layer cannot also be the one you asked to hear.
  await post('/api/mix', { muted: [layerA], soloed: [] })
  const soloMuted = await post('/api/mix', { soloOnly: layerA }).then((r) => r.json())
  check('soloOnly unmutes the layer it isolates', !soloMuted.mix.muted.includes(layerA))
  await post('/api/mix', { muted: [], soloed: [] })
  const badSolo = await post('/api/mix', { soloOnly: '' })
  check('empty soloOnly is 400', badSolo.status === 400)

  // resetAllTrims clears every layer in ONE mutation, so the rack returns to
  // as-written in a single frame rather than one re-evaluation per layer.
  await post('/api/mix', { trim: { layer: layerA, volume: 0.4 } })
  await post('/api/mix', { trim: { layer: layerB, swing: 0.5 } })
  const seeded = await get('/api/mix').then((r) => r.json())
  check('two layers are trimmed before the reset', Object.keys(seeded.mix.trims).length === 2, JSON.stringify(seeded.mix.trims))
  const resetAll = await post('/api/mix', { resetAllTrims: true }).then((r) => r.json())
  check('resetAllTrims empties every trim', Object.keys(resetAll.mix.trims).length === 0, JSON.stringify(resetAll.mix.trims))
  check('resetAllTrims bumps seq once', resetAll.mix.seq === seeded.mix.seq + 1)
  check(
    'resetAllTrims is structural when a timing trim was cleared',
    resetAll.mix.structuralSeq === seeded.mix.structuralSeq + 1,
    `${seeded.mix.structuralSeq} -> ${resetAll.mix.structuralSeq}`,
  )
  const resetAllAgain = await post('/api/mix', { resetAllTrims: true }).then((r) => r.json())
  check('resetAllTrims on a clean rack changes nothing', resetAllAgain.mix.seq === resetAll.mix.seq)
  const badReset = await post('/api/mix', { resetAllTrims: 'yes' })
  check('non-boolean resetAllTrims is 400', badReset.status === 400)

  // Status reports trims so the agent can read the listener's balance.
  const statusTrims = await get('/api/status').then((r) => r.json())
  check('status reports trims', statusTrims.mix?.trims !== undefined)

  // Leave a clean mix behind. Note this does not restore whatever mute, solo or
  // trim state existed before the run: smoke already rewrites mix state freely,
  // and the reset above destroyed the baseline on purpose so the seq assertions
  // are deterministic.
  await post('/api/mix', { muted: [], soloed: [] })
  await post('/api/mix', { resetTrim: layerB })
  await post('/api/mix', { resetTrim: layerA })

  console.log('notes:')
  const preNotes = await get('/api/notes').then((r) => r.json())
  const noteRes = await post('/api/notes', { text: 'bass too muddy', layer: 'bass' })
  const noteBody = await noteRes.json()
  check('note accepted', noteRes.ok && noteBody.note?.text === 'bass too muddy')
  check('note tagged with layer', noteBody.note?.layer === 'bass')
  check('note tagged with revision', typeof noteBody.note?.revision === 'number')
  const trackNote = await post('/api/notes', { text: 'love this section' }).then((r) => r.json())
  check('track-level note has null layer', trackNote.note?.layer === null)
  const badNote = await post('/api/notes', { text: '   ' })
  check('blank note is 400', badNote.status === 400)
  const badNote2 = await post('/api/notes', {})
  check('missing text is 400', badNote2.status === 400)
  const noteList = await get('/api/notes').then((r) => r.json())
  check(
    'notes listed',
    Array.isArray(noteList.notes) && noteList.notes.some((n) => n.at === noteBody.note.at),
  )
  const statusNotes = await get('/api/status').then((r) => r.json())
  check('status includes recentNotes', Array.isArray(statusNotes.recentNotes))
  check('status no longer exposes recentReactions', statusNotes.recentReactions === undefined)
  if (preNotes.notes.length === 0) {
    // The queue was empty before the test - clean up our fake notes so the
    // agent can't mistake them for listener feedback. (With real notes
    // present we leave everything: clearing would erase them too.)
    const clearRes = await fetch(`${BASE}/api/notes`, { method: 'DELETE' })
    const cleared = await clearRes.json()
    check('notes cleared', clearRes.ok && cleared.notes.length === 0)
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

  console.log('recording survives a client identity change:')
  await recordingSurvivesIdentityChange()

  // Restore starting state
  await post('/api/gain', { level: initial.gain.level })
  if (initial.desiredPlaying) await post('/api/play', {})

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
  if (failed > 0) process.exit(1)
}

main()
