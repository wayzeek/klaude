---
name: theory
description: Music theory for composing - scales, chords, progressions, borrowed chords, tension, and song arcs. Use when choosing harmony, writing chord progressions, designing emotional structure, or when music feels flat and needs depth.
---

# Music Theory - Making It Feel Like Something

Theory is not rules. It's a map of what emotions live where. Use it to make deliberate choices instead of defaulting to the same four chords.

---

## Intervals & Emotion

The distance between two notes carries feeling:

| Interval | Semitones | Feeling |
|----------|-----------|---------|
| Minor 2nd | 1 | Dread, dissonance (Jaws) |
| Major 2nd | 2 | Neutral step, motion |
| Minor 3rd | 3 | Sadness, introspection |
| Major 3rd | 4 | Brightness, warmth |
| Perfect 4th | 5 | Open, heroic |
| Tritone | 6 | Maximum tension, evil/unstable |
| Perfect 5th | 7 | Power, stability (power chords) |
| Minor 6th | 8 | Longing, drama |
| Major 6th | 9 | Sweetness, nostalgia |
| Minor 7th | 10 | Soulful tension, wants to resolve |
| Major 7th | 11 | Dreamy, sophisticated, floaty |
| Octave | 12 | Completion, emphasis |

Melodies that move in steps feel smooth and vocal; leaps of a 5th or 6th feel dramatic. A leap followed by steps back down is the oldest melody trick there is.

---

## Scales & Modes - The Mood Map

All usable directly in `.scale()`:

