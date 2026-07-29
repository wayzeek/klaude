/**
 * Evaluate Strudel code in Node and inspect it without playing a note.
 *
 * Strudel patterns are pure functions of time: `pattern.queryArc(from, to)`
 * returns the events that *would* be scheduled over that span, with their
 * timing, sound, gain and pitch. That makes it possible to check what a track
 * actually contains before anyone hears it - which chord voicings produced
 * notes, how loud each layer sits, whether a section repeats verbatim.
 *
 * Nothing here starts audio. The web-audio side of Strudel is stubbed out; we
 * only need the pattern algebra.
 *
 * Usage:
 *   const strudel = await loadStrudel()
 *   const track = await strudel.evaluateTrack(code)
 *   track.layers.get('bass').queryArc(0, 4)
 */

import { register } from 'node:module'

// The resolve hook has to be installed before @strudel/core enters the module
// graph, so everything below is imported dynamically. Resolve the hook's URL
// directly rather than via its path - a pathname is percent-encoded, so a
// checkout under a directory with a space in it would not load.
register(new URL('strudel-resolver.mjs', import.meta.url).href)

/** Pattern methods that only draw things. Identity functions offline. */
const VISUAL_METHODS = [
  '_pianoroll',
  'pianoroll',
  '_punchcard',
  'punchcard',
  '_scope',
  'scope',
  '_spectrum',
  'spectrum',
  '_spiral',
  'spiral',
  '_pitchwheel',
  'pitchwheel',
  'markcss',
]

let cached = null

/**
 * The runtime from the most recent `loadStrudel()` call, or null if none has
 * resolved yet. Synchronous, unlike `loadStrudel` itself, for callers that
 * need `core.State`/`core.TimeSpan` to build a query by hand rather than
 * through `queryArc` - see `queryEvents` below for why `queryArc` cannot be
 * that path. Safe to call only after `loadStrudel()` has resolved at least
 * once in this process; `loadStrudel`'s own module-graph setup guarantees
 * exactly that for every caller downstream of it.
 */
export function cachedStrudel() {
  return cached
}

/**
 * Load and configure the Strudel runtime. Idempotent - the module graph and
 * the global eval scope are process-wide, so repeated calls share one setup.
 */
export async function loadStrudel() {
  if (cached) return cached

  // Strudel logs to console.log at import time ("🌀 @strudel/core loaded 🌀")
  // and warns about the missing browser globals. Neither is useful here.
  const quiet = suppressConsole()
  let core, mini, tonal, transpiler
  try {
    core = await import('@strudel/core')
    mini = await import('@strudel/mini')
    tonal = await import('@strudel/tonal')
    transpiler = await import('@strudel/transpiler')
    await core.evalScope(core, mini, tonal)
  } finally {
    quiet.restore()
  }

  // Drawing and colouring are no-ops offline; without them any track that
  // visualises itself fails to evaluate.
  for (const name of VISUAL_METHODS) {
    if (!core.Pattern.prototype[name]) {
      core.Pattern.prototype[name] = function () {
        return this
      }
    }
  }
  if (!core.Pattern.prototype.color) {
    core.Pattern.prototype.color = function () {
      return this
    }
  }

  installOutputProtocol(core)

  const chordDictionary = buildChordDictionary(tonal)

  cached = {
    core,
    mini,
    tonal,
    transpiler,
    evaluateTrack: (code) => evaluateTrack({ core, transpiler, tonal }, code),
    chordDictionary,
    /**
     * Does `.voicing()` understand this chord symbol? A bare root ("C") is a
     * major triad and valid; anything else has to match the dictionary exactly.
     */
    isKnownChord(symbol) {
      const parts = splitChordSymbol(symbol)
      if (!parts) return false
      if (parts.quality === '') return true
      return chordDictionary.has(parts.quality)
    },
    /** Suggest a working spelling for a symbol the dictionary rejects. */
    suggestChord(symbol) {
      const parts = splitChordSymbol(symbol)
      if (!parts) return null
      const candidates = CHORD_SUGGESTIONS[parts.quality.toLowerCase()]
      if (!candidates) return null
      return candidates.map((quality) => `${parts.root}${quality}`)
    },
  }
  return cached
}

