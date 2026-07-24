---
name: api
description: Control the Strudel REPL via REST APIs. Use when you need to push code, start/stop playback, check status, fade volume, update the now-playing HUD, record audio, or restore history.
allowed-tools: Bash(curl *), Bash(node scripts/*), Bash(pnpm push*), Write
---

# Strudel API

Talk to the REPL at `http://localhost:3000`.

---

## Pushing Code - use the push script

Write the code to a file, then push it. No JSON escaping, no quoting bugs:

```bash
node scripts/push.mjs /tmp/track.js --play
```

- `--play` starts playback AND waits for the browser's eval verdict:
  - `OK: playing` - the code ran, you're done
  - `FAIL: evaluation error: ...` - fix the code and push again
  - `WARN: no browser tab connected` - ask the user to open http://localhost:3000
- Without `--play` it just updates the editor.
- Reading from stdin works too: `node scripts/push.mjs - --play`

**The feedback loop is the point.** Never assume a push worked - the script's
exit code and message tell you. If you use raw curl instead, you MUST check
`/api/status` → `lastEval` yourself after pushing.

---

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
stopping playback. A new revision clears solo and keeps mutes.

**Solo a layer and listen to it in isolation - your closest ear to the mix:**

```bash
curl -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"soloed": ["bass"]}'
node scripts/listen.mjs 8
curl -X POST http://localhost:3000/api/mix -H "Content-Type: application/json" -d '{"soloed": []}'
```

---

## Listening - your ears

`OK: playing` means the code ran, not that it sounds good. To actually hear
the mix, record a short clip and read the analysis:

```bash
node scripts/listen.mjs 12          # record 12s of what's playing, analyze, clean up
node scripts/listen.mjs 12 --keep   # same, but keep the WAV in recordings/
node scripts/analyze.mjs <file.wav> # analyze an existing recording (newest if omitted)
```

The report gives loudness (RMS/peak/dynamic range), stereo width, clipping,
band balance, spectral TILT (dB/Hz per band - the honest brightness measure),
a loudness ARC over time, and NOTES flagging producer-level problems (mud,
missing highs, hollow mids, flat dynamics, mono mixes).

**How to use it well:**
- Listen after establishing a groove, not after every push - then fix what
  the notes flag (no highs → add hats/open filters; clipping → lower gains;
  mono → pan/jux; flat dynamics → more contrast between sections).
- A clip taken right after a pattern swap can contain the previous pattern's
  decaying tail. If a reading looks impossible, listen again before acting.
- TILT beats BALANCE for judging brightness: high-mid below about -30 dB/Hz
  reads as dull; a healthy bright groove sits around -10 to -25.
- During a recorded set, `listen.mjs` is unavailable (one recording at a
  time) - do a sound check BEFORE starting the tape.

---

## Endpoints

| Endpoint | Method | What it does |
|----------|--------|--------------|
| `/api/code` | POST | Push code `{"code": "...", "play": true?}` - `play:true` = atomic push-and-play |
| `/api/code` | GET | Current code + revision (this is what the browser truly shows - local edits sync back) |
| `/api/play` | POST | Play. Repeat POSTs force re-evaluation (bumps `playEpoch`) |
| `/api/stop` | POST | Stop. Also clears the now-playing HUD |
| `/api/status` | GET | Full state - see field guide below |
| `/api/gain` | POST | Master volume `{"level": 0..1, "rampMs": 4000?}` - smooth fades |
| `/api/nowplaying` | POST/DELETE | HUD metadata `{"title", "artist", "section"}` - partial updates OK |
| `/api/history` | GET/POST | List revisions / restore one: `{"revision": N}` |
| `/api/record/start` | POST | Start recording in the browser |
| `/api/record/stop` | POST | Stop; the WAV lands in `recordings/` |
| `/api/recordings` | GET | List saved WAVs (`/api/recordings/<name>` streams one) |
| `/api/mix` | GET/POST | Per-layer solo/mute: `{"muted": [...], "soloed": [...]}` - full replacement per key |
| `/api/notes` | GET/POST/DELETE | Listener feedback: free text, optionally aimed at a layer |
| `/api/events` | GET | SSE stream (browsers use this; you don't need it) |

---

## Status Field Guide

```
desiredPlaying   what was requested        ─ these two disagreeing means
actualPlaying    what the browser reports  ─ something needs attention
lastEval         {revision, ok, error, fresh} - fresh:true means it refers to
                 the CURRENT revision; fresh + ok:false = your push is broken
browserConnected false = nothing can play; ask the user to open localhost:3000
audioReady       false = tab open but audio locked; an overlay in the tab
                 asks the user for one click - sound starts after that
recording        {phase: idle|starting|recording|stopping|done|error, file?}
mix              {muted, soloed, seq} - live per-layer mixer state
layers           layer names reported by the last successful eval
recentNotes      listener feedback; each note has text, layer, revision, section
```

---

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
No notes ≠ boredom - silence is normal. React to signals, don't fish for them.

Mute state is feedback too: `/api/status` → `mix.muted` naming a layer for
two sections running means the listener has already made the call - write it
out of the arrangement.

Starting a fresh session? `curl -X DELETE http://localhost:3000/api/notes`
clears leftovers from earlier sessions.

---

## Fades (DJ transitions)

```bash
# Fade out over 4s, then swap tracks silently, then fade back in
curl -X POST http://localhost:3000/api/gain -H "Content-Type: application/json" -d '{"level": 0, "rampMs": 4000}'
# (wait ~4s, push new code with play, then:)
curl -X POST http://localhost:3000/api/gain -H "Content-Type: application/json" -d '{"level": 1, "rampMs": 2000}'
```

Always restore gain to 1 before ending a session.

---

## Now Playing HUD

Keep the listener oriented during sets - update on every track/section change:

```bash
curl -X POST http://localhost:3000/api/nowplaying -H "Content-Type: application/json" \
  -d '{"title": "Loveland Sunrise", "artist": "SOLOMUN", "section": "building"}'
```

Later, updating just the section keeps title/artist. `/api/stop` clears it.

---

## Recording a Bounce

```bash
curl -X POST http://localhost:3000/api/record/start     # needs audioReady:true
# ... let the track play ...
curl -X POST http://localhost:3000/api/record/stop
# poll /api/status until recording.phase is "done" - recording.file has the path
```

Stopping playback mid-recording finishes the bounce automatically.

---

## History (undo)

```bash
curl http://localhost:3000/api/history                   # list revisions
curl -X POST http://localhost:3000/api/history -H "Content-Type: application/json" -d '{"revision": 12}'
```

Restoring never overwrites history - it creates a new revision. Survives
server restarts. Use it when the user says "go back to how it was before".

---

## Raw curl JSON Escaping (fallback only)

Prefer the push script. If you must inline code in curl, the API uses
`JSON.parse()`: only `\"` `\\` `\n` `\t` `\r` `\/` are valid escapes.
`\x`, `\s`, `\d` or any other backslash+letter **breaks the request** (400).
A literal backslash in code must be `\\`.

```bash
# ✅ GOOD
curl -X POST http://localhost:3000/api/code \
  -H "Content-Type: application/json" \
  -d '{"code": "$: s(\"bd sd hh hh\")", "play": true}'
```
