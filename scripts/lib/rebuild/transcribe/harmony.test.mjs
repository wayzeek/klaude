import { describe, expect, it } from 'vitest'
import { decodeWav } from '../../decoded-audio.mjs'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { midiToHz } from './f0.mjs'
import { gridFromJson } from './quantize.mjs'
import { beatChroma, transcribeHarmony } from './harmony.mjs'

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
