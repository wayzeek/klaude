# Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating glass-pill UI (emoji reactions, HUD card, transport pill, tape popover) with one flat terminal-style console offering per-layer solo/mute and free-text notes routed to the agent.

**Architecture:** The agent writes tracks as named layers via a `layers({...})` global the client registers before evaluation; `layers()` filters the stack against server-owned mix state (solo wins, else drop muted) and re-evaluation on mix changes is seamless (Strudel's scheduler keeps phase). Notes replace reactions end-to-end: browser posts free text tagged with layer + section + revision; the agent reads them between phases. One new `console.tsx` component replaces four floating overlays.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind 4, @strudel/repl 1.3.0 (pinned), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-24-console-redesign-design.md`

## Global Constraints

- Package manager: `pnpm` only (a hook blocks `npm`).
- No new dependencies. `layers()` uses pattern **methods** (`.stack()`, `.mask("0")`, `.onTrigger(fn, false)`) — all verified live against this REPL on 2026-07-24; do not import `@strudel/core`.
- `onTrigger` callback signature (verified): `(hap, currentTime, cps, targetTime)` — times in AudioContext seconds.
- The Strudel transpiler requires `$:` lines at top level (verified: `$:` inside a `try{}` block fails with "unexpected ast format").
- Test harness is `scripts/smoke.mjs` against the running dev server (`pnpm dev`, port 3000). Next dev hot-reloads API routes; the state singleton survives via `globalThis` — no server restarts needed between edits. Tests must restore any state they change.
- Browser-dependent steps need a tab on http://localhost:3000 (Playwright MCP is fine). Always verify pushes with `node scripts/push.mjs <file> --play` and trust its verdict.
- UI rules (from spec): monospace, flat, 1px solid borders, square corners, existing theme tokens only. Forbidden: `backdrop-blur`, `shadow-*`, gradients, `rounded-*`, `animate-in` slide/fade entrances.
- Commits: Conventional Commits, **ask the user before each commit** (house rule), no Co-Authored-By or Claude-Session lines.
- Reviewer-facing prose (docs, README): human-voiced, concise, no internal phase labels.

---

### Task 1: Server mix state + `/api/mix`

**Files:**
- Modify: `src/app/api/state.ts`
- Create: `src/app/api/mix/route.ts`
- Modify: `src/app/api/status/route.ts`
- Test: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: existing `StateEmitter`, `rejectCrossOrigin(request)`.
- Produces: `type MixState = { muted: string[]; soloed: string[]; seq: number }`; `state.mix: MixState`; `state.layerNames: string[]`; `state.setMix(patch: { muted?: string[]; soloed?: string[] }): MixState`; `state.recordEval(result, layers?: string[])` (extended signature); `BroadcastState` gains `mix: MixState` and `layers: string[]`; `GET/POST /api/mix`; `/api/status` gains `mix` and `layers`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke.mjs`, add to the `status:` block (after the `recording phase` check):

```javascript
  check('status has mix state', Array.isArray(initial.mix?.muted) && Array.isArray(initial.mix?.soloed) && typeof initial.mix?.seq === 'number')
  check('status has layers array', Array.isArray(initial.layers))
```

Insert a new block between `nowplaying:` and `reactions:`:

```javascript
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
  const mixPushRes = await post('/api/code', { code: marker + '\n// mix probe' }).then((r) => r.json())
  const mixAfter = await get('/api/mix').then((r) => r.json())
  check('push clears solo', mixAfter.mix.soloed.length === 0)
  check('push preserves mutes', mixAfter.mix.muted.includes('bass'))
  check('push bumps mix seq (solo cleared)', mixAfter.mix.seq > mixSet.mix.seq)
  await post('/api/mix', { muted: mix0.mix.muted, soloed: [] })
  await post('/api/history', { revision: initial.revision })
```

(The trailing history restore keeps the later `play/stop:` block starting from the original code, same as the existing restore pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm smoke`
Expected: FAIL on `status has mix state`, `GET /api/mix returns mix + layers` (404 → JSON parse error is acceptable as failure), and the rest of the mix block.

- [ ] **Step 3: Implement state changes**

In `src/app/api/state.ts`:

Add after the `Reaction` type:

```typescript
export type MixState = { muted: string[]; soloed: string[]; seq: number }
```

Extend `BroadcastState`:

```typescript
export type BroadcastState = {
  code: string
  revision: number
  desiredPlaying: boolean
  playEpoch: number
  gain: { level: number; rampMs: number; seq: number }
  nowPlaying: NowPlaying | null
  command: RecordCommand | null
  mix: MixState
  layers: string[]
}
```

Extend `PersistedState` and `loadPersisted` (muted layers survive restarts; solo is session-only):

```typescript
type PersistedState = {
  code: string
  revision: number
  history: HistoryEntry[]
  mutedLayers?: string[]
}
```

In `loadPersisted`, before the `return`, add:

```typescript
    const mutedLayers = (Array.isArray(parsed.mutedLayers) ? parsed.mutedLayers : []).filter(
      (m): m is string => typeof m === 'string',
    )
    return { code: parsed.code, revision: parsed.revision as number, history, mutedLayers }
```

In `StateEmitter`, add fields after `_recordIssuedAt`:

```typescript
  private _mix: MixState = { muted: [], soloed: [], seq: 0 }
  private _layerNames: string[] = []
```

In the constructor, after `this._history = ...`:

```typescript
    this._mix = { muted: persisted?.mutedLayers ?? [], soloed: [], seq: 0 }
```

Extend the `broadcast` getter with `mix: this._mix, layers: this._layerNames`.

Add getters after `get history()`:

```typescript
  get mix(): MixState {
    return this._mix
  }

  get layerNames(): string[] {
    return this._layerNames
  }
```

In `applyCode`, before `this.schedulePersist()`:

```typescript
    // New revision: solo is a listening gesture, not an arrangement - clear it.
    // Mutes persist until the layer disappears or someone unmutes.
    if (this._mix.soloed.length > 0) {
      this._mix = { ...this._mix, soloed: [], seq: this._mix.seq + 1 }
    }
```

Add a mutation after `setNowPlaying`:

```typescript
  // --- mix (per-layer solo/mute) ---------------------------------------------

  /** Replace mix arrays (full replacement per provided key). Bumps seq, emits. */
  setMix(patch: { muted?: string[]; soloed?: string[] }): MixState {
    this._mix = {
      muted: patch.muted ?? this._mix.muted,
      soloed: patch.soloed ?? this._mix.soloed,
      seq: this._mix.seq + 1,
    }
    this.schedulePersist()
    this.emit()
    return this._mix
  }
```

Extend `recordEval` signature to `recordEval(result: EvalResult, layers?: string[]): void` and add at the end of the method:

```typescript
    // A successful eval of the current revision reports the track's layer
    // names - adopt them and prune mix entries for layers that no longer
    // exist (a stale solo would otherwise silence everything forever).
    if (result.ok && result.revision === this._revision && layers) {
      const namesChanged =
        layers.length !== this._layerNames.length || layers.some((n, i) => n !== this._layerNames[i])
      if (namesChanged) this._layerNames = [...layers]
      const muted = this._mix.muted.filter((n) => layers.includes(n))
      const soloed = this._mix.soloed.filter((n) => layers.includes(n))
      const pruned = muted.length !== this._mix.muted.length || soloed.length !== this._mix.soloed.length
      if (pruned) {
        this._mix = { muted, soloed, seq: this._mix.seq + 1 }
        this.schedulePersist()
      }
      if (namesChanged || pruned) this.emit()
    }
```

In `persistNow`, extend the payload:

```typescript
      const payload: PersistedState = {
        code: this._code,
        revision: this._revision,
        history: this._history,
        mutedLayers: this._mix.muted,
      }
```

- [ ] **Step 4: Create `src/app/api/mix/route.ts`**

```typescript
/**
 * =============================================================================
 * MIX API ENDPOINT
 * =============================================================================
 *
 * Per-layer solo/mute for tracks written with the layers({...}) convention.
 * The browser's console posts here on toggle; the agent posts here to hear a
 * layer in isolation (solo, then scripts/listen.mjs). Connected browsers
 * re-evaluate on every change - audibly seamless, the scheduler keeps phase.
 *
 * ENDPOINTS:
 *   GET  /api/mix - Current mix state plus the layer names of the last
 *        successfully evaluated revision.
 *   POST /api/mix { "muted"?: string[], "soloed"?: string[] }
 *        Full replacement per provided key. Solo wins over mute; a new code
 *        push clears solo and keeps mutes.
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const MAX_LAYERS = 64
const MAX_NAME_LENGTH = 40

function parseNames(value: unknown, field: string): { names?: string[]; error?: string } {
  if (value === undefined) return {}
  if (
    !Array.isArray(value) ||
    value.length > MAX_LAYERS ||
    value.some((n) => typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH)
  ) {
    return { error: `${field} must be an array of at most ${MAX_LAYERS} non-empty strings (max ${MAX_NAME_LENGTH} chars)` }
  }
  return { names: [...new Set(value as string[])] }
}

export async function GET() {
  return NextResponse.json({ mix: state.mix, layers: state.layerNames })
}

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { muted, soloed } = (body ?? {}) as { muted?: unknown; soloed?: unknown }
  const mutedParsed = parseNames(muted, 'muted')
  if (mutedParsed.error) return NextResponse.json({ error: mutedParsed.error }, { status: 400 })
  const soloedParsed = parseNames(soloed, 'soloed')
  if (soloedParsed.error) return NextResponse.json({ error: soloedParsed.error }, { status: 400 })
  if (!mutedParsed.names && !soloedParsed.names) {
    return NextResponse.json({ error: 'Provide muted and/or soloed (arrays of layer names)' }, { status: 400 })
  }

  return NextResponse.json({
    mix: state.setMix({ muted: mutedParsed.names, soloed: soloedParsed.names }),
    layers: state.layerNames,
  })
}
```

- [ ] **Step 5: Expose in `/api/status`**

In `src/app/api/status/route.ts`, add to the response object after `recording: state.recording,`:

```typescript
    mix: state.mix,
    layers: state.layerNames,
```

- [ ] **Step 6: Run tests**

Run: `pnpm smoke`
Expected: all checks pass, including the new `mix:` block (the still-untouched `reactions:` block keeps passing — it is replaced in Task 2).

- [ ] **Step 7: Ask the user, then commit**

Verify `pnpm smoke` output is green, show it, and ask: "Ready to commit with message: `feat: server-side mix state with per-layer solo/mute API`?"

```bash
git add src/app/api/state.ts src/app/api/mix/route.ts src/app/api/status/route.ts scripts/smoke.mjs
git commit -m "feat: server-side mix state with per-layer solo/mute API"
```

---

### Task 2: Notes replace reactions

**Files:**
- Modify: `src/app/api/state.ts`
- Create: `src/app/api/notes/route.ts`
- Delete: `src/app/api/reactions/route.ts`
- Modify: `src/app/api/status/route.ts`
- Test: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: `StateEmitter`, `rejectCrossOrigin`.
- Produces: `export type Note = { text: string; layer: string | null; at: number; revision: number; section: string | null }`; `state.addNote(text: string, layer: string | null): Note`; `state.notes: Note[]`; `state.clearNotes(): void`; `GET/POST/DELETE /api/notes`; `/api/status` field `recentNotes` (replaces `recentReactions`). The `Reaction` type, `REACTION_KINDS`, `addReaction`, `reactions`, `clearReactions`, and `/api/reactions` are deleted.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke.mjs`, replace the entire `reactions:` block (from `console.log('reactions:')` through its closing `}` of the `if (preReactions...)` cleanup) with:

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm smoke`
Expected: FAIL throughout the `notes:` block (404 on `/api/notes`).

