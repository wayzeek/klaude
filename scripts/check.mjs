#!/usr/bin/env node
/**
 * Check a track before anyone hears it.
 *
 * Pushing code proves it parsed. Recording it proves how it sounds. Neither
 * catches the failures where Strudel accepts something plausible and quietly
 * plays nothing: a chord spelling outside its dictionary, a sidechain pointed
 * at the wrong bus, a sample pack that was never loaded. Those corrupt the
 * author's picture of their own track, because the code looks right and the
 * mix analysis has nothing to complain about.
 *
 * This evaluates the code headlessly, queries the events it would produce, and
 * reports what is actually there.
 *
 * Usage:
 *   node scripts/check.mjs <file.js|track.md> [...more] [--json] [--quiet]
 *   node scripts/check.mjs --tracks          # every track in tracks/
 *   node scripts/check.mjs -                 # read code from stdin
 *
 * Exits non-zero if any ERROR was found.
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadStrudel, queryEvents, withCapturedLogs } from './lib/strudel-node.mjs'

/** Cycles of the pattern to query when looking for repetition and balance. */
const ANALYSIS_CYCLES = 64

/**
 * Gain ceilings per sound family, from the table in the /humanize skill.
 * Strudel's default gain is 0.8, which is far too loud for a filtered synth
 * bass and is the documented cause of "the bass drowns the entire mix".
 */
const BASS_SYNTHS = new Set(['sawtooth', 'saw', 'square', 'sqr', 'pulse', 'supersaw', 'triangle', 'tri', 'sine', 'sin'])
const BASS_GAIN_CEILING = 0.45
const BASS_REGISTER_MAX_MIDI = 52 // G#2 and below counts as bass register

/** A section held longer than this without change reads as a stuck loop. */
const MAX_UNCHANGED_CYCLES = 12

const severities = { error: 'ERROR', warn: 'WARN', info: 'INFO' }

class Findings {
  constructor() {
    this.items = []
  }
  add(severity, rule, message, detail) {
    this.items.push({ severity, rule, message, detail })
  }
  error(rule, message, detail) {
    this.add('error', rule, message, detail)
  }
  warn(rule, message, detail) {
    this.add('warn', rule, message, detail)
  }
  info(rule, message, detail) {
    this.add('info', rule, message, detail)
  }
  get errorCount() {
    return this.items.filter((i) => i.severity === 'error').length
  }
  get warnCount() {
    return this.items.filter((i) => i.severity === 'warn').length
  }
}

// --- individual checks --------------------------------------------------------

/**
 * Chord symbols outside Strudel's dictionary make .voicing() return an empty
 * pattern, so the chord is simply absent while the code still reads as if the
 * harmony were there.
 */
function checkChords(strudel, track, findings) {
  for (const symbol of track.chordSymbols) {
    if (strudel.isKnownChord(symbol)) continue
    const suggestions = strudel.suggestChord(symbol)
    const fix = suggestions?.length
      ? `use ${suggestions.map((s) => `"${s}"`).join(' or ')}`
      : 'no close match in the dictionary'
    findings.error(
      'silent-chord',
      `chord "${symbol}" is not in Strudel's dictionary - it voices to SILENCE`,
      fix,
    )
  }
}

/** Every pattern needs a tempo or it plays at the default, not the intended one. */
function checkTempo(track, findings) {
  if (track.cps === null) {
    findings.error('no-tempo', 'no setcpm() or setcps() - the track plays at the default tempo')
    return
  }
  if (!Number.isFinite(track.cps) || track.cps <= 0) {
    findings.error('bad-tempo', `${track.cpsSource}() produced a nonsensical tempo (${track.cps} cps)`)
  }
}

/**
 * `.duckorbit(n)` ducks orbit n. It does NOT mean "duck me when orbit n plays".
 *
 * So a pad carrying .duckorbit(1) while the kick sits on orbit 1 turns the
 * sidechain inside out: the pad gain-punches the kick. And because orbit 1 is
 * also the default bus, a layer that never set its own orbit ducks itself and
 * everything else that stayed on the default.
 */
