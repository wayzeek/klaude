---
name: strudel
description: Create music with Strudel live coding syntax. Use when the user asks to play a song, make music, create beats, patterns, or sounds.
allowed-tools: Bash(curl *), Bash(say *)
---

# Strudel Reference

Quick reference for Strudel syntax. Not exhaustive - experiment and discover.

**Full sound listings** (all drum machines, GM instruments, wavetables, multi-sampled instruments): read `references/sound-catalog.md` in this skill's directory.

**Real recorded samples** (verified external packs: lofi drum crate, real breaks, sax/sitar/guitar, voices, texture): read `references/crate.md` - reach for these whenever the music should feel warm or human.

---

## The Basics

Everything happens in **cycles** (≈2 seconds by default).

```javascript
$: s("bd")           // One kick per cycle
$: s("bd*4")         // Four kicks per cycle
$: s("bd sd bd sd")  // Sequence: kick-snare-kick-snare
$: s("bd*4, hh*8")   // Layers: kick AND hats together
```

---

## Mini-Notation Cheatsheet

| Symbol | Meaning | Example |
|--------|---------|---------|
| `*n` | Repeat n times | `hh*4` |
| `/n` | Slow down n times | `[c d e f]/2` |
| `[ ]` | Group (subdivide) | `[bd sd] hh` |
| `< >` | Alternate each cycle | `<bd sd cp>` |
| `{ }` | Polymeter (layers rotate at same step rate) | `{bd sd, hh hh hh}` |
| `%n` | Steps per cycle for polymeter | `{c eb g c2}%8` |
| `,` | Play in parallel (stack) | `bd, hh*2` |
| `~` or `-` | Rest (silence) | `bd ~ sd ~` |
| `?` | 50% chance to play | `hh*8?` |
| `(n,m)` | Euclidean rhythm | `bd(3,8)` |
| `@n` | Elongate (weight) | `c@3 e` |
| `!n` | Replicate | `bd!3 sd` |
| `\|` | Random choice | `bd \| sd \| cp` |
| `:n` | Sample number | `hh:2` |
| `..` | Range | `n("0 .. 7")` |

**Polymeter** is a distinct rhythmic device from `[ ]` subdivision: each layer keeps its own length and they rotate against each other. `{bd sd, hh hh hh}` plays a 2-step and a 3-step loop at the same step rate — they realign every 6 steps.

---

## Sounds

**Basic Drums:** `bd` `sd` `hh` `cp` `oh` `rim` `lt` `mt` `ht` `cr` `rd` `cb`

**Drum Banks (classic):** `.bank("RolandTR909")` `.bank("RolandTR808")` `.bank("RolandTR707")`

**Drum machines as samples:** `s("tr808_bd tr808_sd tr808_hh")` or with `:n` for variations: `s("tr808_bd:0 tr808_bd:5")`. Highlights: `tr808` (hip-hop), `tr909` (house/techno), `linndrum` (80s pop), `dmx` (early hip-hop), `sp12` (dusty sampling), `mpc60` (hip-hop). **Full catalog with variation counts: `references/sound-catalog.md`.**

**Basic Waveforms:**
| Sound | Alias | Description |
|-------|-------|-------------|
| `sine` | `sin` | Pure tone, smooth |
| `triangle` | `tri` | Soft, flute-like |
| `sawtooth` | `saw` | Bright, buzzy - classic synth |
| `square` | `sqr` | Hollow, clarinet-like |
| `supersaw` | - | Detuned saws - huge pads |
| `pulse` | - | Variable width square |

**Noise:** `white` (hiss) `pink` (warmer) `brown` (rumble) — great for risers, rain, air.

**GM Instruments (highlights):** `gm_piano` `gm_epiano1` (Rhodes) `gm_acoustic_bass` `gm_synth_bass_1` `gm_pad_warm` `gm_pad_halo` `gm_string_ensemble_1` `gm_voice_oohs` `gm_choir_aahs` `gm_tenor_sax` `gm_trumpet` `gm_flute` `gm_koto` `gm_vibraphone` `gm_music_box` — hundreds more in the catalog.

**Multi-sampled instruments (highlights):** `piano` `steinway` `sax` `harmonica` `kalimba` `marimba` `timpani` `conga` `bongo` `darbuka` `gong` `dantranh` — full list in the catalog.