- [ ] **Step 3: Implement state changes**

In `src/app/api/state.ts`:

Replace the `REACTION_KINDS`, `ReactionKind`, and `Reaction` declarations with:

```typescript
export type Note = {
  text: string
  /** Layer the note targets, or null for the whole track. */
  layer: string | null
  at: number
  revision: number
  section: string | null
}
```

Replace `REACTIONS_LIMIT` with `const NOTES_LIMIT = 200`. Replace the `_reactions` field with `private _notes: Note[] = []`. Replace the whole `--- reactions ---` section with:

```typescript
  // --- notes --------------------------------------------------------------

  /** Record listener feedback, tagged with what was playing at the time. */
  addNote(text: string, layer: string | null): Note {
    const note: Note = {
      text,
      layer,
      at: Date.now(),
      revision: this._revision,
      section: this._nowPlaying?.section ?? null,
    }
    this._notes.push(note)
    if (this._notes.length > NOTES_LIMIT) {
      this._notes.splice(0, this._notes.length - NOTES_LIMIT)
    }
    this.schedulePersist()
    return note
  }

  get notes(): Note[] {
    return this._notes
  }

  clearNotes(): void {
    this._notes = []
    this.schedulePersist()
  }
```

Extend `PersistedState` with `notes?: Note[]`, load them in `loadPersisted`:

