# moltek reference

The technical side. The [README](../README.md) covers what the studio is and what
it does; this is the part you need if you are driving it yourself, wiring up a
different assistant, or working on it.

## Writing a track

A track is a set of named parts and one call that plays them together:

```js
setcpm(124 / 4)

const kick = s("bd*4").bank("RolandTR909")
const bass = note("<c2 ab1 bb1>").s("sawtooth").lpf(600)

$: layers({ kick, bass })
```

The music is [Strudel](https://strudel.cc), so everything Strudel does works here.
Naming the parts through `layers()` is the only addition moltek asks for, and it is
what produces a channel per part in the mixer, so you or an agent can mute, solo and
trim them separately while the track keeps playing.

`Cmd+Enter` re-runs the editor, `Cmd+.` stops.

One quoting rule worth knowing, because it fails silently: Strudel's transpiler
turns **double-quoted** strings into patterns. `note("<c2 eb2>")` is a pattern;
`note('<c2 eb2>')` looks for a single note literally named `<c2 eb2>` and plays
nothing. Use double quotes for patterns and single quotes for plain strings such as
`samples('github:tidalcycles/dirt-samples')`, which throws if it is given a pattern.

## Driving it from an assistant

Everything happens over HTTP, so anything that can make a request can run the
studio. Claude Code skills ship in `.claude/` as a working example: they teach an
assistant the syntax, the endpoints, the feel rules, and how to read the analysis.
Port them to whatever you use, or point your assistant at this document.

The shortest path is one command:

```bash
node scripts/push.mjs my-track.js --play
```

That checks the track, pushes it, and waits for the browser to report back, so a
success message means the music is actually running rather than that a request was
accepted.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Start the studio on `localhost:3000` |
| `pnpm check <file>` | Evaluate a track in silence and report problems |
| `pnpm push <file> [--play]` | Check, then push; `--play` waits for the verdict |
| `pnpm listen [secs]` | Record what is playing and analyse it |
| `pnpm analyze [file]` | Analyse a WAV, or the newest recording |
| `pnpm themes` | Check every theme's contrast and regenerate the CSS |
| `pnpm share [file]` | Print a strudel.cc link for a track |
| `pnpm smoke` | Check the API against a running studio |
| `pnpm validate:tracks` | Check every saved track in `tracks/` |
| `pnpm test` | Run the unit tests |
| `pnpm build` | Production build; runs the theme gate first |

## Checking a track

`check.mjs` evaluates a track without audio and inspects the notes it would
actually produce, which catches the failures that raise no error:

```
FAIL my-track.js  (2056 events/64cy · 120 BPM · 6 layers)
     ERROR [silent-chord] chord "Fmaj7" is not in Strudel's dictionary - it voices to SILENCE
           -> use "F^7" or "FM7"
     ERROR [duck-self] "gm_epiano1" ducks orbit 1, which is its own bus (298 events)
           -> duckorbit ducks the TARGET orbit. Put .duckorbit(N) on the kick
```

It also warns about a bass loud enough to bury the mids, several parts stacked in
the same register, missing sample packs, and sections that repeat note for note.
`pnpm push` runs it first and refuses to push on errors.

Known gap: the checker's evaluation path parses single-quoted strings as patterns
where the browser does not, so a track written with single quotes can pass the check
and still be silent in the studio. Use double quotes for patterns.

## Listening back

```bash
node scripts/listen.mjs 12                                    # record 12s of what is playing
node scripts/analyze.mjs tape.wav --expect-bpm 124 --expect-key "F minor"
```

The analysis reports loudness, dynamics, frequency balance, stereo width, clipping
and an energy arc, plus measured tempo with onset density and the key the sounding
notes belong to. Passing `--expect-bpm` and `--expect-key` lets the measurement
contradict your intent, which is the useful part.

## API

The browser and server stay in sync over Server-Sent Events, so a push appears
immediately and the browser reports what happened when it ran.

| Endpoint | Method | Description |
|---|---|---|
| `/api/code` | `GET` | Current code and its revision |
| `/api/code` | `POST` | Replace the code: `{ code, play? }` |
| `/api/play` | `POST` | Start playback. Posting again re-evaluates |
| `/api/stop` | `POST` | Stop |
| `/api/status` | `GET` | Everything: last eval, connected tabs, audio readiness, recording |
| `/api/gain` | `POST` | Master volume, optionally ramped: `{ level, rampMs }` |
| `/api/nowplaying` | `POST` | Title and section for the bottom bar |
| `/api/history` | `GET`/`POST` | List revisions, or restore one |
| `/api/record/start` | `POST` | Start recording |
| `/api/record/stop` | `POST` | Stop and save the WAV to `recordings/` |
| `/api/recordings` | `GET` | List recordings; `/api/recordings/<name>` streams one |
| `/api/mix` | `GET`/`POST` | Mute, solo and per-part trims |
| `/api/notes` | `GET`/`POST`/`DELETE` | Feedback typed in the mixer |
| `/api/events` | `GET` | The SSE stream |

Prefer `scripts/push.mjs` over curl where you can: it handles quoting and waits for
the verdict.

Recordings the agent starts are saved server-side into `recordings/`, where the
analysis scripts and `/api/recordings` can reach them. Recordings you start by hand
download through the browser instead.

State and revision history persist to `.moltek/state.json`, so a restart keeps the
working track. Playback never auto-resumes.

## Your own samples

Drop WAV or MP3 files into `public/samples/` and name them in a pattern:

```js
samples({ clap: '/samples/my-clap.wav' })
```

See `public/samples/README.md`. External packs are catalogued for the agent in the
`/strudel` skill: a large lofi drum collection, classic breaks, sax, sitar, guitar,
voices and textures.

## Themes

Every palette lives in `src/lib/themes.json`, which is the only file that writes a
colour down. `pnpm themes` measures each one against WCAG contrast thresholds and
generates the CSS from it, so a theme cannot drift from the values that were
verified. It also checks that every `var()` in the source resolves to a token the
palette defines, because an undefined custom property paints as unset rather than
raising anything.

Record is held perceptually distinct from the accent using OKLab distance rather
than contrast ratio, since a red and a green of equal lightness score near 1.0 while
being obvious at a glance.

`pnpm build` runs the gate first, so an unreadable theme stops the build.

## Voice

The bundled skills can speak through the macOS `say` command, so that part is macOS
only. The built-in voices are rough and the Siri voices are much better: System
Settings, Accessibility, Spoken Content, then the info button beside System Voice,
search for Siri, download one, and set it as the system voice.

## Built with

Next.js, Tailwind, and [Strudel](https://github.com/tidalcycles/strudel) bundled
locally with a pinned CDN fallback. For the music side, the
[Strudel docs](https://strudel.cc/learn) are good and
[TidalCycles](https://tidalcycles.org) is where the ideas come from.
