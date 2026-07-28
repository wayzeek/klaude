/**
 * Step maths and loop folding: the spine every transcriber sits on.
 *
 * A "step" is a sixteenth note, counted from the grid's downbeat. Everything
 * downstream speaks in steps rather than seconds, because a step is the unit
 * moltek's mini-notation is written in and the unit quantisation error is
 * measured in.
 */

export const STEPS_PER_BEAT = 4

/** The six layers a transcription can carry. Frozen: the emitter, the studio's
 *  mixer and the rack all key off these exact names. */
export const LAYERS = Object.freeze(['kick', 'snare', 'hats', 'bass', 'chords', 'lead'])

/** Loop lengths worth trying, shortest first. A loop longer than four bars
 *  stops being a loop and starts being a transcript, which #46 rules out on
 *  readability grounds. */
export const LOOP_BAR_CANDIDATES = Object.freeze([1, 2, 4])

/** A loop position has to appear in more than half the repetitions to survive
 *  the fold. Exactly half is a coin toss and produces flickering patterns. */
const KEEP_FRACTION = 0.5

/**
 * Below this, the fold is not explaining the section and a longer candidate
 * gets a turn.
 *
 * Set from a case with a clear right answer: a variation recurring in every
 * other bar scores 0.864 at one bar and 1.0 at two, and two bars is correct.
 *
 * What this metric cannot do, stated so nobody tries: separate that case from a
 * one-off fill in a single bar, which scores 0.85 at one bar and 0.9 at two.
 * The fill is the case where one bar would be the better answer, and it scores
 * *lower* than the case where two bars is right - so no threshold on this
 * metric orders them correctly. Both fold to two bars. Losing a fill to a
 * two-bar loop is a mild cost and the honest one available here; separating
 * them needs a signal beyond bucket agreement.
 */
const DEFAULT_MIN_AGREEMENT = 0.9

export function stepSeconds(grid) {
  return grid.beatSeconds / STEPS_PER_BEAT
}

export function stepsPerBar(grid) {
  return grid.beatsPerBar * STEPS_PER_BEAT
}

/** Absolute step index for a time in seconds, counted from the downbeat. */
export function stepAt(grid, seconds) {
  return Math.round((seconds - grid.downbeatSeconds) / stepSeconds(grid))
}

/**
 * How far the true onset sits from the step it quantised to, in steps.
 *
 * Positive means the onset was late. Always within -0.5..0.5, because `stepAt`
 * rounds to the nearest step. Carried through to the emission check so
 * quantisation drift is reportable separately from a dropped event.
 */
export function stepDrift(grid, seconds) {
  const exact = (seconds - grid.downbeatSeconds) / stepSeconds(grid)
  return exact - Math.round(exact)
}

/** The half-open step range a section covers, plus its bounds in seconds. */
export function sectionRange(grid, section) {
  const perBar = stepsPerBar(grid)
  const fromStep = section.startBar * perBar
  const toStep = (section.startBar + section.bars) * perBar
  return {
    fromStep,
    toStep,
    steps: toStep - fromStep,
    fromSec: grid.barAt(section.startBar),
    toSec: grid.barAt(section.startBar + section.bars),
  }
}

/**
 * Rebuild a usable grid from the scalars `reference.json` stores.
 *
 * `detectGrid` returns three closures alongside its numbers, and JSON drops
 * them silently. Every consumer that reads a grid back off disk needs them,
 * so rehydration lives here rather than being open-coded per caller.
 */
export function gridFromJson(json) {
  const beatSeconds = json.beatSeconds ?? 60 / json.bpm
  const beatsPerBar = json.beatsPerBar
  const barSeconds = json.barSeconds ?? beatSeconds * beatsPerBar
  const downbeatSeconds = json.downbeatSeconds
  return {
    ...json,
    beatSeconds,
    beatsPerBar,
    barSeconds,
    downbeatSeconds,
    beatAt: (index) => downbeatSeconds + index * beatSeconds,
    barAt: (index) => downbeatSeconds + index * barSeconds,
    secondsToBars: (seconds) => seconds / barSeconds,
  }
}

/**
 * Fold a section's events into the shortest loop that explains them.
 *
 * Sections run to sixteen bars and more. Writing every one of those bars out
 * is unreadable, and it is also usually a lie: the material repeats, and the
 * repetition is the musical fact worth capturing. So we try each candidate
 * loop length and measure how well the section's repetitions agree with each
 * other, taking the shortest that clears the bar.
 *
 * Agreement keys on pitch as well as position, because a two-bar bassline
 * whose second bar changes note has identical rhythm in both bars and would
 * otherwise fold to one bar and lose half the line.
 */
