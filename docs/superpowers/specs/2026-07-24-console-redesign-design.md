# Console redesign: terminal mixer with per-layer feedback

The current overlay UI (floating glass pills, emoji reaction bar, now-playing HUD card, tape-shelf popover) reads as generic and gives the listener no precise way to say what's wrong with the music. This redesign replaces all of it with a single terminal-style console: a per-layer mixer with solo/mute and free-text notes routed back to the agent.

The screen's audience is the person writing patterns, alone. Chrome stays out of the way of the code; the emoji reaction bar is removed entirely.

## Named layers: the new contract

The agent writes every track as named layers through a `layers()` helper the app registers globally before evaluation:

```javascript
const kick = s("bd*4").bank("RolandTR909").gain(.72)
const bass = note("<c1 eb1>").s("sawtooth").lpf(450).gain(.32)

$: layers({ kick, bass, hats, keys })
```

`layers()` does three things at eval time:

1. Registers the layer names with the client (which reports them to the server alongside the eval result), so the console knows what rows to draw.
2. Filters the stack against the current mix state: soloed layers win (union of all solos); otherwise muted layers are dropped. Dropped layers are removed from the stack, not gain-zeroed.
3. Returns the resulting pattern, so it composes anywhere a pattern goes — including inside `arrange()` sections. Names are global across sections: muting `bass` mutes it in every section that has a layer named `bass`.

When mix state changes, the client re-evaluates the unchanged editor code. Strudel's scheduler keeps its phase across re-evaluation, so toggles are seamless — playback never stops or restarts.

## Mix state and API

The server owns mix state: `{ muted: string[], soloed: string[], seq }`.

- `POST /api/mix` — set/toggle mute and solo. Called by the browser (console clicks) and by the agent (curl), so the agent can solo a layer and run `listen.mjs` on it in isolation — the same ear the listener has.
- Mix state rides the existing SSE stream and appears in `GET /api/status`, with the reported layer names of the current revision.
- A new push (`POST /api/code`) clears solo but preserves mutes for layer names that still exist — a layer the listener silenced stays silenced across revisions until they bring it back or the agent removes it.

## Notes: free-text feedback, targeted

Notes replace reactions. A note is what the listener types, aimed at a layer or at the whole track:

- `POST /api/notes` `{ layer?: string, text: string }` — the server stamps revision, current HUD section, and time.
- `GET /api/notes` — the agent reads these between phases exactly where it read reactions before; `DELETE` clears.
- `GET /api/status` includes recent notes.

The `/api/reactions` endpoint and the reaction bar component are deleted. Persisted mix/note state follows the same server-side persistence the rest of the protocol uses.

## The console

One flat, monospace panel docked at the bottom-right of the editor, replacing the floating transport pill, HUD card, reaction bar, and tape-shelf popover. Visual rules: monospace type, 1px solid borders, square corners, theme colors, no backdrop blur, no shadows, no gradients, no slide-in animations. Meters are segmented blocks. It collapses to its header line.

**Header row** — everything the HUD card and transport pill did, as one line: play/stop/re-eval/record controls as glyphs, `title · section · elapsed · rev N`, master level meter, volume slider, tapes toggle. Recording shows a timer in the same row.

**Layer rows** — one per reported layer:

```
bass   ▊▊▁   [S] [M]   ▸ note
```

- `[S]` / `[M]` toggle solo/mute live. Active states are visually loud (inverse video), since they change what's audible.
- `▸ note` opens an inline text input in the row; Enter sends the note tagged with that layer. One extra row at the bottom takes track-level notes.
- A small activity indicator pulses when the layer's pattern fires events.

**Tapes** — toggling the tapes control expands text rows inside the same panel (name, date, size, inline audio element, download). No separate popover.

**System states** — recorder errors and the recording review (discard/download) render as rows in the console. The audio-unlock overlay stays (it's load-bearing) but restyled flat and monospace.

Components deleted: `reaction-bar.tsx`, the HUD card and floating controls in `strudel-editor.tsx`, `tape-shelf.tsx` as a popover (its logic folds into the console). `level-meter.tsx`'s analyser logic is kept and rehoused.

## Agent-side changes

- **/api skill** — document `layers()`, `/api/mix` (including solo-then-listen for debugging), and `/api/notes` replacing reactions ("reading the room" reads notes; mute state is also a signal — a layer the listener keeps muted should probably die in the code).
- **/compose, /dj-set, /humanize skills** — write tracks as named layers; check notes between phases/sections.
- **smoke.mjs** — replace reaction checks with notes and mix checks (validation, clamping, push-preserves-mutes).
- **Default editor code** — updated to the layers convention so the first thing anyone sees models the contract.

## Testing

- `smoke.mjs` covers the server protocol: mix validation, solo/mute semantics (solo wins, unions), mute persistence across pushes, notes stamping (revision/section), status exposure.
- Browser pass: push a layered track, toggle solo/mute from both the console and curl while playing (audio changes without stopping), send a layer note and read it back from `/api/notes`, record and review from the console rows.
- `listen.mjs` while a layer is soloed via API confirms the agent-side isolation loop.
