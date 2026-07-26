#!/usr/bin/env node
/**
 * moltek theme gate and CSS generator.
 *
 * `src/lib/themes.json` is the only place a palette is written down. This
 * script does two jobs with it:
 *
 *   1. Gates contrast. Every theme must prove it is legible, using WCAG 2.1
 *      relative-luminance ratios. Any gated failure exits non-zero, and `pnpm
 *      build` runs this first, so an illegible palette cannot ship.
 *   2. Generates `src/app/themes.generated.css`. The palette is never written
 *      twice, because a palette defined twice is a palette that drifts.
 *
 * GATED:
 *   fg / bg               >= 4.5   body text (AA)
 *   mutedFg / bg          >= 4.5   secondary labels are still text
 *   mutedFg / surface     >= 4.5   and they mostly sit on a panel, which for a
 *                                  light theme is darker than the page
 *   accent / bg           >= 3.0   non-text UI (WCAG 1.4.11)
 *   destructive / bg      >= 3.0   the armed-record state is UI too
 *   destructive vs accent >= 0.10  an armed take must not read as ordinary
 *                                  playback. Measured as OKLab distance, not
 *                                  contrast: a red and a green of equal
 *                                  luminance have a ratio near 1.0 while
 *                                  being obvious at a glance, so the check
 *                                  has to see hue. This was a comment in the
 *                                  CSS; now it is a number that fails the
 *                                  build.
 *   body / bg             >= 3.0   the mascot has to read against the room
 *   eye / body            >= 3.0   eyes have to read against the body
 *   gear / body           >= 2.0   the cup has to separate from the body
 *   gear / bg             >= 3.0   the band and arms sit above the head, on the room
 *   pad / gear            >= 1.25  the pad is a recess inside the cup, so it
 *                                  only ever borders the cup. Subtle on
 *                                  purpose, and never checked against the
 *                                  body, which it does not touch.
 *
 * ADVISORY, measured and printed but not gated:
 *   surface / bg   Panel separation is carried by --border, not the fill.
 *   border / bg    What actually separates panels. Wants ~1.5 or better.
 *   editor / bg    The editor sits deeper so code reads as the work surface.
 *
 * Every token is emitted under an `--mk-` prefix. Generic names like
 * --background, --border and --body are occupied by other stylesheets on this
 * page (the Strudel bundle among them), and an inline or later definition wins
 * over ours no matter how specific our selector is. Namespacing removes the
 * whole class of bug rather than playing specificity games with it.
 *
 * Everything decorative derives from bg/fg/accent with color-mix in the
 * generated CSS: the neutral ramp, the booth, the room, the LEDs and the
 * syntax colours. That keeps this file's hand-written surface to the twelve
 * tokens a contrast ratio can actually be computed for, and it means a light
 * theme inverts correctly instead of needing its own scenery.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SRC = path.join(ROOT, 'src/lib/themes.json')
const OUT = path.join(ROOT, 'src/app/themes.generated.css')

const { themes: THEMES } = JSON.parse(readFileSync(SRC, 'utf8'))

const CHECKS = [
  { label: 'fg / bg', a: 'fg', b: 'bg', min: 4.5 },
  { label: 'mutedFg / bg', a: 'mutedFg', b: 'bg', min: 4.5 },
  // Muted labels mostly sit on panels, not on the page. For a light theme the
  // panel is darker than the page, so measuring only against bg flatters it.
  { label: 'mutedFg / surface', a: 'mutedFg', b: 'surface', min: 4.5 },
  { label: 'accent / bg', a: 'accent', b: 'bg', min: 3.0 },
  { label: 'destructive / bg', a: 'destructive', b: 'bg', min: 3.0 },
  { label: 'destructive vs accent', a: 'destructive', b: 'accent', min: 0.1, metric: 'dE' },
  { label: 'body / bg', a: 'body', b: 'bg', min: 3.0 },
  { label: 'eye / body', a: 'eye', b: 'body', min: 3.0 },
  { label: 'gear / body', a: 'gear', b: 'body', min: 2.0 },
  { label: 'gear / bg', a: 'gear', b: 'bg', min: 3.0 },
  { label: 'pad / gear', a: 'pad', b: 'gear', min: 1.25 },
  { label: 'surface / bg', a: 'surface', b: 'bg', advisory: true },
  { label: 'border / bg', a: 'border', b: 'bg', advisory: true },
  { label: 'editor / bg', a: 'editor', b: 'bg', advisory: true },
]

const lin = (c) => {
  c /= 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const lum = (h) => {
  const [r, g, b] = rgb(h)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const ratio = (x, y) => {
  const a = lum(x)
  const b = lum(y)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * OKLab, for the one comparison a contrast ratio cannot answer.
 *
 * Contrast ratio is a lightness ratio and is blind to hue, so a red and a green
 * of equal luminance score about 1.0 while being obvious at a glance. Telling
 * the armed-record colour apart from the playback accent is a perceptual
 * question, not a lightness one, so it gets a perceptual distance.
 */
