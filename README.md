# moltek

**A live coding music studio that hears itself.**

Write patterns in [Strudel](https://strudel.cc), push them from whatever coding
agent you use, and the studio records its own output, reads back the mix, and
tells the agent what's actually wrong with it.

![the studio](docs/img/studio.png)

Most agent-driven music setups can tell you the code ran. This one can tell you
the bass is muddy, the pad is ducking the kick instead of the other way round,
and that the chord you wrote voices to silence.

## Why it's different

**It refuses to lie about whether the code worked.** Pushing waits for the
browser to evaluate and reports the verdict, so `OK: playing` means the pattern
is running, not that a request was accepted.

**It catches faults that make no noise.** Some failures raise no error and still
ruin a track. Strudel's `.voicing()` speaks jazz shorthand, so a
plausible-looking `Cmaj7` is not in its dictionary and voices to silence.
`.duckorbit(n)` ducks orbit `n` rather than the layer carrying it, so a pad
written for a sidechain punches the kick instead. Code like that pushes cleanly,
plays without complaint, and measures fine. `check.mjs` evaluates a track
headlessly and inspects the events it would actually produce:

```
FAIL my-track.js  (2056 events/64cy · 120 BPM · 6 layers)
     ERROR [silent-chord] chord "Fmaj7" is not in Strudel's dictionary - it voices to SILENCE
           -> use "F^7" or "FM7"
     ERROR [duck-self] "gm_epiano1" ducks orbit 1, which is its own bus (298 events)
           -> duckorbit ducks the TARGET orbit. Put .duckorbit(N) on the kick
```

It also flags default-gain bass, low-mid pile-ups, missing sample packs, and
sections that repeat bit-for-bit. `pnpm push` runs it first and refuses on errors.

**It has ears.** Pushing code only proves it ran. The analysis scripts record a
clip of the live output and read back loudness, dynamics, frequency balance,
stereo width, clipping and an energy arc, plus the musical content: measured
tempo with onset density, and the key the sounding notes belong to. State your
intent and let the measurement disagree with you.

```bash
node scripts/listen.mjs 12                                    # record 12s of what's playing
node scripts/analyze.mjs tape.wav --expect-bpm 124 --expect-key "F minor"
```

**It hears you too.** Every layer gets a fader, solo, mute and four feel knobs,
and a note box that sends free text straight to the agent, stamped with the layer,
the revision and the section playing at that moment. So it gets "the bass in the
drop is too muddy" instead of guessing.

<img src="docs/img/mixer.png" alt="the layer mixer" width="384">

Every control is a **trim on top of what the code says**, so centre always means
as-written and nothing silently rewrites your patterns. Volume, tone and space
apply live. The two timing controls rebuild the pattern, so they re-evaluate when
you let go rather than under your finger.

## Any agent, not one

The studio is driven entirely over a REST API, so anything that can make an HTTP
request can run it: a coding agent, a shell script, a keybinding, your own tooling.
There is nothing harness-specific in the app.

Claude Code skills ship in `.claude/` as the worked example, because that is what
this was built against. They teach an agent the Strudel syntax, the transport, the
feel rules and how to read the analysis output. Port them to whatever you use, or
just point your agent at the API table below and the `scripts/` directory.

## Quick start

You need Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev          # studio at http://localhost:3000
```

Then drive it. From a shell:

```bash
node scripts/push.mjs my-track.js --play    # checks, pushes, waits for the verdict
node scripts/listen.mjs 12                  # records it and reads back the mix
```

Or from an agent session, if you're using the bundled Claude Code skills:

```
"Teach me Strudel"           -> /tutorial
"Play me a techno set"       -> /dj-set
"Compose a synthwave track"  -> /compose
"Let's make music together"  -> /interactive
```

`Cmd+Enter` evaluates, `Cmd+.` stops.

## Themes

Eight of them, in the bottom bar. Here's the resident in each one. He's part of
the theme rather than a picture sitting on top of it, so he recolours with the
chrome, the meters, the room and the editor in the same repaint.

| | | | |
|:-:|:-:|:-:|:-:|
| ![ember](docs/img/theme-ember.png) | ![concrete](docs/img/theme-concrete.png) | ![sodium](docs/img/theme-sodium.png) | ![steel](docs/img/theme-steel.png) |
| `ember` | `concrete` | `sodium` | `steel` |
| ![hazard](docs/img/theme-hazard.png) | ![uv](docs/img/theme-uv.png) | ![oxblood](docs/img/theme-oxblood.png) | ![bone](docs/img/theme-bone.png) |
| `hazard` | `uv` | `oxblood` | `bone` |

<img src="docs/img/picker.png" alt="the theme picker" width="640">

Palettes live in one place, `src/lib/themes.json`, which is the only file in the
repo that writes a colour down. `pnpm themes` measures every pair that matters
against WCAG thresholds and then generates the CSS from it. A theme that can't be
read doesn't get built:

```
PASS  concrete  (dark)
      fg / bg                14.59 : 1   min 4.50    ok
      body / bg               6.15 : 1   min 3.00    ok
      gear / bg              14.74 : 1   min 3.00    ok
      destructive vs accent  0.436 dE    min 0.10    ok
```

That last one is a perceptual distance rather than a contrast ratio, because the
question it answers is whether an armed take can be mistaken for ordinary
playback, and a red and a green of equal lightness score near 1.0 while being
obvious at a glance. `pnpm build` runs the gate first, so adding a ninth theme
means proving it's legible before it can ship.

## The studio

Code stays front and centre, because that's the instrument. A rack down the right
holds the layer mixer over the tape deck; the chrome sits in a flat strip along the
bottom. The rack's width and the mixer/tapes split both drag.

Tracks are written as named layers, which is what makes the mixer possible:

```javascript
layers({ kick, bass, rhodes, pad })
```

The mascot is his own window, draggable and resizable, and he moves to whatever is
actually playing: the meter reads the master level, the lamps flash on the kick,
the legs absorb the landing.

Server state and revision history persist to `.moltek/state.json`, so a restart
doesn't lose the working track. Playback never auto-resumes, deliberately.

## Recording

Hit play, then the red record button. It pulses and shows duration; click again to
stop and a review row appears so you can listen before keeping or discarding.
Keeping downloads the WAV through your browser.

An agent can record too, over `/api/record/start` and `/api/record/stop`, and those
takes are saved server-side into `recordings/` where the analysis scripts and
`/api/recordings` can reach them. So takes you start by hand come to you as a
download; takes the agent starts land in the project. If playback stops
mid-recording the take finishes rather than capturing silence.

## Scripts

| Command | What it does |
|---|---|
| `pnpm check <file>` | Evaluate headlessly, report silent chords, bad routing, mix problems |
| `pnpm push <file> [--play]` | Check, then push; `--play` waits for the eval verdict |
| `pnpm listen [secs]` | Record the live output and print a producer-grade analysis |
| `pnpm analyze [file]` | Analyse a WAV, newest recording if omitted |
| `pnpm themes [--html]` | Gate every theme's contrast and regenerate the CSS |
| `pnpm share [file]` | Print a strudel.cc share link |
| `pnpm smoke` | API smoke test against the running server |
| `pnpm validate:tracks` | Check every saved track's structure, tempo, duration, content |

## API

Real-time sync over Server-Sent Events, so the browser updates the moment code is
pushed, and reports back, so the caller knows whether a push actually evaluated or
threw.

| Endpoint | Method | Description |
|---|---|---|
| `/api/code` | `GET` | Current code and revision. Browser edits sync back automatically, on a short poll |
| `/api/code` | `POST` | Push code `{ code, play? }`, atomic push-and-play |
| `/api/play` | `POST` | Start playback. Repeat POSTs force re-evaluation |
| `/api/stop` | `POST` | Stop playback |
| `/api/status` | `GET` | Full state: eval results, connected clients, audio readiness, recording |
| `/api/gain` | `POST` | Master volume with ramp `{ level, rampMs }` |
| `/api/nowplaying` | `POST` | Now-playing metadata `{ title, artist, section }` |
| `/api/history` | `GET`/`POST` | List pushed revisions, restore one. Survives restarts |
| `/api/record/start` | `POST` | Start recording in the browser |
| `/api/record/stop` | `POST` | Stop recording; the WAV lands in `recordings/` |
| `/api/recordings` | `GET` | List saved recordings; `/api/recordings/<name>` streams one |
| `/api/mix` | `GET`/`POST` | Per-layer solo/mute `{ muted, soloed }` and trims `{ trim: { layer: "bass", volume: 0.5 } }` |
| `/api/notes` | `GET`/`POST`/`DELETE` | Listener feedback, optionally aimed at a layer |
| `/api/events` | `GET` | SSE stream |

Prefer the script over hand-rolled curl: it handles escaping and waits for the
verdict.

## Samples

Drop WAV or MP3 files into `public/samples/` and register them with
`samples({ name: '/samples/file.wav' })`. Real instruments, field recordings, your
own hits. See `public/samples/README.md`.

Verified external packs, including a lofi drum crate with hundreds of one-shots,
classic breaks, sax, sitar, guitar, voices and textures, are catalogued for the
agent in the `/strudel` skill.

## Voice

The bundled skills speak over macOS `say`, which is macOS only. The stock voices
are rough and the Siri voices are much better: System Settings, Accessibility,
Spoken Content, then the info button beside System Voice, search "Siri", download
one and set it as the system voice.

## Built on

Next.js, Tailwind, and [Strudel](https://github.com/tidalcycles/strudel)
(`@strudel/repl` bundled locally with a pinned CDN fallback). Worth reading:
[Strudel docs](https://strudel.cc/learn) and [TidalCycles](https://tidalcycles.org).

## Credits and license

moltek continues development of
[strudel-claude](https://github.com/renatoworks/strudel-claude), created by Renato
Costa under the MIT License.

Licensed **AGPL-3.0-or-later**. Strudel is AGPL and moltek bundles it, so the
combined work carries the same terms: build on this freely, but if you ship it,
including as a hosted service, publish your source too. Full text in `LICENSE`,
attribution and notices in `NOTICE`.

The mascot is derived from the character Anthropic uses for Claude Code. The
character design is theirs. This project is not affiliated with, sponsored by, or
endorsed by Anthropic, and Claude and Claude Code are their trademarks, referred
to here only to describe one of the agents that can drive this.