export function foldToLoop(
  events,
  section,
  grid,
  { candidates = LOOP_BAR_CANDIDATES, minAgreement = DEFAULT_MIN_AGREEMENT } = {},
) {
  const perBar = stepsPerBar(grid)
  const fromStep = section.startBar * perBar
  const local = events
    .map((event) => ({ ...event, step: event.step - fromStep }))
    .filter((event) => event.step >= 0 && event.step < section.bars * perBar)
    .sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))

  if (local.length === 0) {
    return { loopBars: Math.min(section.bars, candidates[candidates.length - 1]), events: [], agreement: 0 }
  }

  // Only candidates that divide the section evenly are usable: a 4-bar loop
  // over a 6-bar section would silently drop the last two bars.
  const usable = candidates.filter((bars) => bars <= section.bars && section.bars % bars === 0)
  if (usable.length === 0) return { loopBars: section.bars, events: local, agreement: 1 }

  let best = null
  for (const bars of usable) {
    const scored = scoreFold(local, bars, perBar, section.bars)
    if (!best || scored.agreement > best.agreement) best = scored
    if (scored.agreement >= minAgreement) return scored
  }
  // Nothing cleared the bar. The longest usable candidate loses the least.
  const longest = usable[usable.length - 1]
  return scoreFold(local, longest, perBar, section.bars)
}

/** Fold at one candidate length and measure how well the repetitions agree. */
function scoreFold(local, loopBars, perBar, sectionBars) {
  const loopSteps = loopBars * perBar
  const reps = Math.floor(sectionBars / loopBars)

  // Bucket by loop position and pitch. Two events at the same step with
  // different notes are different musical facts and must not merge.
  const buckets = new Map()
  for (const event of local) {
    const position = event.step % loopSteps
    const key = `${position}:${event.midi ?? ''}:${event.symbol ?? ''}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { position, midi: event.midi, symbol: event.symbol, members: [] }
      buckets.set(key, bucket)
    }
    bucket.members.push(event)
  }

  // Agreement: the share of event mass that sits in buckets filled by every
  // repetition. Sum of c^2 over sum of c, divided by reps - one when every
  // bucket is complete, 1/reps when nothing lines up.
  //
  // A single repetition is not evidence of anything: the loop trivially equals
  // the section, so the formula would return 1 and short-circuit the search at
  // whatever candidate happens to be as long as the section. Scoring it zero
  // makes that candidate reachable only through the fallback, which is where it
  // belongs.
  let weighted = 0
  let total = 0
  for (const bucket of buckets.values()) {
    const count = Math.min(bucket.members.length, reps)
    weighted += count * count
    total += count
  }
  const agreement = reps > 1 && total > 0 ? weighted / (total * reps) : 0

  const kept = []
  for (const bucket of buckets.values()) {
    const count = Math.min(bucket.members.length, reps)
    if (count / reps <= KEEP_FRACTION && reps > 1) continue
    kept.push(mergeBucket(bucket, count, reps))
  }
  kept.sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))
  return { loopBars, events: kept, agreement }
}

/** One event from a bucket's members: median velocity and length, mean drift,
 *  and a confidence discounted by how many repetitions actually had it. */
function mergeBucket(bucket, count, reps) {
  const members = bucket.members
  const support = reps > 1 ? count / reps : 1
  return {
    step: bucket.position,
    length: medianInt(members.map((m) => m.length)),
    velocity: median(members.map((m) => m.velocity)),
    confidence: mean(members.map((m) => m.confidence)) * support,
    midi: bucket.midi,
    symbol: bucket.symbol,
    driftSteps: mean(members.map((m) => m.driftSteps ?? 0)),
  }
}

/**
 * Median of numbers, unrounded.
 *
 * Rounding here would be a quiet disaster: velocities live in 0..1, so four
 * repeated hits at 0.8 would fold to 1 and a ghost note at 0.25 would fold to
 * 0, destroying exactly the dynamics Task 4 works to preserve - and the fold
 * would still look like it worked.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Median rounded to a whole number, for step counts, which are integers. */
function medianInt(values) {
  return Math.round(median(values))
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}
