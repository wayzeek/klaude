/**
 * A transcription becomes moltek source.
 *
 * The output is the remix surface, so readability is a feature. Someone opening
 * this should see the song's structure - a handful of named loops and an
 * arrangement - rather than a wall of generated notes. That is why loops are
 * folded to one, two or four bars upstream, why each layer gets a named const,
 * and why a repeated section references a definition instead of restating it.
 *
 * Sounds come from moltek's own palette, matching how tracks/MINUIT writes them.
 * They are an approximation, not a reproduction: the clone plays the right notes
 * with moltek's sounds, and will not sound like the record.
 */

import { PITCH_NAMES } from '../dsp.mjs'
import { LAYERS, gridFromJson, stepsPerBar } from './transcribe/quantize.mjs'

/**
 * Per-layer sound and gain.
 *
 * Gains are staged the way the-chase stages them and the way check.mjs expects:
 * the kick loudest, the bass well under it so the mids can be heard, everything
 * else finding room underneath. `snare` is a rimshot rather than a clap -
 * a bare clap on the backbeat reads as cheesy.
 */
/**
 * `sound` is the value that lands in `event.value.s` when the emitted pattern
 * is queried, and every layer's is distinct. That is load-bearing: the emission
 * check in Task 13 cannot query per layer, because `track.layers` is a stacked
 * representative channel rather than a timeline, so it queries the whole
 * arranged pattern and sorts events back into layers by this field.
 */
export const SOUNDS = Object.freeze({
  kick: Object.freeze({ kind: 'sample', token: 'bd', sound: 'bd', suffix: '.bank("RolandTR909")', gain: 0.5 }),
  snare: Object.freeze({ kind: 'sample', token: 'rim', sound: 'rim', suffix: '.bank("RolandTR909")', gain: 0.35 }),
  hats: Object.freeze({ kind: 'sample', token: 'hh', sound: 'hh', suffix: '.bank("RolandTR909").hpf(2200)', gain: 0.25 }),
  bass: Object.freeze({ kind: 'note', sound: 'sawtooth', suffix: '.s("sawtooth").hpf(95).lpf(440).lpq(1)', gain: 0.35 }),
  // A register split of the same transcribed bass line (`bass.mjs`'s
  // `splitByRegister`), not an independent voice - see its doc comment for
  // where the MIDI 32 boundary comes from. `.s("sine")` matches
  // `sound: 'sine'` below so `verify-emission.mjs` can sort events back into
  // this layer; the low `lpf` matches `tracks/MINUIT/02-the-chase.md`'s own
  // hand-authored `mkSub` (`.s("sine").lpf(130)`). Gain sits under `bass`'s
  // own (0.3 vs 0.35), same relative balance as the reference track's
  // `mkSub`/`mkBass` (.24/.26) - a sub is felt more than heard, not louder
  // than the line it sits under.
  sub: Object.freeze({ kind: 'note', sound: 'sine', suffix: '.s("sine").lpf(130)', gain: 0.3 }),
  chords: Object.freeze({ kind: 'chord', sound: 'gm_epiano1', suffix: '.voicing().s("gm_epiano1").hpf(380)', gain: 0.3 }),
  lead: Object.freeze({ kind: 'note', sound: 'gm_tenor_sax', suffix: '.s("gm_tenor_sax")', gain: 0.35 }),
})

const SHARP_TO_FLAT = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' }

/**
 * Keys whose signature is written with flats, which depends on the mode as well
 * as the root. D major takes two sharps; D minor takes one flat. Collapsing the
 * two would respell F# as Gb in D major, which no musician writes.
 */
const FLAT_MAJOR = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'])
const FLAT_MINOR = new Set(['D', 'G', 'C', 'F', 'Bb', 'Eb'])

export function prefersFlats(keyName) {
  const [root = '', mode = ''] = (keyName ?? '').trim().split(/\s+/)
  return mode.toLowerCase() === 'minor' ? FLAT_MINOR.has(root) : FLAT_MAJOR.has(root)
}

export function midiToNoteName(midi, { flats = true } = {}) {
  const pitchClass = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  let name = PITCH_NAMES[pitchClass]
  if (!flats && name.length === 2 && name[1] === 'b') {
    name = Object.keys(SHARP_TO_FLAT).find((sharp) => SHARP_TO_FLAT[sharp] === name) ?? name
  }
  if (flats) name = SHARP_TO_FLAT[name] ?? name
  return `${name.toLowerCase()}${octave}`
}