```typescript
    const notes = (Array.isArray(parsed.notes) ? parsed.notes : []).filter(
      (n): n is Note =>
        n !== null &&
        typeof n === 'object' &&
        typeof (n as Note).text === 'string' &&
        typeof (n as Note).at === 'number' &&
        typeof (n as Note).revision === 'number',
    )
```

return them (`return { code: ..., revision: ..., history, mutedLayers, notes }`), initialize in the constructor (`this._notes = persisted?.notes ?? []`), and persist them in `persistNow` (`notes: this._notes,`).

- [ ] **Step 4: Create `src/app/api/notes/route.ts` and delete the reactions route**

```typescript
/**
 * =============================================================================
 * NOTES API ENDPOINT
 * =============================================================================
 *
 * Free-text listener feedback, aimed at a named layer or the whole track.
 * The console posts here; the agent reads between phases and acts on it.
 * Each note is stamped with the revision and HUD section playing at the time.
 *
 * ENDPOINTS:
 *   POST /api/notes { "text": string, "layer"?: string }
 *   GET  /api/notes - Recent notes, oldest first, plus serverTime.
 *   DELETE /api/notes - Clear the queue (new session, or test cleanup).
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const RECENT_LIMIT = 50
const MAX_TEXT_LENGTH = 500
const MAX_LAYER_LENGTH = 40

export async function GET() {
  return NextResponse.json({
    notes: state.notes.slice(-RECENT_LIMIT),
    serverTime: Date.now(),
  })
}

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { text, layer } = (body ?? {}) as { text?: unknown; layer?: unknown }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text must be a non-empty string (max ${MAX_TEXT_LENGTH} chars)` },
      { status: 400 },
    )
  }
  if (layer !== undefined && (typeof layer !== 'string' || layer.length === 0 || layer.length > MAX_LAYER_LENGTH)) {
    return NextResponse.json(
      { error: `layer must be a non-empty string (max ${MAX_LAYER_LENGTH} chars)` },
      { status: 400 },
    )
  }

  return NextResponse.json({ note: state.addNote(trimmed, (layer as string | undefined) ?? null) })
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.clearNotes()
  return NextResponse.json({ notes: [] })
}
```

```bash
rm -r src/app/api/reactions
```

- [ ] **Step 5: Update `/api/status`**

Replace `recentReactions: state.reactions.slice(-20),` with `recentNotes: state.notes.slice(-20),`.

- [ ] **Step 6: Run tests**

Run: `pnpm smoke`
Expected: all pass. Also run `npx tsc --noEmit` — expected: the only errors are in `src/components/reaction-bar.tsx` if any (there should be none: it posts via fetch, no shared types). Any other error means a missed `Reaction` reference; fix it.

- [ ] **Step 7: Ask the user, then commit**

Show green output, ask: "Ready to commit with message: `feat: free-text layer notes replace emoji reactions (server)`?"

```bash
git add -A src/app/api scripts/smoke.mjs
git commit -m "feat: free-text layer notes replace emoji reactions (server)"
```

---

### Task 3: Client `layers()` global, layer reporting, mix-aware re-eval

**Files:**
- Create: `src/lib/layer-pulse.ts`
- Modify: `src/hooks/use-strudel.ts`
- Modify: `src/app/api/eval/route.ts`
- Test: live browser verification via `scripts/push.mjs`, `curl`, `scripts/listen.mjs`

**Interfaces:**
- Consumes: `state.recordEval(result, layers?)` from Task 1; `BroadcastState.mix`/`.layers` over SSE.
- Produces: `window.layers(map: Record<string, Pattern>): Pattern` available to evaluated code; `useStrudel()` additionally returns `mix: { muted: string[]; soloed: string[]; seq: number }`, `layers: string[]`, `revision: number`; exported `type Mix = { muted: string[]; soloed: string[]; seq: number }` from `use-strudel.ts`; `POST /api/eval` accepts optional `layers: string[]`; `src/lib/layer-pulse.ts` exports `onLayerPulse(fn: (layer: string) => void): () => void` and `emitLayerPulse(layer: string): void`.

- [ ] **Step 1: Create `src/lib/layer-pulse.ts`**

```typescript
/**
 * =============================================================================
 * LAYER PULSE BUS
 * =============================================================================
 *
 * Tiny pub/sub between the layers() runtime (which learns when a layer's
 * pattern fires an event) and the console rows that blink on activity.
 * Module-level so the audio path never touches React state directly.
 */

type PulseListener = (layer: string) => void

const listeners = new Set<PulseListener>()

