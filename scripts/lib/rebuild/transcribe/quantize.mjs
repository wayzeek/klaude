/**
 * Step maths and loop folding: the spine every transcriber sits on.
 *
 * A "step" is a sixteenth note, counted from the grid's downbeat. Everything
 * downstream speaks in steps rather than seconds, because a step is the unit
 * moltek's mini-notation is written in and the unit quantisation error is
 * measured in.
 */

export const STEPS_PER_BEAT = 4

/** The seven layers a transcription can carry. Frozen: the emitter, the
 *  studio's mixer and the rack all key off these exact names.
 *
 *  `sub` sits next to `bass` rather than at the end: it is a register split of
 *  the same transcribed bass line (see `bass.mjs`'s `splitByRegister`), not an
 *  independent voice, and the studio's mixer/rack are name-agnostic - moltek's
 *  own `tracks/MINUIT/02-the-chase.md` already hand-writes thirteen layer
 *  names through the same `layers({...})` call, `sub` among them - so adding
 *  a name here is not the studio-contract change it would be in a mixer that
 *  hardcoded six rows. */
export const LAYERS = Object.freeze(['kick', 'snare', 'hats', 'bass', 'sub', 'chords', 'lead'])

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

/**
 * The whole-section fallback below only fires when every usable candidate
 * folded a section's events down to nothing - a bar count no candidate above
 * 1 divides evenly (17 is prime, so only the 1-bar candidate applies; every
 * bar becomes a "repetition" of it, and content that does not actually
 * repeat every bar loses every bucket to `KEEP_FRACTION`). That can mean two
 * different things and they need opposite answers: real content that simply
 * has no short loop to fold into (must survive, even as a long transcript),
 * or a couple of spurious hits that correctly failed to recur (must stay
 * empty). `agreement` cannot tell them apart - measured on the real drum and
 * bass stems, the spurious case (a 5-bar kick section, 2
 * hits, ground truth has none) scores 0.400 agreement, *higher* than one of
 * the real cases (a 5-bar bass section, 4 notes, scores 4/4 against truth)
 * at 0.300.
 *
 * Density - events per bar - separates them cleanly on the same data: the
 * spurious kick section is 0.400/bar; the real bass sections are 0.800/bar
 * and 4.176/bar. 0.5 sits in the gap, and it is not a value picked to split
 * those three points - it is `MIN_NOTES_PER_SECTION`'s own floor (both
 * transcribers require at least 2 events before ever calling `foldToLoop`),
 * generalised from the 4-bar loop it was sized for (2 events / 4 bars) to
 * whatever length this fallback actually has to cover.
 */
const MIN_FALLBACK_DENSITY = 0.5

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
 *
 * `oneEventPerStep` is for a layer that can only ever be doing one thing at a
 * given instant - a monophonic pitch line, or a chord track that sounds one
 * symbol at a time. Bucketing by position *and* pitch/symbol (above) is what
 * makes two genuinely different repetitions visible in the first place, but
 * nothing about that bucketing stops two of them from landing at the exact
 * same step and both surviving `KEEP_FRACTION`'s filter - which is exactly
 * what happened to a real bass section (two readings of the same instant, an
 * octave apart, both confidently supported). Left default (`false`), a
 * caller gets today's behaviour unchanged: this file does not know on its own
 * which layers are single-voice, so it is each transcriber's job to say so.
 *
 * The returned `discarded` array is every raw member of a bucket that failed
 * `KEEP_FRACTION` (empty when `reps <= 1`, since nothing is filtered then) -
 * real, already-detected events the loop does not explain, kept rather than
 * thrown away outright so a caller can decide whether any of it is a fill or
 * a one-off impact worth reclaiming. See `fills.mjs`, the one caller that does.
 *
 * A single bucket is kept or discarded as a whole, never both - but a bucket
 * is keyed by `position:midi:symbol`, not by position alone, so on a
 * pitched or symbolic layer two different notes at the same step are two
 * different buckets and can land on opposite sides (one kept, one
 * discarded). `discarded`'s steps are only guaranteed disjoint from `events`'
 * steps for a layer whose events carry no midi/symbol - drums, `fills.mjs`'s
 * only caller - not as a property of this function in general. Confirmed
 * directly: midi 36 kept in every repetition and midi 48 discarded after one
 * stray repetition can both report step 0 under `oneEventPerStep`.
 */
