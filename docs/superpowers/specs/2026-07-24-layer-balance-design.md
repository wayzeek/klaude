# Layer balance: per-layer faders and feel knobs

The console can already silence a layer or hear it alone. It cannot make one *quieter*. Every judgement about balance has to be typed as a note and waited on, which means the listener can hear that the pad is too loud but has no way to simply pull it down.

This adds a fader and four feel knobs to every layer, so the mix can be shaped by ear, live, by someone who does not read the code. The controls are named for what they sound like rather than what they are, and each one is a trim on top of the written track: at rest, every control is a no-op and the track sounds exactly as the agent wrote it.

## The controls

Each named layer gets five values, all with a neutral default:

| Value | Range | Neutral | Reads as |
|---|---|---|---|
| `volume` | 0 to 2 | 1 | quieter, louder |
| `tone` | -1 to 1 | 0 | muffled, thin |
| `space` | -1 to 1 | 0 | dry, roomy |
| `feel` | -1 to 1 | 0 | early, late |
| `swing` | 0 to 1 | 0 | straight, swung |

A value at its neutral changes nothing about the events a layer produces. This is a hard rule, not an optimisation: an untouched layer must sound exactly as it does today, so that adding this feature cannot alter any existing track.

Note what the rule does *not* say. The value-trim wrapper is installed on every layer unconditionally, whether or not that layer currently holds a trim. Installing it only for already-trimmed layers would be a bug: a layer at rest would have nothing in place to read a later fader move, so the first touch of every fader would demand a re-evaluation and the fader would not be rideable at all.

Precisely, then: at neutral, `applyValueTrim` returns the *same value object* it was handed and `applyStructuralTrim` returns the *same pattern* it was handed. The event that comes out carries identical timing, context and values. It is not literally the same object, because Strudel's `withValue` builds a new one whether or not the value changed, and no arrangement of this design avoids that. The guarantee is about what the listener can hear and what a test can compare, not about object identity.

### What each one does to a hap

Three controls change values on events as the scheduler asks for them, verified against the engine's own parameter defaults:

- **volume** multiplies `postgain`, the gain stage superdough applies after the inline effects chain, defaulting to 1. Multiplying `gain` instead would also preserve per-hit dynamics, so that is not the reason to prefer `postgain`; the reasons are that it defaults to a clean 1 rather than 0.8, that it sits after the effects rather than in front of them, and that the delay and reverb sends are fed from it, so a hit and its tails scale together.

- **tone** below neutral closes a lowpass, above neutral opens a highpass, and both are written to never fight the filtering the code already chose:

  ```
  base = cutoff ?? 20000
  tone < 0:  cutoff  = clamp(base * 2^(4 * tone), min(base, 120), base)
  tone > 0:  hcutoff = min(max(hcutoff ?? 0, 30 * 2^(6 * tone)), max(base / 4, hcutoff ?? 0))
  ```

  The lower clamp is `min(base, 120)` rather than a flat 120 so that a layer the code deliberately filtered below 120 Hz is left alone instead of being *brightened* by its own darkening knob. The upper clamp holds the result at or under `base`, so the knob can never open a filter it did not close.

  On the highpass side, capping at `base / 4` keeps the two filters from closing on each other: without it, a layer lowpassed at 1 kHz would meet a 1.9 kHz highpass at full travel and very nearly vanish. That cap is itself floored at the code's own highpass, because the two rules genuinely conflict on a layer that is both lowpassed at 1 kHz and highpassed at 500 Hz: a flat `base / 4` would drag the highpass down to 250 and quietly undo what the author asked for. Between narrowing the band and overriding the author, this picks narrowing.

- **space** offsets the reverb send: `room = clamp((room ?? 0) + 0.6 * space, 0, 1)`. The engine gates reverb on `room > 0`, so a layer written dry stays dry until the knob asks for wet.

Two controls change the shape of the pattern rather than its values:

- **feel** shifts the layer by up to 1/64 of a cycle, late or early. Cycle-relative rather than absolute milliseconds, so the lean holds when the tempo changes. This is deliberately *not* the engine's `nudge` control: `nudge` is only honoured on the sample playback path, so it would move drums and do nothing at all to a synth bass.
- **swing** delays the hits that fall in the second half of each quarter-slice:

  ```
  pattern.inside(4, x => x.within(0.5, 1, y => y.late((2/3 * swing) / 2)))
  ```

  Strudel ships `swingBy`, which looks like exactly this and is not usable here. It is defined as `pat.inside(n, late(seq(0, swing / 2)))`, and that patterned `late` multiplies structure: any event longer than half a slice spans both argument values and comes out twice. Measured at full travel against `n = 4`, a one-chord-per-cycle pad goes from 4 events per 4 cycles to 32, quarter notes double, and even Strudel's own documented `hh*8` example goes from 32 to 48. The result is flams, not swing.

  The `within` form routes each event down exactly one branch, so nothing can be duplicated. Measured against the same five layers it preserves the event count exactly, displaces off-beat eighths and sixteenths, and leaves quarter notes and held pads where they are.

