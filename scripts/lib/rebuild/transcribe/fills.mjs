/**
 * Fills and one-off impacts: what `foldToLoop`'s KEEP_FRACTION discards on
 * purpose, reclaimed for the one shape it is safe to reclaim.
 *
 * `foldToLoop` explains a section by finding the shortest loop its own
 * repetitions agree on; anything that fails to recur - a drum fill into a
 * transition, a crash on a drop, a pickup - is dropped along with genuine
 * noise, by construction (see its own `KEEP_FRACTION` comment). That is the
 * right default for #46 (a loop, not a transcript) and the wrong one for the
 * handful of real events a listener actually notices: fifteen bit-for-bit
 * identical intro bars with nothing marking a transition is the tell an
 * early reviewer named as the give-away that a machine wrote the track.
 *
 * Restricted to drum roles (kick/snare/hats) only - the one place this
 * codebase measured per-onset detection at 86-99% precision. Melody's fold
 * residue measured 15.4% accuracy overall against ground truth
 * (`detectMelodySalience`'s own headline) - noise, not signal - so calling
 * this on anything but a drum role's discarded events would be inventing
 * fills out of noise, which is worse than reporting nothing. Nothing in this
 * file is called for bass, chords or lead.
 *
 * Two shapes only, both gated hard against real, already-detected onsets -
 * never a synthesised or generic fill:
 *
 * - A FILL is a burst of discarded events concentrated in the section's own
 *   closing bar, denser than what the surviving loop already plays there.
 *   "Several" is a real minimum (`MIN_FILL_EVENTS`), not a single stray
 *   onset: one extra hit at the end of a section is not distinguishable from
 *   ordinary quantisation noise by count alone, and this file does not try.
 * - A CRASH/impact is a discarded event on the section's first downbeat
 *   (absolute step 0, not every bar's own step 0), louder than anything the
 *   loop's own kept events reach. Two raw detections of that one instant
 *   (measured, real - see `mergeDuplicateSteps`) merge to one before this
 *   is judged; this file has no way to name a section whose first downbeat
 *   genuinely carries several DIFFERENT discarded onsets, because they
 *   would all share that one step and merge the same way.
 *
 * A discarded event mostly does not land on a step a kept loop event
 * occupies: `scoreFold` buckets by `step % loopSteps` (plus midi/symbol),
 * so one bucket is either kept in full or discarded in full, never both -
 * see quantize.test.mjs for the direct proof. For a drum layer (the only
 * caller of this file - midi and symbol are always null there) that means a
 * discarded step and a kept step can never coincide, full stop, which is
 * what makes "denser/louder than the loop already plays there" a meaningful
 * comparison rather than a race against the loop's own content: a fill or
 * crash this file names is always additional, never a replacement, and
 * `emit.mjs` stacks it with `.superimpose()` rather than overwriting
 * anything. (`scoreFold`'s own bucket key includes midi/symbol, so this
 * disjointness is not a property of the fold in general - a pitched layer
 * using `oneEventPerStep` could see a kept note and a discarded, different
 * note share one step. Not reachable here, since nothing but drums calls
 * this file, but worth being precise about for whoever next reads
 * `discarded` off a different layer.)
 *
 * Everything else - a burst in the middle of a section, a single quiet extra
 * hit anywhere, a burst spanning into the second-to-last bar - stays
 * dropped, silently, exactly as it was before this file existed. An honest
 * zero is the correct output for a section with no real one-off content,
 * not a bug to work around; the sanctioned outcome when nothing clears the
 * gate is to ship this machinery emitting nothing and say so, not to lower
 * the gate until something does.
 *
 * `detectCrash` only ever sees `foldToLoop`'s own `discarded` array - and for
 * a drum role (midi/symbol always null), `foldToLoop` buckets purely by
 * step position, so the section's true first downbeat and every later bar's
 * *ordinary* downbeat land in the exact same bucket. A bucket is kept or
 * discarded as a whole (see quantize.mjs's own doc comment); when a downbeat
 * genuinely recurs - the ordinary case - that bucket clears `KEEP_FRACTION`
 * and is kept whole, and `mergeBucket` reports its MEDIAN velocity. A single
 * loud crash stacked on an otherwise-ordinary downbeat is invisible in that
 * median and never reaches `discarded` at all - `detectCrash` is never even
 * called with it. `extractPreFoldImpact` (below) exists to catch exactly
 * this, by acting *before* `foldToLoop` ever buckets anything.
 */