export function onLayerPulse(listener: PulseListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitLayerPulse(layer: string): void {
  listeners.forEach((listener) => listener(layer))
}
```

- [ ] **Step 2: Accept `layers` in `/api/eval`**

In `src/app/api/eval/route.ts`, extend the destructuring with `layers`:

```typescript
  const { clientId, revision, playEpoch, ok, error, layers } = (body ?? {}) as {
    clientId?: unknown
    revision?: unknown
    playEpoch?: unknown
    ok?: unknown
    error?: unknown
    layers?: unknown
  }
```

After the existing validation block, add:

```typescript
  let layerNames: string[] | undefined
  if (layers !== undefined) {
    if (
      !Array.isArray(layers) ||
      layers.length > 64 ||
      layers.some((l) => typeof l !== 'string' || l.length === 0 || l.length > 40)
    ) {
      return NextResponse.json(
        { error: 'layers must be an array of at most 64 non-empty strings (max 40 chars)' },
        { status: 400 },
      )
    }
    layerNames = layers as string[]
  }
```

And pass it through: `state.recordEval({ ... }, layerNames)`.

- [ ] **Step 3: Wire mix state and `layers()` into `use-strudel.ts`**

All edits in `src/hooks/use-strudel.ts`.

Import the pulse bus at the top:

```typescript
import { emitLayerPulse } from '@/lib/layer-pulse'
```

Add the type and extend `ServerState`:

```typescript
export type Mix = { muted: string[]; soloed: string[]; seq: number }
```

```typescript
type ServerState = {
  code: string
  revision: number
  desiredPlaying: boolean
  playEpoch: number
  gain: { level: number; rampMs: number; seq: number }
  nowPlaying: NowPlaying | null
  command: RemoteCommand | null
  mix: Mix
  layers: string[]
}
```

Add state + refs near the other `useState`/`useRef` declarations:

```typescript
  const [mix, setMix] = useState<Mix>({ muted: [], soloed: [], seq: 0 })
  const [layerNames, setLayerNames] = useState<string[]>([])
  const [revision, setRevision] = useState(0)

  // Mix state the layers() runtime reads at evaluation time, and the names
  // collected during the current evaluation pass.
  const mixRef = useRef<{ muted: string[]; soloed: string[] }>({ muted: [], soloed: [] })
  const appliedMixSeqRef = useRef(-1)
  const collectedLayersRef = useRef<string[]>([])
```

Register the global once on mount (place after the engine-loading `useEffect`). It must exist before any evaluation, including the pending-state eval at editor-ready:

```typescript
  /**
   * layers({ kick, bass, ... }) - the named-layer convention. Evaluated code
   * calls this; it registers the names (reported with the eval result so the
   * console knows its rows), drops muted layers / keeps soloed ones, taps
   * each survivor with a non-dominant onTrigger for the activity pulses, and
   * returns the stacked pattern. Solo is global: soloing a name silences
   * every layers() group that doesn't contain it.
   */
  useEffect(() => {
    type Pat = {
      stack: (other: Pat) => Pat
      mask: (pattern: string) => Pat
      onTrigger: (fn: (hap: unknown, currentTime: number, cps: number, targetTime: number) => void, dominant: boolean) => Pat
    }
    const w = window as unknown as { layers?: (map: Record<string, Pat>) => Pat }
    w.layers = (map) => {
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        throw new Error('layers() expects an object of named patterns, e.g. layers({ kick, bass })')
      }
      const names = Object.keys(map)
      if (names.length === 0) throw new Error('layers() needs at least one named pattern')
      for (const name of names) {
        if (!collectedLayersRef.current.includes(name)) collectedLayersRef.current.push(name)
      }
      const { muted, soloed } = mixRef.current
      const entries = Object.entries(map).filter(([name]) =>
        soloed.length > 0 ? soloed.includes(name) : !muted.includes(name),
      )
      if (entries.length === 0) {
        // Everything silenced: an event-free pattern keeps the eval valid.
        return map[names[0]].mask('0')
      }
      const tapped = entries.map(([name, pat]) =>
        pat.onTrigger((_hap, currentTime, _cps, targetTime) => {
          // Schedule the visual pulse for when the event becomes audible.
          const delayMs = Math.max(0, (targetTime - currentTime) * 1000)
          setTimeout(() => emitLayerPulse(name), delayMs)
        }, false),
      )
      return tapped.reduce((acc, pat) => acc.stack(pat))
    }
    return () => {
      delete w.layers
    }
  }, [])
```

In `runEvaluation`, reset the collection right before `await editor.evaluate()`:

```typescript
      collectedLayersRef.current = []
```

and extend the eval report post at the end of `runEvaluation`:

```typescript
      post('/api/eval', {
        clientId: clientIdRef.current,
        revision,
        playEpoch,
        ok,
        error,
        layers: ok ? collectedLayersRef.current : undefined,
      })
```

In `evaluateAndReport`, include the applied mix seq in the dedupe key so a mix toggle is never swallowed by an in-flight eval of the same revision:

```typescript
      const key = `${revision}:${playEpoch}:${appliedMixSeqRef.current}`
```

In `handleServerState`, feed the runtime FIRST (before any evaluate call) — insert at the top of the callback, right after `serverStateRef.current = s`:

```typescript
      mixRef.current = { muted: s.mix.muted, soloed: s.mix.soloed }
      const mixChanged = s.mix.seq !== appliedMixSeqRef.current
      appliedMixSeqRef.current = s.mix.seq
      setMix(s.mix)
      setLayerNames(s.layers)
      setRevision(s.revision)