The order is fixed at swing first, then feel: swing rearranges hits within the bar, feel leans the finished layer against the beat, which is the order a player would think in. Measured against this engine the two actually commute on ordinary patterns, so nothing audible rides on the choice today. `applyStructuralTrim` owns the sequence anyway, so that behaviour cannot drift if either transform is ever changed.

### Limits worth stating

All three are consequences of trimming rather than rewriting, and all three should be visible in the UI rather than discovered by confusion.

**A value trim takes effect from a layer's next onset, not instantly.** This is the important one. Superdough builds a fresh gain and filter chain per triggered hit, so a note already sounding keeps the settings it was born with, as do its release and reverb tails. On drums, hats or a busy bass, the next hit is milliseconds away and the fader feels continuous. On a pad holding one chord for four cycles, a fader move is not heard until that chord retriggers. The whole-mix master fader in the statusline is a real persistent gain node and does move sustained sound immediately; the per-layer faders cannot, because the engine gives each hit its own chain.

**A layer already darker than the floor cannot be darkened further.** The lower clamp is the code's own cutoff when that sits below 120 Hz, so the knob has nowhere left to travel on a layer written that dark.

**Swing cannot move a hit that is already on the beat.** It bends off-beats, so it transforms hats and shakers, leaves a four-on-the-floor kick exactly where it was, and does nothing at all to a held pad. This is measured behaviour of the chosen transform, not a hope.

## Live versus structural

Value trims are applied inside the pattern, so they are read fresh each time the scheduler queries the next chunk of music. Strudel's clock queries in 50 ms slices on a 100 ms callback interval with a 100 ms overlap, and the cyclist adds a fixed 100 ms trigger latency, so events are already committed up to roughly 300 ms ahead. A trim therefore reaches the audio on the first onset scheduled after that window, with no re-evaluation and no gap in the sound. On any layer that hits more often than a few times a bar this is indistinguishable from instant, which is what makes the fader rideable. Re-evaluating the whole track on every mouse move would instead re-run sample loading and chord voicing dozens of times a second.

Structural trims cannot work that way, because they rebuild the pattern. `feel` and `swing` therefore commit on release and re-evaluate, exactly as solo and mute already do. Strudel keeps scheduler phase across re-evaluation, so the change is audibly seamless.

The practical consequence for the UI: volume, tone and space update continuously while dragging; feel and swing update on release.

### Splitting the change counter

Today the client re-evaluates whenever `mix.seq` differs from the seq it last applied, and that same seq is baked into the evaluation queue's coalescing key. Left alone, that single counter defeats the whole design: every fader move would bump it and re-evaluate the track, which is the exact cost this section exists to avoid.

So `MixState` carries two counters:

- `seq` bumps on any mix change at all. It remains the token the UI and the persisted state use to notice that something moved.
- `structuralSeq` bumps only on changes that require the pattern to be rebuilt: `muted`, `soloed`, and the `feel` or `swing` value of any layer.

The client then reads them differently. Every SSE snapshot refreshes the live trim reference the pattern reads at query time, unconditionally and without evaluating anything. Re-evaluation is triggered by a change in `structuralSeq`, which replaces today's `mix.seq` comparison, and `structuralSeq` is what goes into the evaluation key so a trim-only change cannot invent a new key or displace a queued evaluation.

This keeps the existing serialization guarantees untouched. The queue, the coalescing to the newest key, and the generation counter that invalidates evaluations superseded by a stop all continue to work exactly as they do now, because from their point of view nothing new happens when a fader moves.

## State and protocol

The server owns the trims, beside the mutes it already owns. `MixState` grows two fields:

```
mix: { muted, soloed, trims: Record<layerName, LayerTrim>, seq, structuralSeq }
```

Only non-neutral trims are stored, so the common case stays empty and the persisted file stays small. The server decides which counter to bump by comparing the incoming patch against the stored record, so the rule about what counts as structural lives in one place rather than being re-derived by each caller.

