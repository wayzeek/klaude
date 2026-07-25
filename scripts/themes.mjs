#!/usr/bin/env node
/**
 * moltek theme contrast gate.
 *
 * Every theme must prove it is legible before it ships. Ratios are WCAG 2.1
 * relative-luminance contrast. Exits non-zero on any gated failure, so `pnpm
 * build` refuses to produce a bundle with an illegible palette.
 *
 * GATED - a theme that fails any of these does not ship:
 *   fg / bg      >= 4.5   body text (AA)
 *   muted / bg   >= 4.5   secondary labels are still text
 *   accent / bg  >= 3.0   non-text UI (WCAG 1.4.11)
 *   body / bg    >= 3.0   the mascot has to read against the room
 *   eye / body   >= 3.0   eyes have to read against the body
 *   gear / body  >= 2.0   the cup has to separate from the body
 *   gear / bg    >= 3.0   the band and both arms sit above the head, on the room
 *   pad / gear   >= 1.25  the ear pad is a recess inside the cup, so it only
 *                         ever borders the cup. Subtle on purpose, and not
 *                         checked against the body, which it never touches.
 *
 * ADVISORY - measured and shown, not gated:
 *   surface / bg   Panel separation here is carried by --border, not by the
 *                  fill. ember's #141413 / #1c1c1a is 1.08, so the console
 *                  panel's fill does nothing without its border.
 *   border / bg    What actually separates panels. Wants ~1.5 or better.
 *
 * `ember` must stay identical to production: src/app/globals.css for the UI
 * tokens, src/lib/moltek-sprite.ts for MOLTEK_BODY, GEAR and GEAR_PAD. A gate
 * measuring anything else is measuring a fiction.
 */

const THEMES = [
  // ember mirrors production. --border is rgb(240 238 230 / 12%) in
  // globals.css; #2e2e2c is that composited over slate, since a contrast ratio
  // needs an opaque value.
  { name: 'ember', kind: 'dark', note: "Today's palette. Mascot body lifted off #dd775b so it clears the floor.",
    bg:'#141413', surface:'#1c1c1a', editor:'#100f0e', fg:'#f0eee6', muted:'#87867f',
    accent:'#d97757', body:'#E0714F', gear:'#D5D1C6', pad:'#B0AEA5', eye:'#000000',
    border:'#2e2e2c' },

  { name: 'concrete', kind: 'dark', note: 'Grey room, the equipment carries the colour. The booth look.',
    bg:'#1a1a19', surface:'#262625', editor:'#131312', fg:'#ecebe6', muted:'#9d9d95',
    accent:'#c6ff3d', body:'#9a9a93', gear:'#c6ff3d', pad:'#9ecc2f', eye:'#000000',
    border:'#3d3d3a' },

  { name: 'sodium', kind: 'dark', note: 'Street lighting at 4am. Warmest, and the highest headroom of the set.',
    bg:'#15130f', surface:'#221e18', editor:'#110f0c', fg:'#f2ede2', muted:'#a09a8c',
    accent:'#e8a33d', body:'#e0a03c', gear:'#7a7369', pad:'#5d5750', eye:'#000000',
    border:'#3e372c' },

  { name: 'steel', kind: 'dark', note: 'Cold industrial. Calmest of the dark set, reads studio more than club.',
    bg:'#101416', surface:'#1b2327', editor:'#0d1113', fg:'#e6eef2', muted:'#93a3ab',
    accent:'#6fb3cc', body:'#79aec4', gear:'#5f6a73', pad:'#48515a', eye:'#000000',
    border:'#33403f' },

  { name: 'hazard', kind: 'dark', note: 'Signage orange on near-black. Loudest dark theme.',
    bg:'#141312', surface:'#211f1c', editor:'#100f0e', fg:'#f2efe9', muted:'#9e9a92',
    accent:'#f25c05', body:'#f26a1b', gear:'#e9e6dd', pad:'#c0bcb2', eye:'#000000',
    border:'#3c3833' },

  { name: 'uv', kind: 'dark', note: 'Blacklight violet. Synthetic on purpose.',
    bg:'#100e18', surface:'#1c1829', editor:'#0c0a12', fg:'#eae7f5', muted:'#9a95b0',
    accent:'#9b7cff', body:'#8f70f7', gear:'#c9c4d6', pad:'#a29cb5', eye:'#000000',
    border:'#37325a' },

  { name: 'oxblood', kind: 'dark', note: 'Deep red room. Deep oxblood works as the accent; the body has to sit brighter.',
    bg:'#160f10', surface:'#241a1b', editor:'#120c0d', fg:'#f0e7e7', muted:'#a08e90',
    accent:'#c94a5e', body:'#c9485c', gear:'#c8c1c2', pad:'#a3999b', eye:'#000000',
    border:'#42302f' },

  { name: 'bone', kind: 'light', note: 'The one light theme. Body sits mid-tone: dark enough for the paper, light enough for black eyes.',
    bg:'#ece9e1', surface:'#ddd9cf', editor:'#f5f3ed', fg:'#1a1a18', muted:'#5e5d57',
    accent:'#a8382a', body:'#b5533c', gear:'#3d3d3a', pad:'#5a5a55', eye:'#000000',
    border:'#b8b5aa' },
]

