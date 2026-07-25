#!/usr/bin/env node
/**
 * Self-test for the parts that have no other way to be wrong loudly.
 *
 * The pattern linter and the audio analysis both make claims that look
 * plausible whether or not they are true: "this chord is silent", "this is 128
 * BPM", "this is in F minor". A regression here is invisible in normal use, so
 * both are checked against signals and patterns whose answers are known in
 * advance. The onset detector once reported ten hits a second on a steady sine;
 * that is the class of bug this exists to catch.
 *
 * Usage: node scripts/selftest.mjs
 */

import { analyzeWavBuffer } from './analyze.mjs'
import { loadStrudel } from './lib/strudel-node.mjs'
import { checkFile } from './check.mjs'
import {
  NEUTRAL_TRIM,
  clampTrim,
  isNeutral,
  isStructuralDifference,
  applyValueTrim,
  applyStructuralTrim,
  faderPosition,
  faderVolume,
  hasTrim,
  trimFor,
} from '../src/lib/trim.ts'
import { createThrottle } from '../src/lib/throttle.ts'

const SAMPLE_RATE = 44100

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`)
  }
}

// --- signal generation ---------------------------------------------------------

/** Wrap mono float samples as a 16-bit PCM WAV buffer. */
function encodeWav(samples) {
  const count = samples.length
  const buf = Buffer.alloc(44 + count * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + count * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buf
}

const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12)

/** Arpeggiate MIDI notes with a couple of harmonics, like a real instrument. */
function synthNotes(midiNotes, seconds, noteSeconds = 0.5) {
  const total = SAMPLE_RATE * seconds
  const out = new Float32Array(total)
  const noteLength = Math.floor(SAMPLE_RATE * noteSeconds)
  for (let i = 0; i < total; i++) {
    const hz = midiToHz(midiNotes[Math.floor(i / noteLength) % midiNotes.length])
    const envelope = Math.exp((-(i % noteLength) / SAMPLE_RATE) * 3)
    const phase = (2 * Math.PI * hz * i) / SAMPLE_RATE
    out[i] = envelope * 0.3 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase))
  }
  return out
}

/** Kick-like clicks at a fixed tempo. Deterministic, so no Math.random(). */
function synthBeats(bpm, seconds) {
  const total = SAMPLE_RATE * seconds
  const out = new Float32Array(total)
  const period = Math.round((SAMPLE_RATE * 60) / bpm)
  for (let beat = 0; beat * period < total; beat++) {
    const start = beat * period
    for (let i = 0; i < 600 && start + i < total; i++) {
      const thump = Math.exp(-i / 80) * 0.8 * Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE)
      // A cheap deterministic pseudo-noise burst for the transient.
      const transient = Math.exp(-i / 25) * 0.5 * Math.sin(i * 12.9898) * Math.cos(i * 78.233)
      out[start + i] += thump + transient
    }
  }
  return out
}

// --- audio analysis tests -----------------------------------------------------

function testAnalysis() {
  console.log('analyze.mjs')

  // Tempo, measured against a signal whose tempo is exact.
  {
    const report = analyzeWavBuffer(encodeWav(synthBeats(128, 12)), { bpm: 128 })
    check('detects 128 BPM', Math.abs(report.tempo.bpm - 128) < 2, `${report.tempo.bpm.toFixed(1)} BPM`)
    check(
      'counts one onset per beat',
      Math.abs(report.onsetCount - 25) <= 3,
      `${report.onsetCount} onsets, expected ~25`,
    )
    check(
      'no mismatch note when tempo agrees',
      !report.notes.some((note) => note.includes('TEMPO MISMATCH')),
    )
  }

  // A wrong claim has to be reported, or the check is decoration.
  {
    const report = analyzeWavBuffer(encodeWav(synthBeats(100, 12)), { bpm: 140 })
    check(
      'reports a real tempo mismatch',
      report.notes.some((note) => note.includes('TEMPO MISMATCH')),
      `measured ${report.tempo.bpm.toFixed(0)}, claimed 140`,
    )
  }

  // Half and double tempo are detector artefacts, not disagreements.
  {
    const report = analyzeWavBuffer(encodeWav(synthBeats(128, 12)), { bpm: 64 })
    check(
      'tolerates a half-tempo reading',
      !report.notes.some((note) => note.includes('TEMPO MISMATCH')),
    )
  }

  // Sustained material must not manufacture onsets. This is the regression
  // that motivated normalising spectral flux.
  {
    const total = SAMPLE_RATE * 12
    const drone = new Float32Array(total)
    for (let i = 0; i < total; i++) drone[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)
    const report = analyzeWavBuffer(encodeWav(drone))
    check('a steady drone has no onsets', report.onsetRate < 0.2, `${report.onsetRate.toFixed(2)}/sec`)
    check(
      'flags the drone as arrhythmic',
      report.notes.some((note) => note.includes('no rhythmic articulation')),
    )
  }

  // Key: a C major triad must not pass as F minor (3 shared notes).
  {
    const report = analyzeWavBuffer(encodeWav(synthNotes([60, 64, 67, 72], 12)), { key: 'F minor' })
    check(
      'reports a real key mismatch',
      report.notes.some((note) => note.includes('KEY MISMATCH')),
      `detected ${report.key.best.name}`,
    )
  }

  // Closely-related keys share most of their notes and audio detection cannot
  // reliably pick the tonic, so these must NOT be reported as mismatches.
  {
    const fMinor = synthNotes([53, 56, 60, 63, 60, 56], 12)
    const report = analyzeWavBuffer(encodeWav(fMinor), { key: 'F minor' })
    check(
      'no false mismatch on a related key',
      !report.notes.some((note) => note.includes('KEY MISMATCH')),
      `detected ${report.key.best.name}, claimed F minor`,
    )
  }

  // Neighbouring keys are deliberately tolerated: a relative major/minor pair
  // is the same seven notes, and a fifth away differs by one, which is inside
  // what the detector can resolve. Only distant keys are reported.
  {
    const cMajor = synthNotes([60, 64, 67, 72], 12)
    for (const claimed of ['A minor', 'G major', 'F major']) {
      const report = analyzeWavBuffer(encodeWav(cMajor), { key: claimed })
      check(
        `tolerates a neighbouring key (${claimed})`,
        !report.notes.some((note) => note.includes('KEY MISMATCH')),
      )
    }
    const distant = analyzeWavBuffer(encodeWav(cMajor), { key: 'F# major' })
    check(
      'flags a genuinely distant key',
      distant.notes.some((note) => note.includes('KEY MISMATCH')),
      'C major audio claimed as F# major',
    )
  }

  // Noise has no tempo and no tonal centre. Asserting either against it
  // produced contradictory false positives before the confidence gates.
  {
    const total = SAMPLE_RATE * 12
    const noise = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      noise[i] = 0.3 * Math.sin(i * 12.9898) * Math.cos(i * 78.233)
    }
    const report = analyzeWavBuffer(encodeWav(noise), { bpm: 128, key: 'F minor' })
    check(
      'no tempo mismatch claimed on noise',
      !report.notes.some((note) => note.includes('TEMPO MISMATCH')),
      report.tempo ? `measured ${report.tempo.bpm.toFixed(0)}, conf ${report.tempo.confidence.toFixed(2)}` : 'no tempo',
    )
    check(
      'no key mismatch claimed on noise',
      !report.notes.some((note) => note.includes('KEY MISMATCH')),
      `best ${report.key?.best.name} at ${report.key?.best.score.toFixed(2)}`,
    )
  }
}

// --- linter tests -------------------------------------------------------------

async function testLinter() {
  console.log('check.mjs')
  const strudel = await loadStrudel()
  const lint = async (code) => (await checkFile(strudel, '(test)', code)).findings
  const hasRule = (findings, rule) => findings.items.some((item) => item.rule === rule)

  {
    const findings = await lint(`setcpm(120/4)\n$: layers({ keys: chord("<Cm7 Fmaj7>").voicing().s("piano") })`)
    check('catches a silent chord', hasRule(findings, 'silent-chord'))
  }
  {
    const findings = await lint(`setcpm(120/4)\n$: layers({ keys: chord("<Cm7 F^7>").voicing().s("piano").gain(.5) })`)
    check('accepts the correct spelling', !hasRule(findings, 'silent-chord'))
  }
  {
    const findings = await lint(
      `setcpm(120/4)\nconst kick = s("bd*4").gain(.8).orbit(1)\nconst pad = chord("<Cm7>").voicing().s("piano").gain(.4).duckorbit(1)\n$: layers({ kick, pad })`,
    )
    check('catches a layer ducking its own bus', hasRule(findings, 'duck-self'))
  }
  {
    const findings = await lint(
      `setcpm(120/4)\nconst kick = s("bd*4").gain(.8).orbit(1).duckorbit(2).duckdepth(.4)\nconst pad = chord("<Cm7>").voicing().s("piano").gain(.4).orbit(2)\n$: layers({ kick, pad })`,
    )
    check('accepts correct sidechain routing', !hasRule(findings, 'duck-self'))
  }
  {
    const findings = await lint(`$: layers({ kick: s("bd*4").gain(.8) })`)
    check('catches a missing tempo', hasRule(findings, 'no-tempo'))
  }
  {
    const findings = await lint(`setcpm(120/4)\n$: layers({ drums: s("crate_bd*4").gain(.8) })`)
    check('catches an unloaded sample pack', hasRule(findings, 'sample-pack-not-loaded'))
  }
  {
    const findings = await lint(
      `setcpm(120/4)\nsamples('github:eddyflux/crate')\n$: layers({ drums: s("crate_bd*4").gain(.8) })`,
    )
    check('accepts a loaded sample pack', !hasRule(findings, 'sample-pack-not-loaded'))
  }
  {
    // The same bar for 64 cycles, nothing varying.
    const findings = await lint(`setcpm(120/4)\n$: layers({ kick: s("bd*4").gain(.8), bass: note("c1").s("sine").gain(.3) })`)
    check('catches bit-for-bit repetition', hasRule(findings, 'verbatim-repetition'))
  }
  {
    const findings = await lint(`setcpm(120/4)\n$: s("bd*4").gain(.8)`)
    check('notices a track with no named layers', hasRule(findings, 'no-named-layers'))
  }
  {
    const findings = await lint(
      `setcpm(120/4)\n$: layers({ bass: note("<c1 eb1>").s("sawtooth").lpf(400) })`,
    )
    check('catches default-gain bass', hasRule(findings, 'bass-too-loud'))
  }

  // A chord symbol that never reaches .voicing() cannot be silenced by it.
  // rootNotes() only needs the root, so this sounds an audible C3.
  {
    const findings = await lint(
      `setcpm(120/4)\n$: layers({ bass: chord("<Cmaj7>").rootNotes(2).s("sawtooth").gain(.3) })`,
    )
    check('no false silent-chord when voicing is never called', !hasRule(findings, 'silent-chord'))
  }
  // ...but the same symbol through .voicing() must still be caught, including
  // via the pattern method rather than the global function.
  {
    const findings = await lint(
      `setcpm(120/4)\n$: layers({ keys: n("0").chord("<Cmaj7>").voicing().s("piano").gain(.4) })`,
    )
    check('catches a silent chord via the .chord() method', hasRule(findings, 'silent-chord'))
  }

  // A sweeping filter makes every cycle different; calling that repetition
  // would be a false positive.
  {
    const findings = await lint(
      `setcpm(120/4)\n$: layers({ kick: s("bd*4").gain(.8).lpf("<200 800 2000 4000>") })`,
    )
    check('a filter sweep is not verbatim repetition', !hasRule(findings, 'verbatim-repetition'))
  }

  // `n` on a sampled sound is a variant index, not a pitch. Reading it as MIDI
  // put congas in the sub-bass and invented register collisions.
  {
    const findings = await lint(
      `setcpm(120/4)\n$: layers({ perc: s("conga*4").n("0 2 5 7").gain(.3), metal: s("metal*4").n("2 3").gain(.2) })`,
    )
    check('sample variant indexes are not read as pitch', !hasRule(findings, 'register-collision'))
  }

  // Two lines sharing an explicit output id: the REPL keeps the last.
  {
    const strudelLib = await import('./lib/strudel-node.mjs')
    const track = await strudelLib.loadStrudel().then((s) =>
      s.evaluateTrack(`setcpm(120/4)\nd1: s("bd*4").gain(.8)\nd1: s("hh*8").gain(.5)`),
    )
    const sounds = new Set(
      strudelLib.queryEvents(track.pattern, 0, 1).map((e) => e.value.s),
    )
    check(
      'a reused output id keeps only the last pattern',
      sounds.has('hh') && !sounds.has('bd'),
      `sounds: ${[...sounds].join(', ')}`,
    )
  }
}

// --- trim maths ----------------------------------------------------------------

/**
 * The per-layer trims are pure arithmetic on hap values, and every one of their
 * numbers is a claim about what the listener will hear: that neutral changes
 * nothing, that darkening cannot silence a layer or accidentally brighten it,
 * that thinning cannot collide with the layer's own lowpass. None of that is
 * visible in normal use until a fader lies, so it is all checked here.
 */
function testTrimValues() {
  console.log('trim values:')

  // Neutral must be a true no-op, down to the object reference.
  const value = { s: 'bd', gain: 0.3 }
  check('neutral returns the same object', applyValueTrim(value, NEUTRAL_TRIM) === value)

  // Volume multiplies postgain, never gain, so per-hit dynamics survive.
  const louder = applyValueTrim({ s: 'bd', gain: 0.3 }, { ...NEUTRAL_TRIM, volume: 0.5 })
  check('volume writes postgain', louder.postgain === 0.5, `postgain=${louder.postgain}`)
  check('volume leaves gain alone', louder.gain === 0.3, `gain=${louder.gain}`)
  const stacked = applyValueTrim({ s: 'bd', postgain: 0.5 }, { ...NEUTRAL_TRIM, volume: 0.5 })
  check('volume multiplies an existing postgain', stacked.postgain === 0.25, `postgain=${stacked.postgain}`)

  // Tone, darkening. Bare layers start from wide open; filtered layers scale.
  const darkBare = applyValueTrim({ s: 'bd' }, { ...NEUTRAL_TRIM, tone: -1 })
  check('darkening a bare layer lands at 1250 Hz', darkBare.cutoff === 1250, `cutoff=${darkBare.cutoff}`)
  const darkFiltered = applyValueTrim({ cutoff: 400 }, { ...NEUTRAL_TRIM, tone: -1 })
  check('darkening a filtered layer floors at 120 Hz', darkFiltered.cutoff === 120, `cutoff=${darkFiltered.cutoff}`)

  // The discontinuity this maths exists to remove: a layer already written
  // below the floor must be left alone, not brightened by its own dark knob.
  const belowFloor = applyValueTrim({ cutoff: 80 }, { ...NEUTRAL_TRIM, tone: -1 })
  check('a layer below the floor is not brightened', belowFloor.cutoff === 80, `cutoff=${belowFloor.cutoff}`)
  const nudged = applyValueTrim({ cutoff: 80 }, { ...NEUTRAL_TRIM, tone: -0.01 })
  check('no jump just below neutral', nudged.cutoff === 80, `cutoff=${nudged.cutoff}`)

  // Tone, thinning. Never crosses the layer's own lowpass, never undoes an
  // existing highpass.
  const thinBare = applyValueTrim({ s: 'bd' }, { ...NEUTRAL_TRIM, tone: 1 })
  check('thinning a bare layer lands at 1920 Hz', thinBare.hcutoff === 1920, `hcutoff=${thinBare.hcutoff}`)
  const thinFiltered = applyValueTrim({ cutoff: 1000 }, { ...NEUTRAL_TRIM, tone: 1 })
  check('thinning is capped under the lowpass', thinFiltered.hcutoff === 250, `hcutoff=${thinFiltered.hcutoff}`)
  const thinExisting = applyValueTrim({ cutoff: 1000, hcutoff: 500 }, { ...NEUTRAL_TRIM, tone: 1 })
  check('thinning never lowers an existing highpass', thinExisting.hcutoff === 500, `hcutoff=${thinExisting.hcutoff}`)

  // Space adds to the reverb send and clamps at both ends.
  const wet = applyValueTrim({ s: 'bd' }, { ...NEUTRAL_TRIM, space: 1 })
  check('space adds room', Math.abs(wet.room - 0.6) < 1e-9, `room=${wet.room}`)
  const dry = applyValueTrim({ s: 'bd', room: 0.2 }, { ...NEUTRAL_TRIM, space: -1 })
  check('space clamps at dry', dry.room === 0, `room=${dry.room}`)
  const soaked = applyValueTrim({ s: 'bd', room: 0.9 }, { ...NEUTRAL_TRIM, space: 1 })
  check('space clamps at fully wet', soaked.room === 1, `room=${soaked.room}`)

  // Clamping and classification.
  check('clampTrim clamps high', clampTrim({ volume: 99 }).volume === 2)
  check('clampTrim clamps low', clampTrim({ tone: -99 }).tone === -1)
  check('clampTrim ignores junk', clampTrim({ volume: 'loud' }).volume === 1)
  check('clampTrim ignores NaN', clampTrim({ volume: NaN }).volume === 1)
  check('clampTrim keeps unmentioned values', clampTrim({ tone: 0.5 }, { ...NEUTRAL_TRIM, volume: 0.4 }).volume === 0.4)
  check('isNeutral true for neutral', isNeutral(NEUTRAL_TRIM))
  check('isNeutral false for a fader move', !isNeutral({ ...NEUTRAL_TRIM, volume: 0.9 }))

  // The fader taper: quadratic, so unity sits high up the throw and the quiet
  // end of the travel is usable rather than crammed into the last few pixels.
  check('fader unity sits at ~71% of travel', Math.abs(faderPosition(1) - Math.SQRT1_2) < 1e-9)
  check('fader top is 200%', Math.abs(faderVolume(1) - 2) < 1e-9)
  check('fader bottom is silence', faderVolume(0) === 0)
  check('fader round-trips', Math.abs(faderVolume(faderPosition(0.4)) - 0.4) < 1e-9)
  // sqrt(0.5) squared is 1.0000000000000002, so without snapping a fader parked
  // on unity stores a non-neutral trim: a star that never clears and a postgain
  // written onto every event for nothing.
  check('fader unity round-trips to exactly neutral', faderVolume(faderPosition(1)) === 1)
  check('a fader parked on unity is neutral', isNeutral({ ...NEUTRAL_TRIM, volume: faderVolume(faderPosition(1)) }))

  // Layer names come from the track's own code, so one can be called
  // `constructor`. A bare trims[name] lookup returns Object.prototype's member
  // instead of a trim, and reading .feel off it shifts the pattern by NaN.
  const emptyTrims = {}
  check('trimFor ignores inherited names', trimFor(emptyTrims, 'constructor') === NEUTRAL_TRIM)
  check('trimFor ignores toString', trimFor(emptyTrims, 'toString').feel === 0)
  check('hasTrim ignores inherited names', !hasTrim(emptyTrims, 'constructor'))
  check('trimFor still finds a real trim', trimFor({ bass: { ...NEUTRAL_TRIM, volume: 0.5 } }, 'bass').volume === 0.5)

  // Darkening must never drop the lowpass under an authored highpass: that
  // leaves no pass band at all and the layer disappears.
  const overHpf = applyValueTrim({ s: 'x', hcutoff: 5000 }, { ...NEUTRAL_TRIM, tone: -1 })
  check('darkening stays above an authored highpass', overHpf.cutoff > 5000, `cutoff=${overHpf.cutoff}`)
  // A layer the author already made narrow is left alone rather than widened.
  const narrow = applyValueTrim({ s: 'x', cutoff: 6000, hcutoff: 5000 }, { ...NEUTRAL_TRIM, tone: -1 })
  check('darkening leaves an already narrow band alone', narrow.cutoff === 6000, `cutoff=${narrow.cutoff}`)
  // The ordinary case is unchanged: no highpass means the old floor applies.
  const plain = applyValueTrim({ s: 'x' }, { ...NEUTRAL_TRIM, tone: -1 })
  check('darkening an unfiltered layer still reaches 1250', plain.cutoff === 1250, `cutoff=${plain.cutoff}`)
  check(
    'volume change is not structural',
    !isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, volume: 0.5 }),
  )
  check('swing change is structural', isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, swing: 0.5 }))
  check('feel change is structural', isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, feel: 0.5 }))
}

// --- trim structure --------------------------------------------------------------

/**
 * Swing and feel rebuild the pattern rather than changing values, so they are
 * checked against real evaluated patterns.
 *
 * The count checks are the point of this suite. Strudel ships `swingBy`, which
 * looks like exactly the transform wanted here and is defined as
 * `pat.inside(n, late(seq(0, swing / 2)))`. That patterned `late` multiplies
 * structure: an event longer than half a slice spans both argument values and
 * comes out twice, so a held pad gets flammed instead of swung. Measured at full
 * travel over 4 cycles it took a one-chord pad from 4 events to 32 and even
 * Strudel's own documented `hh*8` example from 32 to 48. If anyone ever
 * "simplifies" applyStructuralTrim back to swingBy, these checks fail.
 */
async function testTrimStructure() {
  console.log('trim structure:')
  const strudel = await loadStrudel()

  const onsetsIn = (pattern, cycles) =>
    pattern
      .queryArc(0, cycles)
      .filter((hap) => hap.whole)
      .map((hap) => hap.whole.begin.valueOf())
      .filter((begin) => begin >= 0 && begin < cycles)
      .sort((a, b) => a - b)

  const LAYERS = [
    ['pad', '$: note("c3").s("sawtooth")'],
    ['quarters', '$: s("hh*4")'],
    ['eighths', '$: s("hh*8")'],
    ['sixteenths', '$: s("hh*16")'],
  ]

  for (const [label, code] of LAYERS) {
    const track = await strudel.evaluateTrack(code)
    const base = onsetsIn(track.pattern, 4)
    const swung = onsetsIn(applyStructuralTrim(track.pattern, { ...NEUTRAL_TRIM, swing: 1 }), 4)
    check(
      `swing preserves the event count on ${label}`,
      swung.length === base.length,
      `${base.length} -> ${swung.length}`,
    )
  }

  // Swing displaces off-beats and leaves on-beats alone.
  const eighths = await strudel.evaluateTrack('$: s("hh*8")')
  const swungEighths = onsetsIn(applyStructuralTrim(eighths.pattern, { ...NEUTRAL_TRIM, swing: 1 }), 1)
  check('swing leaves the downbeat alone', swungEighths[0] === 0, `first=${swungEighths[0]}`)
  check('swing pushes the off-eighth late', swungEighths[1] > 0.125 + 1e-9, `second=${swungEighths[1]}`)
  const quarters = await strudel.evaluateTrack('$: s("hh*4")')
  const swungQuarters = onsetsIn(applyStructuralTrim(quarters.pattern, { ...NEUTRAL_TRIM, swing: 1 }), 1)
  check(
    'swing does not move quarter notes',
    swungQuarters.every((onset, i) => Math.abs(onset - i * 0.25) < 1e-9),
    swungQuarters.join(' '),
  )

  // Feel leans the whole layer.
  const late = onsetsIn(applyStructuralTrim(quarters.pattern, { ...NEUTRAL_TRIM, feel: 1 }), 1)
  const early = onsetsIn(applyStructuralTrim(quarters.pattern, { ...NEUTRAL_TRIM, feel: -1 }), 1)
  check('feel late pushes onsets later', late[0] > 0, `first=${late[0]}`)
  check('feel early pulls onsets earlier', early[0] < 0.25, `first=${early[0]}`)
  check('feel shifts by 1/64 of a cycle', Math.abs(late[0] - 1 / 64) < 1e-9, `shift=${late[0]}`)

  // Neutral returns the identical pattern object.
  check(
    'neutral returns the same pattern',
    applyStructuralTrim(quarters.pattern, NEUTRAL_TRIM) === quarters.pattern,
  )

  // Both at once: the count still holds, and both effects are present.
  const both = { ...NEUTRAL_TRIM, swing: 1, feel: 1 }
  const applied = onsetsIn(applyStructuralTrim(eighths.pattern, both), 1)
  check('swing plus feel preserves the count', applied.length === 8, `count=${applied.length}`)
  check('swing plus feel leans the downbeat late', applied[0] > 0, `first=${applied[0]}`)
  check(
    'swing plus feel still pushes the off-eighth further',
    applied[1] - applied[0] > 0.125 + 1e-9,
    `gap=${applied[1] - applied[0]}`,
  )
}

// --- layers runtime -----------------------------------------------------------

/**
 * The runtime is imported DYNAMICALLY on purpose. It imports `@/lib/trim`, and
 * a static import specifier resolves at link time, before any module body has
 * run and therefore before the alias hook in strudel-resolver.mjs is active.
 * The static form fails with ERR_MODULE_NOT_FOUND even though the hook is
 * registered; the dynamic form resolves after the hook is live.
 */
async function testLayersRuntime() {
  console.log('layers runtime:')
  const strudel = await loadStrudel()
  const { createLayersRuntime } = await import('../src/lib/layers-runtime.ts')
  const track = await strudel.evaluateTrack('$: s("bd*2")')
  const other = await strudel.evaluateTrack('$: s("hh*4")')

  const countIn = (pattern, cycles) => pattern.queryArc(0, cycles).filter((hap) => hap.whole).length

  // Names are collected in declaration order, for the console's row order.
  let mix = { muted: [], soloed: [] }
  const collected = []
  const pulses = []
  const layers = createLayersRuntime({
    getMix: () => mix,
    getTrim: () => NEUTRAL_TRIM,
    collect: (name) => collected.push(name),
    onPulse: (pulse) => pulses.push(pulse),
  })

  const stacked = layers({ kick: track.pattern, hats: other.pattern })
  check('collects every layer name', collected.join(',') === 'kick,hats', collected.join(','))
  check('stacks both layers', countIn(stacked, 1) === 6, `${countIn(stacked, 1)} events`)

  // Muting drops a layer from the stack rather than gain-zeroing it.
  mix = { muted: ['hats'], soloed: [] }
  check('mute drops the layer', countIn(layers({ kick: track.pattern, hats: other.pattern }), 1) === 2)

  // Solo wins over mute and silences everything unsoloed.
  mix = { muted: ['hats'], soloed: ['hats'] }
  check('solo wins over mute', countIn(layers({ kick: track.pattern, hats: other.pattern }), 1) === 4)

  // Everything silenced still yields a valid, event-free pattern.
  mix = { muted: ['kick', 'hats'], soloed: [] }
  const silent = layers({ kick: track.pattern, hats: other.pattern })
  check('all muted yields no events', countIn(silent, 1) === 0)

  // Activity pulses fire per layer when the pattern is queried and triggered.
  mix = { muted: [], soloed: [] }
  const tapped = layers({ kick: track.pattern })
  tapped.queryArc(0, 1).forEach((hap) => hap.context?.onTrigger?.(hap, 0, 1, 0))
  check(
    'pulses name the layer',
    pulses.length > 0 && pulses.every((p) => p.layer === 'kick'),
    pulses.map((p) => p.layer).join(','),
  )
  // The pulse carries what the mascot dances to, read AFTER the trims apply.
  check('pulses carry the sound', pulses.every((p) => p.sound === 'bd'), JSON.stringify(pulses[0]))
  check(
    'pulses carry a clamped intensity',
    pulses.every((p) => p.intensity >= 0 && p.intensity <= 2),
    JSON.stringify(pulses[0]),
  )
  check('pulses carry a cycle position', pulses.every((p) => p.cyclePos >= 0 && p.cyclePos < 1))
  check('pulses carry a positive cps', pulses.every((p) => p.cps > 0))

  // Bad input is rejected loudly rather than producing silence.
  let threw = false
  try {
    layers({})
  } catch {
    threw = true
  }
  check('empty map throws', threw)
  threw = false
  try {
    layers(null)
  } catch {
    threw = true
  }
  check('null map throws', threw)
}

/**
 * The claim this suite exists to prove: a fader move is heard without the
 * pattern being rebuilt. The pattern is constructed ONCE, then the trim store
 * is mutated and the same pattern re-queried. If the runtime ever captures a
 * trim instead of looking it up per query, every check below that mutates
 * `store` fails, and the whole no-re-evaluation design is dead.
 */
async function testLayerTrimsAreLive() {
  console.log('layer trims:')
  const strudel = await loadStrudel()
  const { createLayersRuntime } = await import('../src/lib/layers-runtime.ts')
  const track = await strudel.evaluateTrack('$: s("bd*2").gain(.3)')

  const store = {}
  const layers = createLayersRuntime({
    getMix: () => ({ muted: [], soloed: [] }),
    getTrim: (name) => store[name] ?? NEUTRAL_TRIM,
    collect: () => {},
    onPulse: () => {},
  })

  // Built once. Never rebuilt below.
  const pattern = layers({ bass: track.pattern })
  const valuesOf = (p) =>
    p
      .queryArc(0, 1)
      .filter((h) => h.whole)
      .map((h) => h.value)

  const before = valuesOf(pattern)
  check('starts untrimmed', before[0].postgain === undefined, JSON.stringify(before[0]))
  check('keeps the written gain', before[0].gain === 0.3)

  // THE claim: mutate the store, re-query the same pattern, see the change.
  store.bass = { ...NEUTRAL_TRIM, volume: 0.5 }
  const after = valuesOf(pattern)
  check('a fader move lands without rebuilding', after[0].postgain === 0.5, JSON.stringify(after[0]))
  check('the written gain is still untouched', after[0].gain === 0.3)

  store.bass = { ...NEUTRAL_TRIM, volume: 0.5, tone: -1, space: 0.5 }
  const all = valuesOf(pattern)
  check('tone lands live', all[0].cutoff === 1250, `cutoff=${all[0].cutoff}`)
  check('space lands live', Math.abs(all[0].room - 0.3) < 1e-9, `room=${all[0].room}`)

  // Back to neutral must be indistinguishable from never having been trimmed,
  // in timing and context as well as in values. The wrapper is still installed,
  // so this is what the identity guarantee actually means.
  store.bass = { ...NEUTRAL_TRIM }
  const restored = valuesOf(pattern)
  check('neutral restores the original values', JSON.stringify(restored) === JSON.stringify(before))

  const spansOf = (p) =>
    p
      .queryArc(0, 1)
      .filter((h) => h.whole)
      .map((h) => `${h.whole.begin.valueOf()}-${h.whole.end.valueOf()}/${h.part.begin.valueOf()}`)
      .join(',')
  const bare = layers({ bass: track.pattern })
  check('neutral preserves timing exactly', spansOf(pattern) === spansOf(bare), spansOf(pattern))
  const contextKeys = (p) =>
    p
      .queryArc(0, 1)
      .filter((h) => h.whole)
      .map((h) =>
        Object.keys(h.context ?? {})
          .sort()
          .join('+'),
      )
      .join(',')
  check('neutral preserves the context shape', contextKeys(pattern) === contextKeys(bare), contextKeys(pattern))

  // Trims do not bleed between layers in one stack.
  const other = await strudel.evaluateTrack('$: s("hh*4").gain(.6)')
  store.bass = { ...NEUTRAL_TRIM, volume: 0.25 }
  const pair = layers({ bass: track.pattern, hats: other.pattern })
  const hats = valuesOf(pair).filter((v) => v.s === 'hh')
  const bass = valuesOf(pair).filter((v) => v.s === 'bd')
  check('the trimmed layer is trimmed', bass.every((v) => v.postgain === 0.25))
  check('the untrimmed layer is untouched', hats.every((v) => v.postgain === undefined))

  // Structural trims are read at build time, so each variant must be built
  // under the trim it is testing. Building both with swing:1 set would compare
  // two swung patterns and prove nothing.
  // Onsets are filtered to the queried cycle, matching testTrimStructure's
  // helper. Swing delays off-beats, so an unfiltered window also returns the
  // previous cycle's last off-beat (pushed to -0.0417) as an overlapping whole,
  // which would read as an extra event and turn a correct transform into a
  // count-preservation failure.
  const onsetsOf = (p) =>
    p
      .queryArc(0, 1)
      .filter((h) => h.whole)
      .map((h) => h.whole.begin.valueOf())
      .filter((begin) => begin >= 0 && begin < 1)
      .sort((a, b) => a - b)
      .join(',')

  store.bass = { ...NEUTRAL_TRIM }
  const straight = layers({ bass: (await strudel.evaluateTrack('$: s("hh*8")')).pattern })
  const straightOnsets = onsetsOf(straight)
  store.bass = { ...NEUTRAL_TRIM, swing: 1 }
  const swung = layers({ bass: (await strudel.evaluateTrack('$: s("hh*8")')).pattern })
  const swungOnsets = onsetsOf(swung)
  check('swing applies through the runtime', swungOnsets !== straightOnsets)
  check(
    'swing through the runtime preserves the count',
    swungOnsets.split(',').length === straightOnsets.split(',').length,
  )

  // A structural trim is read once, at build time. Mutating it afterwards must
  // NOT change an already-built pattern: that is what the re-evaluation on
  // structuralSeq is for, and a live structural change would mean the counter
  // split was pointless.
  store.bass = { ...NEUTRAL_TRIM }
  check('a built structural trim does not change under it', onsetsOf(swung) === swungOnsets)
}

// --- throttle -----------------------------------------------------------------

async function testThrottle() {
  console.log('throttle:')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const sent = []
  const throttle = createThrottle((v) => sent.push(v), 80)

  // Leading edge: the first move goes out immediately. A trailing debounce
  // would send nothing here, which is what makes a fader feel dead.
  throttle.push(1)
  check('first push sends immediately', sent.length === 1 && sent[0] === 1, JSON.stringify(sent))

  // Rapid moves coalesce to the newest value rather than queueing.
  throttle.push(2)
  throttle.push(3)
  throttle.push(4)
  check('rapid pushes do not each send', sent.length === 1, JSON.stringify(sent))
  await sleep(120)
  check('the newest value lands after the interval', sent.length === 2 && sent[1] === 4, JSON.stringify(sent))

  // Flush delivers a pending value at once, for pointer-up.
  throttle.push(5)
  throttle.push(6)
  const beforeFlush = sent.length
  throttle.flush()
  check(
    'flush sends the pending value',
    sent.length === beforeFlush + 1 && sent[sent.length - 1] === 6,
    JSON.stringify(sent),
  )
  const afterFlush = sent.length
  await sleep(120)
  check('flush leaves nothing queued', sent.length === afterFlush, JSON.stringify(sent))

  // Cancel drops a pending value, for unmount.
  const dropped = []
  const other = createThrottle((v) => dropped.push(v), 80)
  other.push('a')
  other.push('b')
  other.cancel()
  await sleep(120)
  check('cancel drops the pending value', dropped.join(',') === 'a', dropped.join(','))
}

/**
 * A layer can legitimately be named `constructor` or `toString`, because layer
 * names come from the track's own code. Before trimFor, the runtime's trim
 * lookup returned an inherited function for those names, read `feel` as
 * undefined, and shifted the pattern by NaN - which throws inside Strudel and
 * fails the whole evaluation, silencing the track.
 */
async function testPrototypeLayerNames() {
  console.log('prototype layer names:')
  const strudel = await loadStrudel()
  const { createLayersRuntime } = await import('../src/lib/layers-runtime.ts')
  const track = await strudel.evaluateTrack('$: s("bd*2")')

  const store = {}
  const layers = createLayersRuntime({
    getMix: () => ({ muted: [], soloed: [] }),
    getTrim: (name) => trimFor(store, name),
    collect: () => {},
    onPulse: () => {},
  })

  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    let events = null
    let error = null
    try {
      events = layers({ [name]: track.pattern }).queryArc(0, 1).filter((h) => h.whole).length
    } catch (err) {
      error = err
    }
    check(`a layer named ${name} evaluates`, error === null && events === 2, error ? error.message : `${events} events`)
  }

  // And a real trim on such a name still applies.
  store.constructor = { volume: 0.5, tone: 0, space: 0, feel: 0, swing: 0 }
  const trimmed = layers({ constructor: track.pattern })
    .queryArc(0, 1)
    .filter((h) => h.whole)
    .map((h) => h.value.postgain)
  check('a trim on an inherited-looking name applies', trimmed.every((g) => g === 0.5), JSON.stringify(trimmed))
}

// --- main ---------------------------------------------------------------------

testAnalysis()
await testLinter()
testTrimValues()
await testTrimStructure()
await testLayersRuntime()
await testLayerTrimsAreLive()
await testPrototypeLayerNames()
await testThrottle()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
