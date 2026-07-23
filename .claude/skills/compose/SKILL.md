---
name: compose
description: Create full arranged tracks with timeline structure. Use when user asks to "compose", "create a track", "make a song", or specifies a duration.
allowed-tools: Bash(curl *), Bash(node scripts/*), Write
---

# Compose - Full Track Compositions

**Load `/strudel` first** for syntax (notes, sounds, effects, patterns). Load `/humanize` for feel (swing, ghosts, fills, drift, gain staging) - a composition without it sounds programmed. Load `/theory` when choosing harmony and emotional structure.

Sound-check with `node scripts/listen.mjs 10` once the core groove exists - fix what the NOTES flag before building the full arrangement on top.

Use `arrange()` to create complete tracks with intro, build, drop, breakdown, outro.

**Full worked examples** (Metal, Melodic Techno, UK Garage, Lo-fi, Synthwave): read `references/genre-examples.md` in this skill's directory.

---

## IMPORTANT: Examples Are Inspiration Only

The genre examples show **what's possible**, not what to copy.

Every track you create should be **unique**:
- Different chord progressions
- Different rhythms and patterns
- Different instrument choices
- Different arrangement structures
- Your own weird ideas

Study the techniques, then make something **new**.

---

## The Formula

```
cps = BPM / 60 / 4
cycles = minutes × 60 × cps
```

| Duration | 90 BPM | 110 BPM | 120 BPM | 128 BPM | 140 BPM | 160 BPM | 174 BPM |
|----------|--------|---------|---------|---------|---------|---------|---------|
| cps      | 0.375  | 0.458   | 0.5     | 0.533   | 0.583   | 0.667   | 0.725   |
| 2 min    | 45     | 55      | 60      | 64      | 70      | 80      | 87      |
| 5 min    | 112    | 137     | 150     | 160     | 175     | 200     | 217     |
| 10 min   | 225    | 275     | 300     | 320     | 350     | 400     | 435     |

---

## The Pattern

1. **Define your elements** - bass, drums, chords, leads, atmosphere
2. **Calculate total cycles** for target duration
3. **Build the arrangement** - distribute cycles across sections
4. **Use `stack()`** to layer elements in each section
5. **Present it** - show the journey with the output format below

---

## Output Format - The Presentation

After creating a track, **ALWAYS** present it with personality:

### 1. The Title
Creative, evocative, with emojis that match the vibe:
```
🎸 BASEMENT SHOW - FEEDBACK AND FURY 🎸
🌙 LATE NIGHT FREQUENCIES 🌙
🚨 SHIBUYA BASEMENT - 4AM - THEY'RE LOOKING FOR US 🚨
🎉 WAREHOUSE PARTY - NO PHONES 🎉
```

### 2. The Hook
One line that captures the feeling:
```
quiet... quiet... LOUD. quiet... LOUD. DESTROY.
3AM. Candles lit. Feeling every emotion.
You descend the stairs. The bass hits your chest. Everyone's eyes are black.
120 CYCLES OF PURE EMOTION
```

### 3. The Journey Table
Show the arrangement as a story - what happens when:

| Moment | Cycles | What's Happening |
|--------|--------|------------------|
| INTRO | 8 | Feedback hums... clean arpeggios |
| VERSE 1 | 16 | 🌑 Quiet - clean guitar, soft drums |
| PRE-CHORUS | 8 | Tension... distortion creeping in |
| CHORUS | 16 | 💥 EXPLODE - power chords, crash cymbal |
| BREAKDOWN | 8 | Double-time chaos → silence → feedback |
| SOLO | 16 | 🔥 Raw screaming lead |
| FINAL CHORUS | 16 | 💛 MAXIMUM - everything at once |
| OUTRO | 12 | Destroy everything... fade to feedback |

Use emojis to mark the emotional peaks: 💥 🔥 💛 🌑 😭 🚨 💊 👁️ ✨

### 4. The Arsenal
List what makes this track special:
```
The formula:
- F minor - the saddest key
- F5 → Bb5 → Ab5 - power chord progression
- Clean verse → Distorted chorus - classic dynamics
- Contrasting drums - quiet kit vs explode kit
- Feedback always lurking in the background

The sound:
- Distorted kicks punching through walls
- 303 acid in E Phrygian (dark scale)
- 32nd hi-hats like a racing heartbeat
- Sirens sweeping in the distance

The arsenal:
- 6 vocal layers (oohs, aahs, choir, stutter, deep)
- Full UK garage kit with shakers
- 3 levels of supersaw (stab → big → MASSIVE)
- Halo pads floating above it all
```

### 5. The Closer
End with a memorable line that matches the vibe:
```
The bass hits your chest before you see the stage. 💀
3AM. Candles lit. Feeling every emotion. 🌙
We might get arrested but this moment is forever. 💊
You're not leaving this room the same person. 🎨
```

### Full Example

```
🌧️ MIDNIGHT RAMEN SHOP - SHIBUYA 🍜

Rain outside, warm inside, 3am thoughts.

112 CYCLES OF LATE NIGHT CONTEMPLATION

| Moment | Cycles | The Vibe |
|--------|--------|----------|
| RAIN | 4 | Just rain... setting the scene |
| WARMTH | 4 | Pad fades in through the steam |
| KEYS ARRIVE | 8 | 🎹 Dusty electric piano through the window |
| SETTLING IN | 8 | Vinyl crackle joins... you're home |
| BEAT DROPS | 8 | 🥢 Gentle kick... hats like chopsticks |
| FULL GROOVE | 8 | Snare joins... head nodding |
| KOTO ENTERS | 8 | 🎎 Something unexpected... beautiful |
| MUSIC BOX | 8 | ✨ High keys sparkle above |
| BREAKDOWN | 8 | 🌧️ Rain gets louder... flute whispers |
| RETURN | 16 | Everything together... the full moment |
| PEAK | 12 | 💜 All layers... maximum coziness |
| FADE | 16 | 🌙 Elements leave one by one... just rain |

The ingredients:
- Gb minor - melancholic but warm
- gm_epiano1 - that dusty Rhodes sound
- gm_koto + gm_shakuhachi - Japanese 3am energy
- gm_music_box - childhood nostalgia
- Rain (filtered white noise) - always present
- Crunchy drums with shape(0.2) - SP-404 vibes

The rain never stops. Neither do your thoughts. 🍜
```

---

## Learn From the Examples, Don't Copy

What to take from `references/genre-examples.md`:
- **Structure**: How to organize elements into variables
- **Layering**: How `stack()` builds complexity
- **Pacing**: How cycle counts create tension and release
- **Movement**: How filter/gain automation keeps it alive
- **Contrast**: How breakdowns make drops hit harder

What to change **every time**:
- Chord progressions - find your own harmony
- Rhythms - your own groove
- Instruments - mix unexpected sounds
- BPM - match the vibe you want
- Arrangement - your own journey

---

## Key Techniques

- **Layered drum kits**: Build `garage`, `fullKit`, `maxKit` variables for easy stacking
- **Filter automation**: `.lpf(sine.range(800, 4000).slow(8))` for movement
- **Gradual reveals**: Open filters, add gain, introduce elements over phases
- **Breakdowns**: Strip to atmosphere, build tension with risers
- **Stutter effects**: `.clip(0.1)`, `.fast(2)` on vocals for builds
- **Room for emotion**: `.room(0.8+)` on pads and vocals during breakdowns
- **Key changes**: `.trans(3)` to shift everything up a minor third

---

## Saving Tracks

When a composition lands, offer to save it — the `/tracks` skill saves to and replays from the `tracks/` library.
