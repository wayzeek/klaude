/**
 * Did we write it down right?
 *
 * Narrow by design: this catches emitter bugs, quantisation drift and dropped
 * events, and nothing else. It cannot tell you the transcription was correct -
 * that is the hearing check's job - and it cannot tell you the track will make
 * a sound. `strudel-node.mjs` stubs `samples()` rather than loading them, so a
 * pack-dependent sound exists symbolically while the rendered layer would be
 * silent. Sample resolution belongs to the render stage.
 */

import { cachedStrudel, loadStrudel, midiOf, withCapturedLogs } from '../strudel-node.mjs'
import { SOUNDS } from './emit.mjs'
import { CHORD_TEMPLATES } from './transcribe/chords.mjs'
import { LAYERS, gridFromJson, stepsPerBar } from './transcribe/quantize.mjs'

/** How far an event may sit from where it was transcribed before it counts as
 *  a different event rather than the same one slightly late. */
const MATCH_TOLERANCE_STEPS = 0.5
/** Mean drift above this is reported as a defect in its own right. */
const MAX_MEAN_DRIFT_STEPS = 0.25
/** How far an emitted note's duration may sit from what was transcribed, in
 *  steps, before it counts as a defect rather than quantisation noise. */
const LENGTH_TOLERANCE_STEPS = 0.5
/** How far an emitted gain may sit from the transcribed velocity's expected
 *  value before it counts as a defect. `emit.mjs` rounds gain to two decimal
 *  places (see its own `round2`), so this only has to clear that rounding,
 *  not audio noise - a real defect (a dropped dynamics factor, a stale
 *  constant) is off by tenths, not hundredths. */
const GAIN_TOLERANCE = 0.02
/** `emit.mjs` keeps its own `round2` private; duplicated here rather than
 *  exported for a one-line rounding function, matching the same
 *  duplicate-rather-than-couple precedent `verify-hearing.mjs`'s
 *  `detectorCurve` comment explains. */
const round2 = (value) => Math.round(value * 100) / 100

/** A chord symbol's pitch-class set, straight from the same template table
 *  `resynth.mjs`'s `chordMidis` uses - the vocabulary a chord layer can ever
 *  actually be, so a symbol that isn't in it (should never happen; caught
 *  upstream) has no set to compare against. */
function chordPitchClasses(symbol) {
  const template = CHORD_TEMPLATES.find((candidate) => candidate.symbol === symbol)
  if (!template) return null
  const pcs = []
  for (let pc = 0; pc < 12; pc++) if (template.vector[pc] > 0) pcs.push(pc)
  return pcs
}