function checkDucking(events, findings) {
  const duckers = events.filter((e) => e.value.duckorbit != null)
  if (duckers.length === 0) return

  const orbitOf = (event) => event.value.orbit ?? 1
  const selfDucking = new Map()
  const targets = new Map()

  for (const event of duckers) {
    const own = orbitOf(event)
    const sound = event.value.s ?? event.value.sound ?? 'unknown'
    for (const target of [event.value.duckorbit].flat()) {
      if (target === own) {
        const entry = selfDucking.get(sound) ?? { orbit: own, count: 0 }
        entry.count++
        selfDucking.set(sound, entry)
      }
      if (!targets.has(target)) targets.set(target, new Set())
      targets.get(target).add(sound)
    }
  }

  for (const [sound, { orbit, count }] of selfDucking) {
    findings.error(
      'duck-self',
      `"${sound}" ducks orbit ${orbit}, which is its own bus (${count} events)`,
      'duckorbit ducks the TARGET orbit. Put .duckorbit(N) on the kick and .orbit(N) on the layer that should pump',
    )
  }

  // What lives on each ducked orbit? If the target is carrying the drums and
  // the ducking layer is harmonic, the sidechain is pointed the wrong way.
  const soundsByOrbit = new Map()
  for (const event of events) {
    const orbit = orbitOf(event)
    const sound = event.value.s ?? event.value.sound
    if (!sound) continue
    if (!soundsByOrbit.has(orbit)) soundsByOrbit.set(orbit, new Set())
    soundsByOrbit.get(orbit).add(sound)
  }

  for (const [target, duckingSounds] of targets) {
    const onTarget = soundsByOrbit.get(target)
    if (!onTarget) {
      findings.error(
        'duck-missing-orbit',
        `.duckorbit(${target}) targets an orbit nothing plays on - the duck does nothing`,
        'Strudel logs "duck target orbit does not exist" and carries on silently',
      )
      continue
    }
    const targetHasDrums = [...onTarget].some((s) => isDrum(s))
    const duckersAreHarmonic = [...duckingSounds].every((s) => !isDrum(s))
    if (targetHasDrums && duckersAreHarmonic) {
      findings.warn(
        'duck-inverted',
        `${[...duckingSounds].join(', ')} duck orbit ${target}, which carries drums (${[...onTarget].filter(isDrum).join(', ')})`,
        'this makes the harmony punch the kick. For a classic pump, the kick ducks the harmony',
      )
    }
  }
}

const DRUM_HINTS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'cr', 'rd', 'cb', 'lt', 'mt', 'ht', 'sh', 'perc', 'clap', 'kick', 'snare', 'hat']
function isDrum(sound) {
  const name = String(sound).toLowerCase().replace(/^crate_|^tr\d+_/, '')
  return DRUM_HINTS.some((hint) => name === hint || name.startsWith(hint))
}

/**
 * Sound namespaces that only exist once a pack has been loaded.
 *
 * Most prefixed names (`gm_*` soundfonts, `tr909_*` and the other drum
 * machines) are prebaked by the REPL and always available. These are not: the
 * name resolves to nothing until the matching samples() call has run, and the
 * layer is silent with only a console message to say so.
 */
const PACK_NAMESPACES = [{ prefix: 'crate_', pack: 'eddyflux/crate' }]

function checkSamplePacks(events, track, findings) {
  const loaded = JSON.stringify(track.samplePacks)
  const used = new Set()
  for (const event of events) {
    const sound = event.value.s ?? event.value.sound
    if (typeof sound === 'string') used.add(sound)
  }
  for (const { prefix, pack } of PACK_NAMESPACES) {
    const example = [...used].find((sound) => sound.startsWith(prefix))
    if (example && !loaded.includes(pack)) {
      findings.error(
        'sample-pack-not-loaded',
        `"${example}" comes from ${pack}, which samples() never loaded - the layer is silent`,
        `add samples('github:${pack}') at the top of the track`,
      )
    }
  }
}

/**
 * Strudel's default gain is 0.8. On a filtered synth bass that buries
 * everything above it, which is why /humanize insists bass gain is always set
 * explicitly and kept near 0.3-0.4.
 */
