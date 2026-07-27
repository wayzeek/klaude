# moltek

**An AI music studio.** Ask for a track, and the agent writes it, plays it, listens
back to what came out, and mixes it. You sit at the desk and tell it what you want
changed.

![the studio](docs/img/studio.png)

The music itself is [Strudel](https://strudel.cc), so a track is real code you can
read and change yourself whenever you want. Around that, moltek is the studio: a
mixer channel for every part, recording, version history, and the tools that let
the agent judge its own work instead of guessing.

## Run it

You need Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`, then open your coding agent in the same folder and
ask it for something:

```
"play me a slow melodic techno track"
"make the bass darker and give it more room"
"record the last two minutes"
```

Claude Code skills ship in `.claude/`, so with Claude Code it works straight away.
Anything else drives the studio over HTTP, which is one command:

```bash
node scripts/push.mjs my-track.js --play
```

## How it knows what it made

An agent writing music is working blind. It can produce something that parses
perfectly and makes no sound, or a mix where the bass buries everything, and it has
no way to tell. These are the four things moltek does about that.

### It tells you whether the code actually ran

Pushing waits for the browser to evaluate the code and reports what happened, so a
success message means the pattern is running, not that a request was accepted. If
the code threw, you get the error. If no browser tab is open, you get told that
instead of silence.

### It catches mistakes that make no sound

Some Strudel mistakes produce no error and no audio. A chord name that isn't in
Strudel's dictionary plays nothing. `.duckorbit(n)` turns down the bus you name,
not the layer you attached it to, so a pad meant to duck under the kick can end up
ducking the kick instead. Code like this pushes cleanly and plays without
complaint.

So before pushing, the track is evaluated without audio and the notes it would
produce are inspected:

```
FAIL my-track.js  (2056 events/64cy · 120 BPM · 6 layers)
     ERROR [silent-chord] chord "Fmaj7" is not in Strudel's dictionary - it voices to SILENCE
           -> use "F^7" or "FM7"
     ERROR [duck-self] "gm_epiano1" ducks orbit 1, which is its own bus (298 events)
           -> duckorbit ducks the TARGET orbit. Put .duckorbit(N) on the kick
```

It also warns about a bass loud enough to bury everything, several parts crowded
into the same register, missing sample packs, and sections that repeat note for
note. `pnpm push` runs this first and refuses to push if anything is an error.

### It listens back

Running is not the same as sounding good, so the studio can record a few seconds of
its own output and measure it: loudness, dynamics, how the frequencies are balanced,
stereo width, clipping, and how the energy moves over time. It also measures the
tempo and works out what key the notes belong to, which is useful mostly because it
can then disagree with you:

```bash
node scripts/listen.mjs 12                                    # record 12s of what is playing
node scripts/analyze.mjs tape.wav --expect-bpm 124 --expect-key "F minor"
```

### It lets you say what you think

Every part in the mixer has a fader, solo, mute, four feel controls, and a box you
can type into.

<img src="docs/img/mixer.png" alt="the mixer" width="384">

Typing "the bass is too muddy here" sends that to the agent along with which part
you aimed it at, which version of the code was playing, and where in the track you
were. So it gets a specific complaint about a specific bar instead of a guess.

The controls are adjustments layered on top of the code, never edits to it. Centre
always means "as written", so nothing you do here quietly rewrites your track.
Volume, tone and space take effect immediately; the two timing controls have to
rebuild the pattern, so they wait until you let go of the slider.

## Taking over

Nothing is hidden. What the agent writes is ordinary Strudel sitting in the editor,
and you can change it whenever you like. `Cmd+Enter` re-runs it, `Cmd+.` stops.

A track is a set of named parts:

```js
setcpm(124 / 4)

const kick = s("bd*4").bank("RolandTR909")
const bass = note("<c2 ab1 bb1>").s("sawtooth").lpf(600)

$: layers({ kick, bass })
```

Those names are what produce the channels in the mixer. If you already know
Strudel, everything you know still works, and `layers()` is the only thing moltek
asks you to add.

## Themes

Eight of them, in the bottom bar.

| | | | |
|:-:|:-:|:-:|:-:|
| ![ember](docs/img/theme-ember.png) | ![concrete](docs/img/theme-concrete.png) | ![sodium](docs/img/theme-sodium.png) | ![steel](docs/img/theme-steel.png) |
| `ember` | `concrete` | `sodium` | `steel` |
| ![hazard](docs/img/theme-hazard.png) | ![uv](docs/img/theme-uv.png) | ![oxblood](docs/img/theme-oxblood.png) | ![bone](docs/img/theme-bone.png) |
| `hazard` | `uv` | `oxblood` | `bone` |

The mascot belongs to the theme rather than sitting on top of it, so he changes
colour along with the editor, the meters and everything else.

<img src="docs/img/picker.png" alt="the theme picker" width="640">

Every palette lives in `src/lib/themes.json`. Running `pnpm themes` checks that
each one is actually readable, using the same contrast rules as accessibility
guidelines, and then generates the CSS from it. A theme with unreadable text or a
mascot that disappears into the background fails the check and the build stops, so
adding a ninth theme means proving it works before it can ship.

## Recording

Press play, then the round record button. Press it again to stop and you get a row
you can listen to before deciding whether to keep it. Keeping it downloads a WAV.

An agent records through `/api/record/start` and `/api/record/stop` instead, and
those takes are saved into `recordings/` where the analysis scripts can reach them.
So takes you start yourself come to you as a download, and takes the agent starts
stay in the project. If playback stops partway through, the recording ends there
rather than filling up with silence.

## Your own samples

Drop WAV or MP3 files into `public/samples/` and name them in your patterns:

```js
samples({ clap: '/samples/my-clap.wav' })
```

See `public/samples/README.md`. A set of external packs is also catalogued for the
agent in the `/strudel` skill: a large lofi drum collection, classic breaks, sax,
sitar, guitar, voices and textures.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Start the studio |
| `pnpm check <file>` | Evaluate a track without audio and report problems |
| `pnpm push <file> [--play]` | Check, then push; `--play` waits for the result |
| `pnpm listen [secs]` | Record what is playing and analyse it |
| `pnpm analyze [file]` | Analyse a WAV, or the newest recording |
| `pnpm themes` | Check every theme's contrast and regenerate the CSS |
| `pnpm share [file]` | Print a strudel.cc link for a track |
| `pnpm smoke` | Check the API against a running studio |
| `pnpm validate:tracks` | Check every saved track in `tracks/` |

## API

The browser and the server stay in sync over Server-Sent Events, so a push shows up
immediately, and the browser reports back what happened when it ran.

| Endpoint | Method | Description |
|---|---|---|
| `/api/code` | `GET` | The current code and its version number |
| `/api/code` | `POST` | Replace the code: `{ code, play? }` |
| `/api/play` | `POST` | Start playing. Posting again re-runs the code |
| `/api/stop` | `POST` | Stop |
| `/api/status` | `GET` | Everything: last result, connected tabs, whether audio is unlocked, recording state |
| `/api/gain` | `POST` | Master volume, optionally faded: `{ level, rampMs }` |
| `/api/nowplaying` | `POST` | Set the title and section shown in the bottom bar |
| `/api/history` | `GET`/`POST` | List previous versions, or go back to one |
| `/api/record/start` | `POST` | Start recording |
| `/api/record/stop` | `POST` | Stop recording and save the WAV to `recordings/` |
| `/api/recordings` | `GET` | List recordings; `/api/recordings/<name>` plays one |
| `/api/mix` | `GET`/`POST` | Mute, solo and per-part adjustments |
| `/api/notes` | `GET`/`POST`/`DELETE` | The feedback typed in the mixer |
| `/api/events` | `GET` | The event stream |

Use `scripts/push.mjs` rather than curl where you can: it handles quoting and waits
for the result.

## Voice

The bundled skills can speak through the macOS `say` command, so that part is macOS
only. The built-in voices are rough; the Siri voices are much better. System
Settings, Accessibility, Spoken Content, then the info button next to System Voice,
search for Siri, download one and set it as the system voice.

## Built with

Next.js, Tailwind, and [Strudel](https://github.com/tidalcycles/strudel), bundled
locally with a pinned CDN fallback. If you want to learn the music side, the
[Strudel docs](https://strudel.cc/learn) are good, and
[TidalCycles](https://tidalcycles.org) is where the ideas come from.

## Credits and licence

moltek continues [strudel-claude](https://github.com/renatoworks/strudel-claude) by
Renato Costa, which was MIT licensed.

moltek is licensed **AGPL-3.0-or-later**, because Strudel is AGPL and moltek bundles
it. In practice: use it, change it, build on it. If you distribute it or run it as a
service for other people, publish your source too. Full text in `LICENSE`, notices
in `NOTICE`.

The mascot is based on the character Anthropic uses for Claude Code, and that
character design is theirs. This project is not affiliated with or endorsed by
Anthropic. Claude and Claude Code are their trademarks, mentioned here only to say
which agent the bundled skills are written for.