const oklab = (hex) => {
  const [r, g, b] = rgb(hex).map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const deltaE = (x, y) => {
  const a = oklab(x)
  const b = oklab(y)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/* --------------------------------------------------------------- gate ---- */

const REQUIRED = ['bg', 'surface', 'editor', 'fg', 'mutedFg', 'accent',
  'destructive', 'border', 'body', 'gear', 'pad', 'eye']

let failures = 0
const results = THEMES.map((t) => {
  const missing = REQUIRED.filter((k) => typeof t[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t[k]))
  if (missing.length) {
    failures += missing.length
    return { theme: t, rows: [], ok: false, missing }
  }
  const rows = CHECKS.map((c) => {
    const r = c.metric === 'dE' ? deltaE(t[c.a], t[c.b]) : ratio(t[c.a], t[c.b])
    const pass = c.advisory ? null : r >= c.min
    if (pass === false) failures++
    return { ...c, r, pass }
  })
  return { theme: t, rows, ok: rows.every((r) => r.pass !== false), missing: [] }
})

const W = 21
console.log(`\nmoltek theme gate  (${THEMES.length} themes)\n` + '='.repeat(70))
for (const { theme, rows, ok, missing } of results) {
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${theme.name}  (${theme.kind})`)
  if (missing.length) {
    console.log(`      missing or malformed tokens: ${missing.join(', ')}`)
    continue
  }
  for (const r of rows) {
    const verdict = r.advisory ? ' info ' : r.pass ? '  ok  ' : ' FAIL '
    const bound = r.advisory ? '   advisory' : `min ${r.min.toFixed(2)}`
    const shown = r.metric === 'dE' ? `${r.r.toFixed(3)} dE ` : `${r.r.toFixed(2)} : 1`
    console.log(`      ${r.label.padEnd(W)} ${shown.padStart(9)}   ${bound}  ${verdict}`)
  }
}
console.log('\n' + '='.repeat(70))
console.log(
  failures === 0
    ? `all ${THEMES.length} themes pass every gated condition`
    : `${failures} failing gated condition(s) across ${results.filter((r) => !r.ok).length} theme(s)`,
)

if (failures) {
  console.error('\nrefusing to generate CSS from a failing palette')
  process.exit(1)
}

/* ----------------------------------------------------------- generate ---- */

const mix = (a, pct, b) => `color-mix(in oklab, ${a} ${pct}%, ${b})`
/**
 * A hue rotated off the accent, at a lightness and chroma that stay readable
 * on this kind of background. Uses relative colour syntax, so it recomputes
 * from whatever the theme's accent is.
 */
const hue = (kind, deg) => {
  const l = kind === 'light' ? 0.46 : 0.79
  return `oklch(from var(--mk-accent) ${l} 0.125 calc(h + ${deg}))`
}
const V = (n) => `var(--mk-${n})`

/**
 * Tokens derived from the twelve explicit ones. `--away` is the direction the
 * room recedes in: black for a dark theme, white for a light one, which is
 * what lets one set of expressions serve both.
 */
function derived(kind) {
  const away = kind === 'light' ? '#ffffff' : '#000000'
  return [
    ['away', away],

    // Neutral ramp, foreground down to background.
    ['n1', mix(V('fg'), 88, V('bg'))],
    ['n2', mix(V('fg'), 72, V('bg'))],
    ['n3', mix(V('fg'), 56, V('bg'))],
    ['n4', mix(V('fg'), 38, V('bg'))],
    ['n5', mix(V('fg'), 22, V('bg'))],
    ['n6', mix(V('fg'), 12, V('bg'))],


    // The mascot.
    ['m-body', V('body')],
    ['m-gear', V('gear')],
    ['m-pad', V('pad')],
    ['m-eye', V('eye')],
    ['m-accent', V('accent')],

    // The booth he stands behind. Cold by rule: the accent belongs to things
    // that are lit, so hardware close to him stays neutral or it reads as
    // stray pieces of him.
    ['m-chrome-top', V('n3')],
    ['m-chrome', V('n5')],
    ['m-chrome-deep', mix(V('bg'), 55, V('away'))],
    ['m-chrome-hi', V('n4')],
    ['m-cap', V('fg')],
    ['m-cap-2', V('n2')],
    ['m-led-off', V('n5')],
    ['m-led-on', V('n2')],
    ['m-led-hot', V('fg')],

    // The room. A stepped wall crossing the background value, a floor lifted
    // off it so the crowd silhouettes read, and stacks pushed further away.
    ['m-wall-1', mix(V('bg'), 45, V('away'))],
    ['m-wall-2', mix(V('bg'), 80, V('away'))],
    ['m-wall-3', mix(V('bg'), 96, V('fg'))],
    ['m-wall-4', mix(V('bg'), 91, V('fg'))],
    ['m-floor', mix(V('bg'), 87, V('fg'))],
    ['m-stack', mix(V('bg'), 55, V('away'))],
    ['m-stack-in', V('bg')],
    ['m-grille', mix(V('bg'), 91, V('fg'))],
    ['m-truss-hi', mix(V('bg'), 87, V('fg'))],

    // Editor and syntax. Tokens separate by lightness rather than hue, which
    // keeps code readable without dragging in colours from outside the theme.
    ['cm-gutter', mix(V('mutedFg'), 55, V('bg'))],
    ['cm-line-bg', mix(V('fg'), 5, V('bg'))],
    ['cm-comment', mix(V('mutedFg'), 70, V('bg'))],
    // Syntax hues rotate around the theme's accent. One accent therefore yields
    // a whole readable palette, so the editor is genuinely colourful without any
    // theme having to hand-author a dozen more values, and every hue still
    // belongs to that theme.
    ['cm-keyword', V('accent')],
    ['cm-meta', V('accent')],
    ['cm-var', V('fg')],
    ['cm-punct', V('mutedFg')],
    ['cm-string', hue(kind, 132)],
    ['cm-number', hue(kind, 196)],
    ['cm-atom', hue(kind, 196)],
    ['cm-fn', hue(kind, 62)],
    ['cm-prop', hue(kind, -42)],
    ['cm-op', hue(kind, -18)],
    ['cm-def', hue(kind, 28)],
    ['cm-type', hue(kind, 100)],
    ['cm-tag', hue(kind, 160)],
    ['cm-select', mix(V('accent'), 24, 'transparent')],
    ['cm-bracket', mix(V('accent'), 26, 'transparent')],
    ['cm-bracket-line', mix(V('accent'), 55, 'transparent')],
    ['cm-playing', mix(V('accent'), 42, 'transparent')],
    ['cm-gutter-line', mix(V('fg'), 8, 'transparent')],
  ]
}

const block = (selector, t) => {
  const explicit = REQUIRED.map((k) => `  --mk-${k}: ${t[k]};`)
  const rest = derived(t.kind).map(([k, v]) => `  --mk-${k}: ${v};`)
  return `${selector} {\n  color-scheme: ${t.kind};\n${explicit.join('\n')}\n\n${rest.join('\n')}\n}`
}

const first = THEMES[0]
const css = `/**
 * GENERATED FILE - do not edit.
 *
 * Written by scripts/themes.mjs from src/lib/themes.json. Edit the JSON and run
 * \`pnpm themes\`, or just \`pnpm build\`, which runs the gate first and refuses
 * to regenerate from a palette that fails contrast.
 *
 * ${THEMES.length} themes: ${THEMES.map((t) => t.name).join(', ')}
 */

/* ${first.name} is also the default, so the first paint before any
   data-theme attribute is applied is a real theme rather than unstyled. */
${block(':root, :root[data-theme=\'' + first.name + '\']', first)}

${THEMES.slice(1).map((t) => block(`:root[data-theme='${t.name}']`, t)).join('\n\n')}
`

writeFileSync(OUT, css)
console.log(`\nwrote ${path.relative(ROOT, OUT)}  (${css.split('\n').length} lines)`)

/* ------------------------------------------------------- dangling vars ---- */

/**
 * Every `var(--...)` in src/ has to resolve to a token this file emits.
 *
 * An undefined custom property raises nothing. The declaration is invalid at
 * computed-value time and the element simply paints as though nothing was set,
 * so the page still renders and every test still passes. That is exactly how the
 * master level meter and the per-layer activity lights went blank when the
 * palette was namespaced to `--mk-*` and the old generic aliases were dropped:
 * three components wrote `var(--primary)` and `var(--muted)` from JS, which no
 * longer existed, and nothing anywhere complained.
 */
{
  const { readdirSync, statSync } = await import('node:fs')
  const ALLOWED = ['--mk-', '--color-', '--font-', '--radius', '--tw-']

  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return walk(full)
      return /\.(ts|tsx|css)$/.test(name) && !name.endsWith('themes.generated.css') ? [full] : []
    })

  const emitted = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]))
  const files = walk(path.join(ROOT, 'src'))

  // Variables the source defines for itself count as defined: --rack-w is a
  // layout value set inline on an element, not a palette token.
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/'?(--[\w-]+)'?\s*:/g)) emitted.add(m[1])
  }

  const offenders = new Set()
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1]
      if (emitted.has(name) || ALLOWED.some((p) => name.startsWith(p))) continue
      offenders.add(`${path.relative(ROOT, file)}  var(${name})`)
    }
  }

  if (offenders.size) {
    console.error(`\n${offenders.size} reference(s) to a custom property no theme defines:`)
    for (const o of offenders) console.error(`  ${o}`)
    console.error('\nAn undefined var paints as unset, so this fails silently in the browser.')
    process.exit(1)
  }
  console.log(`checked every var() in src/ against ${emitted.size} emitted tokens: none dangling`)
}