const CHECKS = [
  { label:'fg / bg',      a:'fg',     b:'bg',   min:4.5 },
  { label:'muted / bg',   a:'muted',  b:'bg',   min:4.5 },
  { label:'accent / bg',  a:'accent', b:'bg',   min:3.0 },
  { label:'body / bg',    a:'body',   b:'bg',   min:3.0 },
  { label:'eye / body',   a:'eye',    b:'body', min:3.0 },
  { label:'gear / body',  a:'gear',   b:'body', min:2.0 },
  { label:'gear / bg',    a:'gear',   b:'bg',   min:3.0 },
  { label:'pad / gear',   a:'pad',    b:'gear', min:1.25 },
  { label:'surface / bg', a:'surface',b:'bg',   advisory:true },
  { label:'border / bg',  a:'border', b:'bg',   advisory:true },
]

const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const lum = h => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
const ratio = (x, y) => {
  const a = lum(x), b = lum(y)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

let failures = 0
const results = THEMES.map(t => {
  const rows = CHECKS.map(c => {
    const r = ratio(t[c.a], t[c.b])
    const pass = c.advisory ? null : r >= c.min
    if (pass === false) failures++
    return { ...c, r, pass }
  })
  return { theme: t, rows, ok: rows.every(r => r.pass !== false) }
})

const W = 14
console.log('\nmoltek theme contrast gate\n' + '='.repeat(66))
for (const { theme, rows, ok } of results) {
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${theme.name}  (${theme.kind})`)
  for (const r of rows) {
    const verdict = r.advisory ? ' info ' : r.pass ? '  ok  ' : ' FAIL '
    const bound = r.advisory ? '   advisory' : `min ${r.min.toFixed(2)}`
    console.log(
      `      ${r.label.padEnd(W)} ${r.r.toFixed(2).padStart(6)} : 1   ${bound}  ${verdict}`)
  }
}
console.log('\n' + '='.repeat(66))
console.log(failures === 0
  ? `all ${THEMES.length} themes pass every gated condition`
  : `${failures} failing gated condition(s) across ${results.filter(r => !r.ok).length} theme(s)`)

/* ---------------------------------------------------------------- html ---- */

/** Real sprite roles, mirroring BODY / HANDS / LEGS / EYES / CANS / CUP_OFF. */
const SPRITE = [
  { x:11, y:0,   w:85, h:65, role:'body' },
  { x:0,  y:21,  w:22, h:23, role:'body' },
  { x:85, y:21,  w:22, h:23, role:'body' },
  { x:11, y:60,  w:11, h:26, role:'body' },
  { x:32, y:60,  w:11, h:26, role:'body' },
  { x:64, y:60,  w:11, h:26, role:'body' },
  { x:85, y:60,  w:11, h:26, role:'body' },
  { x:21, y:11,  w:11, h:11, role:'eye'  },
  { x:75, y:11,  w:11, h:11, role:'eye'  },
  { x:20, y:-10, w:67, h:7,  role:'gear' },
  { x:14, y:-7,  w:6,  h:10, role:'gear' },
  { x:87, y:-7,  w:6,  h:10, role:'gear' },
  { x:5,  y:1,   w:14, h:25, role:'gear' },
  { x:8,  y:6,   w:8,  h:15, role:'pad'  },
  { x:91, y:-10, w:14, h:25, role:'gear' },  // CUP_OFF + CUP_OFF_OFFSET
  { x:94, y:-5,  w:8,  h:15, role:'pad'  },
]
const sprite = (t, h) => {
  const px = h / 104
  const r = SPRITE.map(o =>
    `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${t[o.role]}"/>`).join('')
  return `<svg width="${Math.round(115 * px)}" height="${Math.round(h)}" viewBox="-4 -16 115 104" shape-rendering="crispEdges">${r}</svg>`
}

const card = ({ theme: t, rows, ok }) => `
<div class="card" style="--bg:${t.bg};--sf:${t.surface};--ed:${t.editor};--fg:${t.fg};--mu:${t.muted};--ac:${t.accent};--bd:${t.border}">
  <div class="hd">
    <span class="nm">${t.name}</span>
    <span class="kd">${t.kind}</span>
    <span class="vd ${ok ? 'p' : 'f'}">${ok ? 'passes' : 'fails'}</span>
  </div>
  <div class="room">
    <div class="chrome">
      <span class="dot"></span><span class="lbl">transport</span>
      <span class="meter"><i></i><i></i><i></i><i></i><i class="off"></i></span>
    </div>
    <div class="floor">${sprite(t, 96)}${sprite(t, 42)}</div>
    <div class="ed">$: s("bd*4").bank("RolandTR909")</div>
  </div>
  <div class="note">${t.note}</div>
  <table>${rows.map(r => `<tr class="${r.pass === false ? 'bad' : r.advisory ? 'adv' : ''}">
    <td>${r.label}</td><td class="n">${r.r.toFixed(2)}</td>
    <td class="m">${r.advisory ? 'advisory' : 'min ' + r.min}</td>
    <td class="v">${r.advisory ? '·' : r.pass ? 'ok' : 'FAIL'}</td></tr>`).join('')}</table>
</div>`

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>moltek — themes, contrast checked</title><style>
  body{margin:0;padding:28px 24px 56px;background:#f0eee6;color:#141413;
       font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  h1{font-size:15px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;margin:0 0 4px}
  .sub{color:#87867f;margin:0 0 22px;max-width:900px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .card{border:1px solid #c6c4ba;background:#e8e6dc;padding:0 0 10px}
  .hd{display:flex;align-items:baseline;gap:8px;padding:9px 11px 8px}
  .nm{font-size:14px;font-weight:600}
  .kd{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#87867f}
  .vd{margin-left:auto;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:1px 6px}
  .vd.p{background:#141413;color:#f0eee6}
  .vd.f{background:#b8452e;color:#fff}
  .room{background:var(--bg);padding:0}
  .chrome{display:flex;align-items:center;gap:7px;padding:6px 9px;border-bottom:1px solid var(--bd)}
  .dot{width:8px;height:8px;background:var(--ac);display:inline-block}
  .lbl{color:var(--mu);font-size:10px;letter-spacing:.1em;text-transform:uppercase}
  .meter{margin-left:auto;display:flex;gap:2px}
  .meter i{width:7px;height:8px;background:var(--ac);display:inline-block}
  .meter i.off{background:var(--mu);opacity:.35}
  .floor{display:flex;align-items:flex-end;justify-content:center;gap:16px;padding:14px 8px 10px}
  .floor svg{display:block}
  .ed{background:var(--ed);color:var(--fg);font-size:10px;padding:6px 9px;white-space:nowrap;overflow:hidden}
  .note{color:#3d3d3a;font-size:11.5px;padding:9px 11px 6px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  td{padding:2px 11px;border-top:1px solid #d8d5cb;color:#3d3d3a}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  td.m{color:#87867f}
  td.v{text-align:right;font-weight:600}
  tr.bad td{background:#f6dcd6;color:#8c2f1f}
  tr.adv td{color:#8a8880}
</style></head><body>
<h1>moltek — themes, contrast checked</h1>
<p class="sub">Each theme rendered as a miniature studio: chrome strip with accent meter, the mascot on the floor, an editor line. Every colour pair that matters is measured against a WCAG threshold below the swatch. ${failures === 0 ? 'All themes pass every gated condition.' : failures + ' condition(s) still failing.'}</p>
<div class="grid">${results.map(card).join('')}</div>
</body></html>`

if (process.argv.includes('--html')) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('.moltek', { recursive: true })
  writeFileSync('.moltek/themes.html', html)
  console.log('\nwrote .moltek/themes.html')
}

process.exitCode = failures ? 1 : 0