/**
 * Working replacements for chord spellings that look obvious but are silent.
 *
 * Strudel inherits iReal Pro's jazz shorthand: a caret means major, a hyphen
 * means minor, "o" is diminished and "h" is half-diminished. Pop spellings like
 * "maj7", "sus4" and "dim" are not in that vocabulary, though close relatives
 * are - "sus" really is a suspended fourth triad, "o7" really is a diminished
 * seventh. Every replacement below was checked to produce notes.
 */
const CHORD_SUGGESTIONS = {
  maj7: ['^7', 'M7'],
  maj9: ['^9', 'M9'],
  maj11: ['^9', 'M9'],
  maj13: ['^13', 'M13'],
  major: [''],
  major7: ['^7', 'M7'],
  min: ['m'],
  min7: ['m7', '-7'],
  min9: ['m9', '-9'],
  minor: ['m'],
  minor7: ['m7', '-7'],
  sus4: ['sus'],
  sus2: ['2'],
  dim: ['o'],
  dim7: ['o7'],
  halfdim: ['h7'],
  aug7: ['7#5'],
  m7b9: ['m7', '7b9'],
  '7sus4': ['7sus'],
  '9sus4': ['9sus'],
}

/**
 * Collector for patterns registered this evaluation, or null outside one.
 *
 * `outputs` is keyed by label because the REPL's `.p(id)` overwrites: two lines
 * sharing an id means the later one replaces the earlier, not both playing.
 * @type {{ outputs: Map<string, unknown>, transforms: Function[], anonymous: number,
 *          voicedChords: Set<string> } | null}
 */
let outputCollector = null

/**
 * Reimplement the REPL's multi-output protocol.
 *
 * `$: pattern` is sugar for `pattern.p('$')`, which the real REPL uses to
 * collect every labelled line into one stack. Those methods are installed by
 * `repl()`, which needs a scheduler and an audio context, so headlessly we
 * provide the same surface: `.p()` records and passes through, `.q()` mutes,
 * and `d1`-`d9` / `p1`-`p9` are the numbered aliases. Without this, any track
 * written the documented way (`$: layers({...})`) fails to evaluate at all.
 */
function installOutputProtocol(core) {
  const { Pattern, silence } = core

  Pattern.prototype.p = function (id) {
    // `x_` and `_x` are the REPL's mute markers.
    if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return silence
    if (outputCollector) {
      // `$:` lines are anonymous and all play together, so each gets its own
      // key; an explicit id reused replaces its previous pattern.
      const key =
        typeof id === 'string' && id.includes('$') ? `${id}${outputCollector.anonymous++}` : String(id)
      outputCollector.outputs.set(key, this)
    }
    return this
  }
  Pattern.prototype.q = function () {
    return silence
  }

  for (let i = 1; i < 10; i++) {
    for (const prefix of ['d', 'p']) {
      Object.defineProperty(Pattern.prototype, `${prefix}${i}`, {
        get() {
          return this.p(i)
        },
        configurable: true,
      })
    }
    Pattern.prototype[`q${i}`] = silence
  }

  // Record the chord symbols that actually reach .voicing().
  //
  // Checking every symbol handed to chord() would be wrong: `.rootNotes()` only
  // needs the root, so `chord("Cmaj7").rootNotes(3)` sounds a perfectly audible
  // C3 even though "Cmaj7" is not in the voicing dictionary. Only voicing() can
  // turn an unknown symbol into silence, so only its inputs are worth checking.
  // Wrapping the method rather than the global also covers `.chord()` used as a
  // pattern method, which a global wrapper never sees.
  const originalVoicing = Pattern.prototype.voicing
  Pattern.prototype.voicing = function (...args) {
    if (outputCollector) {
      for (const symbol of chordSymbolsIn(this)) outputCollector.voicedChords.add(symbol)
    }
    return originalVoicing.apply(this, args)
  }

  // `all(fn)` transforms the registered patterns stacked together; `each(fn)`
  // applies to each one separately.
  globalThis.all = (transform) => {
    outputCollector?.transforms.push({ scope: 'all', transform })
    return silence
  }
  globalThis.each = (transform) => {
    outputCollector?.transforms.push({ scope: 'each', transform })
    return silence
  }
}

/** How many cycles to scan for chord symbols; enough for a slowed progression. */
const CHORD_SCAN_CYCLES = 32

/** Chord symbols carried by a pattern's events. */
function chordSymbolsIn(pattern) {
  try {
    return pattern
      .queryArc(0, CHORD_SCAN_CYCLES)
      .map((hap) => (typeof hap.value === 'string' ? hap.value : hap.value?.chord))
      .filter((value) => typeof value === 'string')
  } catch {
    return []
  }
}

