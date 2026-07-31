import { describe, expect, it } from 'vitest'
import { decodeWav } from '../../decoded-audio.mjs'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import { gridFromJson } from './quantize.mjs'
import { beatChroma, transcribeHarmony, transcribeHarmonyFromNotes } from './harmony.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const grid = gridFromJson({
  bpm: BPM,
  beatSeconds: 60 / BPM,
  barSeconds: (60 / BPM) * 4,
  downbeatSeconds: 0,
  beatsPerBar: 4,
})

/** Sustained triads, one per bar. `bars` is an array of MIDI-note arrays. */
function chordClip(bars, { gain = 0.25 } = {}) {
  const barSeconds = (60 / BPM) * 4
  const frames = Math.ceil(bars.length * barSeconds * SAMPLE_RATE)
  const out = new Float32Array(frames)
  for (let bar = 0; bar < bars.length; bar++) {
    const start = Math.floor(bar * barSeconds * SAMPLE_RATE)
    const n = Math.floor(barSeconds * SAMPLE_RATE)
    for (const midi of bars[bar]) {
      const hz = midiToHz(midi)
      for (let i = 0; i < n && start + i < frames; i++) {
        const fade = Math.min(1, i / (SAMPLE_RATE * 0.01), (n - i) / (SAMPLE_RATE * 0.01))
        out[start + i] += gain * fade * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
      }
    }
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

// Fm = F Ab C at MIDI 53, 56, 60. C#maj = C# F Ab at 61, 65, 68.
const FM = [53, 56, 60]
const CSHARP = [61, 65, 68]
const SECTION_4 = [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null }]

/**
 * A chord held for `bars` bars, with a second, different chord mixed in at
 * equal gain for exactly one beat in the middle - real ambiguity, not the
 * absence of any competing signal `chordClip`'s held-chord fixtures have.
 * At this gain, that one beat's own raw per-beat winner is the *blip*
 * chord, not the held one (verified directly against `chords.mjs`'s
 * `scoreChroma`) - a plain per-row argmax reads that beat as the wrong
 * chord. Only the surrounding beats' evidence, carried through
 * `smoothChordPath`'s self-transition bonus, can hold the true chord
 * through it.
 */
function heldChordWithBlip(chord, bars, blipChord, blipBeat, { gain = 0.25 } = {}) {
  const barSeconds = (60 / BPM) * 4
  const beatSeconds = 60 / BPM
  const frames = Math.ceil(bars * barSeconds * SAMPLE_RATE)
  const out = new Float32Array(frames)
  const addTone = (midi, start, length, level) => {
    const hz = midiToHz(midi)
    for (let i = 0; i < length && start + i < frames; i++) {
      const fade = Math.min(1, i / (SAMPLE_RATE * 0.01), (length - i) / (SAMPLE_RATE * 0.01))
      out[start + i] += level * fade * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
    }
  }
  for (const midi of chord) addTone(midi, 0, frames, gain)
  const blipStart = Math.floor(blipBeat * beatSeconds * SAMPLE_RATE)
  const blipLength = Math.floor(beatSeconds * SAMPLE_RATE)
  for (const midi of blipChord) addTone(midi, blipStart, blipLength, gain)
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

describe('beatChroma', () => {
  it('gives one twelve-value vector per beat', () => {
    const audio = decodeWav(chordClip([FM, FM]))
    const { times, vectors } = beatChroma(audio, grid)
    expect(vectors.length).toBeGreaterThan(4)
    expect(times).toHaveLength(vectors.length)
    expect(vectors[0]).toHaveLength(12)
  })

  it('puts the energy on the notes actually sounding', () => {
    const audio = decodeWav(chordClip([FM, FM, FM, FM]))
    const { vectors } = beatChroma(audio, grid)
    const chroma = vectors[4] // well inside the second bar
    const ranked = [...chroma.keys()].sort((a, b) => chroma[b] - chroma[a])
    // F=5, Ab=8, C=0.
    expect(ranked.slice(0, 3).sort((a, b) => a - b)).toEqual([0, 5, 8])
  })

  it('is normalised, so a loud passage does not outweigh a quiet one', () => {
    // Three simultaneous unity-phase tones clip at gain 0.4 (peak ~1.2 against
    // writeWavBuffer's +/-1 clamp), which distorts the loud case into a
    // genuinely different, harmonically-contaminated signal rather than a
    // louder version of the same one - no normalisation recovers from that.
    // 0.3 stays clear of the three-tone ceiling (3*0.3 = 0.9) while still
    // being 6x the quiet gain.
    const loud = beatChroma(decodeWav(chordClip([FM, FM], { gain: 0.3 })), grid)
    const quiet = beatChroma(decodeWav(chordClip([FM, FM], { gain: 0.05 })), grid)
    const sum = (v) => v.reduce((a, b) => a + b, 0)
    expect(sum(loud.vectors[2])).toBeCloseTo(sum(quiet.vectors[2]), 1)
  })
})

describe('transcribeHarmony', () => {
  it('recovers a held minor triad', () => {
    const loop = transcribeHarmony(chordClip([FM, FM, FM, FM]), grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(loop.events.every((e) => e.symbol === 'Fm')).toBe(true)
  })

  it('recovers a two-chord progression as a two-bar loop', () => {
    const loop = transcribeHarmony(
      chordClip([FM, CSHARP, FM, CSHARP]),
      grid,
      SECTION_4,
      { key: 'F minor' },
    )[0]
    expect(loop.loopBars).toBe(2)
    expect(loop.events.map((e) => e.symbol)).toEqual(['Fm', 'C#'])
  })

  it('gives each chord a length covering the bar it fills', () => {
    const loop = transcribeHarmony(chordClip([FM, CSHARP, FM, CSHARP]), grid, SECTION_4, { key: 'F minor' })[0]
    for (const event of loop.events) expect(event.length).toBe(16)
  })

  it('does not flicker between neighbouring chords', () => {
    const loop = transcribeHarmony(chordClip([FM, FM, FM, FM]), grid, SECTION_4, { key: 'F minor' })[0]
    expect(new Set(loop.events.map((e) => e.symbol)).size).toBe(1)
  })

  it('holds the true chord through one beat of real competing evidence', () => {
    // Fm held for 4 bars, with a C# major triad mixed in at equal gain for
    // beat 8 (bar 2's downbeat) alone. That beat's own evidence genuinely
    // favours C# - this is smoothing doing its job, not a clean fixture.
    const loop = transcribeHarmony(heldChordWithBlip(FM, 4, CSHARP, 8), grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(new Set(loop.events.map((e) => e.symbol))).toEqual(new Set(['Fm']))
  })

  it('reports how much of the progression sits outside the key', () => {
    const inKey = transcribeHarmony(chordClip([FM, FM, FM, FM]), grid, SECTION_4, { key: 'F minor' })[0]
    expect(inKey.outOfKey).toBe(0)

    // E major is foreign to F minor on every note.
    const emaj = [52, 56, 59]
    const foreign = transcribeHarmony(
      chordClip([emaj, emaj, emaj, emaj]),
      grid,
      SECTION_4,
      { key: 'F minor' },
    )[0]
    expect(foreign.outOfKey).toBeGreaterThan(0.5)
  })

  it('returns null for a silent section', () => {
    const silent = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(Math.ceil(8 * SAMPLE_RATE))],
    })
    expect(transcribeHarmony(silent, grid, SECTION_4, { key: 'F minor' })[0]).toBeNull()
  })

  it('returns null for real, non-silent content with no chord in it', () => {
    // Twelve equal-gain tones, one per pitch class - real, substantial audio
    // energy (unlike the digital-silence fixture above, which the margin
    // gate rejects for the trivial reason that its chroma is exactly zero).
    // This one has plenty of signal; it just isn't a chord, and every
    // template ties against it the same way a flat chroma vector does.
    // Gain 0.05 keeps twelve summed tones under +/-1 (worst case 12 * 0.05 =
    // 0.6) - chordClip's own default of 0.25 is sized for two or three
    // simultaneous notes and clips hard with twelve of them, which would
    // make this fixture partly about distortion rather than about the
    // twelve-tone ambiguity it claims to demonstrate.
    const notes = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
    const chromatic = chordClip([notes, notes, notes, notes], { gain: 0.05 })
    expect(transcribeHarmony(chromatic, grid, SECTION_4, { key: 'F minor' })[0]).toBeNull()
  })

  it('still recovers a chord under moderate, realistic interference', () => {
    // Fm held for 4 bars with fourteen inharmonic partials mixed in underneath
    // it, at less than a tenth of the chord's own gain - a stand-in for the
    // bleed and room noise a real stem carries, not a pristine synthetic
    // triad. The chord still dominates and the gate should not be so strict
    // that ordinary interference like this defeats it.
    const partials = [211, 233, 251, 277, 307, 337, 367, 397, 431, 461, 499, 523, 557, 587]
    const barSeconds = (60 / BPM) * 4
    const frames = Math.ceil(4 * barSeconds * SAMPLE_RATE)
    const out = new Float32Array(frames)
    for (const midi of FM) {
      const hz = midiToHz(midi)
      for (let i = 0; i < frames; i++) {
        const fade = Math.min(1, i / (SAMPLE_RATE * 0.01), (frames - i) / (SAMPLE_RATE * 0.01))
        out[i] += 0.25 * fade * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
      }
    }
    for (const hz of partials) {
      for (let i = 0; i < frames; i++) out[i] += 0.02 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + hz)
    }
    const noisy = writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
    const loop = transcribeHarmony(noisy, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(loop.events.every((e) => e.symbol === 'Fm')).toBe(true)
  })

  it('carries confidence and a symbol on every event, and no MIDI', () => {
    const loop = transcribeHarmony(chordClip([FM, CSHARP, FM, CSHARP]), grid, SECTION_4, { key: 'F minor' })[0]
    for (const event of loop.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
      expect(typeof event.symbol).toBe('string')
      expect(event.midi).toBeNull()
    }
  })

  it('returns one entry per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    expect(transcribeHarmony(chordClip([FM, CSHARP, FM, CSHARP]), grid, sections, { key: 'F minor' })).toHaveLength(2)
  })
})

