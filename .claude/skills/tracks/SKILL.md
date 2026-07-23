---
name: tracks
description: Save, list, and replay tracks from the tracks/ library. Use when the user asks to save a composition, play a saved track, list the library, share a track, record a bounce, or replay something made earlier.
allowed-tools: Bash(curl *), Bash(node scripts/*), Bash(pnpm validate:tracks*), Read, Glob, Write
---

# Tracks - The Library

Saved compositions live in `tracks/<ARTIST>/<NN>-<slug>.md`. Each file is one track: frontmatter metadata + one JavaScript code block.

---

## File Format

````markdown
---
name: acid-bloom
description: Deep house grown wild with acid. A squelchy 303-style bass wobbles under warm Cm7 chords.
tempo: 0.517 cps (~124 BPM)
key: C minor
duration: ~2.7 minutes
---

# Track 1: Acid Bloom

```javascript
// full Strudel code here
```
````

- `<ARTIST>` is an uppercase style/persona directory (e.g. `HARDFLOOR`, `TIDELINE`, `DOOM`)
- `<NN>` is a zero-padded sequence number within that directory (`01`, `02`, ...)
- Exactly one ```javascript block per file — it must be complete and runnable as-is (including `setcps`/`setcpm`)

---

## Listing the Library

Glob `tracks/*/*.md`, read the frontmatter of each, and present a friendly table: artist, track name, vibe (description), key, duration. Never dump raw file contents at the user.

---

## Playing a Track

1. Find the file (fuzzy-match on name/artist/description if the user is vague — "play the acid one" → `HARDFLOOR/01-acid-bloom.md`)
2. Read it and extract the JavaScript block to a temp file
3. Push and play it: `node scripts/push.mjs /tmp/track.js --play` — the script reports whether it actually evaluated (see `/api`)
4. Set the HUD so the browser shows what's on: `POST /api/nowplaying {"title": "Acid Bloom", "artist": "HARDFLOOR"}`
5. Announce what's playing with personality — name, vibe, key

---

## Saving a Track

When a composition lands (or the user asks to save):

1. **Pick or create the artist directory** — reuse an existing persona if the style fits, otherwise invent a fitting new uppercase name. Ask the user if unsure.
2. **Number it** — next `<NN>` in that directory.
3. **Slug from the track name** — lowercase, hyphenated.
4. **Write the file** in the format above. The code block must be the exact final version that played (fetch `GET /api/code` if needed to capture what's actually loaded).
5. Confirm the save with the path.

**Frontmatter rules:** `tempo` shows both cps and BPM; `duration` is the real arranged length (sum of `arrange()` cycles ÷ cps = seconds, ÷ 60 for minutes); `description` is evocative, one or two sentences.

6. **Validate it** — run `pnpm validate:tracks`. It checks the structure AND that your stated tempo/duration match the code. Fix any mismatch before confirming the save.

---

## Replaying with Variations

"Play it again but slower/darker/longer" → load the saved code, apply the change (adjust `setcps`, filters, arrangement), play it — and offer to save the variation as a new numbered track rather than overwriting the original. Never overwrite a saved track unless the user explicitly asks.

---

## Sharing a Track

`node scripts/share.mjs tracks/HARDFLOOR/01-acid-bloom.md` won't work on the markdown — extract the code block to a file first, or share what's currently loaded with no argument: `node scripts/share.mjs`. It prints a strudel.cc link anyone can open. Mention the caveats when relevant: strudel.cc runs the latest Strudel (minor drift possible), and local samples from `public/samples/` won't resolve there.

---

## Recording a Bounce

To capture a track as audio: play it, then `POST /api/record/start`, let it run its full arrangement, `POST /api/record/stop`. Poll `/api/status` until `recording.phase` is `"done"` — the WAV path is in `recording.file` (they land in `recordings/`). Offer this when a composition is finished and the user seems to love it.
