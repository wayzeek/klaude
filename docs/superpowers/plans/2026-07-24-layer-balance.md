# Layer Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every named layer in the studio mixer a volume fader and four feel knobs (muffled/thin, dry/roomy, early/late, straight/swung) that shape the agent's track live, without stopping playback.

**Architecture:** Every control is a trim applied on top of the written pattern, never a replacement. Volume, tone and space are applied per event inside `layers()` by a wrapper that reads a live lookup at query time, so they need no re-evaluation. Feel and swing rebuild the pattern, so they re-evaluate like solo and mute already do. The server owns the trim values beside the existing mutes and carries two change counters so a fader move cannot trigger an evaluation.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, `@strudel/repl` 1.3.0 (pinned), superdough. Package manager is **pnpm**. Tests are plain Node scripts (`scripts/selftest.mjs` via `pnpm test`, `scripts/smoke.mjs` via `pnpm smoke`), no test framework.

**Spec:** `docs/superpowers/specs/2026-07-24-layer-balance-design.md`

## Global Constraints

- Package manager is `pnpm`. Never run `npm`.
- Never auto-commit without asking. Each task below ends with a commit step; ask before running it.
- No em-dashes in any prose, comment, or doc written by this plan.
- Node 24 strips TypeScript types natively, so `scripts/*.mjs` can `import` a `.ts` file directly, but **the import specifier must include the `.ts` extension** and the imported file must not use non-erasable syntax (enums, namespaces, parameter properties).
- Node cannot resolve the `@/...` path alias. `src/lib/trim.ts` has no imports at all, so a test can import it statically. `src/lib/layers-runtime.ts` does import `@/lib/trim`, so testing it needs the alias hook and the **dynamic** import that Task 4 sets up. Verified: a static import of a file containing `@/lib/...` fails with `ERR_MODULE_NOT_FOUND` even when the hook is registered, because static specifiers resolve at link time before any module body runs.
- `src/lib/trim.ts` must stay dependency-free: no React, no server imports, no Strudel imports. It is the only file allowed to contain the audio numbers.
- `scripts/selftest.mjs` has **no `main()`**. It calls its suites at the top level, at the bottom of the file, under a `// --- main ---` comment: `testAnalysis()` then `await testLinter()`, then prints the tally and exits. New suites are added to that block, in order.
- Trim value ranges and neutrals, exactly: `volume` 0 to 2 neutral 1; `tone` -1 to 1 neutral 0; `space` -1 to 1 neutral 0; `feel` -1 to 1 neutral 0; `swing` 0 to 1 neutral 0.
- A neutral trim must return the *same value object* and the *same pattern* it was handed.
- Existing UI conventions: monospace, 1px borders, square corners, no blur, no shadows, no gradients. Reuse the `.flat-fader` class in `src/app/globals.css` for sliders.
- Do not use `swingBy`. It multiplies events. See Task 2.

---

## File Structure

**Create:**
- `src/lib/trim.ts` - trim vocabulary, clamping, and all audio maths. Pure.
- `src/lib/throttle.ts` - leading-edge throttle with a flush, for fader drags. Pure.
- `src/lib/layers-runtime.ts` - the `layers()` implementation, moved out of the hook and extended with trims.
- `src/components/channel-row.tsx` - one mixer row: number, activity light, name, fader, solo, mute.
- `src/components/channel-strip.tsx` - the selected layer's four knobs, reset, and note box.

**Modify:**
- `src/app/api/state.ts` - `MixState` gains `trims` and `structuralSeq`; `setMix` handles trim patches; persistence and pruning extended.
- `src/app/api/mix/route.ts` - validates `trim` and `resetTrim`.
- `src/hooks/use-strudel.ts` - `Mix` type, live trim ref, structural-seq gating, delegates `layers()` to the runtime.
- `src/components/mixer-panel.tsx` - becomes the list plus selection state only.
- `scripts/selftest.mjs` - unit tests for trim maths, the swing regression, the live-read behaviour, and the throttle.
- `scripts/smoke.mjs` - API coverage for trim patches and counters.
- `README.md`, `.claude/skills/api/SKILL.md`, `.claude/skills/humanize/SKILL.md` - document trims for the agent.

---

### Task 1: Trim vocabulary and value maths

**Files:**
- Create: `src/lib/trim.ts`
- Test: `scripts/selftest.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LayerTrim = { volume: number; tone: number; space: number; feel: number; swing: number }`; `NEUTRAL_TRIM: LayerTrim`; `TRIM_RANGES: Record<keyof LayerTrim, [number, number]>`; `clampTrim(patch: Partial<LayerTrim>, base?: LayerTrim): LayerTrim`; `isNeutral(t: LayerTrim): boolean`; `isStructuralDifference(a: LayerTrim, b: LayerTrim): boolean`; `applyValueTrim<V extends Record<string, unknown>>(value: V, trim: LayerTrim): V`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/selftest.mjs`. Put the import beside the existing imports at the top:

```javascript
import { NEUTRAL_TRIM, clampTrim, isNeutral, isStructuralDifference, applyValueTrim } from '../src/lib/trim.ts'
```

Then add this function. Step 5 wires it into the runner:

```javascript
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
  check(
    'volume change is not structural',
    !isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, volume: 0.5 }),
  )
  check(
    'swing change is structural',
    isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, swing: 0.5 }),
  )
  check(
    'feel change is structural',
    isStructuralDifference(NEUTRAL_TRIM, { ...NEUTRAL_TRIM, feel: 0.5 }),
  )
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL, `Cannot find module` for `../src/lib/trim.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/trim.ts`:

```typescript
/**
 * =============================================================================
 * LAYER TRIMS
 * =============================================================================
 *
 * Per-layer mix trims and the audio maths behind them. Every value is a trim
 * on top of what the track's code already asked for, never a replacement, and
 * every neutral is a true no-op: at neutral these functions hand back the very
 * object and pattern they were given.
 *
 * All the numbers live here and nowhere else. This file is pure so they can be
 * tested without a browser, a server, or an audio context.
 */

export type LayerTrim = {
  /** Multiplies postgain. 1 is as written. */
  volume: number
  /** Below 0 closes a lowpass, above 0 opens a highpass. 0 is as written. */
  tone: number
  /** Offsets the reverb send. 0 is as written. */
  space: number
  /** Leans the layer early or late. 0 is on the beat. */
  feel: number
  /** Delays off-beat hits. 0 is straight. */
  swing: number
}

export const NEUTRAL_TRIM: LayerTrim = { volume: 1, tone: 0, space: 0, feel: 0, swing: 0 }

export const TRIM_RANGES: Record<keyof LayerTrim, [number, number]> = {
  volume: [0, 2],
  tone: [-1, 1],
  space: [-1, 1],
  feel: [-1, 1],
  swing: [0, 1],
}

/** Cutoff assumed for a layer whose code set no lowpass: effectively open. */
const OPEN_HZ = 20000
/** Darkening stops here rather than reaching silence. */
const DARK_FLOOR_HZ = 120
/** Where the thinning highpass starts, just below audibility. */
const HPF_BASE_HZ = 30
/** How much of the reverb send a full turn of the space knob is worth. */
const SPACE_DEPTH = 0.6

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

const TRIM_KEYS = Object.keys(TRIM_RANGES) as (keyof LayerTrim)[]

/**
 * Fold a partial patch onto a base trim, clamping each value into range.
 * Out-of-range numbers are clamped rather than rejected, so a slider mid-drag
 * can never produce a state the mixer refuses. Values that are not finite
 * numbers are ignored entirely.
 */
export function clampTrim(patch: Partial<LayerTrim>, base: LayerTrim = NEUTRAL_TRIM): LayerTrim {
  const out: LayerTrim = { ...base }
  for (const key of TRIM_KEYS) {
    const value = patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const [lo, hi] = TRIM_RANGES[key]
      out[key] = clamp(value, lo, hi)
    }
  }
  return out
}

export const isNeutral = (trim: LayerTrim): boolean =>
  trim.volume === 1 && trim.tone === 0 && trim.space === 0 && trim.feel === 0 && trim.swing === 0

/**
 * Does moving from `a` to `b` require the pattern to be rebuilt? Only feel and
 * swing restructure; volume, tone and space are read per event at query time.
 * The whole point of the live fader path is that this returns false for them.
 */
export const isStructuralDifference = (a: LayerTrim, b: LayerTrim): boolean =>
  a.feel !== b.feel || a.swing !== b.swing

/**
 * Apply the per-event trims to one hap value.
 *
 * Volume targets `postgain` rather than `gain`: postgain defaults to a clean 1,
 * sits after the inline effects, and feeds the delay and reverb sends, so a hit
 * and its tails scale together. Multiplying `gain` would preserve per-hit
 * dynamics too, but it starts from an 0.8 default and lands in front of the fx.
 */
export function applyValueTrim<V extends Record<string, unknown>>(value: V, trim: LayerTrim): V {
  if (trim.volume === 1 && trim.tone === 0 && trim.space === 0) return value

  const next: Record<string, unknown> = { ...value }

  if (trim.volume !== 1) {
    const postgain = typeof value.postgain === 'number' ? value.postgain : 1
    next.postgain = postgain * trim.volume
  }

  if (trim.tone !== 0) {
    const base = typeof value.cutoff === 'number' ? value.cutoff : OPEN_HZ
    if (trim.tone < 0) {
      // Never brighter than written, and never above the code's own cutoff when
      // that already sits below the floor: a flat 120 would *raise* it.
      next.cutoff = clamp(base * 2 ** (4 * trim.tone), Math.min(base, DARK_FLOOR_HZ), base)
    } else {
      const existing = typeof value.hcutoff === 'number' ? value.hcutoff : 0
      const target = HPF_BASE_HZ * 2 ** (6 * trim.tone)
      // Cap under the lowpass so the two filters cannot close on each other and
      // silence the layer, but never below a highpass the code asked for.
      const cap = Math.max(base / 4, existing)
      next.hcutoff = Math.min(Math.max(existing, target), cap)
    }
  }

  if (trim.space !== 0) {
    const room = typeof value.room === 'number' ? value.room : 0
    next.room = clamp(room + SPACE_DEPTH * trim.space, 0, 1)
  }

  return next as V
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for every `trim values:` check.

- [ ] **Step 5: Wire the new test into the runner**

`scripts/selftest.mjs` has no `main()`. Its suites run at the top level at the bottom of the file:

```javascript
// --- main ---------------------------------------------------------------------