export function foldToLoop(
  events,
  section,
  grid,
  {
    candidates = LOOP_BAR_CANDIDATES,
    minAgreement = DEFAULT_MIN_AGREEMENT,
    oneEventPerStep = false,
  } = {},
) {
  const perBar = stepsPerBar(grid)
  const fromStep = section.startBar * perBar
  const local = events
    .map((event) => ({ ...event, step: event.step - fromStep }))
    .filter((event) => event.step >= 0 && event.step < section.bars * perBar)
    .sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))

  if (local.length === 0) {
    return { loopBars: Math.min(section.bars, candidates[candidates.length - 1]), events: [], agreement: 0, discarded: [] }
  }

  // Only candidates that divide the section evenly are usable: a 4-bar loop
  // over a 6-bar section would silently drop the last two bars. 1 always
  // divides evenly, so `usable` is never empty for any real caller - none
  // passes a `candidates` list without 1 in it - but a caller that did would
  // land here, so this goes through `scoreFold` (reps=1, nothing pruned)
  // rather than returning raw `local` directly: `oneEventPerStep` has to
  // reach every path that can produce output, not just the ones exercised
  // today, or a future caller asking for the constraint on an unusual
  // `candidates` list would silently not get it.
  const usable = candidates.filter((bars) => bars <= section.bars && section.bars % bars === 0)
  const result =
    usable.length === 0
      ? scoreFold(local, section.bars, perBar, section.bars, oneEventPerStep)
      : foldAgainstCandidates(local, usable, perBar, section.bars, minAgreement, oneEventPerStep)

  // `local.length > 0` here - a section with no events returned above - so a
  // result with no kept events means every candidate's fold emptied out, not
  // that there was nothing to fold. That happens whenever the section's bar
  // count shares no factor with any candidate above 1 (17 is prime, so only
  // the 1-bar candidate is usable at all): every bar is then a separate
  // "repetition" of a 1-bar loop, and if the material does not actually
  // repeat every bar, the keep-fraction filter drops every bucket - real
  // content and a couple of non-recurring spurious hits both land here the
  // same way, and `MIN_FALLBACK_DENSITY`'s own comment is where the two get
  // told apart. Below it, this result already is the answer: whatever
  // `foldAgainstCandidates` returned, honestly empty. At or above it, the
  // fallback is the whole section - longer than #46 wants a loop to be, but a
  // real transcript beats silently reporting nothing - folded through
  // `scoreFold` at `loopBars: section.bars` (one repetition, so nothing is
  // pruned) rather than returned as raw `local`, so two events that landed on
  // the exact same step and pitch still merge instead of coming out as
  // duplicates.
  if (result.events.length === 0 && local.length / section.bars >= MIN_FALLBACK_DENSITY) {
    return scoreFold(local, section.bars, perBar, section.bars, oneEventPerStep)
  }
  return result
}

/** Try each usable candidate length, shortest first, returning the first
 *  that clears `minAgreement` or the best-scoring one if none do. */
function foldAgainstCandidates(local, usable, perBar, sectionBars, minAgreement, oneEventPerStep) {
  let best = null
  for (const bars of usable) {
    const scored = scoreFold(local, bars, perBar, sectionBars, oneEventPerStep)
    if (!best || scored.agreement > best.agreement) best = scored
    if (scored.agreement >= minAgreement) return scored
  }
  // Nothing cleared the bar. The longest usable candidate loses the least.
  const longest = usable[usable.length - 1]
  return scoreFold(local, longest, perBar, sectionBars, oneEventPerStep)
}

/** Fold at one candidate length and measure how well the repetitions agree. */
function scoreFold(local, loopBars, perBar, sectionBars, oneEventPerStep = false) {
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

  // Buckets that fail KEEP_FRACTION are not just dropped - their raw members
  // (still carrying their original, absolute section-relative `step`) are
  // collected as `discarded`. That is real, already-detected content the
  // fold decided does not recur often enough to be part of the loop; #23
  // reclaims the one shape of it that is safe to reclaim - see fills.mjs.
  // A bucket can only be EITHER kept or discarded, never both - but a
  // bucket's key includes midi/symbol, not just position, so this only
  // rules out a discarded step coinciding with a kept one when a layer's
  // events carry no midi/symbol (drums - see this function's own doc
  // comment and fills.mjs, its only consumer).
  let survivors = []
  const discarded = []
  for (const bucket of buckets.values()) {
    const count = Math.min(bucket.members.length, reps)
    if (count / reps <= KEEP_FRACTION && reps > 1) {
      discarded.push(...bucket.members)
      continue
    }
    survivors.push({ bucket, count })
  }
  if (oneEventPerStep) survivors = resolveStepCollisions(survivors, loopSteps)

  const kept = survivors.map(({ bucket, count }) => mergeBucket(bucket, count, reps))
  kept.sort((a, b) => a.step - b.step || (a.midi ?? 0) - (b.midi ?? 0))
  // `resolveStepCollisions` above only guarantees at most one event *starting*
  // at a given step - it says nothing about an earlier event's `length`
  // running into where the next one starts. `mergeBucket` computes each
  // event's length as the median across repetitions independently of its
  // neighbours, so a bucket whose length happened to run long in enough
  // repetitions can outlive the next real onset even though no single
  // repetition actually overlapped. Only meaningful where `oneEventPerStep`
  // already promises a layer can't be doing two things at once - a chord or
  // drum layer isn't asking for this and keeps today's behaviour.
  if (oneEventPerStep) clampToNextOnset(kept, loopSteps)
  return { loopBars, events: kept, agreement, discarded }
}