function checkGainStaging(events, findings) {
  const bySound = groupBy(events, (e) => e.value.s ?? e.value.sound ?? '(note)')
  const table = []
  for (const [sound, group] of bySound) {
    const gains = group.map((e) => e.value.gain ?? 0.8)
    const mean = gains.reduce((a, b) => a + b, 0) / gains.length
    const notes = group.map((e) => midiOf(e.value)).filter((n) => n !== null)
    const medianNote = notes.length ? median(notes) : null
    table.push({ sound, events: group.length, meanGain: mean, medianNote })

    const isBassRegister = medianNote !== null && medianNote <= BASS_REGISTER_MAX_MIDI
    if (BASS_SYNTHS.has(sound) && isBassRegister && mean > BASS_GAIN_CEILING) {
      const unset = group.filter((e) => e.value.gain == null).length
      findings.warn(
        'bass-too-loud',
        `"${sound}" sits in bass register at gain ${mean.toFixed(2)} (over ${BASS_GAIN_CEILING})`,
        unset > 0
          ? `${unset} of ${group.length} events set no gain at all, so they default to 0.8`
          : 'lower it toward 0.3-0.4 so the mids can be heard',
      )
    }
  }
  return table.sort((a, b) => b.events - a.events)
}

/**
 * Layers stacked in the low-mid register turn into mud.
 *
 * Only the bottom of the spectrum is worth flagging. Pads, choirs and leads
 * routinely share register higher up - that is ordinary layering and sounds
 * fine. Below roughly middle C the same overlap eats the bass and the result is
 * the 150-400 Hz pile-up the /theory skill calls the mud zone. Reported once as
 * a cluster rather than once per pair, which would bury the real signal.
 */
const MUD_ZONE_MAX_MIDI = 55 // ~G3; above this, shared register is normal
const MUD_ZONE_MIN_EVENTS = 16
const MUD_ZONE_SPREAD = 5 // semitones

function checkRegisterCollisions(events, findings) {
  const pitched = events.filter(
    (e) => midiOf(e.value) !== null && !isDrum(e.value.s ?? e.value.sound ?? ''),
  )
  const bySound = groupBy(pitched, (e) => e.value.s ?? e.value.sound ?? '(note)')
  const lowVoices = [...bySound]
    .filter(([, group]) => group.length >= MUD_ZONE_MIN_EVENTS)
    .map(([sound, group]) => ({ sound, median: median(group.map((e) => midiOf(e.value))) }))
    .filter((profile) => profile.median <= MUD_ZONE_MAX_MIDI)
    .sort((a, b) => a.median - b.median)

  // Walk the sorted registers and take the widest run that stays inside the
  // spread, so three pads a semitone apart are one finding, not three.
  let best = []
  for (let start = 0; start < lowVoices.length; start++) {
    const run = [lowVoices[start]]
    for (let next = start + 1; next < lowVoices.length; next++) {
      if (lowVoices[next].median - lowVoices[start].median <= MUD_ZONE_SPREAD) run.push(lowVoices[next])
      else break
    }
    if (run.length > best.length) best = run
  }

  if (best.length >= 2) {
    const named = best.map((p) => `"${p.sound}" (MIDI ${p.median.toFixed(0)})`).join(', ')
    findings.warn(
      'register-collision',
      `${best.length} layers stacked in the low-mid mud zone: ${named}`,
      'move one up an octave, or high-pass it out of the bass\'s way',
    )
  }
}

/**
 * A stack held unchanged for many cycles is the single most common reason a
 * track reads as repetitive, and it is invisible in a spectral analysis: the
 * balance looks identical because it IS identical.
 */
function checkRepetition(pattern, findings) {
  const signatures = []
  for (let cycle = 0; cycle < ANALYSIS_CYCLES; cycle++) {
    const events = queryEvents(pattern, cycle, cycle + 1)
    if (events.length === 0) {
      signatures.push('(silent)')
      continue
    }
    // The signature has to cover every control, not just pitch and gain: a
    // section sweeping .lpf("<200 2000>") differs only in `cutoff`, and judging
    // it identical would report repetition that is not there.
    signatures.push(
      events
        .map((e) => {
          const controls = Object.keys(e.value)
            .sort()
            .map((key) => `${key}=${formatControl(e.value[key])}`)
            .join(',')
          return `${(e.begin - cycle).toFixed(4)}+${(e.end - e.begin).toFixed(4)}[${controls}]`
        })
        .join('|'),
    )
  }

  let runStart = 0
  let longest = { length: 0, start: 0 }
  for (let i = 1; i <= signatures.length; i++) {
    if (i < signatures.length && signatures[i] === signatures[runStart]) continue
    const length = i - runStart
    if (signatures[runStart] !== '(silent)' && length > longest.length) {
      longest = { length, start: runStart }
    }
    runStart = i
  }

  if (longest.length > MAX_UNCHANGED_CYCLES) {
    findings.warn(
      'verbatim-repetition',
      `cycles ${longest.start}-${longest.start + longest.length - 1} are bit-for-bit identical (${longest.length} cycles)`,
      'vary something every 2-4 cycles: .every(), .chunk(), an alternating <...> ending, or a chord swap',
    )
  }
  return longest
}