```javascript
// Switch between sounds (space = alternate)
note("c d e f").sound("piano gm_electric_guitar_muted")

// Stack sounds (comma = layer together)
note("c d e f").sound("piano, gm_electric_guitar_muted")

// FM Synthesis
.fm(4)            // FM modulation index
.fmh(2)           // FM harmonicity ratio

// Vibrato
.vib(4)           // Vibrato speed (hz)
.vibmod(0.5)      // Vibrato depth (semitones)
```

---

## Custom Samples

Load sample packs from GitHub or any URL with `samples()` — call it once at the top, then use the names with `s()`.

```javascript
// GitHub repo with a strudel.json manifest
samples('github:tidalcycles/dirt-samples')
$: s("moog:2 casio:1")

// Map names to files on any host
samples({
  bd: 'bd/BT0AADA.wav',
  sd: 'sd/rytm-01-classic.wav',
}, 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/')
```

Tested packs with highlight lists live in `references/crate.md`.

---

## Notes

```javascript
note("c4 e4 g4")                 // Letter notation
n("0 2 4 7").scale("C:minor")    // Scale degrees
n("0 .. 7").scale("C:minor")     // Range shorthand: 0 1 2 3 4 5 6 7
chord("<Cm7 Fm7>").voicing()     // Chords
```

---

## Scales

Use `n()` with `.scale()` - any number will sound good in the scale.

**Common scales:**
- `C:major` - happy, bright
- `A:minor` - sad, emotional
- `D:dorian` - jazzy, soulful
- `G:mixolydian` - bluesy, groovy
- `A:minor:pentatonic` - safe, universal
- `F:major:pentatonic` - bright, easy

**With octave:** `A2:minor` (starts at A2)

**Automate scales:**
```javascript
n("0 2 4 7").scale("<C:major D:mixolydian>/4")
```

For which scale/progression fits which mood, load the `/theory` skill.

---

## Sampler Controls

```javascript
.speed(2)         // Playback speed (negative = reverse)
.begin(0.25)      // Start point (0-1)
.end(0.75)        // End point (0-1)
.clip(0.5)        // Duration multiplier (alias: .legato)
.cut(1)           // Cut group (stops others in same group)
.loopAt(4)        // Fit sample to n cycles
.fit()            // Fit sample to event duration

// Slicing
.chop(8)          // Chop into n pieces
.slice(8, "0 1 2 3 4 5 6 7")  // Slice and reorder
.splice(8, "0 1 2 3")         // Like slice, speed-adjusted
.striate(6)       // Interleave n progressive slices across repeats - texture/glitch
```

`.clip(1)` ends each note exactly when the next starts; `.clip(0.5)` gives detached, punchy notes; `.clip(2)` overlaps. Use low clip values to avoid washy, smeared sustains.

---

## Envelopes

```javascript
// Amplitude ADSR
.attack(0.1)      // Attack time (seconds)
.decay(0.2)       // Decay time
.sustain(0.5)     // Sustain level (0-1)
.release(0.3)     // Release time

// Filter envelope (add to lpf)
.lpenv(4)         // Envelope depth
.lpa(0.1)         // Filter attack
.lpd(0.2)         // Filter decay

// Pitch envelope
.penv(12)         // Pitch envelope depth (semitones)
```

---

## Effects

```javascript
// Filters
.lpf(800)         // Low-pass filter
.hpf(200)         // High-pass filter
.lpq(10)          // Resonance
.vowel("a e i o") // Vowel filter

// Space
.room(0.5)        // Reverb amount
.size(4)          // Reverb size
.delay(0.5)       // Delay amount
.delaytime(0.25)  // Delay time
.delayfb(0.5)     // Delay feedback

// Dynamics
.gain(0.8)        // Volume
.pan(0.5)         // Stereo position
.distort(0.2)     // Distortion
.shape(0.3)       // Waveshaping
.crush(4)         // Bit crush
.coarse(4)        // Sample-rate reduction
.phaser(2)        // Sweeping phaser (speed in hz)
```

---

## Echo

Decaying repeats of each event — distinct from `.delay()` (a wet/dry effect). Great for fills and breakdown tails.

```javascript
s("bd sd").echo(3, 1/6, 0.8)          // 3 repeats, 1/6 cycle apart, 0.8 feedback
n("0 4 7").echoWith(4, 1/8, (p, i) => p.add(i * 12))  // Transform each repeat
```

---

## Signals (Continuous Patterns)