/** Respell a chord symbol's root for the key. Strudel accepts both spellings;
 *  this is for whoever reads the track. */
export function respell(symbol, { flats = true } = {}) {
  if (!flats) return symbol
  const match = /^([A-G]#)(.*)$/.exec(symbol)
  if (!match) return symbol
  return `${SHARP_TO_FLAT[match[1]] ?? match[1]}${match[2]}`
}

/**
 * Sixteen slots become mini-notation.
 *
 * `slots[i]` is `{ token, length }` at a note's onset and `null` elsewhere. Runs
 * of the same thing collapse with `@`, so a whole-bar chord is one token rather
 * than sixteen, and the result stays readable at a glance.
 */
export function barToMini(slots) {
  const tokens = []
  let index = 0
  while (index < slots.length) {
    const slot = slots[index]
    if (slot) {
      const span = Math.max(1, Math.min(slot.length, slots.length - index))
      tokens.push(span > 1 ? `${slot.token}@${span}` : slot.token)
      index += span
      continue
    }
    let rest = 0
    while (index + rest < slots.length && !slots[index + rest]) rest++
    tokens.push(rest > 1 ? `~@${rest}` : '~')
    index += rest
  }
  const line = tokens.join(' ')
  return line.replace(/^~@\d+$|^~$/, '~')
}

/**
 * A loop becomes a mini-notation string and a matching gain string.
 *
 * Two shapes, chosen by whether anything sustains across a bar line. A drum
 * loop never does, and reads best as an alternation - one bracketed bar per
 * cycle. A held chord or a long bass note does, and an alternation cannot
 * express it: each bracket is its own cycle, so the note would simply stop at
 * the bar. Those loops are emitted as one sequence stretched over `loopBars`
 * cycles with `.slow()`.
 *
 * The gain string carries velocity, which is otherwise lost. #41 requires ghost
 * notes to survive as ghost notes, and they only do if the dynamics reach the
 * output. Rest positions repeat the base gain rather than `~` so every slot has
 * a defined value and the two strings stay aligned by weight.
 *
 * `SOUNDS[layer].gain` is the loudest an event on that layer ever gets - the
 * ceiling, not a midpoint - matching `resynth.mjs` (`voice.gain * velocity`,
 * no extra factor) and the hand-authored gains in tracks/MINUIT. A layer whose
 * transcriber never varies velocity (bass.mjs hardcodes 0.8; nothing in this
 * pipeline emits higher) must still land at or under its own base gain.
 */
function loopToPatterns(loop, layer, perBar, { flats, soundMatch }) {
  const total = loop.loopBars * perBar
  const base = effectiveGain(layer, soundMatch)
  const slots = new Array(total).fill(null)
  for (const event of loop.events) {
    if (event.step < 0 || event.step >= total) continue
    slots[event.step] = {
      token: tokenFor(event, layer, { flats }),
      // Clamp to the loop's end, not the bar's: a note may legitimately sustain
      // across a bar line and clipping it there silently shortens every pad.
      length: Math.max(1, Math.min(event.length, total - event.step)),
      gain: round2(base * (event.velocity ?? 0.8)),
    }
  }

  const crosses = slots.some(
    (slot, i) => slot && Math.floor(i / perBar) !== Math.floor((i + slot.length - 1) / perBar),
  )

  if (loop.loopBars === 1) {
    return { mini: barToMini(slots), gains: barToGains(slots, base), slow: 1 }
  }
  if (crosses) {
    return { mini: barToMini(slots), gains: barToGains(slots, base), slow: loop.loopBars }
  }
  const bars = []
  const gains = []
  for (let bar = 0; bar < loop.loopBars; bar++) {
    const slice = slots.slice(bar * perBar, (bar + 1) * perBar)
    bars.push(`[${barToMini(slice)}]`)
    gains.push(`[${barToGains(slice, base)}]`)
  }
  return { mini: `<${bars.join(' ')}>`, gains: `<${gains.join(' ')}>`, slow: 1 }
}

/** The gain string, walked exactly as `barToMini` walks the tokens so the two
 *  line up weight for weight. */
export function barToGains(slots, base) {
  const tokens = []
  let index = 0
  while (index < slots.length) {
    const slot = slots[index]
    if (slot) {
      const span = Math.max(1, Math.min(slot.length, slots.length - index))
      tokens.push(span > 1 ? `${slot.gain}@${span}` : String(slot.gain))
      index += span
      continue
    }
    let rest = 0
    while (index + rest < slots.length && !slots[index + rest]) rest++
    tokens.push(rest > 1 ? `${round2(base)}@${rest}` : String(round2(base)))
    index += rest
  }
  return tokens.join(' ')
}

const round2 = (value) => Math.round(value * 100) / 100

/**
 * `SOUNDS[layer].gain`, trimmed by `sound-match.mjs`'s `gainTrim` when one is
 * present. The trim only ever multiplies by a factor in (0, 1] - see
 * `sound-match.mjs`'s own comment on why gain only ever moves down - so this
 * can never raise a layer's ceiling, only lower it for this one render.
 * Every caller that needs "the loudest this layer gets" (`loopToPatterns`,
 * `sameLoops`) goes through this rather than `SOUNDS[layer].gain` directly,
 * so a track emitted with a trim and the reuse check that decides whether two
 * sections match agree on what "the same gain" means.
 */
export function effectiveGain(layer, soundMatch) {
  const trim = soundMatch?.[layer]?.gainTrim
  const base = SOUNDS[layer].gain
  return Number.isFinite(trim) ? round2(base * trim) : base
}

function tokenFor(event, layer, { flats }) {
  const sound = SOUNDS[layer]
  if (sound.kind === 'sample') return sound.token
  if (sound.kind === 'chord') return respell(event.symbol ?? '', { flats })
  return midiToNoteName(event.midi ?? 60, { flats })
}

/**
 * Break a long mini-notation (or gain) string onto several physical lines,
 * at token boundaries. Mini-notation treats any run of whitespace - a single
 * space or a newline - identically, so this changes nothing about what the
 * pattern plays; it exists because a bass line slowed across seventeen bars,
 * or a hi-hat gain array with one value per hit, is a 500-1200 character
 * single line otherwise, which fails #46's readability criterion outright.
 * Short strings pass through untouched (`lines.length` never exceeds 1), so
 * this only changes output for the loops it needs to.
 */
function wrapTokens(str, { width = 90, indent = '  ' } = {}) {
  const tokens = str.split(' ')
  const lines = []
  let current = ''
  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token
    if (current && candidate.length > width) {
      lines.push(current)
      current = token
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.join(`\n${indent}`)
}

/**
 * A `.lpf(saw.range(a, b))` sweep, `.slow()`-ed so it ramps once across the
 * whole section rather than once per underlying cycle.
 *
 * `outerSlow` is this layer's own `.slow(n)` from `loopToPatterns` (1 for a
 * single-bar or `<[...][...]>`-alternation loop, `loop.loopBars` for one
 * that crosses a bar and gets wrapped in `.slow()` itself). That outer
 * `.slow()` is applied *after* this whole expression (see `layerExpression`'s
 * `tail`), and it stretches everything nested inside it - including an
 * embedded control pattern already joined via an earlier `.lpf()` - by that
 * same factor. Checked directly against the runtime: `note(...).lpf(saw
 * .range(a,b).slow(6)).slow(6)` does *not* ramp across 6 bars, it ramps
 * across 36 (6×6); `.slow(1)` in the same spot (i.e. `6 / outerSlow` with
 * `outerSlow = 6`) ramps across exactly 6, matching a plain `saw.range(a,b)
 * .slow(6)` with no outer `.slow()` at all. `sectionBars` always divides
 * evenly by `outerSlow` - `loopToPatterns`/`foldToLoop` only ever produce a
 * `loopBars` that divides the section's own bar count, or 1.
 */
function sweepChain(sweepLpf, outerSlow, sectionBars) {
  if (!sweepLpf) return ''
  const ratio = sectionBars / outerSlow
  const slowSuffix = ratio > 1 ? `.slow(${ratio})` : ''
  return `.lpf(saw.range(${sweepLpf.lpfStart}, ${sweepLpf.lpfEnd})${slowSuffix})`
}

/**
 * A loop's one-off fill/crash (`fills.mjs`'s `variation`), expanded to
 * absolute section-relative steps with the same gain/length clamps the
 * emitted `.superimpose` pattern actually applies.
 *
 * Shared by `variationChain` below (which builds the pattern from it) and
 * `verify-emission.mjs` (which has to expect exactly what was built), so the
 * two can never independently drift on how a variation's gain or length is
 * computed - the same reason `effectiveGain` itself is exported rather than
 * recomputed per caller.
 */
export function expandVariation(loop, perBar, base) {
  if (!loop?.variation) return []
  return loop.variation.events
    .filter((event) => event.step >= 0 && event.step < perBar)
    .map((event) => ({
      step: loop.variation.bar * perBar + event.step,
      midi: event.midi ?? null,
      symbol: event.symbol ?? null,
      length: Math.max(1, Math.min(event.length, perBar - event.step)),
      gain: round2(base * (event.velocity ?? 0.8)),
    }))
}

/**
 * A fill or crash, layered on top of the loop's own closing bar (fill) or
 * opening bar (crash) via `.lastOf`/`.every` - the idiom tracks/MINUIT
 * already uses for last-cycle variation (`kick.lastOf(8, x => x.ply(...))`,
 * `hats.lastOf(4, x => x.degradeBy(...))`), not a split `arrange()` entry.
 *
 * `.lastOf`/`.every` count cycles of the pattern they are attached to, so
 * every OTHER layer in the same section is completely unaffected regardless
 * of which one carries a variation - where splitting the section's own
 * `arrange()` entry in two would reset every co-occurring layer's own
 * multi-bar loop back to ITS cycle zero at the split point, misaligning any
 * loop whose `loopBars` does not happen to divide the split evenly. That
 * failure mode is the same mechanism `layerExpression`'s own comment
 * documents for a constant control applied after `.slow()` - checked
 * directly against the runtime there, not assumed - so this file avoids it
 * by construction rather than re-deriving it: a variation decorates the
 * layer that has one, in place, and never touches the arrangement.
 *
 * Must sit AFTER `tail` (the loop's own `.gain()`/`.slow()`), never before:
 * `.lastOf`/`.every` need to count bars of the OUTPUT timeline, and applying
 * them before an inner `.slow(loopBars)` would count cycles of the
 * unslowed pattern instead, which then stretches by `loopBars` right along
 * with everything else - landing the variation on the wrong bar entirely.
 *
 * `chainExtra` - the same `soundMatch`/dynamics/sweep string
 * `layerExpression` already spliced onto the main pattern - is passed
 * through and applied here too, in the same slot (after the dry sound's
 * suffix, before `.gain()`). Found by independent review, verified directly
 * against the real runtime before fixing: without it, a kick's fill/crash
 * hits carried only `.bank(...)`/`.gain(...)` while the loop's own hits also
 * carried room, pan and `.duckorbit()`/`.duckdepth()`/`.duckattack()` - the
 * fill played dry and never drove the section's own sidechain, an audible
 * inconsistency `verify-emission.mjs` cannot see (it only compares timing,
 * pitch, length and gain). A sweep's own `saw.range(...).slow(...)` is a
 * pure function of query time, so a second, independent instance of it here
 * evaluates identically to the main pattern's at whatever cycle the
 * variation actually plays - reusing the string is safe, not just convenient.
 */
function variationChain(loop, layer, perBar, { flats, soundMatch, anchor, sectionBars, chainExtra }) {
  if (!loop.variation) return ''
  const sound = SOUNDS[layer]
  const base = effectiveGain(layer, soundMatch)
  const expanded = expandVariation(loop, perBar, base)
  const barStart = loop.variation.bar * perBar
  const slots = new Array(perBar).fill(null)
  for (const event of expanded) {
    const localStep = event.step - barStart
    if (localStep < 0 || localStep >= perBar) continue
    slots[localStep] = { token: tokenFor(event, layer, { flats }), length: event.length, gain: event.gain }
  }
  const mini = barToMini(slots)
  const gains = barToGains(slots, base)
  let extraLayer
  if (sound.kind === 'sample') extraLayer = `s(\`${mini}\`)${sound.suffix}${chainExtra}.gain(\`${gains}\`)`
  else if (sound.kind === 'chord') extraLayer = `chord(\`${mini}\`).anchor("${anchor}").mode("above")${sound.suffix}${chainExtra}.gain(\`${gains}\`)`
  else extraLayer = `note(\`${mini}\`)${sound.suffix}${chainExtra}.gain(\`${gains}\`)`
  const wrapper = loop.variation.kind === 'crash' ? 'every' : 'lastOf'
  return `.${wrapper}(${sectionBars}, x => x.superimpose(() => ${extraLayer}))`
}

/**
 * The wrapper around a layer's mini-notation. Template literals rather than
 * quoted strings throughout, so a wrapped (multi-line) pattern is still
 * valid JS - and so a short, unwrapped one costs nothing by using the same
 * quoting.
 *
 * `soundMatch[layer].chain`, if present, is spliced in right after the
 * dry sound's own suffix and before `.gain()`/`.slow()` - the same slot
 * `SOUNDS[layer].suffix` already occupies, so a `.room()`/`.lpf()`/`.pan()`
 * `sound-match.mjs` derived reads exactly like a hand-written effect chain
 * would.
 */
function layerExpression(loop, layer, perBar, { flats, anchor, soundMatch, dynamics, sectionBars }) {
  const sound = SOUNDS[layer]
  const { mini, gains, slow } = loopToPatterns(loop, layer, perBar, { flats, soundMatch })
  const wrappedMini = wrapTokens(mini)
  const wrappedGains = wrapTokens(gains)
  // Both chains have to land here, before `.gain()`/`.slow()`, not spliced on
  // afterward at the arrange() call site: a control applied *after* `.slow()`
  // duplicates any hap whose span crosses one of the original (pre-slow)
  // cycle boundaries, the same failure `sound-match.mjs`'s own `.pan()`
  // comment documents for a *varying* control - checked directly (probe
  // script, not committed) against a *constant* one too (`.orbit(2)` after
  // `.slow(4)` turned 8 events into 11 on a sustained lead line; the same
  // call before `.slow(4)` stayed at 8), so this restriction is not limited
  // to controls whose value changes per cycle. That is why dynamics are
  // baked into the const itself rather than decorating the shared reference
  // in `arrange()` - see `dynamics.mjs`'s own emission comment for how that
  // forces two sections with different dynamics to never share one const.
  const extra = (soundMatch?.[layer]?.chain ?? '') + (dynamics?.layers?.[layer]?.chain ?? '') + sweepChain(dynamics?.layers?.[layer]?.sweepLpf, slow, sectionBars)
  const tail = `.gain(\`${wrappedGains}\`)${slow > 1 ? `.slow(${slow})` : ''}`
  const variation = variationChain(loop, layer, perBar, { flats, soundMatch, anchor, sectionBars, chainExtra: extra })
  if (sound.kind === 'sample') return `s(\`${wrappedMini}\`)${sound.suffix}${extra}${tail}${variation}`
  if (sound.kind === 'chord') {
    return `chord(\`${wrappedMini}\`).anchor("${anchor}").mode("above")${sound.suffix}${extra}${tail}${variation}`
  }
  return `note(\`${wrappedMini}\`)${sound.suffix}${extra}${tail}${variation}`
}

/**
 * One comment block, once per track, naming the measurement behind every
 * layer's sound-match decision - including the layers where nothing was
 * applied, since "left alone, and why" is as much a finding as an effect.
 * Repeating the same reasoning above every section that uses a layer (there
 * may be many) would bury it; one block a human reads once does the job the
 * brief actually asks for ("a human will read it").
 */
function soundMatchHeader(soundMatch) {
  if (!soundMatch) return []
  const lines = ['// --- sound match: measured against the source stems ---']
  for (const layer of LAYERS) {
    const notes = soundMatch[layer]?.notes?.filter(Boolean) ?? []
    if (!notes.length) continue
    lines.push(`// ${layer}:`)
    for (const note of notes) lines.push(`//   - ${note}`)
  }
  lines.push('// ---------------------------------------------------------')
  lines.push('')
  return lines
}

/**
 * Assemble the whole track.
 *
 * Sections whose transcriptions came out identical share one set of
 * definitions; see `reuseTarget` for why that, and not `sameAs`, is the
 * condition.
 */
export function emitTrack(transcription, { title = null, source = null, soundMatch = null, dynamics = null } = {}) {
  const grid = gridFromJson(transcription.grid)
  const perBar = stepsPerBar(grid)
  const keyName = transcription.key?.name ?? ''
  const keyRoot = keyName.split(/\s+/)[0] || 'C'
  const flats = prefersFlats(keyName)
  const anchor = `${keyRoot.toLowerCase()}4`.replace('#', 's')

  const lines = []
  lines.push('// ═══════════════════════════════════════════════════════════')
  lines.push(`//  ${(title ?? 'rebuild').toUpperCase()}  ·  ${keyName} · ${Math.round(grid.bpm)} BPM`)
  if (source) lines.push(`//  rebuilt from ${source}`)
  lines.push('// ═══════════════════════════════════════════════════════════')
  lines.push(...soundMatchHeader(soundMatch))
  lines.push("samples('github:tidalcycles/dirt-samples')")
  // Strudel's cpm is cycles per minute and moltek writes one cycle per bar, so
  // the divisor is the detected meter, not a hardcoded 4. At 120 BPM in 3/4,
  // dividing by 4 would play the track at 90.
  lines.push(`setcpm(${Math.round(grid.bpm)}/${grid.beatsPerBar})`)
  lines.push('')

  // Which section each section takes its definitions from. A repeat only
  // borrows when both it and its original were heard confidently *and* carry
  // the same dynamics - see `reuseTarget`'s own comment for why a section
  // whose kick pumps the bass can never share a const with one that doesn't,
  // now that dynamics are baked into the const itself (see `layerExpression`).
  const definitionOf = new Map()
  for (const section of transcription.sections) {
    const target = reuseTarget(section, transcription.sections, soundMatch, dynamics) ?? section.index
    definitionOf.set(section.index, target)
  }

  const emitted = new Set()
  for (const section of transcription.sections) {
    if (definitionOf.get(section.index) !== section.index) continue
    const present = LAYERS.filter((layer) => section.loops?.[layer])
    if (!present.length) continue
    const dyn = dynamics?.[section.index]
    lines.push(`// section ${section.index} - bar ${section.startBar}, ${section.bars} bars, ${section.label}`)
    if (dyn?.summary) lines.push(`//   ${dyn.summary}`)
    for (const layer of present) {
      const name = `s${section.index}_${layer}`
      const note = section.loops[layer].variation?.note
      if (note) lines.push(`//   ${layer} ${section.loops[layer].variation.kind}: ${note}`)
      lines.push(`const ${name} = ${layerExpression(section.loops[layer], layer, perBar, { flats, anchor, soundMatch, dynamics: dyn, sectionBars: section.bars })}`)
      emitted.add(name)
    }
    lines.push('')
  }

  lines.push('const S = silence')
  lines.push(`const sec = (o) => layers({ ${LAYERS.map((l) => `${l}: o.${l} || S`).join(', ')} })`)
  lines.push('')
  lines.push('arrange(')
  for (const section of transcription.sections) {
    const from = definitionOf.get(section.index)
    const source_ = transcription.sections.find((candidate) => candidate.index === from) ?? section
    const parts = LAYERS.filter((layer) => source_.loops?.[layer]).map(
      (layer) => `${layer}: s${from}_${layer}`,
    )
    const note = from === section.index ? '' : `  // repeats section ${from}`
    lines.push(`  [${section.bars}, sec({${parts.length ? ` ${parts.join(', ')} ` : ''}})],${note}`)
  }
  lines.push(')')
  lines.push('')
  return lines.join('\n')
}

/**
 * The section this one may borrow definitions from, or null.
 *
 * Reuse is allowed only when the two sections transcribed to *the same thing*.
 * That makes it a pure deduplication of identical output: it cannot change a
 * single note the track plays, only how many times the source states them.
 *
 * The obvious alternative - trust `sameAs`, perhaps gated on both sections
 * passing the hearing check - does not work, and the reason is worth keeping.
 * A hearing check proves section A's transcription matches A's audio and B's
 * matches B's. It says nothing about whether A and B resemble each other. Two
 * musically different sections, each transcribed perfectly, would both pass and
 * B would then be overwritten with A's material. Phase 1 measured false repeat
 * matches at 0.9464 and 0.9352 against a 0.9 threshold, so this is not a
 * hypothetical.
 *
 * Dynamics are checked here too, for the same reason velocity is: they reach
 * the emitted const itself now (`layerExpression` bakes them in before
 * `.slow()` - see its own comment for why they can no longer live on the
 * shared `arrange()` reference), so two sections with identical notes but a
 * kick that only pumps the bass in one of them are not the same output and
 * must not share one definition.
 */
function reuseTarget(section, sections, soundMatch, dynamics) {
  if (section.sameAs === null || section.sameAs === undefined) return null
  const original = sections.find((candidate) => candidate.index === section.sameAs)
  if (!original || original.bars !== section.bars) return null
  if (!sameLoops(original.loops, section.loops, soundMatch)) return null
  if (!sameDynamics(dynamics?.[original.index], dynamics?.[section.index])) return null
  return section.sameAs
}

/** Do two sections carry the same per-layer dynamics chain, or both carry
 *  none? Compared by the emitted chain string itself, not the raw measurement
 *  - two sections whose measured numbers differ in the third decimal place
 *  but round to the same chain are the same output either way, which is
 *  exactly what reuse is checking for. */
function sameDynamics(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  const layers = new Set([...Object.keys(a.layers ?? {}), ...Object.keys(b.layers ?? {})])
  for (const layer of layers) {
    const layerA = a.layers?.[layer]
    const layerB = b.layers?.[layer]
    if ((layerA?.chain ?? null) !== (layerB?.chain ?? null)) return false
    // sweepLpf's *numbers* are what has to match - the `.slow()` ratio
    // `sweepChain` derives from them is already pinned equal by `sameLoops`
    // requiring both sections' loopBars (and so `bars`, already checked by
    // `reuseTarget` before this runs) to agree.
    if ((layerA?.sweepLpf?.lpfStart ?? null) !== (layerB?.sweepLpf?.lpfStart ?? null)) return false
    if ((layerA?.sweepLpf?.lpfEnd ?? null) !== (layerB?.sweepLpf?.lpfEnd ?? null)) return false
  }
  return true
}

/** Do two sections carry identical material on every layer? */
function sameLoops(a, b, soundMatch) {
  for (const layer of LAYERS) {
    const left = a?.[layer] ?? null
    const right = b?.[layer] ?? null
    if (left === null && right === null) continue
    if (left === null || right === null) return false
    if (left.loopBars !== right.loopBars) return false
    if (left.events.length !== right.events.length) return false
    const base = effectiveGain(layer, soundMatch)
    for (let i = 0; i < left.events.length; i++) {
      const x = left.events[i]
      const y = right.events[i]
      if (x.step !== y.step || x.length !== y.length) return false
      if ((x.midi ?? null) !== (y.midi ?? null)) return false
      if ((x.symbol ?? null) !== (y.symbol ?? null)) return false
      // Reuse must be lossless output-for-output, and velocity reaches the
      // output as gain (see loopToPatterns). Comparing the rounded, emitted
      // gain rather than raw velocity tolerates the float noise that two
      // independently-measured (but musically identical) audio passages will
      // always carry, while still catching what actually erases dynamics: a
      // genuine ghost-vs-accent difference. Measured directly - kick
      // velocities 1.0 and 0.1 used to reuse one loud gain(0.5) definition
      // for both sections, silencing the ghost hit's dynamics entirely.
      if (round2(base * (x.velocity ?? 0.8)) !== round2(base * (y.velocity ?? 0.8))) return false
    }
    if (!sameVariation(left.variation, right.variation, base)) return false
  }
  return true
}

/**
 * Do two loops carry the same fill/crash, or both carry none? Reuse must be
 * lossless output-for-output exactly like the rest of `sameLoops` - a
 * section whose closing bar carries a real fill and one whose does not are
 * not the same output, even if every other bar is identical, and must never
 * share one const (`variationChain` bakes the variation into that const).
 *
 * `variation.note` (the emitted comment) is deliberately not compared here.
 * It is a pure function of exactly the fields this loop already checks
 * (`kind`, `bar`, and each event's step/velocity - see `detectFill`/
 * `detectCrash`'s own construction in fills.mjs) plus `loop.events`/
 * `loopBars`, which `sameLoops` has already required to match before this
 * ever runs. Two variations that pass every check above cannot have
 * different notes; adding one would be a redundant comparison of a value
 * this function has already pinned by other means, not a gap it closes.
 */
function sameVariation(a, b, base) {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind || a.bar !== b.bar) return false
  if (a.events.length !== b.events.length) return false
  for (let i = 0; i < a.events.length; i++) {
    const x = a.events[i]
    const y = b.events[i]
    if (x.step !== y.step || x.length !== y.length) return false
    if ((x.midi ?? null) !== (y.midi ?? null)) return false
    if ((x.symbol ?? null) !== (y.symbol ?? null)) return false
    if (round2(base * (x.velocity ?? 0.8)) !== round2(base * (y.velocity ?? 0.8))) return false
  }
  return true
}