| Scale | Strudel name | Mood |
|-------|--------------|------|
| Major | `C:major` | Happy, bright, open |
| Natural minor | `A:minor` | Sad, emotional, serious |
| Harmonic minor | `A:harmonic:minor` | Dramatic, Middle Eastern edge (raised 7th pulls hard home) |
| Dorian | `D:dorian` | Hopeful minor - jazzy, soulful, "sad but dancing" |
| Phrygian | `E:phrygian` | Dark, Spanish, menacing (b2 = instant tension) |
| Lydian | `F:lydian` | Dreamlike, floating, film-score wonder (#4) |
| Mixolydian | `G:mixolydian` | Bluesy, groovy major with attitude (b7) |
| Minor pentatonic | `A:minor:pentatonic` | Safe, universal, blues/rock |
| Major pentatonic | `C:major:pentatonic` | Bright, folky, can't-go-wrong |

**Choosing:** electronic club music lives mostly in minor, dorian, and phrygian. Uplifting drops borrow major/mixolydian. Ambient loves lydian. When a track feels generic, often the fix is a mode change, not more layers.

---

## Chords - Construction & Symbols

`chord()` understands standard symbols:

| Symbol | Notes | Character |
|--------|-------|-----------|
| `C` | major triad | plain bright |
| `Cm` | minor triad | plain sad |
| `C7` | dominant 7th | bluesy, wants to move |
| `Cm7` | minor 7th | soulful, smooth - house/deep staple |
| `Cmaj7` | major 7th | dreamy, warm - lo-fi staple |
| `Cm9` / `Cmaj9` | add the 9th | lusher versions of the above |
| `Csus4` / `Csus2` | no 3rd | open, unresolved, neither happy nor sad |
| `Cdim` | diminished | anxiety, horror, passing tension |
| `Caug` | augmented | uncanny, dreamlike unease |
| `C6` / `Cm6` | added 6th | vintage sweetness / noir elegance |

**Rule of thumb:** triads sound plain and honest; 7ths sound sophisticated; 9ths sound lush. Deep house is built on m7/m9. Lo-fi is built on maj7. Trance/EDM drops often use plain triads for punch.

---

## Progressions by Mood

Roman numerals, an example in a real key, ready for `chord("<...>")`:

**Uplifting / anthemic** — I–V–vi–IV
`<C G Am F>` — the thousand-pop-songs progression. Always works, slightly generic.

**Emotional minor (the workhorse)** — i–VI–III–VII
`<Am F C G>` — sad verses, euphoric drops. The default of melodic dance music.

**Classic dark minor** — i–iv–VII–III
`<Am Dm G C>` — resolves in circle-of-fifths motion; feels inevitable, storytelling.

**Jazz movement** — ii–V–I
`<Dm7 G7 Cmaj7>` — sophisticated arrival. Chain it: `<Em7 A7 Dm7 G7 Cmaj7 Cmaj7>`.

**Bittersweet** — I–iii–vi–IV
`<C Em Am F>` — happiness with a shadow in it.

**Epic / heroic minor** — i–VII–VI–VII
`<Am G F G>` — rising and falling waves; great under arpeggios.

**Hypnotic** — one chord, moving texture
`<Cm7>` + filter sweeps, arp patterns, evolving gain. Techno's secret: harmony static, energy moving.

**Tension loop (no resolution)** — i–bII
`<Cm Db>` — phrygian menace; never lands, keeps crawling forward.

---

## Harmonic Surprise - The Borrowed Chord Toolbox

The difference between "nice loop" and "wait, what was THAT" is usually one borrowed chord. Take a progression and swap one chord for something outside the key:

- **Minor iv in a major key** — `<C F Fm C>` — the saddest single move in music. The Fm is sunshine clouding over.
- **bVI and bVII in major** — `<C Ab Bb C>` — instant epic/cinematic lift (borrowed from C minor).
- **Major IV in a minor key (dorian move)** — `<Am D>` — sudden hope inside sadness.
- **Secondary dominant (V of V)** — `<C D7 G C>` — the D7 doesn't belong; it points hard at G and makes the arrival satisfying.
- **Neapolitan bII** — `<Am Bb E7 Am>` — dramatic, operatic darkness before the resolve.
- **Picardy third** — end a minor track on the major i: `<Am ... A>` — unexpected light at the end.
- **Chromatic mediant** — jump between chords a 3rd apart sharing one note: `<C E>` or `<Am F#m>` — the film-trailer chord move. Uncanny, huge.

**How to use:** write a normal progression, then replace ONE chord in the second half with a borrowed one. Surprise lands hardest when everything around it is familiar. One surprise per section is plenty.

---

## Voice Leading & Bass

`voicing()` already picks smooth voicings (smallest movement between chords). Help it:

- Control register with `.anchor("C4")`, push above/below with `.mode("above")` / `.mode("below")`
- Keep bass independent: bass plays roots (`chord(prog).anchor("C2").voicing().arp("0")` or a hand-written root line), chords float above
- **Contrary motion** — when the melody rises, let the bass fall. Instant sophistication.
- Root motion by 4ths/5ths feels strong and inevitable; stepwise root motion feels gentle and songlike; 3rds feel dreamy.

---

## Harmonic Rhythm

How often chords change is an energy dial:

- **1 chord per 2-4 cycles** — hypnotic, meditative (techno, ambient)
- **1 chord per cycle** — natural, balanced (most dance music)
- **2+ chords per cycle** — urgent, songlike, busy (UK garage, jazz)

Trick: keep the same progression but *double* the harmonic rhythm in the final section (`"<Am F C G>"` → `"<[Am F] [C G]>"`) — everything feels like it's accelerating without changing tempo.

---

## Rhythm - Why Grooves Work

- **The backbeat** — snare/clap on 2 and 4 = the universal groove anchor.
- **Syncopation** — accenting where the beat isn't. `"~ bd ~ bd"` offbeat kicks (UKG), `"[~ hh]*4"` offbeat hats (house). Predictable grids need at least one syncopated layer to feel alive.
- **Euclidean rhythms carry cultures:** `(3,8)` = tresillo (reggaeton/dembow bones), `(5,8)` = cuban cinquillo feel, `(7,16)` = broken funk. `bd(3,8)` is centuries of dance music in five characters.
- **Swing/shuffle** — long-short pairs instead of even eighths: `s("[hh@2 hh]*4")` gives a triplet shuffle. Or humanize with velocity: `.gain("0.4 0.25 0.35 0.28")`.
- **Polymeter** — `{bd sd cp, hh hh hh}` — layers of different lengths phasing against each other; hypnotic evolution for free.
- **The pocket** — not every layer on the grid. Nudge one element with `.late(0.01)` for lazy feel or `.early(0.01)` for urgency.

---

## Melody Writing

1. **Start with a motif** — 2-4 notes with a distinct rhythm. Not a melody, a cell.
2. **Repeat it more than feels reasonable** — listeners need 3+ hearings before it's "the hook".
3. **Vary the ending** — same start, different last note: question and answer.
4. **Sequence it** — same shape, different scale degree: `.add(2)` on the pattern.
5. **Expand the range at the climax** — the highest note of the whole track should happen exactly once, at the peak.

Strudel mappings: motif = `n("0 3 2 0")`, answer = `n("0 3 2 <0 -2>")`, sequence = `.off(1, x=>x.add(2))`, mirror = `.rev()` (when the user says "reverse the melody", they mean `.rev()` — notes backwards, not audio reverse).

---

## Tension & Release - The Real Instrument

Music is breathing: tighten, then let go. Ways to build tension WITHOUT adding volume:

- Rise in register (same notes, octave up)
- Increase note density (quarters → eighths → sixteenths)
- Open a filter slowly (`.lpf(saw.range(400, 4000).slow(8))`)
- Shorten the harmonic rhythm (chords change faster)
- Move toward dissonance (add 7ths/9ths, or a diminished passing chord)
- Remove the bass (floor drops away, listener leans in)
- Go silent for half a cycle right before the drop — silence is the loudest sound

And release: land on the i or I chord, drop the octave, close the filter, let the kick return. **The drop hits exactly as hard as the tension before it was honest.**

---

## Story Arcs - Composing a Narrative

Tracks that feel like *stories* have a shape, not just sections:

| Story beat | Musical device |
|-----------|----------------|
| Setting the scene | Sparse texture, one idea, room to breathe |
| The journey begins | Groove enters, harmony starts moving |
| Rising complication | New layers, borrowed chord, register climbs |
| The turning point | Breakdown - strip everything, expose the core motif alone |
| The climax | Everything returns + ONE new element saved for this moment (key change `.trans(3)`, the highest melody note, doubled harmonic rhythm) |
| Resolution | Elements leave one by one; end on an honest chord (picardy third for hope, open sus for ambiguity) |

Save something for the climax. If every section uses every element, the peak is just... more of the same. The unfired gun: a melody, a key change, a countermelody that only appears once.

---

## Register & Arrangement Roles

Every full mix has five jobs — one element per job, stay out of each other's lanes:

| Role | Register | Example |
|------|----------|---------|
| Foundation | 30-100 Hz | sub/kick — `sine` bass, `bd` |
| Groove | percussive | hats, shakers, rims |
| Harmony | 200-800 Hz | chords, pads |
| Lead | 800-3k Hz | melody, arp |
| Air | 3k+ | open hats, noise, sparkle |

Two elements fighting for the same lane = mud. Fix with register (octaves), filters (`.hpf` the pad above the bass), or removal.

**Instrument register matters for genre:** electronic tracks stay coherent with synth-family sounds; acoustic outliers (kalimba in techno) read as parody unless deliberate. Warmth comes from filter/envelope choices (lower lpf, softer attack, moderate release), not from swapping to acoustic instruments.

---

## Quick Diagnosis

| Symptom | Likely fix |
|---------|-----------|
| "Sounds generic" | Borrowed chord, or change mode (minor → dorian/phrygian) |
| "Sounds flat/static" | Harmonic rhythm too slow, no filter movement, no dynamics |
| "Sounds muddy" | Register collision - hpf the pads, simplify the bass |
| "Drop doesn't hit" | Tension before it wasn't real - strip the breakdown harder, add silence |
| "Melody is forgettable" | No repetition - fewer ideas, repeated more, varied at the ends |
| "Too cheesy" | Too many major triads on the grid - add 7ths, syncopate, slow the chords |
| "Feels cold/robotic" | Humanize gains, swing the hats, warm timbres (epiano, filtered saws) |

---

## Philosophy

Theory describes what already sounds good - it never overrules your ears. If it sounds right and breaks a rule, it's right. If it follows every rule and sounds dead, it's dead.