`POST /api/mix` accepts two new forms alongside the existing ones:

- `{ "trim": { "layer": "bass", "volume": 0.6, "tone": -0.4 } }` patches named values for one layer and leaves the rest alone. Out-of-range numbers are clamped, not refused, so no value from a dragging slider can wedge the mixer. A patch that lands every value on its neutral drops the layer's record entirely.
- `{ "resetTrim": "bass" }` returns one layer to as-written.

A single request may carry trim changes alongside mute or solo changes, and applies them as one mutation with one SSE emission, matching how the existing endpoint already treats a combined mute and solo patch. Neither counter moves for a patch that changes nothing: `structuralSeq` in particular must only advance on a real structural difference, or a no-op request would trigger a re-evaluation for no reason. This is stricter than today's `setMix`, which bumps its seq even when handed equivalent state.

Trims ride the existing SSE stream and appear in `GET /api/mix` and `GET /api/status`. This is the point of putting them on the server rather than in the browser: the agent can read that the listener pulled the keys down and muffled them, which is feedback of the same kind as a note but more precise, and it can fold those values into the code when the mix should become permanent.

Lifecycle matches mutes exactly. Trims survive a new revision, because a balance decision outlives the take it was made on. They are pruned once a successful evaluation of the current revision observes the name absent. That is a weaker promise than "a stale trim can never come back", and deliberately so: if a layer disappears in a revision that never evaluates successfully and a later revision reuses the name, no evaluation ever reported the absence and the old trim applies to the new layer. The same hole exists for mutes today. It is worth knowing rather than papering over, and the `*` marker on the row is what makes it visible when it happens.

Trims persist to `.klaude/state.json` and reload with the existing state. Reload validates them the same way the loader already validates history and notes, since a hand-edited or truncated file must not be able to inject an out-of-range trim that request-time clamping never sees.

## The rack

The mixer row keeps its channel number, activity light, name, solo and mute, and gains an inline volume fader. So the whole balance of the track stays readable at a glance and any layer can be ridden without opening anything.

Clicking a row selects it. One channel strip below the layer list shows the selected layer's four knobs, a reset, and the note box:

```
MIXER · 4
01 ● drums     ▐▬▬▬▬▬▬▌──  s m
02 ▸ bass *    ▐▬▬▬▌─────  s m
03 ● keys      ▐▬▬▬▬▬▌───  s m
04 ● pad       ▐▬▬▬▬▌────  s m
────────────────────────────────
CHANNEL · bass                 ↺
 muffled  ◄──────●──────►  thin
 dry      ◄──●──────────►  roomy
 early    ◄──────●──────►  late
 straight ●─────────────►  swung
 ▸ note
```

The handles show where neutral sits for each control. Tone, space and feel rest in the middle because they run both ways; swing rests hard left, because straight is its zero and it only adds. `bass` carries the `*` because its space knob has been moved off neutral.

One strip rather than per-row expansion keeps the rack from growing as layers are opened, and gives the four knobs a fixed place to live. The note moves from the row into the strip, which frees the row width the fader needs and puts words where they belong: the last resort after the knobs.

Selection is sticky and never empty: the strip shows the first layer until another row is clicked, so there is no blank state to design and no click that makes the knobs vanish. With no layers at all the strip is hidden and the existing "no layers yet" line stands alone.

Visual rules are the existing ones. Monospace, 1px borders, square corners, no blur, no shadows. A layer holding any non-neutral value shows a `*` after its name, so a departure from as-written is visible without selecting the row, the same way a mute already strikes the name through.

The fader reads in percent, where 100% is as-written. Its travel is tapered as `volume = 2 * position²`, putting unity at about 71% of the throw and the full 200% at the top, because a fader linear in amplitude wastes most of its travel on the loud end. The engine applies its own configurable gain curve to `postgain`, which is identity by default; the taper above assumes that default rather than relying on it as an invariant.

## Structure

The change touches four concerns, kept in four places.

**`src/lib/trim.ts`** (new) holds the trim vocabulary and all the audio maths as pure functions: the neutral constants, a clamp, `isNeutral`, `applyValueTrim(hapValue, trim)` and `applyStructuralTrim(pattern, trim)`. No React, no server, no Strudel imports beyond the pattern it is handed. Every number in the tables above lives here and nowhere else, which is what makes them testable.