function samePitchClasses(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Which logged lines are worth surfacing as defects. Strudel reports several
 * recoverable faults (an unknown chord symbol, a duck target that does not
 * exist, a sample pack that failed to resolve) by logging rather than
 * throwing, so routine chatter and a real problem look identical unless
 * filtered. Mirrors `checkRuntimeLogs` in `scripts/check.mjs`, the existing
 * precedent for reading this same channel.
 */
const PROBLEM_LOG = /unknown chord|does not exist|arithmetic on control|not found|could not|failed|cannot/i

/**
 * Query a pattern and let failures surface.
 *
 * The obvious way to write this is `pattern.queryArc(from, to)` inside a
 * try/catch, which is exactly what `queryEvents` in strudel-node.mjs does -
 * and it is dead code there. `Pattern.prototype.queryArc` in the installed
 * `@strudel/core` already wraps its own call in a try/catch, logs whatever it
 * catches, and returns `[]`; nothing thrown inside a pattern's query ever
 * reaches a `queryArc` caller, wrapped or not (checked directly against the
 * library, not assumed from its docs - `.add()` against silence, which an
 * earlier draft of this task treated as a reliable way to make `queryArc`
 * throw, does not throw either; it silently produces zero events, the same
 * failure mode this function exists to rule out). The one entry point Strudel
 * does not guard is `pattern.query(state)` itself, so this builds that state
 * by hand from the runtime's own `State`/`TimeSpan` classes and calls it
 * directly - identical to what `queryArc` does internally, minus the net.
 *
 * Precondition: `loadStrudel()` must already have resolved once in this
 * process, so `cachedStrudel()` has something to return. `verifyEmission`
 * guarantees that by construction (it awaits `loadStrudel()` before this is
 * ever called); a caller reaching this cold gets a thrown error naming the
 * precondition, not a `TypeError` on `undefined.State`.
 */
export function querySectionStrict(pattern, from, to) {
  if (!pattern) return { events: [], error: null }
  const runtime = cachedStrudel()
  if (!runtime) {
    throw new Error('querySectionStrict requires loadStrudel() to have resolved first')
  }
  const { core } = runtime
  let haps
  try {
    haps = pattern.query(new core.State(new core.TimeSpan(from, to)))
  } catch (error) {
    return { events: [], error: error.message ?? String(error) }
  }
  const events = haps
    .filter((hap) => hap.whole)
    .map((hap) => ({
      begin: hap.whole.begin.valueOf(),
      end: hap.whole.end.valueOf(),
      value: hap.value ?? {},
    }))
    .sort((a, b) => a.begin - b.begin)
  return { events, error: null }
}

/**
 * Line up two event lists and say how they differ.
 *
 * Greedy nearest-match within a tolerance, which is enough because both lists
 * are quantised to the same grid. Reports each failure mode separately, per
 * #47: an event that vanished, an event that appeared, and an event that kept
 * its slot but changed its note, its chord, its duration or its gain.
 * Collapsing any of those into the others would be technically true and
 * useless for diagnosis - a wrong chord is not the same finding as a
 * shortened one, and both are real defects gain-checking alone would miss.
 *
 * `want.midi` and `want.symbol` are mutually exclusive (a note-kind layer
 * sets one, a chord layer the other) and each is only compared when present,
 * so passing plain `{step, midi}` objects - every caller before this one
 * needed to - still works unchanged.
 */
// `stepsPerBar` is part of the committed interface but unused below: both
// event lists already speak in steps, so a fixed tolerance in that unit needs
// no bar length to interpret it.
export function compareEvents(expected, actual, { stepsPerBar = 16 } = {}) {
  void stepsPerBar
  const remaining = actual.map((event, index) => ({ ...event, index }))
  const used = new Set()
  const missing = []
  const wrongPitch = []
  const wrongChord = []
  const wrongLength = []
  const wrongGain = []
  let matched = 0
  let driftTotal = 0
  let driftCount = 0

  for (const want of expected) {
    let best = null
    let bestDistance = Infinity
    for (const candidate of remaining) {
      if (used.has(candidate.index)) continue
      const distance = Math.abs(candidate.step - want.step)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
    if (!best || bestDistance > MATCH_TOLERANCE_STEPS) {
      missing.push(want)
      continue
    }
    used.add(best.index)
    matched++
    driftTotal += Math.abs(best.step - want.step)
    driftCount++

    if (want.midi !== null && want.midi !== undefined && best.midi !== want.midi) {
      wrongPitch.push({ step: want.step, expected: want.midi, actual: best.midi })
    }
    if (want.symbol !== null && want.symbol !== undefined) {
      const expectedPcs = chordPitchClasses(want.symbol)
      const actualPcs = best.pitchClasses ?? null
      if (expectedPcs && actualPcs && !samePitchClasses(expectedPcs, actualPcs)) {
        wrongChord.push({ step: want.step, expected: want.symbol, actual: actualPcs })
      }
    }
    if (
      want.length !== undefined &&
      best.length !== undefined &&
      Math.abs(best.length - want.length) > LENGTH_TOLERANCE_STEPS
    ) {
      wrongLength.push({ step: want.step, expected: want.length, actual: best.length })
    }
    if (
      want.gain !== undefined &&
      best.gain !== undefined &&
      best.gain !== null &&
      Math.abs(best.gain - want.gain) > GAIN_TOLERANCE
    ) {
      wrongGain.push({ step: want.step, expected: want.gain, actual: best.gain })
    }
  }

  const extra = remaining.filter((candidate) => !used.has(candidate.index))
  return {
    matched,
    missing,
    extra,
    wrongPitch,
    wrongChord,
    wrongLength,
    wrongGain,
    drift: driftCount ? driftTotal / driftCount : 0,
  }
}

/**
 * Evaluate emitted code and compare its events against the transcription.
 *
 * Sequential throughout: `evaluateTrack` swaps process-wide globals and rejects
 * concurrent calls, so this is cheap and offline but not parallelisable.
 *
 * Log capture is split deliberately rather than wrapped around the whole
 * function. `evaluateTrack` is async and already runs its own
 * capture-then-restore around the `await` inside itself (see
 * `scripts/lib/strudel-node.mjs`), so its `warnings` array is trustworthy as
 * returned - wrapping the call again here in `withCapturedLogs` would do
 * nothing but restore the console before the inner await settles, exactly the
 * bug this task calls out. What `evaluateTrack`'s own capture cannot see is
 * the *querying* that happens afterwards: several of Strudel's warnings (an
 * unknown chord reaching `.voicing()`, for instance) fire lazily when a
 * pattern is queried, not when it is built. The section-by-section querying
 * below is synchronous - no `await` inside it - so wrapping only that part in
 * `withCapturedLogs` captures those lazily-fired warnings without the
 * restore-before-settle race. This is the same split `checkFile` in
 * `scripts/check.mjs` uses: `evaluateTrack` unwrapped, the synchronous query
 * pass wrapped, the two warning lists merged afterwards.
 */
export async function verifyEmission(code, transcription) {
  const grid = gridFromJson(transcription.grid)
  const perBar = stepsPerBar(grid)
  const defects = []

  let track
  try {
    const strudel = await loadStrudel()
    track = await strudel.evaluateTrack(code)
  } catch (error) {
    return {
      ok: false,
      sections: [],
      defects: [{ section: null, layer: null, message: `evaluation failed: ${error.message}` }],
    }
  }

  // `evaluateTrack` does not reject on a bad track: it catches the failure into
  // `track.error` and returns normally, with `pattern` left null. Without these
  // two checks, unparseable source and an all-omitted transcription agree
  // perfectly and the run reports ok.
  if (track.error) {
    return {
      ok: false,
      sections: [],
      defects: [{ section: null, layer: null, message: `evaluation failed: ${track.error.message}` }],
    }
  }
  if (!track.pattern) {
    return {
      ok: false,
      sections: [],
      defects: [{ section: null, layer: null, message: 'evaluation produced no pattern' }],
    }
  }

  // One synchronous pass: query each section's slice of the arrangement, sort
  // its events into layers, and compare. Wrapped in `withCapturedLogs` so any
  // warning Strudel logs while these queries run (as opposed to while the code
  // was evaluated) is caught rather than escaping to the real console.
  const { result: sections, logs } = withCapturedLogs(() => {
    const built = []
    let cycle = 0
    for (const section of transcription.sections) {
      const from = cycle
      const to = cycle + section.bars
      cycle = to
      const layers = {}

      // One query per section over the ARRANGED pattern.
      //
      // Querying `track.layers.get(name)` would be the obvious move and is
      // wrong: `layers()` files every occurrence of a name under that name and
      // stacks them into one representative channel with every occurrence
      // starting at cycle zero. There is no arrangement in it. The
      // arrangement is `track.pattern`, and events are sorted back into
      // layers by the sound the emitter gave each one, which is why SOUNDS
      // carries a distinct `sound` per layer.
      const { events, error } = querySectionStrict(track.pattern, from, to)
      if (error) {
        defects.push({ section: section.index, layer: null, message: `pattern query threw: ${error}` })
        for (const layer of LAYERS) {
          const loop = section.loops?.[layer]
          layers[layer] = loop
            ? {
                matched: 0,
                missing: loop.events.length,
                extra: 0,
                wrongPitch: 0,
                wrongChord: 0,
                wrongLength: 0,
                wrongGain: 0,
                drift: 0,
              }
            : null
        }
        built.push({ index: section.index, layers })
        continue
      }

      const byLayer = new Map(LAYERS.map((layer) => [layer, []]))
      for (const event of events) {
        const sound = event.value.s ?? event.value.sound ?? null
        const layer = LAYERS.find((candidate) => SOUNDS[candidate].sound === sound)
        if (layer) byLayer.get(layer).push(event)
      }

      for (const layer of LAYERS) {
        const loop = section.loops?.[layer]
        if (!loop) {
          // A layer with no transcription must also have produced no events.
          if (byLayer.get(layer).length) {
            defects.push({
              section: section.index,
              layer,
              message: `${byLayer.get(layer).length} events for a layer that was omitted`,
            })
          }
          layers[layer] = null
          continue
        }

        // Expected events, expanded from the loop across the section, in
        // steps measured from the section's start. `length` is clamped the
        // same way `loopToPatterns` clamps it (to the loop's own end, not the
        // section's), and `gain` is computed the same way it computes gain
        // (`round2(base * velocity)`), so both sides of the comparison below
        // describe what the emitter actually promises to write, not just what
        // the transcription recorded.
        const base = SOUNDS[layer].gain
        const loopSteps = loop.loopBars * perBar
        const expected = []
        const repetitions = Math.ceil(section.bars / loop.loopBars)
        for (let rep = 0; rep < repetitions; rep++) {
          for (const event of loop.events) {
            const step = rep * loop.loopBars * perBar + event.step
            if (step >= section.bars * perBar) continue
            expected.push({
              step,
              midi: event.midi ?? null,
              symbol: event.symbol ?? null,
              length: Math.max(1, Math.min(event.length, loopSteps - event.step)),
              gain: round2(base * (event.velocity ?? 0.8)),
            })
          }
        }

        // `.voicing()` turns one chord into three or four simultaneous notes,
        // so a chord layer's query yields several events per transcribed
        // event. Collapse simultaneous notes into one onset before comparing,
        // or every chord reads as two spurious extras - but collapsing must
        // not throw away which pitch classes were actually voiced, or a
        // wrong chord and a right one look identical once reduced to a count.
        const raw = byLayer.get(layer).map((event) => ({
          step: (event.begin - from) * perBar,
          midi: midiOf(event.value),
          length: (event.end - event.begin) * perBar,
          gain: event.value.gain ?? null,
        }))
        const actual = layer === 'chords' ? collapseSimultaneous(raw) : raw

        const comparison = compareEvents(expected, actual, { stepsPerBar: perBar })
        layers[layer] = {
          matched: comparison.matched,
          missing: comparison.missing.length,
          extra: comparison.extra.length,
          wrongPitch: comparison.wrongPitch.length,
          wrongChord: comparison.wrongChord.length,
          wrongLength: comparison.wrongLength.length,
          wrongGain: comparison.wrongGain.length,
          drift: comparison.drift,
        }

        if (comparison.missing.length) {
          defects.push({ section: section.index, layer, message: `${comparison.missing.length} events missing` })
        }
        if (comparison.extra.length) {
          defects.push({ section: section.index, layer, message: `${comparison.extra.length} unexpected events` })
        }
        if (comparison.wrongPitch.length) {
          defects.push({
            section: section.index,
            layer,
            message: `${comparison.wrongPitch.length} events at the wrong pitch`,
          })
        }
        // Reported separately from wrongPitch per #47: a wrong chord, a
        // shortened note and a wrong gain are three different defect classes
        // with three different causes, and collapsing them into one count
        // would tell whoever reads this nothing about which to go fix.
        if (comparison.wrongChord.length) {
          defects.push({
            section: section.index,
            layer,
            message: `${comparison.wrongChord.length} events with the wrong chord`,
          })
        }
        if (comparison.wrongLength.length) {
          defects.push({
            section: section.index,
            layer,
            message: `${comparison.wrongLength.length} events with the wrong duration`,
          })
        }
        if (comparison.wrongGain.length) {
          defects.push({
            section: section.index,
            layer,
            message: `${comparison.wrongGain.length} events at the wrong gain`,
          })
        }
        if (comparison.drift > MAX_MEAN_DRIFT_STEPS) {
          defects.push({ section: section.index, layer, message: `mean timing drift ${comparison.drift.toFixed(2)} steps` })
        }
      }
      built.push({ index: section.index, layers })
    }
    return built
  })

  // Known limitation, not fixed here: Strudel's own logger (see `suppressConsole`
  // in strudel-node.mjs) debounces identical message text for about a second,
  // process-wide - the debounce state lives inside @strudel/core, unexported,
  // so nothing on this side of that boundary can scope it per call. A second
  // `verifyEmission` run in the same process, within that window, with the
  // same warning text, will not see it repeated here - `logs`/`track.warnings`
  // simply won't contain it, because @strudel/core never called `console.log`
  // for it the second time. This never produces a false `ok: true` on its own:
  // the structural comparison above (missing/extra/wrongPitch) still catches
  // the underlying problem independently of whether it also got logged. It
  // does mean a caller that batches many tracks in one process - the render
  // CLI this check feeds - can under-count how many tracks hit the *same*
  // named warning, which matters if that CLI ever reports "N tracks warned
  // about X" as a headline number.
  for (const line of new Set([...(track.warnings ?? []), ...logs])) {
    if (PROBLEM_LOG.test(line)) {
      defects.push({ section: null, layer: null, message: `evaluator warned: ${line}` })
    }
  }

  return { ok: defects.length === 0, sections, defects }
}

/**
 * Notes landing on the same onset are one chord, not several events.
 *
 * Keeps the lowest note's step/length/gain, which is the closest thing to a
 * root after `.voicing()` and (per its own comment) shares timing and gain
 * with the rest of the voicing anyway - but carries forward the FULL set of
 * pitch classes actually sounding, not just the one representative note's.
 * Reducing to a bare count here is exactly how a wrong chord came to read as
 * a clean match before this fix: `.voicing()` turning "C" into five real
 * notes and turning "Dm" into another five real notes both collapse to "one
 * onset" if only the count survives.
 */
function collapseSimultaneous(events, tolerance = 0.01) {
  const sorted = [...events].sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))
  const out = []
  for (const event of sorted) {
    const pc = (((event.midi ?? 0) % 12) + 12) % 12
    const last = out[out.length - 1]
    if (last && Math.abs(event.step - last.step) <= tolerance) {
      last.pitchClasses.add(pc)
      continue
    }
    out.push({ ...event, pitchClasses: new Set([pc]) })
  }
  return out.map((event) => ({ ...event, pitchClasses: [...event.pitchClasses].sort((a, b) => a - b) }))
}