```

and extend the evaluate condition so a mix change alone re-evaluates while playing:

```typescript
      if (
        (s.desiredPlaying && (epochChanged || (revisionChanged && s.code !== lastPushedCodeRef.current))) ||
        (mixChanged && s.desiredPlaying && isPlayingRef.current)
      ) {
        appliedEpochRef.current = s.playEpoch
        evaluateAndReport(s.revision, s.playEpoch)
      } else if (epochChanged) {
```

Finally, add `mix`, `layers: layerNames`, and `revision` to the hook's return object.

- [ ] **Step 4: Verify live — layer reporting**

Write `/tmp-scratchpad/layered.js` (use the session scratchpad):

```javascript
setcpm(120/4)
const kick = s("bd*4").bank("RolandTR909").gain(.7)
const hats = s("hh*8").bank("RolandTR909").hpf(4000).gain("[.8 .5]*4")
const bass = note("<c1 eb1 g1 f1>").struct("x ~ x ~ ~ x ~ ~").s("sawtooth").lpf(450).gain(.32)
const keys = chord("<Cm9 Fm9>").voicing().s("gm_epiano1").gain(.6).room(.2)

$: layers({ kick, hats, bass, keys })
```

Run: `node scripts/push.mjs <scratchpad>/layered.js --play`
Expected: `OK: playing`

Run: `curl -s http://localhost:3000/api/status | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['layers'], d['mix'])"`
Expected: `['kick', 'hats', 'bass', 'keys'] {'muted': [], 'soloed': [], 'seq': ...}`

- [ ] **Step 5: Verify live — mute and solo are audible and seamless**

Run: `curl -s -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"muted": ["bass", "kick"]}'`
Then: `node scripts/listen.mjs 6`
Expected: sub+bass share collapses versus the Step 4 groove (hats/keys dominate; high-mid TILT rises). Playback must NOT stop (`actualPlaying: true` throughout).

Run: `curl -s -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"muted": [], "soloed": ["bass"]}'`
Then: `node scripts/listen.mjs 6`
Expected: bass-only reading (sub/bass dominate BALANCE, hats' high band nearly gone).

Run: `curl -s -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"soloed": []}'`
Expected: full groove returns.

- [ ] **Step 6: Verify solo-clears-on-push and stale-name pruning**

Solo `hats`, push the same file again with `--play`, then `curl -s http://localhost:3000/api/mix`.
Expected: `soloed: []` after the push. Then mute `keys`, push a file whose `layers({...})` omits `keys`; after `OK: playing`, GET `/api/mix` shows `keys` pruned from `muted`.

- [ ] **Step 7: Run the full protocol suite**

Run: `pnpm smoke` — expected: all green.
Run: `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 8: Ask the user, then commit**

"Ready to commit with message: `feat: layers() convention - live per-layer solo/mute with activity pulses`?"

```bash
git add src/lib/layer-pulse.ts src/hooks/use-strudel.ts src/app/api/eval/route.ts
git commit -m "feat: layers() convention - live per-layer solo/mute with activity pulses"
```

---

### Task 4: The console component

**Files:**
- Create: `src/components/console.tsx`
- Modify: `src/components/level-meter.tsx` (render only — keep the analyser logic)
- Delete: `src/components/reaction-bar.tsx`, `src/components/tape-shelf.tsx`
- Modify: `src/components/strudel-editor.tsx`
- Modify: `src/lib/constants.ts`
- Modify: `src/app/globals.css`
- Test: `pnpm build`, live browser interaction + screenshot

**Interfaces:**
- Consumes: `useStrudel()` returns from Task 3 (`mix`, `layers`, `revision`, plus existing); `useAudioRecorder` exports (`formatDuration`); `onLayerPulse` from `src/lib/layer-pulse.ts`; `/api/mix`, `/api/notes`, `/api/gain`, `/api/recordings`.
- Produces: `Console` component with props `{ isPlaying, revision, nowPlaying, gainLevel, mix, layers, isRecording, recordingDuration, recorderError, recordedUrl, onPlay, onStop, onRecordClick, onDownloadRecording, onDismissRecording }` (exact types below).

- [ ] **Step 1: Restyle the level meter to segmented blocks**

In `src/components/level-meter.tsx`, keep everything through the `useEffect` (analyser plumbing) except the `draw` body and the JSX. Replace `draw` and the return with a 12-segment version:

```typescript
    const SEGMENTS = 12

    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (!analyser || !data || !barRef.current) return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity
      const level = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB))
      const lit = Math.round(level * SEGMENTS)
      const cells = barRef.current.children
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] as HTMLElement
        const on = i < lit
        // last two segments read hot
        cell.style.background = on
          ? i >= SEGMENTS - 2
            ? 'var(--destructive)'
            : 'var(--primary)'
          : 'var(--muted)'
      }
    }
```

(The `peakRef` div and its logic are removed.) JSX:

```tsx
  return (
    <div ref={barRef} className="flex gap-px" title="Master level">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="w-1 h-3" style={{ background: 'var(--muted)' }} />
      ))}
    </div>
  )
```

- [ ] **Step 2: Create `src/components/console.tsx`**

```tsx
/**
 * =============================================================================
 * CONSOLE
 * =============================================================================
 *
 * The one control surface: a flat, monospace, tracker-style panel. Header
 * carries transport, what's playing, the master meter and volume; below it,
 * one row per named layer (activity, solo, mute, a note back to the agent),
 * a track-level note line, tapes, and recording states. No other floating
 * UI exists.
 */

'use client'

import { useEffect, useRef, useState, useReducer } from 'react'
import { LevelMeter } from '@/components/level-meter'
import { onLayerPulse } from '@/lib/layer-pulse'
import { formatDuration } from '@/hooks/use-audio-recorder'
import type { NowPlaying, Mix } from '@/hooks/use-strudel'

type Tape = { name: string; bytes: number; modified: number }

export type ConsoleProps = {
  isPlaying: boolean
  revision: number
  nowPlaying: NowPlaying | null
  gainLevel: number
  mix: Mix
  layers: string[]
  isRecording: boolean
  recordingDuration: number
  recorderError: string | null
  recordedUrl: string | null
  onPlay: () => void
  onStop: () => void
  onRecordClick: () => void
  onDownloadRecording: () => void
  onDismissRecording: () => void
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})

/** "2026-07-23T18-35-40-145-blackout-bomt.wav" → { title: "blackout", detail } */
function describeTape(tape: Tape): { title: string; detail: string } {
  const m = tape.name.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:-(.+?))?-[a-z0-9]{4}\.wav$/)
  const title = m ? (m[1] ? m[1].replace(/-/g, ' ') : 'untitled') : tape.name.replace(/\.wav$/, '')
  const date = new Date(tape.modified)
  const mb = (tape.bytes / (1024 * 1024)).toFixed(1)
  return {
    title,
    detail: `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mb}mb`,
  }
}