/**
 * The set of chord symbols `.voicing()` actually understands.
 *
 * @strudel/tonal ships two voicing dictionaries keyed by jazz shorthand ("^7"
 * for a major seventh, "-7" for a minor seventh) and then installs aliases:
 * "-" also answers to "m", "^" to "M", "+" to "aug". Anything outside that set
 * makes `.voicing()` return an EMPTY pattern and log a warning, so a chord the
 * author believed was there is simply silent. Enumerating the real dictionary
 * is the only reliable way to tell the difference.
 */
function buildChordDictionary(tonal) {
  const symbols = new Set()
  for (const dict of [tonal.simple, tonal.complex]) {
    for (const key of Object.keys(dict ?? {})) symbols.add(key)
  }
  return symbols
}

/** Split "Dbmaj7" into its root and its chord-quality suffix. */
export function splitChordSymbol(symbol) {
  const match = String(symbol).match(/^([A-Ga-g][b#]*)(.*)$/)
  if (!match) return null
  return { root: match[1], quality: match[2] }
}

/**
 * Capture console output produced while a callback runs. Strudel reports
 * recoverable problems (unknown chords, missing duck targets, unresolved
 * sounds) by logging rather than throwing, so the log IS the diagnostic
 * channel and has to be collected rather than swallowed.
 *
 * Two caveats make the log a supporting witness rather than the primary one:
 * most of these warnings fire lazily when a pattern is *queried*, not when it
 * is evaluated, and Strudel's logger debounces identical messages for a second
 * so the same fault in two tracks may only be reported once. Checks that must
 * not miss anything are done structurally instead.
 */
function suppressConsole() {
  const captured = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const record = (line) => captured.push(stripFormatting(line))
  console.log = (...args) => record(args.join(' '))
  console.warn = (...args) => record(args.join(' '))
  console.error = (...args) => record(args.join(' '))
  return {
    captured,
    restore() {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    },
  }
}

/** Run `fn` with console captured, returning its result and the log lines. */
export function withCapturedLogs(fn) {
  const quiet = suppressConsole()
  try {
    return { result: fn(), logs: quiet.captured }
  } finally {
    quiet.restore()
  }
}

/** Strudel's logger prefixes messages with a %c CSS format directive. */
function stripFormatting(line) {
  return line
    .replace(/%c/g, '')
    .replace(/background-color:[^]*?(?:;|$)|color:[^;]*;?|border-radius:[^;]*;?/g, '')
    .trim()
}

/**
 * Evaluate track source and return the pattern plus everything worth knowing
 * about how it was built: the named layers, the arrangement sections, the
 * tempo, requested sample packs, and any warning Strudel logged on the way.
 */
async function evaluateTrack({ core, transpiler }, code) {
  // Evaluation swaps globals (samples, layers, arrange, chord) and a shared
  // output collector, so two runs at once would silently mix their results.
  // Failing loudly beats reporting one track's chords against another's.
  if (outputCollector !== null) {
    throw new Error('evaluateTrack is not reentrant - await each call before starting the next')
  }

  const layers = new Map()
  const sections = []
  const samplePacks = []
  let cps = null
  let cpsSource = null

  const g = globalThis
  const saved = {}
  const install = (name, value) => {
    saved[name] = { had: name in g, value: g[name] }
    g[name] = value
  }

  // Sample loading is a network fetch; offline we only note what was asked for.
  install('samples', async (arg) => {
    samplePacks.push(arg)
  })

  install('setcpm', (value) => {
    cps = Number(value) / 60
    cpsSource = 'setcpm'
    return value
  })
  install('setcps', (value) => {
    cps = Number(value)
    cpsSource = 'setcps'
    return value
  })

  // moltek's own convention: tracks are written as named layers so the console
  // can mix them. Offline it is the handle for per-layer analysis, so record
  // every pattern filed under each name (a name recurs across arrangement
  // sections) and stack them into one representative channel.
  install('layers', (map) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('layers() expects an object of named patterns, e.g. layers({ kick, bass })')
    }
    const entries = Object.entries(map)
    if (entries.length === 0) throw new Error('layers() needs at least one named pattern')
    for (const [name, pattern] of entries) {
      if (!layers.has(name)) layers.set(name, [])
      layers.get(name).push(pattern)
    }
    return core.stack(...entries.map(([, pattern]) => pattern))
  })

  // Real arrange(), plus a note of how long each section runs so the
  // arrangement's shape can be checked against the stated duration.
  install('arrange', (...entries) => {
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'number') sections.push(entry[0])
    }
    return core.arrange(...entries)
  })

  // Chord symbols are collected where they matter, at .voicing() - see
  // installOutputProtocol.

  const quiet = suppressConsole()
  outputCollector = { outputs: new Map(), transforms: [], anonymous: 0, voicedChords: new Set() }
  let pattern = null
  let error = null
  let voicedChords = []
  try {
    const result = await transpiler.evaluate(code)
    // A track using `$:` registers its lines through .p(); one using a bare
    // trailing expression only yields evaluate()'s return value.
    let registered = [...outputCollector.outputs.values()]
    for (const { scope, transform } of outputCollector.transforms) {
      if (scope === 'each') registered = registered.map((p) => transform(p))
    }
    pattern = registered.length > 0 ? core.stack(...registered) : (result?.pattern ?? null)
    for (const { scope, transform } of outputCollector.transforms) {
      if (scope === 'all' && pattern) pattern = transform(pattern)
    }
    voicedChords = [...outputCollector.voicedChords]
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err))
    voicedChords = [...outputCollector.voicedChords]
  } finally {
    outputCollector = null
    quiet.restore()
    for (const [name, entry] of Object.entries(saved)) {
      if (entry.had) g[name] = entry.value
      else delete g[name]
    }
  }

  // Collapse each layer's occurrences into a single queryable pattern.
  const layerPatterns = new Map()
  for (const [name, patterns] of layers) {
    layerPatterns.set(name, patterns.length === 1 ? patterns[0] : core.stack(...patterns))
  }

  return {
    pattern,
    error,
    layers: layerPatterns,
    layerOccurrences: layers,
    sections,
    cps,
    cpsSource,
    samplePacks,
    /** Symbols that actually reached .voicing(), so silence is possible. */
    chordSymbols: voicedChords,
    warnings: quiet.captured,
  }
}