import { stepsPerBar } from './quantize.mjs'

/** A fill needs at least this many real discarded onsets in the closing bar.
 *  Below it, a single extra hit is not distinguishable from quantisation
 *  noise by count alone - see this file's own doc comment. */
const MIN_FILL_EVENTS = 3

/** A crash must be louder than the loudest hit the loop itself already
 *  plays in this section - "a single loud event", not merely a present one. */
const CRASH_VELOCITY_RATIO = 1.0

/**
 * Collapse discarded members that quantised to the identical absolute step
 * into one event, keeping the louder reading.
 *
 * Measured directly on the real reference track: a role's closing bar can
 * produce two raw onset detections that both round to the same sixteenth
 * (two peaks close enough in time that `pickBandOnsets`'s 30ms minimum
 * separation does not merge them, but far enough apart that `stepAt`'s
 * ~108ms-wide rounding still lands both on the identical step) - one
 * physical instant, read twice, not two. Left unmerged, this both inflates
 * `MIN_FILL_EVENTS` with duplicate readings of a single hit rather than
 * genuinely distinct onsets, and silently loses one of the duplicates in
 * `emit.mjs`'s `variationChain`, which can only hold one event per step in
 * its slot array - so a "3 discarded events" fill built from one real onset
 * detected three times would both clear a gate it should not and emit
 * something quieter than its own note claims. Deduplicating here, before
 * either gate runs, keeps the count and the eventual mini-notation honest
 * with each other.
 */
function mergeDuplicateSteps(events) {
  const byStep = new Map()
  for (const event of events) {
    const existing = byStep.get(event.step)
    if (!existing || event.velocity > existing.velocity) byStep.set(event.step, event)
  }
  return [...byStep.values()]
}

/**
 * Pull a section's first-downbeat crash out of a role's raw hits BEFORE
 * `foldToLoop` ever sees them, so it cannot be laundered into a kept
 * bucket's median (see this file's own module comment for why folding first
 * hides exactly this case, and `fills.test.mjs`'s own `detectCrash` fixture
 * for the shape that cannot arise from a real fold - a kept and a discarded
 * event sharing one step - once this runs upstream of it).
 *
 * `events` and `fromStep` are absolute, grid-relative steps - the same
 * convention `transcribeDrums` already reads hits in - so this has to
 * localise on its own rather than assume the caller already did; `perBar`
 * is `stepsPerBar(grid)`, the same bar width `foldToLoop` measures
 * repetitions against.
 *
 * The comparison basis is deliberately narrower than `detectCrash`'s own
 * (the loudest event anywhere in the *folded* loop): before folding, the
 * loop's own kept events do not exist yet to compare against. The other
 * bar-aligned downbeats of the same role in this section - the same phase
 * `foldToLoop` would itself go on to bucket this hit's later repetitions
 * against - are the only evidence available at this point, and are an
 * apples-to-apples comparison (same phase, different repetition) rather
 * than a looser one. A section with no other bar to compare against (one
 * bar total, or a role silent on every other downbeat) yields no
 * extraction - there is nothing to call "louder than usual" without at
 * least one usual to compare to.
 *
 * Returns the input array unchanged (and `extracted: null`) whenever
 * nothing is pulled out, so a section with no crash costs nothing beyond
 * this function's own two filters and behaves byte-for-byte as it did
 * before this existed.
 */
export function extractPreFoldImpact(events, fromStep, perBar) {
  const atFirstDownbeat = events.filter((event) => event.step === fromStep)
  const otherDownbeats = events.filter((event) => event.step > fromStep && (event.step - fromStep) % perBar === 0)
  if (!atFirstDownbeat.length || !otherDownbeats.length) return { events, extracted: null }

  const loudestOther = Math.max(...otherDownbeats.map((event) => event.velocity))
  const impact = atFirstDownbeat.reduce((max, event) => (event.velocity > max.velocity ? event : max))
  if (impact.velocity <= loudestOther * CRASH_VELOCITY_RATIO) return { events, extracted: null }

  return { events: events.filter((event) => event !== impact), extracted: impact }
}