testAnalysis()
await testLinter()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
```

Add `testTrimValues()` to that block, before the tally:

```javascript
testAnalysis()
await testLinter()
testTrimValues()
```

Leave the tally and exit logic untouched. Every later task adds its own call to this same block, so re-read it rather than assuming what is already there.

- [ ] **Step 6: Typecheck**

Run: `pnpm build`
Expected: compiles with no type errors.

- [ ] **Step 7: Commit** (ask first)

```bash
git add src/lib/trim.ts scripts/selftest.mjs
git commit -m "feat: per-layer trim vocabulary and value maths"
```

---

### Task 2: Structural trim transform

**Files:**
- Modify: `src/lib/trim.ts`
- Test: `scripts/selftest.mjs`

**Interfaces:**
- Consumes: `LayerTrim`, `NEUTRAL_TRIM` from Task 1.
- Produces: `type StructuralPattern` and `applyStructuralTrim<P extends StructuralPattern<P>>(pattern: P, trim: LayerTrim): P`.

**Why this task exists on its own:** Strudel's `swingBy` looks like the right primitive and is not. It is `pat.inside(n, late(seq(0, swing / 2)))`, and that patterned `late` multiplies structure: any event longer than half a slice spans both argument values and is emitted twice. Measured at full travel with `n = 4` over 4 cycles: a one-chord pad goes 4 events to 32, `hh*4` goes 16 to 32, `hh*8` goes 32 to 48. The test below is the guard against anyone "simplifying" this back to `swingBy`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/selftest.mjs`. Extend the Task 1 import:

```javascript
import {
  NEUTRAL_TRIM,
  clampTrim,
  isNeutral,
  isStructuralDifference,
  applyValueTrim,
  applyStructuralTrim,
} from '../src/lib/trim.ts'
```

Add this function, and add `await testTrimStructure()` to the runner block at the bottom of the file (see Task 1 Step 5):

```javascript
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
    // The regression that matters: swing must never add or drop a hit.
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
  check(
    'swing pushes the off-eighth late',
    swungEighths[1] > 0.125 + 1e-9,
    `second=${swungEighths[1]}`,
  )
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
  check(
    'feel shifts by 1/64 of a cycle',
    Math.abs(late[0] - 1 / 64) < 1e-9,
    `shift=${late[0]}`,
  )

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL, `applyStructuralTrim is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/trim.ts`:

```typescript
/** How far a full turn of the feel knob leans a layer, in cycles. */
const FEEL_CYCLES = 1 / 64
/** Slices per cycle that swing works within: quarter-slices, so eighths lope. */
const SWING_SUBDIVISION = 4
/** Delay at full swing, as a fraction of a half-slice. */
const SWING_DEPTH = 2 / 3

/**
 * The pattern surface the structural trims need. Declared structurally rather
 * than imported so this file stays free of Strudel.
 */
export type StructuralPattern<P> = {
  inside: (n: number, fn: (pattern: P) => P) => P
  within: (start: number, end: number, fn: (pattern: P) => P) => P
  late: (amount: number) => P
  early: (amount: number) => P
}

/**
 * Apply the trims that rebuild the pattern. Swing first, then feel: swing
 * rearranges hits inside the bar, feel leans the finished layer against the
 * beat. Measured against this engine the two happen to commute on ordinary
 * patterns, so this order is not load-bearing today; it is fixed and owned in
 * one place so that behaviour cannot drift if either transform changes.
 *
 * Swing is deliberately not Strudel's `swingBy`. That is
 * `pat.inside(n, late(seq(0, swing / 2)))`, whose patterned `late` multiplies
 * structure: an event longer than half a slice spans both argument values and
 * is emitted twice, which flams held notes instead of swinging them. Routing
 * each event through `within` sends it down exactly one branch, so the event
 * count is preserved on every layer.
 */