/**
 * The console draws one mixer row per name in layers({...}). Without it the
 * listener has nothing to solo, mute, or aim a note at.
 */
function checkLayers(track, findings) {
  if (track.layers.size === 0) {
    findings.warn(
      'no-named-layers',
      'the track never calls layers({...}), so the console cannot mix it',
      'wrap the final stack as layers({ kick, bass, keys, ... }) with one name per element',
    )
  }
}

/** Warnings Strudel logged while the pattern was queried, worth surfacing. */
function checkRuntimeLogs(logs, findings) {
  const interesting = [...new Set(logs)].filter((line) =>
    /unknown chord|does not exist|arithmetic on control|not found|could not|failed/i.test(line),
  )
  for (const line of interesting) {
    // Unknown chords are already reported precisely and per symbol.
    if (/unknown chord/i.test(line)) continue
    findings.warn('runtime-warning', line, 'Strudel logged this instead of throwing, so it is easy to miss')
  }
}

// --- helpers ------------------------------------------------------------------

function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

/** Stable short rendering of a control value for signature comparison. */
function formatControl(value) {
  if (typeof value === 'number') return value.toFixed(5)
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/**
 * MIDI number for a hap's pitch, or null if it has none.
 *
 * Only `note` counts. `n` looks like a pitch but usually is not: on a sampled
 * sound it selects the variant, so `s("conga").n(2)` means the third conga
 * recording, not D-1. Strudel already converts `n()` to `note` wherever it is
 * genuinely pitched (via `.scale()`), so reading `n` would only ever misread
 * drums as deep bass and invent register collisions.
 */
function midiOf(value) {
  const note = value.note
  if (typeof note === 'number') return note
  if (typeof note !== 'string') return null
  // Strudel accepts s/f as sharp/flat aliases alongside #/b.
  const match = note.match(/^([a-gA-G])((?:[b#sf])*)(-?\d+)?$/)
  if (!match) return null
  const [, letter, accidentals, octave] = match
  let semis = NOTE_OFFSETS[letter.toLowerCase()]
  for (const accidental of accidentals) {
    semis += accidental === '#' || accidental === 's' ? 1 : -1
  }
  return (Number(octave ?? 3) + 1) * 12 + semis
}

/** Track files keep their code in a single ```javascript block. */
export function extractCode(source, file) {
  if (!file.endsWith('.md')) return source
  const blocks = [...source.matchAll(/```javascript\n([\s\S]*?)```/g)]
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one \`\`\`javascript block, found ${blocks.length}`)
  }
  return blocks[0][1]
}

// --- per-file run -------------------------------------------------------------

export async function checkFile(strudel, label, code) {
  const findings = new Findings()
  const track = await strudel.evaluateTrack(code)

  if (track.error) {
    findings.error('eval-failed', track.error.message)
    return { label, findings, track, gainTable: [], events: [] }
  }
  if (!track.pattern) {
    findings.error('no-pattern', 'the code evaluated but produced no pattern')
    return { label, findings, track, gainTable: [], events: [] }
  }

  // Chord voicing and several other faults only surface when the pattern is
  // queried, and Strudel reports them by logging. Every query therefore runs
  // inside one capture, so nothing leaks to stdout and nothing is missed.
  const { result, logs } = withCapturedLogs(() => {
    const events = queryEvents(track.pattern, 0, ANALYSIS_CYCLES)
    checkTempo(track, findings)
    checkChords(strudel, track, findings)
    checkSamplePacks(events, track, findings)
    checkDucking(events, findings)
    checkLayers(track, findings)
    const gainTable = checkGainStaging(events, findings)
    checkRegisterCollisions(events, findings)
    checkRepetition(track.pattern, findings)
    return { events, gainTable }
  })
  const { events, gainTable } = result
  checkRuntimeLogs([...track.warnings, ...logs], findings)

  if (events.length === 0) {
    findings.error('no-events', `nothing plays in the first ${ANALYSIS_CYCLES} cycles`)
  }

  return { label, findings, track, gainTable, events }
}

// --- reporting ----------------------------------------------------------------

export function formatResult({ label, findings, track, gainTable, events }, { quiet } = {}) {
  const lines = []
  const status = findings.errorCount > 0 ? 'FAIL' : findings.warnCount > 0 ? 'WARN' : 'OK'
  const cycles = track.sections.reduce((a, b) => a + b, 0)
  const summary = [
    `${events.length} events/${ANALYSIS_CYCLES}cy`,
    track.cps ? `${(track.cps * 60 * 4).toFixed(0)} BPM` : 'no tempo',
    cycles ? `${cycles} cycles arranged` : null,
    track.layers.size ? `${track.layers.size} layers` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  lines.push(`${status.padEnd(4)} ${label}  (${summary})`)

  for (const severity of ['error', 'warn', 'info']) {
    for (const item of findings.items.filter((i) => i.severity === severity)) {
      lines.push(`     ${severities[severity]} [${item.rule}] ${item.message}`)
      if (item.detail) lines.push(`           -> ${item.detail}`)
    }
  }

  if (!quiet && gainTable.length) {
    lines.push('     sound levels (mean gain · median MIDI · events)')
    for (const row of gainTable.slice(0, 12)) {
      lines.push(
        `       ${row.sound.padEnd(22)} ${row.meanGain.toFixed(2)}  ${
          row.medianNote === null ? '   -' : row.medianNote.toFixed(0).padStart(4)
        }  ${String(row.events).padStart(5)}`,
      )
    }
  }

  return lines.join('\n')
}

// --- CLI ----------------------------------------------------------------------

function collectTargets(args) {
  if (args.includes('--tracks')) {
    const dir = path.join(process.cwd(), 'tracks')
    const files = []
    for (const artist of fs.readdirSync(dir)) {
      const artistDir = path.join(dir, artist)
      if (!fs.statSync(artistDir).isDirectory()) continue
      for (const file of fs.readdirSync(artistDir)) {
        if (file.endsWith('.md')) files.push(path.join(artistDir, file))
      }
    }
    return files.sort()
  }
  return args.filter((arg) => !arg.startsWith('--'))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const quiet = args.includes('--quiet')
  const targets = collectTargets(args)

  if (targets.length === 0) {
    console.error('usage: node scripts/check.mjs <file.js|track.md> [...] | --tracks | -')
    process.exit(2)
  }

  const strudel = await loadStrudel()
  const results = []

  for (const target of targets) {
    let code
    let label
    try {
      if (target === '-') {
        code = await readStdin()
        label = '(stdin)'
      } else {
        label = path.relative(process.cwd(), target)
        code = extractCode(fs.readFileSync(target, 'utf8'), target)
      }
    } catch (err) {
      console.log(`FAIL ${target}\n     ERROR [unreadable] ${err.message}`)
      results.push({ label: target, fatal: true })
      continue
    }
    results.push(await checkFile(strudel, label, code))
  }

  const checked = results.filter((r) => !r.fatal)

  if (asJson) {
    console.log(
      JSON.stringify(
        checked.map((r) => ({
          file: r.label,
          errors: r.findings.items.filter((i) => i.severity === 'error'),
          warnings: r.findings.items.filter((i) => i.severity === 'warn'),
          sounds: r.gainTable,
          cps: r.track.cps,
          layers: [...r.track.layers.keys()],
        })),
        null,
        2,
      ),
    )
  } else {
    for (const result of checked) console.log(formatResult(result, { quiet }))
    const errors = checked.reduce((a, r) => a + r.findings.errorCount, 0)
    const warnings = checked.reduce((a, r) => a + r.findings.warnCount, 0)
    const clean = checked.filter((r) => r.findings.errorCount === 0).length
    console.log(`\n${clean}/${checked.length} clean · ${errors} errors · ${warnings} warnings`)
  }

  const failed = results.some((r) => r.fatal) || checked.some((r) => r.findings.errorCount > 0)
  process.exit(failed ? 1 : 0)
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (isMain) {
  main().catch((err) => {
    console.error(`FAIL: ${err instanceof Error ? err.stack : err}`)
    process.exit(1)
  })
}