/**
 * Shorten each event so it never reaches the step where the next one starts,
 * wrapping from the last event back to the first since the loop repeats -
 * an event that outlives the loop's own end collides with its next
 * repetition's first onset just as surely as it would collide with a
 * neighbour inside the same cycle.
 *
 * Exists because `barToMini` (emit.mjs) walks a loop's step slots by jumping
 * `event.length` steps past each onset, on the assumption that nothing else
 * occupies the steps in between - true once this runs, silently false
 * before it: a length long enough to jump past the next onset's own slot
 * skipped it outright, rather than reporting an overlap. Measured directly
 * on a real bass stem (Bicep's "Glue", several sections): a bucket's median
 * length outlived the next onset by 1-17 steps, and the emitted mini-
 * notation simply had one fewer note than the transcription - caught by the
 * emission check as "events missing", not by anything upstream, because
 * every step upstream of `barToMini` treats `length` as informational rather
 * than as a claim on steps another event might also start on.
 */
function clampToNextOnset(events, loopSteps) {
  if (events.length === 0) return
  for (let i = 0; i < events.length; i++) {
    const next = events[(i + 1) % events.length]
    const gap = i + 1 < events.length ? next.step - events[i].step : loopSteps - events[i].step + next.step
    if (gap > 0) events[i].length = Math.min(events[i].length, gap)
  }
}

/**
 * At most one survivor per loop position, for a layer that can only be doing
 * one thing at any instant. Two buckets at the same position after the
 * `KEEP_FRACTION` filter are not two simultaneous voices - this file only
 * ever sees one pitch or one symbol per bucket - they are two repetitions
 * disagreeing about what was there, and exactly one of them gets to win.
 *
 * Ranked by how many *distinct* repetitions actually had this bucket, not by
 * `count` (`KEEP_FRACTION`'s own measure, capped `members.length`): those are
 * not the same number. `members.length` counts raw detections, and a single
 * repetition can legitimately contribute more than one - a bass note briefly
 * split into two segments by a glitch, both landing on the same step - which
 * would let a bucket outscore a genuine rival that was actually heard in more
 * *different* repetitions but only once each. Recovering the repetition a
 * member came from is cheap here: `member.step` is still the absolute,
 * pre-modulo step (bucketing above computes `position` without mutating it),
 * so `step / loopSteps`, floored, is exactly that. Confidence only breaks a
 * tie in that count, per the measured case this exists for: a real bass
 * section where two pitches were each heard in every repetition (an
 * octave-detection split that recurred every time) and only their mean onset
 * confidence told them apart. A tie in both falls through to a fixed key
 * order - not `Math.random()` - so the same input always resolves the same
 * way.
 */
function resolveStepCollisions(survivors, loopSteps) {
  const byPosition = new Map()
  for (const survivor of survivors) {
    const position = survivor.bucket.position
    const incumbent = byPosition.get(position)
    if (!incumbent || isStrongerSurvivor(survivor, incumbent, loopSteps)) byPosition.set(position, survivor)
  }
  return [...byPosition.values()]
}

function isStrongerSurvivor(a, b, loopSteps) {
  const repsA = repetitionsRepresented(a.bucket, loopSteps)
  const repsB = repetitionsRepresented(b.bucket, loopSteps)
  if (repsA !== repsB) return repsA > repsB
  const confidenceA = mean(a.bucket.members.map((m) => m.confidence))
  const confidenceB = mean(b.bucket.members.map((m) => m.confidence))
  if (confidenceA !== confidenceB) return confidenceA > confidenceB
  return bucketIdentity(a.bucket) < bucketIdentity(b.bucket)
}

/** How many distinct repetitions of the loop actually contributed a member to
 *  this bucket - not how many members it has, which double-counts a
 *  repetition that produced more than one detection at the same position. */
function repetitionsRepresented(bucket, loopSteps) {
  return new Set(bucket.members.map((member) => Math.floor(member.step / loopSteps))).size
}

/** A stable, deterministic order for the last-resort tie-break above. */
function bucketIdentity(bucket) {
  return `${bucket.midi ?? ''}:${bucket.symbol ?? ''}`
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
