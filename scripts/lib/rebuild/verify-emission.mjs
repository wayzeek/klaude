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
import { LAYERS, gridFromJson, stepsPerBar } from './transcribe/quantize.mjs'

/** How far an event may sit from where it was transcribed before it counts as
 *  a different event rather than the same one slightly late. */
const MATCH_TOLERANCE_STEPS = 0.5
/** Mean drift above this is reported as a defect in its own right. */
const MAX_MEAN_DRIFT_STEPS = 0.25

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
 * are quantised to the same grid. Reports the three failure modes separately,
 * per #47: an event that vanished, an event that appeared, and an event that
 * kept its slot but changed its note. Collapsing the third into the first two
 * would be technically true and useless for diagnosis.
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
  }

  const extra = remaining.filter((candidate) => !used.has(candidate.index))
  return {
    matched,
    missing,
    extra,
    wrongPitch,
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
            ? { matched: 0, missing: loop.events.length, extra: 0, wrongPitch: 0, drift: 0 }
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
        // steps measured from the section's start.
        const expected = []
        const repetitions = Math.ceil(section.bars / loop.loopBars)
        for (let rep = 0; rep < repetitions; rep++) {
          for (const event of loop.events) {
            const step = rep * loop.loopBars * perBar + event.step
            if (step >= section.bars * perBar) continue
            expected.push({ step, midi: event.midi ?? null })
          }
        }

        // `.voicing()` turns one chord into three or four simultaneous notes,
        // so a chord layer's query yields several events per transcribed
        // event. Collapse simultaneous notes into one onset before comparing,
        // or every chord reads as two spurious extras.
        const raw = byLayer.get(layer).map((event) => ({
          step: (event.begin - from) * perBar,
          midi: midiOf(event.value),
        }))
        const actual = layer === 'chords' ? collapseSimultaneous(raw) : raw

        const comparison = compareEvents(expected, actual, { stepsPerBar: perBar })
        layers[layer] = {
          matched: comparison.matched,
          missing: comparison.missing.length,
          extra: comparison.extra.length,
          wrongPitch: comparison.wrongPitch.length,
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
        if (comparison.drift > MAX_MEAN_DRIFT_STEPS) {
          defects.push({ section: section.index, layer, message: `mean timing drift ${comparison.drift.toFixed(2)} steps` })
        }
      }
      built.push({ index: section.index, layers })
    }
    return built
  })

  for (const line of new Set([...(track.warnings ?? []), ...logs])) {
    if (PROBLEM_LOG.test(line)) {
      defects.push({ section: null, layer: null, message: `evaluator warned: ${line}` })
    }
  }

  return { ok: defects.length === 0, sections, defects }
}

/** Notes landing on the same onset are one chord, not several events. Keeps the
 *  lowest, which is the closest thing to a root after `.voicing()`. */
function collapseSimultaneous(events, tolerance = 0.01) {
  const sorted = [...events].sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))
  const out = []
  for (const event of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(event.step - last.step) <= tolerance) continue
    out.push(event)
  }
  return out
}