/** Notes covering one chord's pitch classes for a span of bars, as Basic
 *  Pitch would report a block chord: one note per voice, all starting and
 *  ending together. */
function chordNotes(midiList, fromBar, bars, velocity = 0.6) {
  return midiList.map((midi) => ({
    midi,
    startSec: grid.barAt(fromBar),
    endSec: grid.barAt(fromBar + bars),
    velocity,
  }))
}

describe('transcribeHarmonyFromNotes', () => {
  it('recovers a held minor triad', () => {
    const loop = transcribeHarmonyFromNotes(chordNotes(FM, 0, 4), grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(loop.events.every((e) => e.symbol === 'Fm')).toBe(true)
  })

  it('recovers a two-chord progression as a two-bar loop', () => {
    const notes = [...chordNotes(FM, 0, 2), ...chordNotes(CSHARP, 2, 2)]
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(loop.events.map((e) => e.symbol)).toEqual(['Fm', 'C#'])
  })

  it('carries confidence and a symbol on every event, and no MIDI', () => {
    const notes = [...chordNotes(FM, 0, 2), ...chordNotes(CSHARP, 2, 2)]
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    for (const event of loop.events) {
      expect(event.confidence).toBeGreaterThan(0)
      expect(event.confidence).toBeLessThanOrEqual(1)
      expect(typeof event.symbol).toBe('string')
      expect(event.midi).toBeNull()
    }
  })

  it('returns null for a section with nothing sounding at all', () => {
    expect(transcribeHarmonyFromNotes([], grid, SECTION_4, { key: 'F minor' })[0]).toBeNull()
  })

  it('treats a genuinely silent stretch as unconfident rather than carrying the last chord through it', () => {
    // A chord for one bar, then three bars of nothing.
    const notes = chordNotes(FM, 0, 1)
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    // One confident bar alone is below MIN_CONFIDENT_BARS (2), so this
    // must not emit a loop that pretends the whole section is one chord.
    expect(loop).toBeNull()
  })

  it('does not misread a single sustained note as a full chord it is not part of', () => {
    // Only the root of Fm sounding, nothing else. A single pitch class ties
    // every template containing it at the identical top score (margin
    // exactly 0 - see this function's own doc comment for the measured
    // numbers), so this must be rejected as unconfident rather than
    // confidently naming whichever template happens to sort first. A real
    // probe against the pre-fix code turned one sustained C4 into a
    // four-bar "C" reading.
    const notes = chordNotes([53], 0, 4) // F alone, four bars
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).toBeNull()
  })

  it('does not resolve a two-note perfect fifth into a major or minor triad it cannot distinguish', () => {
    // A power chord (root + fifth) ties every triad/sus4 containing both
    // notes - major, minor and sus4 all score identically - which is
    // genuinely ambiguous evidence, not a chord this function has any basis
    // to name one way or the other.
    const notes = chordNotes([53, 60], 0, 4) // F + C, four bars
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).toBeNull()
  })

  it('does not invent chords under a moving monophonic melody with no harmonic accompaniment', () => {
    // A melodic line moving between single notes, one at a time - never more
    // than one pitch class sounding at once. This is exactly the shape the
    // "other" stem's own melody produces on a passage with nothing playing
    // chords underneath it, which is the real-world case the false-positive
    // bug this test guards against actually manifests as: a fabricated
    // chord progression is worse than reporting no harmony, per this
    // module's own doc comment.
    const notes = [...chordNotes([53], 0, 1), ...chordNotes([55], 1, 1), ...chordNotes([58], 2, 1), ...chordNotes([60], 3, 1)]
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop).toBeNull()
  })

  it('reports outOfKey for a chord outside the given key', () => {
    // D major (D F# A) shares no triad tone with F minor's own scale (F G Ab
    // Bb C Db Eb) - unlike C# major, the bVI of F minor and diatonic to it.
    const D_MAJOR = [62, 66, 69]
    const notes = chordNotes(D_MAJOR, 0, 4)
    const loop = transcribeHarmonyFromNotes(notes, grid, SECTION_4, { key: 'F minor' })[0]
    expect(loop.outOfKey).toBeGreaterThan(0)
  })

  it('returns one entry per section', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 2, label: 'mid', sameAs: null },
      { index: 1, startBar: 2, bars: 2, label: 'mid', sameAs: null },
    ]
    const notes = [...chordNotes(FM, 0, 2), ...chordNotes(CSHARP, 2, 2)]
    expect(transcribeHarmonyFromNotes(notes, grid, sections, { key: 'F minor' })).toHaveLength(2)
  })

  it('recovers a chord in a section that does not start at bar 0', () => {
    // Regression: an earlier version computed each event's `step` relative
    // to the section's own start beat instead of the grid's absolute
    // downbeat. `foldToLoop` expects the latter (it subtracts
    // `section.startBar * stepsPerBar` itself), so the bug silently
    // localised twice and every event fell outside the section's own step
    // range - `foldToLoop` filtered them all out and this returned `null`
    // for every section that did not happen to start at bar 0, where the
    // bug was invisible because subtracting zero twice is still zero.
    const sections = [{ index: 0, startBar: 4, bars: 4, label: 'mid', sameAs: null }]
    const notes = chordNotes(FM, 4, 4)
    const loop = transcribeHarmonyFromNotes(notes, grid, sections, { key: 'F minor' })[0]
    expect(loop).not.toBeNull()
    expect(loop.events.every((e) => e.symbol === 'Fm')).toBe(true)
  })
})