/** Square, flat toggle - inverse video when active. */
function Toggle({
  label,
  active,
  activeClass,
  title,
  onClick,
}: {
  label: string
  active: boolean
  activeClass: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-5 h-5 border text-[10px] leading-none ${
        active ? activeClass : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
      }`}
    >
      {label}
    </button>
  )
}

/** Inline note input - Enter sends, Escape closes. */
function NoteInput({
  placeholder,
  onSend,
  onClose,
  autoFocus,
}: {
  placeholder: string
  onSend: (text: string) => void
  onClose?: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  return (
    <input
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text.trim()) {
          onSend(text.trim())
          setText('')
          onClose?.()
        } else if (e.key === 'Escape') {
          onClose?.()
        }
      }}
      placeholder={placeholder}
      maxLength={500}
      className="flex-1 min-w-0 bg-transparent border border-border px-1.5 h-5 text-[11px] font-mono outline-none placeholder:text-muted-foreground/60 focus:border-primary"
    />
  )
}

function LayerRow({ name, mix }: { name: string; mix: Mix }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [sentAt, setSentAt] = useState(0)
  const dotRef = useRef<HTMLSpanElement>(null)

  // Activity pulse: flash the dot when this layer fires. Direct style
  // mutation - a re-render per audio event would be wasteful.
  useEffect(
    () =>
      onLayerPulse((layer) => {
        if (layer !== name || !dotRef.current) return
        const dot = dotRef.current
        dot.style.background = 'var(--primary)'
        setTimeout(() => {
          dot.style.background = 'var(--muted)'
        }, 90)
      }),
    [name],
  )

  const muted = mix.muted.includes(name)
  const soloed = mix.soloed.includes(name)
  const toggleMute = () =>
    post('/api/mix', { muted: muted ? mix.muted.filter((n) => n !== name) : [...mix.muted, name] })
  const toggleSolo = () =>
    post('/api/mix', { soloed: soloed ? mix.soloed.filter((n) => n !== name) : [...mix.soloed, name] })
  const sendNote = (text: string) => {
    post('/api/notes', { text, layer: name })
    setSentAt(Date.now())
    setTimeout(() => setSentAt(0), 1200)
  }

  return (
    <div className="flex items-center gap-2 px-2 h-7 border-t border-border/60">
      <span ref={dotRef} className="w-1.5 h-1.5 shrink-0" style={{ background: 'var(--muted)' }} />
      <span className={`flex-1 truncate lowercase ${muted && !soloed ? 'text-muted-foreground/50 line-through' : ''}`}>
        {name}
      </span>
      {sentAt > 0 && <span className="text-primary">sent</span>}
      {noteOpen ? (
        <NoteInput autoFocus placeholder={`note on ${name}…`} onSend={sendNote} onClose={() => setNoteOpen(false)} />
      ) : (
        <>
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
            activeClass="bg-destructive text-white border-destructive"
            title={`mute ${name}`}
            onClick={toggleMute}
          />
          <button
            onClick={() => setNoteOpen(true)}
            title={`send a note about ${name}`}
            className="text-muted-foreground hover:text-foreground text-[10px]"
          >
            note
          </button>
        </>
      )}
    </div>
  )
}

export function Console(props: ConsoleProps) {
  const {
    isPlaying,
    revision,
    nowPlaying,
    gainLevel,
    mix,
    layers,
    isRecording,
    recordingDuration,
    recorderError,
    recordedUrl,
    onPlay,
    onStop,
    onRecordClick,
    onDownloadRecording,
    onDismissRecording,
  } = props

  const [collapsed, setCollapsed] = useState(false)
  const [tapesOpen, setTapesOpen] = useState(false)
  const [tapes, setTapes] = useState<Tape[] | null>(null)
  const [trackSentAt, setTrackSentAt] = useState(0)

  // Volume: local value while dragging so the SSE echo can't fight the thumb.
  const [dragVolume, setDragVolume] = useState<number | null>(null)
  const volumePostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volumeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleVolumeChange = (level: number) => {
    setDragVolume(level)
    if (volumePostTimerRef.current) clearTimeout(volumePostTimerRef.current)
    volumePostTimerRef.current = setTimeout(() => {
      post('/api/gain', { level, rampMs: 120 })
    }, 80)
    if (volumeSettleTimerRef.current) clearTimeout(volumeSettleTimerRef.current)
    volumeSettleTimerRef.current = setTimeout(() => setDragVolume(null), 800)
  }

  // Tick the elapsed display once a second while a piece plays.
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!nowPlaying) return
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [nowPlaying])

  useEffect(() => {
    if (!tapesOpen) return
    setTapes(null)
    fetch('/api/recordings')
      .then((res) => res.json())
      .then((data) => setTapes(Array.isArray(data.recordings) ? data.recordings : []))
      .catch(() => setTapes([]))
  }, [tapesOpen])

  const sendTrackNote = (text: string) => {
    post('/api/notes', { text })
    setTrackSentAt(Date.now())
    setTimeout(() => setTrackSentAt(0), 1200)
  }

  const elapsed = nowPlaying ? Math.max(0, Math.floor((Date.now() - nowPlaying.since) / 1000)) : 0
  const headline = nowPlaying
    ? [nowPlaying.title, nowPlaying.section, formatDuration(elapsed)].filter(Boolean).join(' · ')
    : isPlaying
      ? 'playing'
      : 'stopped'

  return (
    <div className="fixed bottom-3 right-3 w-[26rem] max-w-[calc(100vw-1.5rem)] font-mono text-[11px] text-foreground border border-border bg-[oklch(0.1_0.008_285/0.97)] select-none">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 h-8">
        <span className="text-primary font-semibold">klaude</span>
        <button
          onClick={isPlaying ? onStop : onPlay}
          title={isPlaying ? 'stop' : 'play'}
          className="w-4 text-primary hover:opacity-80"
        >
          {isPlaying ? '■' : '▶'}
        </button>
        <button onClick={onPlay} title="re-evaluate" className="text-muted-foreground hover:text-foreground">
          ⟳
        </button>
        <button
          onClick={onRecordClick}
          title={isRecording ? 'stop recording' : 'record'}
          className={isRecording ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}
        >
          {isRecording ? `● ${formatDuration(recordingDuration)}` : '●'}
        </button>
        <span className="flex-1 truncate text-muted-foreground" title={headline}>
          {headline} · r{revision}
        </span>
        <LevelMeter />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={dragVolume ?? gainLevel}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          title="Master volume"
          className="w-14 h-1 accent-[var(--primary)] cursor-pointer"
        />
        <button
          onClick={() => setTapesOpen((o) => !o)}
          className={`text-[10px] ${tapesOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        >
          tapes
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'expand' : 'collapse'}
          className="text-muted-foreground hover:text-foreground w-3"
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Layer mixer */}
          <div className="max-h-[40vh] overflow-y-auto">
            {layers.map((name) => (
              <LayerRow key={name} name={name} mix={mix} />
            ))}
            {layers.length === 0 && (
              <div className="px-2 h-7 flex items-center border-t border-border/60 text-muted-foreground/60">
                no layers - push a track with layers({'{'}…{'}'})
              </div>
            )}
          </div>

          {/* Track-level note */}
          <div className="flex items-center gap-1.5 px-2 h-7 border-t border-border/60">
            <span className="text-primary">&gt;</span>
            {trackSentAt > 0 && <span className="text-primary">sent</span>}
            <NoteInput placeholder="tell klaude…" onSend={sendTrackNote} />
          </div>

          {/* Recorder error */}
          {recorderError && (
            <div className="px-2 h-7 flex items-center border-t border-border/60 text-destructive truncate">
              {recorderError}
            </div>
          )}

          {/* Recording review */}
          {recordedUrl && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border/60">
              <audio src={recordedUrl} controls className="h-7 flex-1 min-w-0" />
              <button onClick={onDownloadRecording} className="text-primary hover:opacity-80 text-[10px]">
                keep
              </button>
              <button onClick={onDismissRecording} className="text-muted-foreground hover:text-destructive text-[10px]">
                discard
              </button>
            </div>
          )}

          {/* Tapes */}
          {tapesOpen && (
            <div className="max-h-[30vh] overflow-y-auto border-t border-border">
              {tapes === null && (
                <div className="px-2 h-7 flex items-center text-muted-foreground/60">loading…</div>
              )}
              {tapes !== null && tapes.length === 0 && (
                <div className="px-2 h-7 flex items-center text-muted-foreground/60">
                  no tapes yet - record a set and it lands here
                </div>
              )}
              {tapes?.map((tape) => {
                const { title, detail } = describeTape(tape)
                const url = `/api/recordings/${encodeURIComponent(tape.name)}`
                return (
                  <div key={tape.name} className="px-2 py-1.5 border-t border-border/40 first:border-t-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate">{title}</span>
                      <span className="text-muted-foreground/70 text-[10px] shrink-0">{detail}</span>
                      <a href={url} download={tape.name} className="text-primary text-[10px] shrink-0">
                        dl
                      </a>
                    </div>
                    <audio controls preload="none" src={url} className="w-full h-7 mt-1" />
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `strudel-editor.tsx` around the console**

Keep: the hooks block, recording mode refs + `ackRecord`/`uploadRecording`/command handler/on-stop effects, `handleKeyDownCapture`, `handleRecordClick`, the load-error and loading returns. Remove: the HUD JSX, recorder toasts, floating controls, `ReactionBar`, `TapeShelf`, `LevelMeter` imports and usage, the volume-slider logic (moved into the console), the elapsed `tick` reducer (moved), and the lucide imports.

New imports at the top:

```tsx
import { useRef, useEffect, useCallback } from 'react'
import { useStrudel, type RemoteCommand } from '@/hooks/use-strudel'
import { useAudioRecorder } from '@/hooks/use-audio-recorder'
import { Console } from '@/components/console'
import { DEFAULT_CODE } from '@/lib/constants'
```

Destructure the new hook returns:

```tsx
  const {
    loaded,
    loadError,
    isPlaying,
    audioBlocked,
    nowPlaying,
    gainLevel,
    mix,
    layers,
    revision,
    clientId,
    editorRef,
    play,
    stop,
    unlockAudio,
    setOnStopCallback,
    setCommandHandler,
  } = useStrudel()
```

Replace everything in the return between the editor container and the closing tag with:

```tsx
      <Console
        isPlaying={isPlaying}
        revision={revision}
        nowPlaying={nowPlaying}
        gainLevel={gainLevel}
        mix={mix}
        layers={layers}
        isRecording={isRecording}
        recordingDuration={duration}
        recorderError={recorderError}
        recordedUrl={recordedUrl}
        onPlay={play}
        onStop={stop}
        onRecordClick={handleRecordClick}
        onDownloadRecording={downloadRecording}
        onDismissRecording={dismissRecording}
      />

      {/* Audio blocked overlay - browsers refuse sound before a user gesture */}
      {audioBlocked && (
        <button
          onClick={unlockAudio}
          className="fixed inset-0 z-50 bg-background/85 flex items-center justify-center cursor-pointer"
        >
          <div className="border border-primary px-6 py-4 font-mono text-sm text-primary">
            ▶ tap anywhere to join the music
          </div>
        </button>
      )}
```

- [ ] **Step 4: Delete the replaced components and the reaction animation**

```bash
rm src/components/reaction-bar.tsx src/components/tape-shelf.tsx
```

In `src/app/globals.css`, delete section `6. APP UI ANIMATIONS` entirely (the `reaction-rise` keyframes and `.reaction-burst` rule), renumbering the BASE STYLES comment header is optional.

- [ ] **Step 5: Update `DEFAULT_CODE`**

In `src/lib/constants.ts`:

```typescript
/** Default Strudel code shown when the editor first loads */
export const DEFAULT_CODE = `// Welcome to klaude - name your layers and the console picks them up
setcpm(120/4)

const drums = s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")
const bass = note("<c2 eb2 f2 g2>").s("sawtooth").lpf(400).lpenv(2)

$: layers({ drums, bass })
`
```

- [ ] **Step 6: Build and verify in the browser**

Run: `npx tsc --noEmit` — expected: clean.
Run: `pnpm build` — expected: successful production build.

With `pnpm dev` running and a tab open: push the Task 3 `layered.js` with `--play`, then verify in the browser (Playwright):
- Console shows 4 layer rows with pulsing activity dots.
- Clicking `m` on `bass` audibly drops the bass and inverts the toggle; `/api/mix` reflects it.
- Clicking `s` on `hats` leaves only hats audible; other rows keep pulsing OFF (no events scheduled for dropped layers).
- Typing in a layer's `note` input and pressing Enter → `curl -s http://localhost:3000/api/notes` shows the note with `layer` set; the row flashes `sent`.
- The track-level `>` input posts a note with `layer: null`.
- `tapes` expands rows inside the panel and plays a WAV inline.
- Record `●` starts/stops; the review row appears with keep/discard.
- POST `/api/nowplaying` with a title/section → header shows `title · section · 0:0x · rN` and the elapsed time ticks.
- Collapse `−` reduces the panel to the header line.
- Take a screenshot and send it to the user.

- [ ] **Step 7: Ask the user, then commit**

"Ready to commit with message: `feat: terminal console - per-layer mixer with notes, replaces floating pills`?"

```bash
git add -A src/components src/lib/constants.ts src/app/globals.css
git commit -m "feat: terminal console - per-layer mixer with notes, replaces floating pills"
```

---

### Task 5: Skills and docs follow the new protocol

**Files:**
- Modify: `.claude/skills/api/SKILL.md`
- Modify: `.claude/skills/dj-set/SKILL.md`
- Modify: `.claude/skills/compose/SKILL.md`
- Modify: `.claude/skills/humanize/SKILL.md`
- Modify: `README.md`
- Test: `grep`, `pnpm smoke`

**Interfaces:**
- Consumes: everything shipped in Tasks 1-4.
- Produces: agent-facing documentation of `layers()`, `/api/mix`, `/api/notes`. Note: `compose` and `humanize` SKILL.md have pre-existing uncommitted local edits — edit on top of them, do not revert.

- [ ] **Step 1: Rewrite the api skill's protocol sections**

In `.claude/skills/api/SKILL.md`:

Add to the endpoints table (replacing the `/api/reactions` row):

```markdown
| `/api/mix` | GET/POST | Per-layer solo/mute: `{"muted": [...], "soloed": [...]}` - full replacement per key |
| `/api/notes` | GET/POST/DELETE | Listener feedback: free text, optionally aimed at a layer |
```

Replace the "Reading the Room" section with:

```markdown
## Reading the Room

The console lets the listener type notes at a specific layer or the whole
track. Every note is stamped with the revision and HUD section playing when
it was written:

```bash
curl -s http://localhost:3000/api/notes
# {"notes":[{"text":"bass too muddy","layer":"bass","revision":42,"section":"the drop","at":...}],"serverTime":...}
```

`/api/status` carries the same as `recentNotes`. Check between phases and
sections; compare `at` against `serverTime` for freshness. A note names the
exact thing to change - act on it in the next push, and say what you changed.

Mute state is feedback too: `/api/status` → `mix.muted` naming a layer for
two sections running means the listener has already made the call - write it
out of the arrangement. Clear leftovers from an old session with
`curl -X DELETE http://localhost:3000/api/notes` when starting fresh.
```

Add a new section after "Pushing Code":

```markdown
## Named Layers - write tracks the console can mix

Always structure tracks as named layers and finish with `layers({...})`:

```javascript
const kick = s("bd*4").bank("RolandTR909").gain(.7)
const bass = note("<c1 eb1>").s("sawtooth").lpf(450).gain(.32)
const hats = s("hh*8").bank("RolandTR909").gain("[.8 .5]*4")

$: layers({ kick, bass, hats })
```

`layers()` works anywhere a pattern goes, including inside `arrange()`
sections - keep names consistent across sections (kick is kick everywhere).
The console draws one mixer row per name; solo/mute apply live without
stopping playback. A push clears solo and keeps mutes.

**Solo a layer and listen to it in isolation - your closest ear to the mix:**

```bash
curl -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"soloed": ["bass"]}'
node scripts/listen.mjs 8
curl -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"soloed": []}'
```
```

Update the Status Field Guide block with:

```
mix              {muted, soloed, seq} - live per-layer mixer state
layers           layer names reported by the last successful eval
recentNotes      listener feedback; each note has text, layer, revision, section
```

- [ ] **Step 2: Update dj-set, compose, humanize skills**

`grep -n "reaction" .claude/skills/dj-set/SKILL.md` and rewrite each hit to the notes protocol (read notes between phases; 🔥/❤️/💤 vocabulary becomes free text; "no notes ≠ boredom - silence is normal" keeps its meaning). Where these skills show code with `stack(...)` as the top-level pattern, switch the example to `$: layers({...})` and add one line: "name every layer - the console mixes by name." In `humanize/SKILL.md`'s checklist, add:

```markdown
- [ ] Track pushed as named layers (`$: layers({ kick, bass, ... })`) so the console can solo/mute
```

- [ ] **Step 3: Update README**

`grep -n -i "reaction" README.md` — rewrite the reaction-bar feature line to describe the console: per-layer mixer (solo/mute), free-text notes to the agent, tapes and recording in one terminal-style panel.

- [ ] **Step 4: Verify no stale references and protocol still green**

Run: `grep -rn -i "reaction" src scripts .claude README.md` — expected: no functional hits (history mentions in specs/plans are fine).
Run: `pnpm smoke` — expected: all green.

- [ ] **Step 5: Ask the user, then commit**

"Ready to commit with message: `docs: skills speak the layers/notes protocol`?"

```bash
git add .claude README.md
git commit -m "docs: skills speak the layers/notes protocol"
```

---

### Task 6: End-to-end pass, reviews, restore the music

**Files:** none new — verification and review only.

- [ ] **Step 1: Full closed-loop rehearsal**

As the agent would: push a layered track with `--play`, set `/api/nowplaying`, confirm console header; solo `bass` via curl → `listen.mjs 8` shows a bass-only reading; clear solo; mute a layer from the browser; send a layer note from the browser and read it via `/api/notes`; record 10s via `/api/record/start`/`stop` and confirm the tape appears in the console's tapes list.

- [ ] **Step 2: Self-review the full diff**

`git diff main@{upstream}...HEAD` (or `git log --stat` over the new commits): check against the spec section by section; check UI code for any forbidden classes (`grep -rn "backdrop-blur\|shadow-\|rounded-\|animate-in" src/components` — expected: no hits in console/level-meter/strudel-editor).

- [ ] **Step 3: Independent Codex review (foreground)**

Dispatch `codex:codex-rescue` with `--wait`, never backgrounded, covering the spec, the plan, and the implementation diff. Triage findings with the superpowers:receiving-code-review skill; fix what's real.

- [ ] **Step 4: Restore the user's music**

The pre-benchmark track (AURORA) was revision 71: `curl -X POST http://localhost:3000/api/history -H "Content-Type: application/json" -d '{"revision": 71}'` — but re-check `/api/history` first; the revision number will have moved during implementation. Match by `firstLine` containing `AURORA`. Restore master gain to 1. Note: AURORA predates the layers convention (top-level `stack()`), which still works — the console just shows no rows for it.

- [ ] **Step 5: Report**

Show the user: final screenshot, smoke output, the listen-while-soloed report, and the commit list.
