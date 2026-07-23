# The Crate - real recorded sample packs

Verified working in this REPL (loaded, played, and heard through
`scripts/listen.mjs`). Built-in synth presets sound programmed; these are
recordings of real instruments and real rooms - reach for them whenever the
music should feel warm, organic, or human.

Call `samples()` once at the top of the code, then use the names with `s()`.
Loading is async: on a fresh browser tab the first cycle may be quiet while
one-shots download (each ~100-250 KiB); they drop in within a second or two.

---

## eddyflux/crate - lofi hip-hop drum crate (verified 2026-07)

```javascript
samples('github:eddyflux/crate')
```

Real one-shot drums with dust on them. Massive round-robin depth - use `:n`
variants so no two hits sound identical (see `/humanize`):

| Sound | Variants | Character |
|-------|----------|-----------|
| `crate_bd` | 53 | soft, thumpy kicks |
| `crate_sd` | 54 | warm snares, lots of personality |
| `crate_hh` | 49 | dusty closed hats |
| `crate_oh` | 34 | open hats |
| `crate_cp` | 37 | claps (real ones, not the cheesy `cp`) |
| `crate_perc` | 40 | misc percussion |
| `crate_sh` | 15 | shakers |
| `crate_rd` | 20 | rides |
| `crate_conga` / `crate_bongo` / `crate_djembe` | 11/4/4 | hand drums |
| `crate_rim` / `crate_stick` / `crate_clave` / `crate_block` | 3/6/4/7 | clicks and ticks |
| `crate_cr` | 16 | crashes |
| `crate_tb` | 8 | tambourine |
| `crate_bell` | 2 | bells |

```javascript
// A groove where every hit is a different real recording
$: s("crate_bd:3 ~ crate_sd:12 ~").gain(.9)
$: s("crate_hh:5 crate_hh:11 crate_hh:5 crate_hh:20".fast(2))
  .gain("[.7 .4 .6 .45]*2").swingBy(1/6, 8)
```

## tidalcycles/dirt-samples - the classic Tidal library (verified 2026-07)

```javascript
samples('github:tidalcycles/dirt-samples')
```

218 sound families. The essential shelves:

**Breaks (real played drums - instant human feel):**
`breaks165` `breaks125` `breaks152` `breaks157` `amencutup` (26 slices of the Amen)

```javascript
$: s("breaks165").loopAt(2).gain(.7)         // fit the break to 2 cycles
$: s("breaks125").chop(8).rev()               // chop and mangle
$: s("amencutup:0 amencutup:3 amencutup:1 amencutup:7")  // resequence the Amen
```

**Real kits & percussion:** `gretsch` (real drum kit), `jazz`, `realclaps`,
`tabla` `tabla2` (multi-hit), `hand`, `east`, `world`

**Instruments with air in them:** `sax`, `sitar`, `gtr` (electric guitar),
`juno` (Juno-60 chords), `moog` (bass one-shots), `arpy`, `stab` (rave stabs),
`pluck`, `notes` (Rhodes-ish)

**Voices & texture:** `speech`, `speakspell`, `numbers`, `birds`, `wind`,
`fire`, `bubble`, `coins`, `space`, `breath`, `crow`, `insect`, `pebbles`

**Vintage machines (sampled, crunchier than .bank()):** `808` `909` `808bd`
`808sd` `808oh` `linnhats` `drumtraks` `dr55` `sequential` `hoover` (rave)

---

## When to reach for the crate

- **Lofi / hip-hop / organic house** → `crate_*` everything
- **Breakbeat / jungle / anything needing swing you can't program** → `breaks*`, `amencutup`
- **Warm textures behind synths** → `birds`, `wind`, `speech` low in the mix
- **A solo voice with a body** → `sax`, `sitar`, `gtr` over a pad
- Layer real one-shots UNDER synth drums to de-plastic them: same pattern,
  `crate_sd` at .3 beneath a 909 snare

Genre character still applies (see the genre guide in sound-catalog.md):
techno stays synth-family; the crate shines where warmth is the point.