```javascript
// Waveforms (0-1)
sine              // Smooth oscillation
saw               // Ramp up
tri               // Triangle
square            // Square wave
cosine            // Cosine

// Random
rand              // Random 0-1
perlin            // Smooth random
irand(8)          // Random integer 0-7

// Modifiers
.range(200, 2000) // Scale to range
.slow(8)          // Slow the signal
.segment(16)      // Sample a signal into n discrete steps

// Example: filter sweep
.lpf(sine.range(200, 2000).slow(8))

// Example: LFO becomes a melody
n(sine.range(0, 7).segment(8)).scale("C:minor")
```

---

## Pattern Functions

```javascript
// Time
.fast(2)          // Double speed
.slow(2)          // Half speed
.early(0.25)      // Shift earlier
.late(0.25)       // Shift later

// Structure
.rev()            // Reverse
.palindrome()     // Forward then backward
.iter(4)          // Shift start each cycle
.ply(2)           // Repeat each event

// Layering
.off(1/8, x=>x.add(7))    // Offset copy + transform
.layer(x=>x.add(7))       // Layer with transform
.superimpose(rev)         // Add reversed copy
.jux(rev)                 // Stereo: L=normal, R=reversed

// Conditional
.every(4, fast(2))        // Every nth cycle
.lastOf(4, x=>x.rev())    // Last of every 4 cycles - great for fills
.firstOf(4, x=>x.hpf(800))  // First of every 4 cycles
.chunk(4, x=>x.crush(4))  // Transform a different quarter each cycle
.sometimes(rev)           // 50% chance
.often(fast(2))           // 75% chance
.rarely(rev)              // 25% chance
.struct("x ~ x ~")        // Apply rhythmic structure
.mask("1 0 1 1")          // Silence where 0

// Randomness
.degrade()                // Remove 50% randomly
.degradeBy(0.3)           // Remove 30% randomly
choose("bd", "sd", "cp")  // Pick one randomly
```

---

## Silence & Kill Switch

```javascript
silence                   // The empty pattern - use as a placeholder
$: s("hh*8").hush()       // Mute one layer (keep the code, kill the sound)
hush()                    // Stop EVERYTHING - instant dramatic cut
```

`hush()` on its own line kills all sound — useful for hard stops before a drop.

---

## Tempo & Duration

```javascript
setcpm(130/4)     // 130 BPM (4/4 time)
setcpm(180/3)     // 180 BPM waltz (3/4 time)
setcps(0.5)       // 0.5 cycles per second (= 120 BPM)
```

### Duration Math

```
cps = BPM / 60 / 4
cycles = minutes × 60 × cps
```

Full BPM/duration cycle tables live in the `/compose` skill. Sum your `arrange()` entries to hit the target.

---

## Chord Voicing & Progressions

```javascript
// Define a progression (angle brackets = one chord per cycle)
let prog = "<Cm7 Fm7 Abmaj7 G7>"

// Basic chord with voicing
chord(prog).voicing().s("piano")

// .anchor() sets the reference note for voicings
chord(prog).anchor("C3").voicing()     // Bass register
chord(prog).anchor("C5").voicing()     // High register

// .mode() controls whether the voicing sits below or above the anchor
chord(prog).anchor("C4").mode("above").voicing()
chord(prog).anchor("C4").mode("below").voicing()

// Dynamic anchors (changes over time)
chord(prog).anchor("<C3@8 C4@4>").voicing()

// .ply(n) repeats each chord n times per cycle
chord(prog).ply(3).gain("0.8 0.3 0.4")  // Waltz: strong-weak-weak
chord(prog).ply(4).gain("1 0.5 0.7 0.5") // House groove

// .arp() arpeggiate through chord tones by index
chord(prog).voicing().arp("0 1 2 3")     // Root, 2nd, 3rd, 4th
chord(prog).voicing().arp("0 2 4 7")     // Wider intervals
chord(prog).ply(6).voicing().arp("0 1 2 3 5 7").rev()  // Descending

// Add octave jumps to arpeggios
chord(prog).voicing().arp("0 1 2 3".add("[12 |0|0]*4"))

// Extract just the root for bass
chord(prog).anchor("C2").voicing().arp("0")
```

For progression ideas, borrowed chords, and which harmony fits which emotion, load `/theory`.

---

## Sidechain Ducking