/**
 * Query a pattern and return plain event objects, sorted by onset.
 *
 * `Pattern.prototype.queryArc` already wraps its own query in a try/catch and
 * logs-then-swallows anything that goes wrong (`.fast("not-a-number")`, for
 * instance, or `.voicing()` on an unknown chord) - measured directly against
 * the installed `@strudel/core`, not assumed. So the try/catch below never
 * actually fires; it is kept because failing loudly on a `null` pattern still
 * matters, and removing dead code that costs nothing to keep is not this
 * function's job. A caller that needs a *genuine* thrown exception - the
 * emission check in `verify-emission.mjs` does, to tell a broken pattern from
 * a silent one - cannot get one through `queryArc` at all and has to build
 * the query by hand with `cachedStrudel().core.State`/`TimeSpan` and call
 * `pattern.query()` directly, which is the one entry point Strudel does not
 * guard.
 */
export function queryEvents(pattern, from, to) {
  if (!pattern) return []
  let haps
  try {
    haps = pattern.queryArc(from, to)
  } catch {
    return []
  }
  return haps
    .filter((hap) => hap.whole)
    .map((hap) => ({
      begin: hap.whole.begin.valueOf(),
      end: hap.whole.end.valueOf(),
      value: hap.value ?? {},
    }))
    .sort((a, b) => a.begin - b.begin)
}

export const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/**
 * MIDI number for a hap's pitch, or null if it has none.
 *
 * Only `note` counts. `n` looks like a pitch but usually is not: on a sampled
 * sound it selects the variant, so `s("conga").n(2)` means the third conga
 * recording, not D-1. Strudel already converts `n()` to `note` wherever it is
 * genuinely pitched (via `.scale()`), so reading `n` would only ever misread
 * drums as deep bass and invent register collisions.
 */
export function midiOf(value) {
  const note = value.note
  if (typeof note === 'number') return note
  if (typeof note !== 'string') return null
  // Strudel accepts s/f as sharp/flat aliases alongside #/b.
  const match = note.match(/^([a-gA-G])((?:[b#sf])*)(-?\d+)?$/)
  if (!match) return null
  const [, letter, accidentals, octave] = match
  let semis = NOTE_OFFSETS[letter.toLowerCase()]
  for (const accidental of accidentals) {
    semis += accidental === '#' || accidental === 's' ? 1 : -1
  }
  return (Number(octave ?? 3) + 1) * 12 + semis
}