**`src/app/api/state.ts`** handles trims inside the existing `setMix` rather than growing sibling methods, extends persistence, and prunes trims in the same place it prunes mutes. One entry point is what makes a combined trim-and-mute request a single mutation with a single SSE emission, and it puts the decision about which counter to move in one place. **`src/app/api/mix/route.ts`** validates and clamps.

**`src/lib/layers-runtime.ts`** (new) takes the `layers()` implementation out of `use-strudel.ts`. That hook is 733 lines and already carries the engine lifecycle, the revision protocol, edit sync, gain ramps and recording commands; the layer runtime is self-contained, needs no React, and is about to get more complex. Moving it is a precondition for the change rather than a tidy-up beside it. Its job is the two ways a trim reaches the audio: install the value-trim wrapper that reads live trims at query time, and apply the structural transforms at evaluation time.

The decision of *when* to re-evaluate stays where it already lives, in the hook's server-snapshot handler, and is driven by `structuralSeq`. Keeping that in one place matters: the runtime should not have an opinion about evaluation scheduling, and the hook should not have an opinion about audio maths.

One interface detail is load-bearing enough to state: the runtime is handed a *lookup function* for the current trims, not a trims object. Passing the object would capture whatever the trims were at evaluation time, the wrapper would close over that snapshot, and every fader would appear dead until the next re-evaluation. The whole live path depends on the wrapper asking for the value at query time rather than remembering it.

The hook must also refresh that live source before it decides anything about evaluation, exactly as it already assigns `mixRef` before the evaluation branch today, and `appliedMixSeqRef` becomes an applied-structural-sequence ref.

**`src/components/`** splits today's `mixer-panel.tsx` into the panel (list, selection state), `channel-row.tsx` (row and fader) and `channel-strip.tsx` (knobs, reset, note).

## Failure modes

- **A value the server dislikes** is clamped into range, never rejected. A slider cannot produce a state the mixer refuses.
- **A layer that disappears** takes its trims with it on the next successful evaluation, so no trim can silence or muffle something invisible.
- **A drag that outruns the audio** cannot: the browser holds the dragged value locally so the thumb never fights its own SSE echo, and posts on a throttle, meaning the first move goes out immediately and further moves go out no more than every 80 ms, with a final post when the drag ends. Note this is deliberately *not* what the master fader does today: that one clears and restarts an 80 ms timer on every change, which is a trailing debounce and sends nothing at all while the pointer keeps moving. Copying it would make the per-layer faders update only after you stop, which is the opposite of rideable.
- **A trim on a layer that is muted or silenced by someone else's solo** is stored and shown, and simply has nothing to act on until the layer is audible again.
- **A neutral trim** passes every event through unchanged, so the feature cannot alter a track nobody has touched. The wrapper is still there, as it must be for the next fader move to be heard without a re-evaluation.

## Verification

The trim maths are pure and exhaustively testable, and Node imports the TypeScript directly, so `scripts/selftest.mjs` covers them in `pnpm test`:

- neutral values return the same value object and the same pattern, and a layer at neutral queries to events identical in timing and values to the untrimmed original
- a filtered layer and a bare layer both respond to `tone` in both directions
- the clamps hold at full travel: darkening never lands above the written cutoff, never below `min(base, 120)`, and the highpass never crosses `base / 4`
- a layer written below the floor is left alone rather than brightened, which is the discontinuity this maths was rewritten to remove
- `space` clamps at dry and at fully wet
- swing and feel compose in the fixed order, and a trimmed layer stacked with an untrimmed one leaves the second alone
- swing preserves the event count exactly, on a pad, on quarter notes, on eighths and on sixteenths. This is the regression test that matters most, because the obvious primitive for the job silently multiplies events instead

The protocol rules are where a subtle regression would hide, so they get tests of their own: a value-only change must not call `evaluate`, a structural change must, a no-op patch must move neither counter, and a value update arriving while a structural evaluation is queued must not displace it.

The API round trip goes into `pnpm smoke`: patch a trim, read it back from `/api/status`, combine a trim with a mute in one request and confirm a single emission, reset it, confirm the record is gone.

Neither of those proves it sounds right, so the last check is by ear: push a multi-layer track, pull one layer down, and confirm with `pnpm listen` that the measured loudness moved in the direction the fader claims. A control that reports a change it did not make is the specific failure this project is built to avoid.

## Out of scope

The palette of ready-made parts to drop onto a layer is a separate piece of work with its own spec. This one deliberately stops at shaping what the agent wrote.

Baking a trimmed mix back into the code stays an agent action through the existing endpoints rather than a button. The server exposes the values; folding them into the track is composing, and that is the agent's job.