```javascript
// Make elements duck (lower volume) when another orbit plays
.duckorbit(1)      // Duck when orbit 1 plays
.duckdepth(0.3)    // How much to duck (0-1)

// Classic house sidechain: chords pump with kick
let kick = s("bd").orbit(1)
let chords = chord("<Cm7 Fm7>").voicing()
  .duckorbit(1).duckdepth(0.4)
  .s("piano")

stack(kick, chords)
```

---

## Timeline Arrangements

When user asks to **"arrange"**, **"create a track"**, **"make a song"**, or specifies a duration → use `arrange()`.

```javascript
arrange(
  [4, intro],
  [8, build],
  [8, drop],
  [4, outro],
)
```

**See the `/compose` skill for full track structure, duration math, and genre examples.**

---

## Probabilistic Variations

```javascript
// .sometimesBy(probability, transform)
.sometimesBy(0.3, x => x.crush(4))   // 30% chance bitcrush
.sometimesBy(0.5, x => x.rev())      // 50% chance reverse

// Create variation helper functions
const degrade = (x, freq = 0.5) => x
  .sometimesBy(freq, x => x.clip("0.5|0.75"))
  .sometimesBy(freq, x => x.ply("2|3"))

// Use in arrangements
arrange(
  [8, degrade(arpeggio)],
  [8, degrade(arpeggio, 0.25)],  // Less degradation
)
```

---

## Transposition

```javascript
.trans(12)    // Up one octave (12 semitones)
.trans(-5)    // Down a fourth
.trans(3)     // Up a minor third (key change!)

// Dramatic ending: transpose up
arrange(
  [8, melody],
  [8, melody.trans(3)],  // Key change!
  [4, melody.trans(3).room(1)],
)
```

---

## Genre → Instrument Guide

Which drums/bass/keys/lead fit each genre: see the table at the end of `references/sound-catalog.md`.

---

## Method Syntax (IMPORTANT)

**All methods need parentheses.** Even methods with no arguments.

```javascript
// ✅ CORRECT
.rev()
.palindrome()
.degrade()

// ❌ WRONG - will cause errors
.rev
.palindrome
.degrade
```

### Higher-Order Functions

Functions like `jux`, `sometimes`, `every`, `off` take a **function** as argument. Two valid forms:

```javascript
// ✅ Standalone transform functions work directly
.jux(rev)
.every(4, fast(2))
.superimpose(rev)

// ✅ Arrow functions - the safest general form, required for chained transforms
.jux(x => x.rev())
.sometimes(x => x.speed(-1))
.every(4, x => x.fast(2))
.off(0.125, x => x.add(7))
.jux(x => x.rev().speed(0.5))   // Multi-transform NEEDS an arrow function
```

When in doubt, use an arrow function — it always works. `.rev` without parentheses inside a chain is still an error; the standalone form only works when passing the bare function name (`jux(rev)`, not `.jux(.rev)`).

---

## Common Mistakes to Avoid

1. **Don't forget parentheses on chained methods** - `.rev()` not `.rev`.
2. **Use arrow functions for multi-step transforms** - `.jux(x => x.rev().speed(0.5))`.
3. **Don't over-simplify rhythms** - `"bd*4, ~ sd ~ sd, hh*8"` is a full groove. Don't reduce it to just `"bd"`.
4. **Don't use invalid sound names** - Stick to documented sounds (drums, GM instruments, synths).
5. **Don't forget `setcpm()`** - Patterns need tempo to play correctly.
6. **Don't create empty patterns** - Always include musical content.
7. **Don't ignore layers** - Use `stack()` to build rich, full arrangements.
8. **Don't fight the cycle** - Work with the timing, not against it.

---

## MIDI / OSC Output

Strudel can drive external gear: `.midi()` sends notes via WebMIDI, `.osc()` sends OSC messages (needs SuperDirt/sidecar). Only relevant if the user asks to connect hardware or a DAW.

---

## Visual Feedback

Always make music visible. Use `_` prefix for inline visuals: `._pianoroll()`, `._spiral()`, `._scope()`, `._spectrum()`, `._pitchwheel()`, `._punchcard()`.

**Load the `/visuals` skill for options, colors, and presets.**

---

## Philosophy

**Texture first. Melody emerges. Drums are the reward.**

Stay in key. Variations, not new ideas. Let it breathe.

Use `.scale()` to stay cohesive.

Experiment freely. Trust your ears.
