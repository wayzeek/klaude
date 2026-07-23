---
name: humanize
description: House rules for making Strudel patterns feel played rather than programmed - swing, ghost notes, velocity, fills, drift, stereo width, and honest gain staging. Load whenever composing or performing music.
---

# Humanize

Machine-perfect timing is the loudest "this was made by software" tell.
A human drummer never plays the same bar twice: hits land slightly off-grid,
at different strengths, with ghost notes between them and a fill when the
phrase turns around. These are the house rules for faking a pulse.

**The rule of three: every pattern gets at least three of these treatments,
and something in the mix is always drifting.** All techniques below are
verified against this REPL.

---

## 1. Time - nothing lands exactly on the grid

```javascript
// Swing: the single highest-impact humanizer. 1/6 = subtle push, 1/3 = heavy shuffle
s("hh*8").swingBy(1/6, 8)     // shift every off-8th by a 1/6 of a step
s("rim*4").swing(4)           // shorthand: swingBy(1/3, 4)

// Micro-timing: a few milliseconds of lean. Keep values under ~.01
s("bd*4").late("[0 .006]*2")          // beats 2 and 4 drag slightly (lazy)
s("hh*8").early("[0 .004]*4")         // hats push ahead (excited)
```

Give different layers different leans - a kick that sits, hats that push,
a snare that drags. That tension between layers IS the groove.

## 2. Loudness - accents, ghosts, and breath

```javascript
// Accent patterns: loud-soft-medium-soft is how humans actually hit things
s("hh*8").gain("[.9 .5 .75 .55]*2")

// Ghost notes: near-silent hits between the real ones (the soul of a drum groove)
s("sd:3*8").gain("[0 .18]*4").degradeBy(.4)    // whispering snares, half missing

// Velocity phrasing on melodic lines - phrase ends softer
note("c2 g1 c2 eb2").velocity("<.8 .65 .75 .7>")

// Slow breathing: nothing stays at constant volume
.gain(perlin.range(.6, .8).slow(3))
```

## 3. Variation - never the same bar twice

```javascript
.degradeBy(.08)                        // drop ~8% of hat hits randomly
.sometimesBy(.15, x => x.speed(1.06))  // occasional slightly-different hit
.sometimesBy(.2, x => x.ply(2))        // occasional double-hit
s("hh:0 hh:1 hh:2 hh:1")               // round-robin sample variants - no two hits identical
```

## 4. Phrase awareness - fills and turnarounds

Humans mark the phrase. Every 4 or 8 bars, something acknowledges the loop:

```javascript
.lastOf(4, x => x.degradeBy(.5))       // thin out at the turnaround
.lastOf(8, x => x.fast(2))             // double-time fill into the next phrase
.every(8, x => x.hpf(600))             // one bar of tension every 8
.off(1/8, x => x.add(12).gain(.3))     // quiet octave echo answers the line
"<0 3 7 [5 10]>"                       // melodies that alternate endings per cycle
```

## 5. Drift - the mix slowly moves underneath everything

```javascript
.lpf(perlin.range(1200, 3000).slow(8))   // filter wanders like a hand on the knob
.pan(sine.range(.15, .85).slow(4))       // slow stereo movement
.delayfb(perlin.range(.2, .4).slow(16))  // even effects breathe
```

## 6. Width - a band stands in a room, not in a point

Measured reality: gentle pan patterns barely register. Be decisive.

```javascript
s("hh*8").pan("0.35 0.65")             // hats alternate sides
s("rim*2").pan(.3)                     // place each percussion voice somewhere
chord("<Cm7 Fm9>").voicing().jux(x => x.rev())   // keys hard-wide, L forward / R mirrored
.off(1/8, x => x.add(12).gain(.3).pan(.8))       // echoes answer from the other side
```

Keep kick and bass centered (mono low end is correct); spread everything else.

## 7. Gain staging - measured, not guessed

Recorded and analyzed through the REPL's own ears (`scripts/listen.mjs`).
The old habit of quiet hats + default-gain bass measures as a dark, buried,
"underwater" mix: high-mid energy 40+ dB below the bass.

| Layer | Gain | Why |
|-------|------|-----|
| Sawtooth/square bass (lpf'd) | **.3-.4, always set explicitly** | default gain (.8) drowns the entire mix |
| Kick | .7-.9 | |
| Hats/percussion | **.5-.9** | they carry the brightness; buried hats = dull mix |
| Keys/leads | .6-.8 | melodic content must sit above the bass, not under it |
| Ghost notes | .12-.2 | felt, not heard |

Healthy targets from the analyzer: high-mid TILT between about -10 and -28
dB/Hz; mid band well above -20; no clipping (if clipping is flagged, pull
the two loudest layers down ~15% and listen again).

---

## Checklist before calling a groove done

- [ ] Swing or micro-timing on at least the hats
- [ ] Accent pattern or velocity phrasing on every rhythmic layer
- [ ] Ghost notes somewhere
- [ ] A fill or turnaround marker every 4-8 bars
- [ ] One thing drifting (perlin filter, breathing gain, wandering pan)
- [ ] Layers panned into places; keys widened
- [ ] Bass gain set explicitly, hats loud enough to read as bright
- [ ] Verified with `node scripts/listen.mjs` - fix what the NOTES flag