export function applyStructuralTrim<P extends StructuralPattern<P>>(pattern: P, trim: LayerTrim): P {
  let out = pattern
  if (trim.swing > 0) {
    const delay = (SWING_DEPTH * trim.swing) / 2
    out = out.inside(SWING_SUBDIVISION, (slice) => slice.within(0.5, 1, (half) => half.late(delay)))
  }
  if (trim.feel !== 0) {
    const shift = Math.abs(trim.feel) * FEEL_CYCLES
    out = trim.feel > 0 ? out.late(shift) : out.early(shift)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for every `trim structure:` check, including all four count-preservation checks.

- [ ] **Step 5: Commit** (ask first)

```bash
git add src/lib/trim.ts scripts/selftest.mjs
git commit -m "feat: swing and feel transforms that preserve event counts"
```

---

### Task 3: Server owns the trims

**Files:**
- Modify: `src/app/api/state.ts`
- Modify: `src/app/api/mix/route.ts`
- Test: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: `LayerTrim`, `clampTrim`, `isNeutral`, `isStructuralDifference`, `NEUTRAL_TRIM` from Tasks 1 and 2.
- Produces: `MixState = { muted: string[]; soloed: string[]; trims: Record<string, LayerTrim>; seq: number; structuralSeq: number }`. `state.setMix` accepts `trim?: { layer: string } & Partial<LayerTrim>` and `resetTrim?: string`. `POST /api/mix` accepts those two forms.

- [ ] **Step 1: Add an SSE frame collector to the smoke helpers**

One check below needs to count SSE frames. The existing `openStream()` helper cannot: it reads once and discards, because its job is to make the server count a live connection. Add this beside it in `scripts/smoke.mjs`:

```javascript
/**
 * Open an SSE stream and keep the frames it receives. The route sends the
 * current state as `data: {...}\n\n`, plus `: heartbeat\n\n` comments which
 * are not frames and are skipped.
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
```

- [ ] **Step 2: Write the failing test**

Add to `scripts/smoke.mjs`, inside `main()`, after the existing `mix:` block. Note the deterministic reset first: the server persists mix state between runs, so a check that assumes an empty starting mix is flaky.

```javascript
console.log('trims:')
// Deterministic starting point. Persisted state means we cannot assume neutral.
await post('/api/mix', { muted: [], soloed: [] })
await post('/api/mix', { resetTrim: 'bass' })
const t0 = await get('/api/mix').then((r) => r.json())
check('mix exposes trims', t0.mix.trims !== null && typeof t0.mix.trims === 'object')
check('mix exposes structuralSeq', typeof t0.mix.structuralSeq === 'number')

// A value-only patch moves seq but NOT structuralSeq. This is the check that
// protects the live fader: a moving structuralSeq means re-evaluation.
const vol = await post('/api/mix', { trim: { layer: 'bass', volume: 0.5 } }).then((r) => r.json())
check('trim stores the value', vol.mix.trims.bass?.volume === 0.5, JSON.stringify(vol.mix.trims.bass))
check('trim leaves other values neutral', vol.mix.trims.bass?.tone === 0)
check('value trim bumps seq', vol.mix.seq === t0.mix.seq + 1)
check(
  'value trim does not bump structuralSeq',
  vol.mix.structuralSeq === t0.mix.structuralSeq,
  `${t0.mix.structuralSeq} -> ${vol.mix.structuralSeq}`,
)

// A structural patch moves both.
const swung = await post('/api/mix', { trim: { layer: 'bass', swing: 0.5 } }).then((r) => r.json())
check('swing trim bumps structuralSeq', swung.mix.structuralSeq === vol.mix.structuralSeq + 1)
check('swing trim preserves the earlier volume', swung.mix.trims.bass?.volume === 0.5)

// A no-op patch moves neither counter.
const noop = await post('/api/mix', { trim: { layer: 'bass', volume: 0.5 } }).then((r) => r.json())
check('no-op trim does not bump seq', noop.mix.seq === swung.mix.seq, `${swung.mix.seq} -> ${noop.mix.seq}`)
check('no-op trim does not bump structuralSeq', noop.mix.structuralSeq === swung.mix.structuralSeq)

// Out-of-range clamps, junk is refused.
const clamped = await post('/api/mix', { trim: { layer: 'bass', volume: 99, tone: -99 } }).then((r) => r.json())
check('volume clamps to 2', clamped.mix.trims.bass?.volume === 2)
check('tone clamps to -1', clamped.mix.trims.bass?.tone === -1)
const badTrim = await post('/api/mix', { trim: { layer: 'bass', volume: 'loud' } })
check('non-numeric trim value is 400', badTrim.status === 400)
const noLayer = await post('/api/mix', { trim: { volume: 0.5 } })
check('trim without a layer is 400', noLayer.status === 400)

// One request may carry a trim and a mute together, as ONE mutation with ONE
// SSE emission. Counting seq cannot show that, so watch the stream. The
// existing openStream() helper deliberately discards what it reads (it exists
// to make the server count a live connection), so this needs its own reader.
const stream = await collectFrames('smoke-combined')
await new Promise((resolve) => setTimeout(resolve, 300)) // let the initial snapshot land
const framesBefore = stream.frames.length
const combined = await post('/api/mix', {
  trim: { layer: 'keys', space: 0.5 },
  toggleMuted: 'keys',
}).then((r) => r.json())
check('combined patch stores the trim', combined.mix.trims.keys?.space === 0.5)
check('combined patch applies the mute', combined.mix.muted.includes('keys'))
check('combined patch bumps seq once', combined.mix.seq === clamped.mix.seq + 1)
await new Promise((resolve) => setTimeout(resolve, 300))
check(
  'combined patch emits once',
  stream.frames.length === framesBefore + 1,
  `${stream.frames.length - framesBefore} frames`,
)
await stream.close()

// Reset drops the record entirely, and so does returning every value to neutral.
const reset = await post('/api/mix', { resetTrim: 'bass' }).then((r) => r.json())
check('reset drops the record', reset.mix.trims.bass === undefined, JSON.stringify(reset.mix.trims))
const backToNeutral = await post('/api/mix', {
  trim: { layer: 'keys', space: 0 },
}).then((r) => r.json())
check('returning to neutral drops the record', backToNeutral.mix.trims.keys === undefined)

// Status reports trims so the agent can read the listener's balance.
const statusTrims = await get('/api/status').then((r) => r.json())
check('status reports trims', statusTrims.mix?.trims !== undefined)

// Leave a clean mix behind. Note this does not restore whatever mute, solo or
// trim state existed before the run: smoke already rewrites mix state freely,
// and the reset above destroyed the baseline on purpose so the seq assertions
// are deterministic. Anyone mid-session should expect their mix reset by smoke.
await post('/api/mix', { muted: [], soloed: [] })
await post('/api/mix', { resetTrim: 'keys' })
await post('/api/mix', { resetTrim: 'bass' })
```

- [ ] **Step 3: Run test to verify it fails**

Start the dev server in one terminal: `pnpm dev`
Then run: `pnpm smoke`
Expected: FAIL on `mix exposes trims` and most checks below it.

- [ ] **Step 4: Extend the state**

In `src/app/api/state.ts`, add the import beside the existing `DEFAULT_CODE` import:

```typescript
import { clampTrim, isNeutral, isStructuralDifference, NEUTRAL_TRIM, type LayerTrim } from '@/lib/trim'
```

Replace the `MixState` type:

```typescript
export type MixState = {
  muted: string[]
  soloed: string[]
  /** Only non-neutral entries are stored, keyed by layer name. */
  trims: Record<string, LayerTrim>
  /** Bumps on any mix change. */
  seq: number
  /** Bumps only on changes that require the pattern to be rebuilt. */
  structuralSeq: number
}
```

Add `trims` to `PersistedState`:

```typescript
type PersistedState = {
  code: string
  revision: number
  history: HistoryEntry[]
  mutedLayers?: string[]
  trims?: Record<string, LayerTrim>
  notes?: Note[]
}
```

In `loadPersisted`, after the `mutedLayers` block, validate the stored trims. A hand-edited or truncated file must not inject a value that request-time clamping never saw:

```typescript
  const trims: Record<string, LayerTrim> = {}
  const rawTrims = (parsed as { trims?: unknown }).trims
  if (rawTrims !== null && typeof rawTrims === 'object' && !Array.isArray(rawTrims)) {
    for (const [name, value] of Object.entries(rawTrims as Record<string, unknown>)) {
      if (name.length === 0 || name.length > MAX_LAYER_NAME) continue
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const clamped = clampTrim(value as Partial<LayerTrim>)
      if (!isNeutral(clamped)) trims[name] = clamped
      if (Object.keys(trims).length >= MAX_TRIMS) break
    }
  }
```

Add the two limits beside the existing constants near `HISTORY_LIMIT`:

```typescript
const MAX_TRIMS = 64
const MAX_LAYER_NAME = 40
```

Return `trims` from `loadPersisted` (add it to the returned object).

Update the constructor's mix initialisation:

```typescript
    this._mix = {
      muted: persisted?.mutedLayers ?? [],
      soloed: [],
      trims: persisted?.trims ?? {},
      seq: 0,
      structuralSeq: 0,
    }
```

Update the field declaration:

```typescript
  private _mix: MixState = { muted: [], soloed: [], trims: {}, seq: 0, structuralSeq: 0 }
```

- [ ] **Step 5: Teach setMix about trims**

Replace `setMix` in `src/app/api/state.ts` with this. The counters are computed by comparing against the stored state, so the rule about what counts as structural lives in exactly one place:

```typescript
  /**
   * Update mix state. Arrays replace wholesale; toggles flip one name against
   * the CURRENT server state, so two rapid clicks from a stale client snapshot
   * cannot overwrite each other. Solo and mute are exclusive per layer.
   *
   * Two counters come out of this. `seq` moves on any change. `structuralSeq`
   * moves only when the pattern has to be rebuilt, which is mute, solo, feel
   * and swing. A patch that changes nothing moves neither and emits nothing:
   * a spurious structural bump would re-evaluate the track under a fader.
   */
  setMix(patch: {
    muted?: string[]
    soloed?: string[]
    toggleMuted?: string
    toggleSoloed?: string
    trim?: { layer: string } & Partial<LayerTrim>
    resetTrim?: string
  }): MixState {
    const prev = this._mix
    const without = (list: string[], name: string) => list.filter((n) => n !== name)
    let muted = patch.muted ?? prev.muted
    let soloed = patch.soloed ?? prev.soloed
    if (patch.toggleMuted) {
      if (muted.includes(patch.toggleMuted)) {
        muted = without(muted, patch.toggleMuted)
      } else {
        muted = [...muted, patch.toggleMuted]
        soloed = without(soloed, patch.toggleMuted)
      }
    }
    if (patch.toggleSoloed) {
      if (soloed.includes(patch.toggleSoloed)) {
        soloed = without(soloed, patch.toggleSoloed)
      } else {
        soloed = [...soloed, patch.toggleSoloed]
        muted = without(muted, patch.toggleSoloed)
      }
    }

    const trims = { ...prev.trims }
    if (patch.resetTrim) delete trims[patch.resetTrim]
    if (patch.trim) {
      const { layer, ...values } = patch.trim
      const merged = clampTrim(values, trims[layer] ?? NEUTRAL_TRIM)
      // A layer back at neutral carries no record, so the common case stays empty.
      if (isNeutral(merged)) delete trims[layer]
      // Live state needs the same ceiling the persisted file has, or a client
      // naming a fresh layer on every request could grow this without bound.
      // Layers that already have a record are always allowed to change.
      else if (layer in trims || Object.keys(trims).length < MAX_TRIMS) trims[layer] = merged
    }

    const sameNames = (a: string[], b: string[]) =>
      a.length === b.length && a.every((name) => b.includes(name))
    const trimNames = new Set([...Object.keys(prev.trims), ...Object.keys(trims)])
    let trimsChanged = false
    let trimsStructural = false
    for (const name of trimNames) {
      const before = prev.trims[name] ?? NEUTRAL_TRIM
      const after = trims[name] ?? NEUTRAL_TRIM
      if (isStructuralDifference(before, after)) trimsStructural = true
      if (
        before.volume !== after.volume ||
        before.tone !== after.tone ||
        before.space !== after.space ||
        before.feel !== after.feel ||
        before.swing !== after.swing
      ) {
        trimsChanged = true
      }
    }

    const structural =
      !sameNames(prev.muted, muted) || !sameNames(prev.soloed, soloed) || trimsStructural
    if (!structural && !trimsChanged) return prev

    this._mix = {
      muted,
      soloed,
      trims,
      seq: prev.seq + 1,
      structuralSeq: prev.structuralSeq + (structural ? 1 : 0),
    }
    this.schedulePersist()
    this.emit()
    return this._mix
  }
```

- [ ] **Step 6: Persist and prune the trims**

In `persistNow`, add trims to the payload:

```typescript
        mutedLayers: this._mix.muted,
        trims: this._mix.trims,
```

In `recordEval`, extend the pruning block so trims follow the same lifecycle as mutes. Replace the lines from `const muted = ...` down to the end of the `if (pruned) { ... }` block, but **keep the `if (namesChanged || pruned) this.emit()` line that follows it**. Dropping that emit would stop the SSE that publishes pruned trims and changed layer names, which is how every browser learns its rows:

```typescript
      const muted = this._mix.muted.filter((n) => layers.includes(n))
      const soloed = this._mix.soloed.filter((n) => layers.includes(n))
      const trims: Record<string, LayerTrim> = {}
      let structuralTrimPruned = false
      for (const [name, trim] of Object.entries(this._mix.trims)) {
        if (layers.includes(name)) trims[name] = trim
        else if (isStructuralDifference(trim, NEUTRAL_TRIM)) structuralTrimPruned = true
      }
      const namesPruned =
        muted.length !== this._mix.muted.length || soloed.length !== this._mix.soloed.length
      const pruned =
        namesPruned || Object.keys(trims).length !== Object.keys(this._mix.trims).length
      if (pruned) {
        // A vanished layer's trim would otherwise apply to whatever later
        // reuses the name. Only a pruned mute, solo, feel or swing is
        // structural: dropping a stale volume needs no re-evaluation, and
        // bumping structuralSeq here would evaluate the track a second time
        // immediately after the evaluation that reported these names.
        const structural = namesPruned || structuralTrimPruned
        this._mix = {
          muted,
          soloed,
          trims,
          seq: this._mix.seq + 1,
          structuralSeq: this._mix.structuralSeq + (structural ? 1 : 0),
        }
        this.schedulePersist()
      }
```

Also update the `applyCode` solo-clearing block, which constructs a mix object:

```typescript
    if (this._mix.soloed.length > 0) {
      this._mix = {
        ...this._mix,
        soloed: [],
        seq: this._mix.seq + 1,
        structuralSeq: this._mix.structuralSeq + 1,
      }
    }
```

- [ ] **Step 7: Validate the new request forms**

In `src/app/api/mix/route.ts`, add the import:

```typescript
import { TRIM_RANGES, type LayerTrim } from '@/lib/trim'
```

Add this validator above `export async function GET`:

```typescript
/**
 * Validate a trim patch. Out-of-range numbers are the caller's normal case
 * (a slider mid-drag) and get clamped downstream; a non-numeric value is a
 * client bug and is refused so it cannot be silently ignored.
 */
function parseTrim(value: unknown): { trim?: { layer: string } & Partial<LayerTrim>; error?: string } {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'trim must be an object like { "layer": "bass", "volume": 0.5 }' }
  }
  const { layer, ...rest } = value as Record<string, unknown>
  if (typeof layer !== 'string' || layer.length === 0 || layer.length > MAX_NAME_LENGTH) {
    return { error: `trim.layer must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` }
  }
  const patch: Record<string, number> = {}
  for (const [key, raw] of Object.entries(rest)) {
    if (!(key in TRIM_RANGES)) return { error: `trim.${key} is not a mix control` }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { error: `trim.${key} must be a finite number` }
    }
    patch[key] = raw
  }
  if (Object.keys(patch).length === 0) return { error: 'trim needs at least one control value' }
  return { trim: { layer, ...patch } as { layer: string } & Partial<LayerTrim> }
}
```

In `POST`, destructure the two new fields, validate them, include them in the "nothing provided" guard, and pass them to `setMix`:

```typescript
  const { muted, soloed, toggleMuted, toggleSoloed, trim, resetTrim } = (body ?? {}) as {
    muted?: unknown
    soloed?: unknown
    toggleMuted?: unknown
    toggleSoloed?: unknown
    trim?: unknown
    resetTrim?: unknown
  }
```

```typescript
  const trimParsed = parseTrim(trim)
  if (trimParsed.error) return NextResponse.json({ error: trimParsed.error }, { status: 400 })
  if (
    resetTrim !== undefined &&
    (typeof resetTrim !== 'string' || resetTrim.length === 0 || resetTrim.length > MAX_NAME_LENGTH)
  ) {
    return NextResponse.json(
      { error: `resetTrim must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` },
      { status: 400 },
    )
  }
```

Extend the empty-patch guard to include the new fields, and extend the `setMix` call:

```typescript
  if (
    !mutedParsed.names &&
    !soloedParsed.names &&
    toggleMuted === undefined &&
    toggleSoloed === undefined &&
    !trimParsed.trim &&
    resetTrim === undefined
  ) {
    return NextResponse.json(
      { error: 'Provide muted/soloed arrays, toggleMuted/toggleSoloed names, or trim/resetTrim' },
      { status: 400 },
    )
  }
```

```typescript
    mix: state.setMix({
      muted: mutedParsed.names,
      soloed: soloedParsed.names,
      toggleMuted: toggleMuted as string | undefined,
      toggleSoloed: toggleSoloed as string | undefined,
      trim: trimParsed.trim,
      resetTrim: resetTrim as string | undefined,
    }),
```

Update the file's header comment to mention the trim forms and the two counters.

- [ ] **Step 8: Harden the pre-existing seq check**

The new no-op guard makes one existing check order-dependent. `scripts/smoke.mjs` currently reads the mix and then asserts that setting `{ muted: ['bass'], soloed: ['hats'] }` bumps `seq` by exactly one. If the server already holds that exact state, the patch is now a no-op and the check fails through no fault of the code.

In `scripts/smoke.mjs`, insert a reset immediately after `console.log('mix:')` and before `const mix0 = ...`:

```javascript
  // setMix no longer bumps seq for a patch that changes nothing, so this block
  // cannot assume anything about the server's current mix. Reset, then read.
  await post('/api/mix', { muted: [], soloed: [] })
```

Leave the rest of the block alone: the toggle checks that follow all make real changes, so their increments still hold.

- [ ] **Step 9: Run the smoke test**

Run: `pnpm smoke` (with `pnpm dev` running)
Expected: PASS for every `trims:` check, and the pre-existing `mix:` checks still pass.

Then prove the order-dependence is really gone by running it twice in a row against the same server: `pnpm smoke && pnpm smoke`
Expected: identical results both times.

- [ ] **Step 10: Typecheck**

Run: `pnpm build`
Expected: compiles clean.

- [ ] **Step 11: Commit** (ask first)

```bash
git add src/app/api/state.ts src/app/api/mix/route.ts scripts/smoke.mjs
git commit -m "feat: server-side per-layer trims with a structural change counter"
```

---

### Task 4: Extract the layers() runtime unchanged

**Files:**
- Create: `src/lib/layers-runtime.ts`
- Modify: `src/hooks/use-strudel.ts:204-243` (the `layers()` effect)
- Test: `scripts/selftest.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type LayerPattern`; `type LayersRuntimeDeps = { getMix: () => { muted: string[]; soloed: string[] }; collect: (name: string) => void; onPulse: (layer: string, delayMs: number) => void }`; `createLayersRuntime(deps: LayersRuntimeDeps): (map: Record<string, LayerPattern>) => LayerPattern`.

**This task changes no behaviour.** It moves code so the next task has something testable to extend. Trims arrive in Task 5.

- [ ] **Step 1: Teach the test resolver about the `@/` alias**

`layers-runtime.ts` imports `@/lib/trim`, and Node cannot resolve that alias, so importing the runtime from a test fails with `ERR_MODULE_NOT_FOUND`. The project already registers a resolve hook for the Strudel tests, so extend it rather than adding a second mechanism.

Append to `scripts/lib/strudel-resolver.mjs`:

```javascript
/** Repo root, two levels up from scripts/lib/. */
const SRC_ROOT = new URL('../../src/', import.meta.url).href

/**
 * Resolve the app's `@/*` path alias to `src/*`, so files under src/ stay
 * idiomatic while still being importable from these Node test scripts.
 * TypeScript is stripped natively, but only for a specifier that names the
 * file, so a bare alias gets `.ts` appended.
 */
function resolveAlias(specifier) {
  const relative = specifier.slice('@/'.length)
  const suffix = /\.[a-z]+$/.test(relative) ? '' : '.ts'
  return new URL(`${relative}${suffix}`, SRC_ROOT).href
}
```

and add a branch at the top of the existing `resolve` function, before the `@kabelsalat/web` branch:

```javascript
  if (specifier.startsWith('@/')) {
    return { url: resolveAlias(specifier), shortCircuit: true }
  }
```

- [ ] **Step 2: Write the failing test**

The runtime must be imported **dynamically**. A static import specifier is resolved at link time, before any module body has run, so the hook is not yet active and the import fails even though it is registered. This was verified: the static form throws `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`, the dynamic form works.

Add to `scripts/selftest.mjs`, and add `await testLayersRuntime()` to the runner block at the bottom (see Task 1 Step 5). Note there is no top-level import for the runtime:

```javascript
async function testLayersRuntime() {
  console.log('layers runtime:')
  const strudel = await loadStrudel()
  // Dynamic: the alias hook has to be live before this specifier resolves.
  const { createLayersRuntime } = await import('../src/lib/layers-runtime.ts')
  const track = await strudel.evaluateTrack('$: s("bd*2")')
  const other = await strudel.evaluateTrack('$: s("hh*4")')

  const countIn = (pattern, cycles) =>
    pattern.queryArc(0, cycles).filter((hap) => hap.whole).length

  // Names are collected in declaration order, for the console's row order.
  let mix = { muted: [], soloed: [] }
  const collected = []
  const pulses = []
  const layers = createLayersRuntime({
    getMix: () => mix,
    collect: (name) => collected.push(name),
    onPulse: (layer) => pulses.push(layer),
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
  check('pulses name the layer', pulses.length > 0 && pulses.every((p) => p === 'kick'), pulses.join(','))

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL, cannot find `../src/lib/layers-runtime.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/layers-runtime.ts`, moving the body of the `layers()` effect out of `use-strudel.ts` verbatim except for the injected dependencies:

```typescript
/**
 * =============================================================================
 * LAYERS RUNTIME
 * =============================================================================
 *
 * `layers({ kick, bass, ... })` is klaude's track contract: the agent names
 * every layer, and the console gets a row per name that can solo, mute and
 * trim it live.
 *
 * This is the function evaluated code calls. It registers the names, drops the
 * layers the mix silences, taps each survivor for activity pulses, and returns
 * the stacked pattern. It is deliberately free of React and of the server
 * protocol: everything it needs arrives as a dependency, which is also what
 * makes it testable in Node.
 */

/**
 * The pattern surface this runtime uses. Declared structurally so Strudel
 * stays out of this file, and as an `interface` rather than a `type` because
 * Task 5 extends it with a generic type parameterised by itself, which a type
 * alias cannot express (TS2456, circular reference).
 */
export interface LayerPattern {
  stack: (other: LayerPattern) => LayerPattern
  mask: (pattern: string) => LayerPattern
  onTrigger: (
    fn: (hap: unknown, currentTime: number, cps: number, targetTime: number) => void,
    dominant: boolean,
  ) => LayerPattern
}

export type LayersRuntimeDeps = {
  /** Current solo/mute state, read at evaluation time. */
  getMix: () => { muted: string[]; soloed: string[] }
  /** Called once per name seen, in declaration order. */
  collect: (name: string) => void
  /** Called when a layer's event becomes audible, with its delay in ms. */
  onPulse: (layer: string, delayMs: number) => void
}

export function createLayersRuntime(deps: LayersRuntimeDeps) {
  return function layers(map: Record<string, LayerPattern>): LayerPattern {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('layers() expects an object of named patterns, e.g. layers({ kick, bass })')
    }
    const names = Object.keys(map)
    if (names.length === 0) throw new Error('layers() needs at least one named pattern')
    for (const name of names) deps.collect(name)

    const { muted, soloed } = deps.getMix()
    const entries = Object.entries(map).filter(([name]) =>
      soloed.length > 0 ? soloed.includes(name) : !muted.includes(name),
    )
    if (entries.length === 0) {
      // Everything silenced: an event-free pattern keeps the eval valid.
      return map[names[0]].mask('0')
    }

    const tapped = entries.map(([name, pattern]) =>
      pattern.onTrigger((_hap, currentTime, _cps, targetTime) => {
        deps.onPulse(name, Math.max(0, (targetTime - currentTime) * 1000))
      }, false),
    )
    return tapped.reduce((acc, pattern) => acc.stack(pattern))
  }
}
```

- [ ] **Step 5: Use it from the hook**

In `src/hooks/use-strudel.ts`, add the import and replace the whole `layers()` effect (the one whose comment begins "layers({ kick, bass, ... }) - the named-layer convention") with:

```typescript
import { createLayersRuntime, type LayerPattern } from '@/lib/layers-runtime'
```

```typescript
  /**
   * Install the layers() runtime. Dependencies are refs and module-level
   * helpers, so the effect runs once and the runtime always reads current
   * state rather than a snapshot from install time.
   */
  useEffect(() => {
    const w = window as unknown as { layers?: (map: Record<string, LayerPattern>) => LayerPattern }
    w.layers = createLayersRuntime({
      getMix: () => mixRef.current,
      collect: (name) => {
        if (!collectedLayersRef.current.includes(name)) collectedLayersRef.current.push(name)
      },
      onPulse: (layer, delayMs) => {
        // Schedule the visual pulse for when the event becomes audible.
        setTimeout(() => emitLayerPulse(layer), delayMs)
      },
    })
    return () => {
      delete w.layers
    }
  }, [])
```

Delete the now-unused local `Pat` type from the hook.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for every `layers runtime:` check.

- [ ] **Step 7: Confirm no behaviour changed**

Run: `pnpm check tracks/*.js` if the `tracks/` directory has any saved tracks, otherwise write a scratch file with `$: layers({ drums: s("bd*4"), bass: note("c2").s("sawtooth") })` and run `pnpm check` on it.
Expected: same verdict as before the change (evaluates, reports 2 layers).

With `pnpm dev` running and a browser tab open at `http://localhost:3000`, push a two-layer track and toggle a mute from the mixer.
Expected: the mute still applies live, the activity lights still pulse.

- [ ] **Step 8: Typecheck and commit** (ask first)

```bash
pnpm build
git add src/lib/layers-runtime.ts src/hooks/use-strudel.ts scripts/selftest.mjs scripts/lib/strudel-resolver.mjs
git commit -m "refactor: move the layers() runtime out of the strudel hook"
```

---

### Task 5: Apply trims inside the runtime

**Files:**
- Modify: `src/lib/layers-runtime.ts`
- Test: `scripts/selftest.mjs`

**Interfaces:**
- Consumes: `applyValueTrim`, `applyStructuralTrim`, `NEUTRAL_TRIM`, `LayerTrim` from Tasks 1 and 2; `createLayersRuntime` from Task 4.
- Produces: `LayersRuntimeDeps` gains `getTrim: (layer: string) => LayerTrim`. `LayerPattern` gains `fmap`, `inside`, `within`, `late`, `early`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/selftest.mjs`. This is the test that proves the live path: the pattern is built **once**, then the trim store is mutated and re-queried.

```javascript
async function testLayerTrimsAreLive() {
  console.log('layer trims:')
  const strudel = await loadStrudel()
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
  const valuesOf = (p) => p.queryArc(0, 1).filter((h) => h.whole).map((h) => h.value)

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
      .map((h) => Object.keys(h.context ?? {}).sort().join('+'))
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
  const onsetsOf = (p) =>
    p
      .queryArc(0, 1)
      .filter((h) => h.whole)
      .map((h) => h.whole.begin.valueOf())
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
```

Extend the existing selftest import from `trim.ts` to include `NEUTRAL_TRIM` if it is not already there, and add `await testLayerTrimsAreLive()` to the runner block at the bottom of the file (see Task 1 Step 5).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL on `a fader move lands without rebuilding` (postgain undefined), because the runtime ignores trims.

- [ ] **Step 3: Write the implementation**

In `src/lib/layers-runtime.ts`, add the import, extend the two types, and wrap each surviving layer:

```typescript
import {
  applyStructuralTrim,
  applyValueTrim,
  NEUTRAL_TRIM,
  type LayerTrim,
  type StructuralPattern,
} from '@/lib/trim'
```

It must stay an `interface` and use `extends`. Writing this as
`type LayerPattern = StructuralPattern<LayerPattern> & { ... }` fails to compile
with TS2456, "Type alias 'LayerPattern' circularly references itself", and takes
five spurious implicit-any errors down with it. Verified against this project's
`tsc` under `--strict`.

```typescript
export interface LayerPattern extends StructuralPattern<LayerPattern> {
  stack: (other: LayerPattern) => LayerPattern
  mask: (pattern: string) => LayerPattern
  fmap: (fn: (value: Record<string, unknown>) => Record<string, unknown>) => LayerPattern
  onTrigger: (
    fn: (hap: unknown, currentTime: number, cps: number, targetTime: number) => void,
    dominant: boolean,
  ) => LayerPattern
}
```

```typescript
export type LayersRuntimeDeps = {
  getMix: () => { muted: string[]; soloed: string[] }
  /**
   * The current trim for a layer. This must be a lookup, never a captured
   * object: the value wrapper below calls it at query time, which is exactly
   * what lets a fader move be heard without re-evaluating the track. Hand it
   * a snapshot and every fader goes dead until the next evaluation.
   */
  getTrim: (layer: string) => LayerTrim
  collect: (name: string) => void
  onPulse: (layer: string, delayMs: number) => void
}
```

Replace the `tapped` block with:

```typescript
    const tapped = entries.map(([name, pattern]) => {
      // Structural trims are read now, at evaluation time, because they
      // rebuild the pattern. The server only bumps structuralSeq for these,
      // so a change here always arrives with a fresh evaluation.
      const structural = applyStructuralTrim(pattern, deps.getTrim(name))

      // The value wrapper goes on unconditionally, even at neutral, and asks
      // for the trim on every query. Installing it only for already-trimmed
      // layers would make the first touch of every fader require a rebuild.
      const trimmed = structural.fmap((value) => applyValueTrim(value, deps.getTrim(name)))

      return trimmed.onTrigger((_hap, currentTime, _cps, targetTime) => {
        deps.onPulse(name, Math.max(0, (targetTime - currentTime) * 1000))
      }, false)
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for every `layer trims:` check.

- [ ] **Step 5: Update the Task 4 test for the new dependency**

The `testLayersRuntime()` test from Task 4 constructs the runtime without `getTrim`. Add `getTrim: () => NEUTRAL_TRIM` to that call so it still compiles and its checks still pass. Run `pnpm test` again and confirm both suites pass.

- [ ] **Step 6: Typecheck and commit** (ask first)

```bash
pnpm build
git add src/lib/layers-runtime.ts scripts/selftest.mjs
git commit -m "feat: apply per-layer trims in the layers runtime"
```

---

### Task 6: Wire the client to the two counters

**Files:**
- Modify: `src/hooks/use-strudel.ts`

**Interfaces:**
- Consumes: `createLayersRuntime` (Task 4), `LayerTrim`/`NEUTRAL_TRIM` (Task 1), server `MixState` (Task 3).
- Produces: `Mix` type gains `trims: Record<string, LayerTrim>` and `structuralSeq: number`. The hook's returned `mix` carries them for the UI.

- [ ] **Step 1: Extend the types**

In `src/hooks/use-strudel.ts`:

```typescript
import { NEUTRAL_TRIM, type LayerTrim } from '@/lib/trim'
```

```typescript
export type Mix = {
  muted: string[]
  soloed: string[]
  trims: Record<string, LayerTrim>
  seq: number
  structuralSeq: number
}
```

Update the `useState` initialiser:

```typescript
  const [mix, setMix] = useState<Mix>({ muted: [], soloed: [], trims: {}, seq: 0, structuralSeq: 0 })
```

- [ ] **Step 2: Add the live trim ref and rename the applied-seq ref**

Replace the `mixRef` / `appliedMixSeqRef` declarations with:

```typescript
  // Mix state the layers() runtime reads at evaluation time, the trims it
  // reads at query time, and the names collected during the current pass.
  const mixRef = useRef<{ muted: string[]; soloed: string[] }>({ muted: [], soloed: [] })
  const trimsRef = useRef<Record<string, LayerTrim>>({})
  const appliedStructuralSeqRef = useRef(-1)
  const collectedLayersRef = useRef<string[]>([])
```

- [ ] **Step 3: Feed the runtime the trim lookup**

In the `createLayersRuntime` call from Task 4, add:

```typescript
      getTrim: (layer) => trimsRef.current[layer] ?? NEUTRAL_TRIM,
```

- [ ] **Step 4: Gate re-evaluation on the structural counter**

In `evaluateAndReport`, the coalescing key must key off the structural counter, so a value-only change cannot invent a new key or displace a queued evaluation:

```typescript
      const key = `${revision}:${playEpoch}:${appliedStructuralSeqRef.current}`
```

In `handleServerState`, replace the mix block. The live sources are refreshed **before** any evaluation decision, exactly as `mixRef` already was:

```typescript
      // Feed the layers() runtime BEFORE any evaluation below reads it. Trims
      // are refreshed unconditionally: the value wrapper reads them on every
      // query, so a fader move needs nothing else to be heard.
      mixRef.current = { muted: s.mix.muted, soloed: s.mix.soloed }
      trimsRef.current = s.mix.trims
      const structuralChanged = s.mix.structuralSeq !== appliedStructuralSeqRef.current
      appliedStructuralSeqRef.current = s.mix.structuralSeq
      setMix(s.mix)
```

And in the evaluation condition below it, replace `mixChanged` with `structuralChanged`:

```typescript
      if (
        (s.desiredPlaying && (epochChanged || (revisionChanged && s.code !== lastPushedCodeRef.current))) ||
        (structuralChanged && s.desiredPlaying && isPlayingRef.current)
      ) {
```

- [ ] **Step 5: Verify a fader does not re-evaluate**

This is a browser behaviour, so it is verified against the server's own eval telemetry rather than a unit test.

Run `pnpm dev`, open `http://localhost:3000`, and push a track with at least two layers:

```bash
cat > /tmp/trim-check.js <<'EOF'
setcpm(120/4)
const drums = s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")
const bass = note("<c2 eb2>").s("sawtooth").lpf(400).gain(.3)
$: layers({ drums, bass })
EOF
node scripts/push.mjs /tmp/trim-check.js --play
```

Read the eval marker, move a fader, and read it again:

```bash
curl -s http://localhost:3000/api/status | node -e 'process.stdin.on("data",d=>{const s=JSON.parse(d);console.log("eval",s.lastEval?.revision,s.lastEval?.playEpoch,"at",s.lastEval?.at,"| seq",s.mix.seq,"structural",s.mix.structuralSeq)})'
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"bass","volume":0.4}}' > /dev/null
sleep 1
curl -s http://localhost:3000/api/status | node -e 'process.stdin.on("data",d=>{const s=JSON.parse(d);console.log("eval",s.lastEval?.revision,s.lastEval?.playEpoch,"at",s.lastEval?.at,"| seq",s.mix.seq,"structural",s.mix.structuralSeq)})'
```

Expected: `seq` increased, `structuralSeq` unchanged, and `lastEval.at` **unchanged** (no new evaluation was reported). The bass is audibly quieter.

Then confirm the opposite for a structural change:

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"bass","swing":0.6}}' > /dev/null
sleep 1
curl -s http://localhost:3000/api/status | node -e 'process.stdin.on("data",d=>{const s=JSON.parse(d);console.log("eval at",s.lastEval?.at,"ok",s.lastEval?.ok,"| structural",s.mix.structuralSeq)})'
```

Expected: `structuralSeq` increased, `lastEval.at` **moved forward**, `ok` is true.

Then check the guarantee that a value change cannot displace a queued structural evaluation. Fire a structural change and a value change back to back, with no pause, so the value patch lands while the structural evaluation is still in flight:

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"toggleMuted":"drums"}' > /dev/null
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"bass","volume":0.3}}' > /dev/null
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"bass","volume":0.9}}' > /dev/null
sleep 2
curl -s http://localhost:3000/api/status | node -e 'process.stdin.on("data",d=>{const s=JSON.parse(d);console.log("eval ok",s.lastEval?.ok,"| muted",JSON.stringify(s.mix.muted),"| bass vol",s.mix.trims.bass?.volume,"| structural",s.mix.structuralSeq)})'
```

Expected: `eval ok` is true, `muted` contains `drums` and the drums are actually silent, and `bass vol` is 0.9. The mute must have survived: if the value patches had displaced the queued structural evaluation, the mute would be recorded in state but still audible.

Reset before moving on:

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"muted":[],"soloed":[]}' > /dev/null
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"resetTrim":"bass"}' > /dev/null
```

- [ ] **Step 6: Typecheck and commit** (ask first)

```bash
pnpm build
git add src/hooks/use-strudel.ts
git commit -m "feat: gate re-evaluation on the structural mix counter"
```

---

### Task 7: Throttled volume fader on every row

**Files:**
- Create: `src/lib/throttle.ts`
- Create: `src/components/channel-row.tsx`
- Modify: `src/components/mixer-panel.tsx`
- Test: `scripts/selftest.mjs`

**Interfaces:**
- Consumes: `Mix` (Task 6), `TRIM_RANGES`/`NEUTRAL_TRIM`/`LayerTrim` (Task 1), `postQuiet` from `src/lib/api-client.ts`.
- Produces: `createThrottle<T>(send: (value: T) => void, intervalMs: number): { push(value: T): void; flush(): void; cancel(): void }`; `ChannelRow` component; `faderPosition(volume: number): number` and `faderVolume(position: number): number` exported from `src/lib/trim.ts`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/selftest.mjs`, and add `await testThrottle()` to the runner block at the bottom of the file (see Task 1 Step 5). `throttle.ts` has no imports of its own, so a static import works here:

```javascript
import { createThrottle } from '../src/lib/throttle.ts'
```

```javascript
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
  check('flush sends the pending value', sent.length === beforeFlush + 1 && sent[sent.length - 1] === 6, JSON.stringify(sent))
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
```

Also add fader-taper checks to `testTrimValues()`:

```javascript
  check('fader unity sits at ~71% of travel', Math.abs(faderPosition(1) - Math.SQRT1_2) < 1e-9)
  check('fader top is 200%', Math.abs(faderVolume(1) - 2) < 1e-9)
  check('fader bottom is silence', faderVolume(0) === 0)
  check('fader round-trips', Math.abs(faderVolume(faderPosition(0.4)) - 0.4) < 1e-9)
```

Extend the `trim.ts` import in the selftest to include `faderPosition` and `faderVolume`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL, cannot find `../src/lib/throttle.ts`.

- [ ] **Step 3: Write the throttle**

Create `src/lib/throttle.ts`:

```typescript
/**
 * =============================================================================
 * THROTTLE
 * =============================================================================
 *
 * Leading-edge throttle with a flush, for controls that are dragged.
 *
 * The distinction from a debounce is the whole point. A debounce restarts its
 * timer on every move, so a slider held in motion sends nothing at all until
 * the pointer stops. A throttle sends the first move at once and then at most
 * one move per interval, which is what lets a fader be ridden.
 */

export type Throttle<T> = {
  /** Offer a value. Sends now, or schedules the newest value. */
  push: (value: T) => void
  /** Send any pending value immediately. Call on pointer-up. */
  flush: () => void
  /** Drop any pending value. Call on unmount. */
  cancel: () => void
}

export function createThrottle<T>(send: (value: T) => void, intervalMs: number): Throttle<T> {
  let lastSentAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null

  const fire = (value: T) => {
    lastSentAt = Date.now()
    send(value)
  }

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    push(value: T) {
      const now = Date.now()
      const waited = now - lastSentAt
      if (waited >= intervalMs) {
        clear()
        pending = null
        fire(value)
        return
      }
      // Inside the window: keep only the newest value, and make sure exactly
      // one timer is armed to deliver it.
      pending = { value }
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          if (pending !== null) {
            const { value: latest } = pending
            pending = null
            fire(latest)
          }
        }, intervalMs - waited)
      }
    },
    flush() {
      clear()
      if (pending !== null) {
        const { value } = pending
        pending = null
        fire(value)
      }
    },
    cancel() {
      clear()
      pending = null
    },
  }
}
```

- [ ] **Step 4: Add the fader taper to trim.ts**

Append to `src/lib/trim.ts`:

```typescript
/**
 * Fader travel to volume, and back.
 *
 * The taper is quadratic so unity sits about 71% up the throw and the useful
 * quiet range is not crammed into the bottom of it. A fader linear in
 * amplitude spends most of its travel on differences nobody can hear. The
 * engine applies its own gain curve to postgain, which is identity by
 * default; this assumes that default rather than depending on it.
 */
export const faderVolume = (position: number): number =>
  clamp(2 * position * position, TRIM_RANGES.volume[0], TRIM_RANGES.volume[1])

export const faderPosition = (volume: number): number =>
  Math.sqrt(clamp(volume, TRIM_RANGES.volume[0], TRIM_RANGES.volume[1]) / 2)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for `throttle:` and the new fader checks.

- [ ] **Step 6: Write the channel row**

Create `src/components/channel-row.tsx`. The `Toggle` helper moves here from `mixer-panel.tsx` unchanged:

```typescript
/**
 * =============================================================================
 * CHANNEL ROW
 * =============================================================================
 *
 * One mixer row: channel number, live activity light, layer name, volume
 * fader, solo and mute. Clicking the row selects it, which is what the
 * channel strip below the list follows.
 *
 * The fader holds its own value while being dragged so the SSE echo cannot
 * fight the thumb, and posts on a throttle so riding it never outruns the
 * audio. A trimmed layer marks its name with a star, so a departure from
 * as-written is visible without selecting the row.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { onLayerPulse } from '@/lib/layer-pulse'
import { postQuiet } from '@/lib/api-client'
import { createThrottle } from '@/lib/throttle'
import { faderPosition, faderVolume, isNeutral, NEUTRAL_TRIM } from '@/lib/trim'
import type { Mix } from '@/hooks/use-strudel'

/** How often a dragged fader may post. */
const FADER_POST_MS = 80
/** How long after the last move the local override is released. */
const FADER_SETTLE_MS = 800

/** Square, flat toggle - inverse video when active, inert when disabled. */
function Toggle({
  label,
  active,
  activeClass,
  title,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  activeClass: string
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      className={`w-8 h-8 shrink-0 border text-xs leading-none ${
        disabled
          ? 'border-border/40 text-muted-foreground/30 cursor-default'
          : active
            ? activeClass
            : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
      }`}
    >
      {label}
    </button>
  )
}

export function ChannelRow({
  name,
  index,
  mix,
  selected,
  onSelect,
}: {
  name: string
  index: number
  mix: Mix
  selected: boolean
  onSelect: () => void
}) {
  const dotRef = useRef<HTMLSpanElement>(null)
  // Local value while dragging, so the server echo cannot fight the thumb.
  const [dragPosition, setDragPosition] = useState<number | null>(null)

  // Activity pulse: flash the dot when this layer fires. Direct style
  // mutation - a re-render per audio event would be wasteful.
  useEffect(
    () =>
      onLayerPulse((layer) => {
        if (layer !== name || !dotRef.current) return
        const dot = dotRef.current
        dot.style.background = 'var(--primary)'
        setTimeout(() => {
          if (dotRef.current) dotRef.current.style.background = 'var(--muted)'
        }, 90)
      }),
    [name],
  )

  const throttle = useMemo(
    () =>
      createThrottle<number>((volume) => {
        postQuiet('/api/mix', { trim: { layer: name, volume } })
      }, FADER_POST_MS),
    [name],
  )
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  // The registered release listener, so unmount can remove the exact one that
  // was added. `commitFader` is a new function every render, so the cleanup
  // cannot simply name it.
  const releaseRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      throttle.cancel()
      if (settleRef.current) clearTimeout(settleRef.current)
      if (releaseRef.current) {
        window.removeEventListener('pointerup', releaseRef.current)
        window.removeEventListener('pointercancel', releaseRef.current)
      }
    },
    [throttle],
  )

  const trim = mix.trims[name] ?? NEUTRAL_TRIM
  const muted = mix.muted.includes(name)
  const soloed = mix.soloed.includes(name)
  // Another layer's solo silences this one too - show it, don't make the
  // listener guess why a row went quiet.
  const silenced = muted || (mix.soloed.length > 0 && !soloed)
  const position = dragPosition ?? faderPosition(trim.volume)

  // Declared before the change handler that arms it, so the listener registered
  // below always refers to an initialised function.
  const commitFader = () => {
    throttle.flush()
    if (settleRef.current) clearTimeout(settleRef.current)
    window.removeEventListener('pointerup', commitFader)
    window.removeEventListener('pointercancel', commitFader)
    releaseRef.current = null
    draggingRef.current = false
    setDragPosition(null)
  }

  const handleFader = (next: number) => {
    setDragPosition(next)
    throttle.push(faderVolume(next))
    // Release the local override once the drag really ends. A pointer let go
    // outside the input fires no mouseup on it, and without this the row would
    // stay pinned to its own value and ignore a change from another tab. The
    // value itself is never at risk: the throttle always delivers a trailing
    // send. Arm the listeners once per drag rather than once per change event,
    // or a single drag would register dozens of them.
    if (!draggingRef.current) {
      draggingRef.current = true
      releaseRef.current = commitFader
      window.addEventListener('pointerup', commitFader)
      window.addEventListener('pointercancel', commitFader)
    }
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(commitFader, FADER_SETTLE_MS)
  }

  // Toggle by intent, not by computed array - the server flips against its
  // own current state, so rapid clicks from a stale snapshot cannot collide.
  const toggleMute = () => postQuiet('/api/mix', { toggleMuted: name })
  const toggleSolo = () => postQuiet('/api/mix', { toggleSoloed: name })

  return (
    <div
      onMouseDown={onSelect}
      className={`flex items-center gap-2.5 px-2.5 h-11 border-b border-border/40 cursor-default ${
        selected ? 'bg-card' : ''
      }`}
    >
      <span className="w-5 shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
        {selected ? '▸' : String(index + 1).padStart(2, '0')}
      </span>
      <span ref={dotRef} className="w-2 h-2 shrink-0" style={{ background: 'var(--muted)' }} />
      <span
        className={`flex-1 min-w-0 truncate lowercase ${silenced ? 'text-muted-foreground/50' : ''} ${
          muted ? 'line-through' : ''
        }`}
        title={name}
      >
        {name}
        {!isNeutral(trim) && <span className="text-primary"> *</span>}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={position}
        onChange={(e) => handleFader(Number(e.target.value))}
        onMouseUp={commitFader}
        onBlur={commitFader}
        onKeyUp={commitFader}
        title={`${name} volume: ${Math.round(faderVolume(position) * 100)}%`}
        className="flat-fader w-20 shrink-0 cursor-pointer"
      />
      <Toggle
        label="s"
        active={soloed}
        activeClass="bg-primary text-primary-foreground border-primary"
        title={`solo ${name}`}
        onClick={toggleSolo}
      />
      <Toggle
        label="m"
        active={muted}
        activeClass="bg-destructive text-background border-destructive"
        title={
          mix.soloed.length > 0 && !soloed ? `${name} is already silent while solo is active` : `mute ${name}`
        }
        onClick={toggleMute}
        disabled={mix.soloed.length > 0 && !soloed}
      />
    </div>
  )
}
```

- [ ] **Step 7: Reduce the panel to the list plus selection**

Rewrite `src/components/mixer-panel.tsx`:

```typescript
/**
 * =============================================================================
 * MIXER PANEL
 * =============================================================================
 *
 * The rack's top section: one channel row per named layer, over a channel
 * strip for whichever row is selected. Selection is sticky and never empty,
 * so there is no blank state and no click that makes the knobs vanish.
 */

'use client'

import { useEffect, useState } from 'react'
import { ChannelRow } from '@/components/channel-row'
import { ChannelStrip } from '@/components/channel-strip'
import type { Mix } from '@/hooks/use-strudel'

export function MixerPanel({ layers, mix }: { layers: string[]; mix: Mix }) {
  const [selected, setSelected] = useState<string | null>(null)

  // Follow the track: a selection that no longer exists falls back to the
  // first layer, so the strip always has something to show.
  useEffect(() => {
    if (layers.length === 0) {
      if (selected !== null) setSelected(null)
    } else if (selected === null || !layers.includes(selected)) {
      setSelected(layers[0])
    }
  }, [layers, selected])

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 shrink-0 flex items-center px-2.5 border-b border-border bg-card text-[11px] uppercase tracking-widest text-muted-foreground">
        mixer{layers.length > 0 ? ` · ${layers.length}` : ''}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {layers.map((name, i) => (
          <ChannelRow
            key={name}
            name={name}
            index={i}
            mix={mix}
            selected={name === selected}
            onSelect={() => setSelected(name)}
          />
        ))}
        {layers.length === 0 && (
          <div className="px-2.5 h-11 flex items-center text-muted-foreground/60">
            no layers yet: push a track built with layers(...)
          </div>
        )}
      </div>
      {/* Keyed by layer: without this React reuses the strip and its knobs
          across a selection change, so a pending drag or a half-typed note
          could be posted under the newly selected layer's name. */}
      {selected !== null && <ChannelStrip key={selected} name={selected} mix={mix} />}
    </section>
  )
}
```

- [ ] **Step 8: Commit** (ask first)

`pnpm build` will fail until Task 8 creates `channel-strip.tsx`, so do Task 8 before committing, then commit both together with the message in Task 8.

---

### Task 8: The channel strip

**Files:**
- Create: `src/components/channel-strip.tsx`

**Interfaces:**
- Consumes: `Mix` (Task 6), `NEUTRAL_TRIM`/`isNeutral`/`LayerTrim` (Task 1), `createThrottle` (Task 7), `NoteInput` from `src/components/note-input.tsx`, `postNote`/`postQuiet` from `src/lib/api-client.ts`.
- Produces: `ChannelStrip` component.

- [ ] **Step 1: Write the strip**

Create `src/components/channel-strip.tsx`:

```typescript
/**
 * =============================================================================
 * CHANNEL STRIP
 * =============================================================================
 *
 * The selected layer's feel knobs, a reset, and a note box. Knobs are named
 * for what they sound like, not for what they are: the listener does not need
 * to know that "muffled" is a lowpass.
 *
 * Two of the five controls rebuild the pattern, so they commit on release
 * rather than continuously. The note is last on purpose: it is the escape
 * hatch for when no knob gets you where you wanted.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { NoteInput } from '@/components/note-input'
import { postNote, postQuiet } from '@/lib/api-client'
import { createThrottle } from '@/lib/throttle'
import { isNeutral, NEUTRAL_TRIM, type LayerTrim } from '@/lib/trim'
import type { Mix } from '@/hooks/use-strudel'

/** How often a dragged live knob may post. */
const KNOB_POST_MS = 80
/**
 * Backstop for a release we never saw. Long on purpose: release is detected on
 * the window, so this should almost never fire, and a short timer here would
 * re-evaluate the track whenever someone paused mid-drag.
 */
const KNOB_SETTLE_MS = 2000

type KnobSpec = {
  key: keyof LayerTrim
  left: string
  right: string
  min: number
  /**
   * Live controls are read per event at query time and land under the finger.
   * Structural ones rebuild the pattern, so they are only sent on release.
   */
  live: boolean
}

const KNOBS: KnobSpec[] = [
  { key: 'tone', left: 'muffled', right: 'thin', min: -1, live: true },
  { key: 'space', left: 'dry', right: 'roomy', min: -1, live: true },
  { key: 'feel', left: 'early', right: 'late', min: -1, live: false },
  { key: 'swing', left: 'straight', right: 'swung', min: 0, live: false },
]

function Knob({
  spec,
  layer,
  value,
}: {
  spec: KnobSpec
  layer: string
  value: number
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  const releaseRef = useRef<(() => void) | null>(null)

  const send = (next: number) => postQuiet('/api/mix', { trim: { layer, [spec.key]: next } })

  const throttle = useMemo(
    () => createThrottle<number>(send, KNOB_POST_MS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, spec.key],
  )
  useEffect(
    () => () => {
      throttle.cancel()
      if (settleRef.current) clearTimeout(settleRef.current)
      if (releaseRef.current) {
        window.removeEventListener('pointerup', releaseRef.current)
        window.removeEventListener('pointercancel', releaseRef.current)
      }
    },
    [throttle],
  )

  const shown = drag ?? value

  const commit = () => {
    if (settleRef.current) clearTimeout(settleRef.current)
    window.removeEventListener('pointerup', commit)
    window.removeEventListener('pointercancel', commit)
    releaseRef.current = null
    draggingRef.current = false
    const pending = dragRef.current
    if (pending !== null) {
      if (spec.live) throttle.flush()
      else send(pending)
      dragRef.current = null
    }
    setDrag(null)
  }

  const handleChange = (next: number) => {
    setDrag(next)
    dragRef.current = next
    if (spec.live) throttle.push(next)
    // Catch the release wherever it happens. A pointer let go outside the input
    // fires no mouseup on it, and a structural knob sends nothing during the
    // drag, so without this its value would simply be lost. Listening on the
    // window means a real release commits, instead of an inactivity timer
    // firing mid-drag and re-evaluating the track while the knob is held.
    // Armed once per drag: once per change event would stack up dozens.
    if (!draggingRef.current) {
      draggingRef.current = true
      releaseRef.current = commit
      window.addEventListener('pointerup', commit)
      window.addEventListener('pointercancel', commit)
    }
    // Long backstop for the keyboard path and any release we still miss.
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(commit, KNOB_SETTLE_MS)
  }

  return (
    <div className="flex items-center gap-2 px-2.5 h-7">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground/70 text-right lowercase">
        {spec.left}
      </span>
      <input
        type="range"
        min={spec.min}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => handleChange(Number(e.target.value))}
        onMouseUp={commit}
        onBlur={commit}
        onKeyUp={commit}
        title={`${spec.left} to ${spec.right}: ${shown.toFixed(2)}`}
        className="flat-fader flex-1 min-w-0 cursor-pointer"
      />
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground/70 lowercase">
        {spec.right}
      </span>
    </div>
  )
}

export function ChannelStrip({ name, mix }: { name: string; mix: Mix }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const trim = mix.trims[name] ?? NEUTRAL_TRIM

  const sendNote = (text: string) =>
    postNote({ text, layer: name }).then((ok) => {
      if (ok) {
        setSent(true)
        setTimeout(() => setSent(false), 1200)
      }
      return ok
    })

  return (
    <div className="shrink-0 border-t border-border">
      <div className="h-8 flex items-center gap-2 px-2.5 border-b border-border/40 bg-card text-[11px] uppercase tracking-widest text-muted-foreground">
        <span className="flex-1 min-w-0 truncate">channel · {name}</span>
        <button
          onClick={() => postQuiet('/api/mix', { resetTrim: name })}
          disabled={isNeutral(trim)}
          title={isNeutral(trim) ? `${name} is already as written` : `reset ${name} to as written`}
          className={`w-6 h-6 shrink-0 border text-xs leading-none ${
            isNeutral(trim)
              ? 'border-border/40 text-muted-foreground/30 cursor-default'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
          }`}
        >
          ↺
        </button>
      </div>
      <div className="py-1">
        {KNOBS.map((spec) => (
          <Knob key={spec.key} spec={spec} layer={name} value={trim[spec.key]} />
        ))}
      </div>
      <div className="px-2.5 pb-2 pt-1">
        {noteOpen ? (
          <NoteInput
            autoFocus
            placeholder={`note on ${name}`}
            onSend={sendNote}
            onClose={() => setNoteOpen(false)}
          />
        ) : (
          <button
            onClick={() => setNoteOpen(true)}
            title={`send a note about ${name}`}
            className={`px-2.5 h-7 border text-xs leading-none ${
              sent
                ? 'border-primary text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
            }`}
          >
            {sent ? 'sent' : 'note'}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: compiles clean, with `mixer-panel.tsx` from Task 7 now resolving `channel-strip.tsx`.

- [ ] **Step 3: Verify in the browser**

With `pnpm dev` running and a tab open, push the two-layer track from Task 6 Step 5 and play it. Check each of these:

- Every row shows a fader; dragging one changes that layer's loudness while the music keeps playing.
- The row you click shows `▸` and its name highlights; the strip below follows it.
- Moving `muffled/thin` and `dry/roomy` changes the sound under your finger.
- Moving `early/late` and `straight/swung` changes it when you release.
- A moved control puts a `*` after the layer's name.
- `↺` clears the `*` and returns the layer to as-written, and is inert when the layer is already neutral.
- `note` still sends, and the text lands in `curl -s localhost:3000/api/notes`.

- [ ] **Step 4: Commit** (ask first)

```bash
git add src/lib/throttle.ts src/lib/trim.ts scripts/selftest.mjs src/components/channel-row.tsx src/components/channel-strip.tsx src/components/mixer-panel.tsx
git commit -m "feat: per-layer faders and feel knobs in the mixer rack"
```

---

### Task 9: Tell the agent the trims exist

**Files:**
- Modify: `README.md`
- Modify: `.claude/skills/api/SKILL.md`
- Modify: `.claude/skills/humanize/SKILL.md`

Trims are feedback. A future session that cannot read them will keep rewriting a mix the listener already fixed by hand.

- [ ] **Step 1: Update the API skill**

In `.claude/skills/api/SKILL.md`, in the endpoint table row for `/api/mix`, add the two new forms:

```
| `/api/mix` | GET/POST | Per-layer solo/mute: `{"muted": [...], "soloed": [...]}` replaces wholesale; `{"toggleMuted": "name"}` / `{"toggleSoloed": "name"}` flips one layer atomically. Solo and mute are exclusive per layer. Per-layer trims: `{"trim": {"layer": "bass", "volume": 0.5, "tone": -0.4}}` patches one layer, `{"resetTrim": "bass"}` returns it to as-written |
```

In the `/api/status` field list, alongside the `mix` line, document the shape:

```
mix              {muted, soloed, trims, seq, structuralSeq} - live mixer state.
                 trims holds only layers the listener has moved off neutral:
                 volume (0-2, 1 = as written), tone (-1 muffled to 1 thin),
                 space (-1 dry to 1 roomy), feel (-1 early to 1 late),
                 swing (0 straight to 1 swung)
```

And add a paragraph after the existing "Mute state is feedback too" note:

```markdown
Trims are the most precise feedback the listener can give without typing.
A `volume` of 0.4 on the pad means the pad was too loud and by how much; a
negative `tone` on the keys means they were too bright. Read them before
rewriting a track, and when the listener is happy, fold the values into the
code itself and reset them so the balance survives the next revision.
```

- [ ] **Step 2: Update the humanize skill**

In `.claude/skills/humanize/SKILL.md`, in the gain staging section, add after the table:

```markdown
The listener can now move any layer themselves, so gain staging is a starting
point rather than a verdict. If `/api/status` shows a trim on a layer, that is
the mix being corrected in real time: honour it in the next revision instead of
pushing the old value back.
```

- [ ] **Step 3: Update the README**

In `README.md`, replace the "Layer mixer" bullet:

```markdown
- **Layer mixer** - tracks are written as named layers (`layers({ kick, bass, ... })`); each gets a row with an activity light, a volume fader, solo, and mute. Selecting a row opens a channel strip with four feel knobs (muffled/thin, dry/roomy, early/late, straight/swung) and a reset. Volume, tone and space apply live without stopping playback; the two timing controls re-evaluate on release
```

In the project-structure listing, add the new files beside their neighbours:

```
│   ├── channel-row.tsx     # One mixer row: fader, solo, mute, activity light
│   ├── channel-strip.tsx   # Selected layer's feel knobs, reset, note
```

```
│   ├── trim.ts             # Per-layer trim maths (volume, tone, space, feel, swing)
│   ├── throttle.ts         # Leading-edge throttle for dragged controls
│   ├── layers-runtime.ts   # layers() implementation and trim application
```

- [ ] **Step 4: Commit** (ask first)

```bash
git add README.md .claude/skills/api/SKILL.md .claude/skills/humanize/SKILL.md
git commit -m "docs: document per-layer trims for the agent and the README"
```

---

### Task 10: Confirm it by ear

**Files:** none.

Passing tests prove the maths, not the music. This task exists because a control that reports a change it did not make is the specific failure this project is built to avoid.

- [ ] **Step 1: Push a track with layers that differ in density**

With `pnpm dev` running and a browser tab open:

```bash
cat > /tmp/trim-ear.js <<'EOF'
setcpm(124/4)
const drums = s("bd*4, [~ rim]*2, hh*8").bank("RolandTR909").gain(.8)
const bass = note("<c2 c2 ab1 bb1>").s("sawtooth").lpf(500).lpenv(2).gain(.32)
const pad = note("<c4,eb4,g4> <ab3,c4,eb4>").s("sawtooth").lpf(1200).attack(.6).release(2).gain(.22)
$: layers({ drums, bass, pad })
EOF
node scripts/push.mjs /tmp/trim-ear.js --play
```

- [ ] **Step 2: Measure the baseline**

Run: `node scripts/listen.mjs 8`
Record the reported loudness and brightness.

- [ ] **Step 3: Pull one layer down and measure again**

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"drums","volume":0.35}}' > /dev/null
```

Run: `node scripts/listen.mjs 8`
Expected: measured loudness is lower than the baseline. If it is not, the fader is lying and the task fails.

- [ ] **Step 4: Check the tone knob moves brightness**

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"drums","volume":1,"tone":-0.8}}' > /dev/null
```

Run: `node scripts/listen.mjs 8`
Expected: measured brightness is lower than the baseline.

- [ ] **Step 5: Confirm the documented pad limit is real, not a surprise**

Move the pad's fader while the chord is sustaining and listen. Expected: the change is heard when the chord next retriggers, not immediately. This is the limit recorded in the spec. If it turns out to be instant, the spec is wrong and should be corrected.

- [ ] **Step 6: Confirm swing does not double hits**

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"resetTrim":"drums"}' > /dev/null
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"trim":{"layer":"drums","swing":0.7}}' > /dev/null
```

Run: `node scripts/listen.mjs 8`
Expected: the hats lope. Listen specifically for flams or doubled hits, which is what `swingBy` would have produced. Onset count per bar should not rise.

- [ ] **Step 7: Reset and report**

```bash
curl -s -X POST http://localhost:3000/api/mix -H 'Content-Type: application/json' -d '{"resetTrim":"drums"}' > /dev/null
```

Run the full suite one last time: `pnpm test` then `pnpm smoke`.
Report the actual output. If anything fails, say so with the output rather than describing the feature as done.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the five controls and their maths to Tasks 1 and 2; the neutral identity guarantee to Tasks 1, 2 and 5; live versus structural and the split change counter to Tasks 3, 5 and 6; state, protocol, persistence and pruning to Task 3; the rack, selection, the `*` marker and the fader taper to Tasks 7 and 8; the note as escape hatch to Task 8; the failure modes to Tasks 1, 3, 5 and 7; verification to Tasks 1, 2, 5, 6 and 10; the agent-visibility rationale to Task 9. The "out of scope" section needs no task by definition.

**Name consistency.** `LayerTrim`, `NEUTRAL_TRIM`, `TRIM_RANGES`, `clampTrim`, `isNeutral`, `isStructuralDifference`, `applyValueTrim`, `applyStructuralTrim`, `StructuralPattern`, `faderVolume`, `faderPosition` (all `src/lib/trim.ts`); `createThrottle`, `Throttle` (`src/lib/throttle.ts`); `createLayersRuntime`, `LayerPattern`, `LayersRuntimeDeps` (`src/lib/layers-runtime.ts`); `ChannelRow`, `ChannelStrip`, `MixerPanel` (components); `trims`, `structuralSeq` on `MixState` and `Mix`; `trimsRef`, `appliedStructuralSeqRef` in the hook. Each is defined in exactly one task and referenced by that name everywhere after.

**Sequencing note.** Task 7 leaves the tree uncompilable until Task 8 lands, because the panel imports the strip. They are kept separate because they are separately reviewable, and Task 7 Step 8 says explicitly to commit them together.
