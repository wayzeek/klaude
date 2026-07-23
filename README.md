# klaude

![klaude](public/strudel-claude.png)

**Your AI resident DJ.** Play, learn, and perform [Strudel](https://strudel.cc) with Claude Code.

A minimal, full-screen live coding environment for making music. **Built for AI** - exposes REST APIs so Claude can compose and control music programmatically.

> klaude continues development of [strudel-claude](https://github.com/renatoworks/strudel-claude), originally created by Renato Costa (MIT).

## What is Strudel?

Strudel is a JavaScript port of Tidal Cycles for algorithmic music composition. Write code, make music, in real-time.

```javascript
// Drums
$: s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")

// Bass
$: note("<c2 eb2 f2 g2>").s("sawtooth").lpf(400)
```

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js and [pnpm](https://pnpm.io)

## Quick Start

**1. Start the server**
```bash
pnpm install
pnpm dev
```

**2. Open Claude Code in the project folder**
```bash
claude
```

**3. Ask for any skill**
```
"Teach me Strudel"          → /tutorial
"Play me a techno set"      → /dj-set
"Compose a synthwave track" → /compose
"Let's make music together" → /interactive
```

See [Skills for Claude Code](#skills-for-claude-code) for more examples.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Play / evaluate code |
| `Cmd+.` | Stop |

## The Console

The code stays front and center (it's live coding), with a small performance
console around it:

- **Now-playing HUD** (top left) - title, artist, current section, elapsed time, and the trail of sections the set has moved through
- **Level meter** - a master VU bar; if it stops breathing, sound died
- **Tape shelf** - saved recordings, playable right in the app
- **Volume slider** - master gain with smooth ramps, synced with `/api/gain`
- **Reaction bar** (bottom right) - 🔥 this hits · ❤️ love it · 💤 losing me. Each tap is tagged with what was playing, so the agent reads the room mid-set

## Recording Audio

Capture your Strudel output to WAV:

1. **Start playback** - Hit play or `Cmd+Enter`
2. **Click the red record button** - It pulses and shows duration
3. **Click again to stop** - A preview toast appears
4. **Listen, then Download or Discard**

Recording can also be driven by the agent over the API (`/api/record/start`, `/api/record/stop`) - those bounces are saved into `recordings/`. If playback stops mid-recording, the recording finishes instead of capturing silence.

## API for Agents

The REST API allows AI agents to read and write Strudel code, enabling autonomous music composition. **Real-time sync** via Server-Sent Events means the browser updates instantly when you push code or trigger playback - and the browser reports back, so agents know whether a push actually evaluated or threw.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/code` | `GET` | Current code and revision (browser edits sync back, so this never lies) |
| `/api/code` | `POST` | Push code `{ "code": "...", "play": true? }` - atomic push-and-play |
| `/api/play` | `POST` | Start playback (repeat POSTs force a re-evaluation) |
| `/api/stop` | `POST` | Stop playback |
| `/api/status` | `GET` | Full state: eval results, connected clients, audio readiness, recording |
| `/api/gain` | `POST` | Master volume with ramp `{ "level": 0..1, "rampMs": 4000 }` - fades |
| `/api/nowplaying` | `POST` | Now-playing HUD `{ "title", "artist", "section" }` |
| `/api/history` | `GET`/`POST` | List pushed revisions / restore one (undo, survives restarts) |
| `/api/record/start` | `POST` | Start recording in the browser |
| `/api/record/stop` | `POST` | Stop recording; the WAV is saved to `recordings/` |
| `/api/recordings` | `GET` | List saved recordings; `/api/recordings/<name>` streams one |
| `/api/reactions` | `GET`/`POST`/`DELETE` | Listener reactions (🔥/❤️/💤) tagged with what was playing |
| `/api/events` | `GET` | SSE stream for real-time updates |

### Example: AI Composing Music

```bash
# Push a code file and play it - no shell escaping, reports the eval verdict
node scripts/push.mjs my-track.js --play
```

The push script waits for the browser to evaluate the code and prints `OK: playing`, the evaluation error, or a warning that no browser tab is connected. Raw curl works too:

```bash
curl -X POST http://localhost:3000/api/code \
  -H "Content-Type: application/json" \
  -d '{"code": "$: s(\"bd*4, cp*2\").bank(\"RolandTR909\")", "play": true}'
```

### The Agent Has Ears

Pushing code only proves it ran - not that it sounds good. The analysis
scripts close that gap: the agent records a short clip of the live output and
reads back loudness, dynamics, frequency balance, stereo width, clipping, and
an energy arc, then fixes the mix like a producer would.

```bash
node scripts/listen.mjs 12        # record 12s of what's playing and analyze it
node scripts/analyze.mjs tape.wav # analyze any saved recording
```

### Reading the Room

The browser shows a reaction bar (🔥 this hits · ❤️ love it · 💤 losing me).
Each tap is stored with the revision and set section playing at that moment,
so the agent can steer a live set by actual listener feedback instead of
guessing.

### Scripts

| Command | What it does |
|---------|--------------|
| `pnpm push <file> [--play]` | Push a code file; `--play` waits for the eval verdict |
| `node scripts/listen.mjs [secs]` | Record the live output and print a producer-grade analysis |
| `node scripts/analyze.mjs [file]` | Analyze a WAV (newest recording if omitted) |
| `pnpm share [file]` | Print a strudel.cc share link for a file or the current code |
| `pnpm smoke` | API smoke test against the running server |
| `pnpm validate:tracks` | Check every saved track's structure, tempo, and duration |

## Local Samples

Drop WAV/MP3 files into `public/samples/` and register them in your patterns with `samples({ name: '/samples/file.wav' })` - real instruments, field recordings, your own hits. See `public/samples/README.md`.

Verified external packs (a lofi drum crate with hundreds of real one-shots, classic drum breaks, sax/sitar/guitar, voices and textures) are cataloged for the agent in the `/strudel` skill.

## Project Structure

```
src/
├── app/
│   ├── api/                # REST API for agents
│   │   ├── code/           # GET/POST code (revisioned)
│   │   ├── eval/           # Browser reports eval results
│   │   ├── clients/        # Browser reports readiness
│   │   ├── events/         # SSE stream
│   │   ├── gain/           # Master volume ramps
│   │   ├── history/        # Revision history + restore
│   │   ├── nowplaying/     # HUD metadata
│   │   ├── play|stop/      # Playback control
│   │   ├── record/         # Remote recording control
│   │   ├── recordings/     # WAV upload + listing
│   │   ├── status/         # Full state for agents
│   │   ├── guard.ts        # Same-origin check for mutating routes
│   │   └── state.ts        # Shared state + event emitter + persistence
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Home page
│   └── globals.css         # Styles + CodeMirror theme
├── components/
│   ├── strudel-editor.tsx  # Main editor + HUD + overlays + volume
│   ├── level-meter.tsx     # Master VU bar (passive analyser tap)
│   ├── reaction-bar.tsx    # 🔥/❤️/💤 listener feedback
│   └── tape-shelf.tsx      # In-app playback of saved recordings
├── hooks/
│   ├── use-strudel.ts      # Strudel lifecycle + revision sync protocol
│   └── use-audio-recorder.ts # Audio recording to WAV
└── lib/
    ├── constants.ts        # Shared constants
    └── wav-encoder.ts      # Pure JS WAV encoder
scripts/                    # push / listen / analyze / share / smoke / validate-tracks
public/samples/             # Your local samples, served to Strudel
```

Server code and revision history persist to `.klaude/state.json`, so a restart doesn't lose the working track (playback intentionally never auto-resumes).

## Tech Stack

- Next.js
- Tailwind CSS
- Strudel REPL (`@strudel/repl` bundled locally, pinned CDN fallback)

## Voice Feedback (macOS only)

The AI agent uses the `say` command for voice feedback. This only works on macOS.

By default, macOS uses basic voices like Daniel or Samantha, but you can enable much better **Siri voices** that sound way more natural:

### Enable Siri Voices

1. Open **System Settings** → **Accessibility** → **Spoken Content**
   *(or press `Cmd+Space` and search "Spoken Content")*
2. Click the **ⓘ** (info icon) next to **System Voice**
3. In the voice dropdown, search for **"Siri"**
4. Download a Siri voice you like
5. **Set it as your System Voice** - this way all `say` commands use it automatically

Test it in Terminal:

```bash
say "Let's make some music"
```

## Skills for Claude Code

This REPL includes skills that teach Claude how to make music. Claude auto-invokes `/strudel` and `/api` whenever it makes music - the syntax and the REPL controls are always at hand.

**Try these:**

### `/tutorial` - Learn Strudel & Music Theory

```
"Teach me Strudel from the beginning"
"Explain how filters work"
"Show me how to make chord progressions"
"Teach me music theory basics"
"What's the difference between major and minor scales?"
```

### `/dj-set` - Live DJ Sets

```
"Play me a 5-minute live techno set"
"Create a deep house journey"
"Do a chill ambient set with voice narration"
"Play an indefinite acid house set until I stop you"
```

### `/compose` - Full Track Compositions

```
"Compose a 3-minute synthwave track"
"Create a full UK garage song"
"Make a lo-fi hip hop beat"
```

### `/interactive` - Guided Music Creation

```
"Let's make music together"
"Help me create a beat"
"Guide me through making a song"
```

### Other Skills

- `/tracks` - Save compositions to `tracks/` and replay them later ("play acid bloom again")
- `/theory` - Music theory: scales, progressions, borrowed chords, song arcs
- `/humanize` - Feel rules: swing, ghost notes, fills, drift, width, gain staging (auto-invoked for music)
- `/visuals` - Add visualizations (pianoroll, spiral, oscilloscope)
- `/strudel` - Syntax reference (auto-invoked)
- `/api` - REPL control + ears (auto-invoked)

## Learn More

- [Strudel Docs](https://strudel.cc/learn)
- [Strudel GitHub](https://github.com/tidalcycles/strudel)
- [Tidal Cycles](https://tidalcycles.org)

## License

MIT - Free to use, copy, modify, and distribute.