/**
 * A fill candidate from a role's discarded events, or null.
 *
 * `discarded` and `loop.events` both carry `step` measured the way
 * `foldToLoop` measures it for its own kept events - absolute, section-
 * relative, pre-modulo - so both can be compared against the same bar
 * arithmetic without re-deriving it.
 *
 * Restricted to exactly the section's last bar, not "the last bar or two":
 * the emission mechanism this feeds (`emit.mjs`'s `.lastOf(section.bars, ...)`
 * superimposition) is a single bar wide, and a fill that genuinely spans two
 * bars would only be partially captured here - a disclosed limitation, not a
 * silent one, and one #23 explicitly allows ("missed real fills are
 * acceptable and reported").
 */
export function detectFill(discarded, loop, section, grid) {
  if (!discarded?.length || !loop?.events?.length) return null
  const perBar = stepsPerBar(grid)
  const lastBar = section.bars - 1
  const inClosingBar = mergeDuplicateSteps(discarded.filter((event) => Math.floor(event.step / perBar) === lastBar))
  if (inClosingBar.length < MIN_FILL_EVENTS) return null

  // What the surviving loop already plays at this bar's own phase within the
  // loop - the loop's own events whose step falls in the same `perBar`-wide
  // window the closing bar occupies once the loop repeats through it. A
  // discarded event's bucket can never be the same bucket a kept event lives
  // in (see this module's doc comment), so this is never counting the same
  // hit twice - only asking whether the fill adds MORE than the loop already
  // accounts for in that position.
  const phaseStart = (lastBar % loop.loopBars) * perBar
  const baseline = loop.events.filter((event) => event.step >= phaseStart && event.step < phaseStart + perBar).length
  if (inClosingBar.length <= baseline) return null

  const events = inClosingBar
    .map((event) => ({
      step: event.step - lastBar * perBar,
      length: 1,
      velocity: event.velocity,
      confidence: event.confidence,
      midi: null,
      symbol: null,
    }))
    .sort((a, b) => a.step - b.step)

  return {
    kind: 'fill',
    bar: lastBar,
    events,
    note: `${inClosingBar.length} discarded events in bar ${lastBar}, density ${inClosingBar.length} vs loop baseline ${baseline}`,
  }
}

/**
 * A crash/impact candidate from a role's discarded events, or null.
 *
 * "The section's first downbeat" is absolute step 0 - the very first instant
 * of the section, not the first step of every bar the loop repeats through -
 * which is why this checks `event.step === 0` rather than
 * `event.step % loopSteps === 0`. Every candidate here already shares that
 * one step by construction, so `mergeDuplicateSteps` always collapses them
 * to at most one merged reading (the louder of however many detections
 * landed on that single instant) - a genuine crash is a single impact, and
 * this is what makes "one" the right count to require rather than
 * "one, unless there were duplicate detections to reject as a burst".
 */
export function detectCrash(discarded, loop) {
  if (!discarded?.length || !loop?.events?.length) return null
  const atFirstDownbeat = mergeDuplicateSteps(discarded.filter((event) => event.step === 0))
  if (atFirstDownbeat.length === 0) return null
  const [hit] = atFirstDownbeat

  const loudest = Math.max(...loop.events.map((event) => event.velocity))
  if (hit.velocity <= loudest * CRASH_VELOCITY_RATIO) return null

  return {
    kind: 'crash',
    bar: 0,
    events: [{ step: 0, length: 1, velocity: hit.velocity, confidence: hit.confidence, midi: null, symbol: null }],
    note: `1 discarded event at bar 0 step 0, velocity ${hit.velocity.toFixed(2)} vs loop max ${loudest.toFixed(2)}`,
  }
}

/**
 * Both candidates for one role/section, fill checked first.
 *
 * A loop carries at most one variation, never both at once. `detectFill`'s
 * window is the section's closing bar and `detectCrash`'s is its first bar,
 * so on a section longer than one bar the two can never compete for the same
 * events - but a real section could in principle show both shapes at once
 * (a crash opening it, a fill closing it), and this schema only names one.
 * Fill wins arbitrarily in that case; a scope choice, not a measured one,
 * disclosed rather than silently dropping whichever loses.
 */
export function detectVariation(discarded, loop, section, grid) {
  return detectFill(discarded, loop, section, grid) ?? detectCrash(discarded, loop, section, grid)
}
