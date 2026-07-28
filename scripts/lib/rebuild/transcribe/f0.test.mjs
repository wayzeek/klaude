import { describe, expect, it } from 'vitest'
import { decodeWav } from '../../decoded-audio.mjs'
import { writeWavBuffer } from '../../__fixtures__/make-wav.mjs'
import { hzToMidi, midiToHz, segmentNotes, trackF0 } from './f0.mjs'

const SAMPLE_RATE = 44100

/** A sequence of held tones. `notes` is [{ midi, seconds }] or [{ hz, seconds }].
 *  A rich waveform - fundamental plus two harmonics - because a pure sine is
 *  the one case where octave errors never happen, and testing only that would
 *  prove nothing about #42's octave requirement. */
function toneSequence(notes, { silenceBetween = 0, harmonics = [1, 0.5, 0.25] } = {}) {
  const total = notes.reduce((sum, note) => sum + note.seconds + silenceBetween, 0)
  const frames = Math.ceil(total * SAMPLE_RATE)
  const out = new Float32Array(frames)
  let cursor = 0
  for (const note of notes) {
    const hz = note.hz ?? midiToHz(note.midi)
    const start = Math.floor(cursor * SAMPLE_RATE)
    const n = Math.floor(note.seconds * SAMPLE_RATE)
    for (let i = 0; i < n && start + i < frames; i++) {
      let value = 0
      for (let h = 0; h < harmonics.length; h++) {
        value += harmonics[h] * Math.sin((2 * Math.PI * hz * (h + 1) * i) / SAMPLE_RATE)
      }
      // Short fades so the boundaries are note changes, not clicks.
      const fade = Math.min(1, i / (SAMPLE_RATE * 0.005), (n - i) / (SAMPLE_RATE * 0.005))
      out[start + i] = 0.4 * fade * value
    }
    cursor += note.seconds + silenceBetween
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

/** Deterministic band-limited noise: many sinusoids at random frequencies and
 *  phases within [minHz, maxHz], so there is no single dominant period -
 *  genuinely non-tonal - even though it carries plenty of energy in the bass
 *  register. Uses the same seeded LCG as this codebase's other DSP fixtures
 *  (see bands.test.mjs); no Math.random(). This exists to exercise the
 *  clarity gate on `voiced`: silence is already caught by the RMS floor, so a
 *  fixture that is loud but not periodic is the only way to prove the gate
 *  does anything. */
function bandLimitedNoise(seconds, { minHz = 30, maxHz = 400, components = 80, seed = 777 } = {}) {
  let state = seed
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const frames = Math.floor(seconds * SAMPLE_RATE)
  const out = new Float32Array(frames)
  const freqs = []
  const phases = []
  for (let c = 0; c < components; c++) {
    freqs.push(minHz + rand() * (maxHz - minHz))
    phases.push(rand() * 2 * Math.PI)
  }
  const amp = 1 / components
  for (let i = 0; i < frames; i++) {
    let value = 0
    for (let c = 0; c < components; c++) {
      value += amp * Math.sin((2 * Math.PI * freqs[c] * i) / SAMPLE_RATE + phases[c])
    }
    out[i] = value
  }
  return writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [out] })
}

describe('pitch conversion', () => {
  it('round-trips A440 as MIDI 69', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 10)
    expect(midiToHz(69)).toBeCloseTo(440, 10)
  })

  it('places F1 near 43.65 Hz', () => {
    expect(midiToHz(29)).toBeCloseTo(43.654, 2)
  })
})

describe('trackF0', () => {
  it('finds the fundamental, not the octave below', () => {
    // MIDI 41 is F2, 87.3 Hz. Plain autocorrelation frequently reports 43.6
    // (MIDI 29, an octave down) instead. A median over ~80 frames of a clean
    // tone would not budge from a single bad frame - checked by mutation,
    // taking the global minimum of the raw (unnormalised) difference function
    // still gives a median of 41.000 while one frame reads 29 - so assert on
    // every voiced frame individually rather than a central statistic.
    const audio = decodeWav(toneSequence([{ midi: 41, seconds: 1 }]))
    const { frames } = trackF0(audio, { minHz: 30, maxHz: 400 })
    const voiced = frames.filter((f) => f.voiced)
    expect(voiced.length).toBeGreaterThan(frames.length * 0.7)
    const wrongOctave = voiced.filter((f) => Math.abs(f.midi - 41) > 1)
    expect(wrongOctave).toEqual([])
  })

  it('tracks a change of note', () => {
    const audio = decodeWav(toneSequence([
      { midi: 41, seconds: 0.6 },
      { midi: 48, seconds: 0.6 },
    ]))
    const { frames } = trackF0(audio, { minHz: 30, maxHz: 400 })
    const early = frames.filter((f) => f.voiced && f.seconds < 0.5)
    const late = frames.filter((f) => f.voiced && f.seconds > 0.7 && f.seconds < 1.1)
    expect(medianOf(early.map((f) => f.midi))).toBeCloseTo(41, 0)
    expect(medianOf(late.map((f) => f.midi))).toBeCloseTo(48, 0)
  })

  it('marks silence unvoiced rather than guessing a pitch', () => {
    const audio = decodeWav(toneSequence(
      [{ midi: 41, seconds: 0.5 }, { midi: 41, seconds: 0.5 }],
      { silenceBetween: 0.5 },
    ))
    const { frames } = trackF0(audio, { minHz: 30, maxHz: 400 })
    const inGap = frames.filter((f) => f.seconds > 0.62 && f.seconds < 0.88)
    expect(inGap.length).toBeGreaterThan(3)
    expect(inGap.every((f) => !f.voiced)).toBe(true)
  })

  it('reports clarity that is high on a clean tone', () => {
    const audio = decodeWav(toneSequence([{ midi: 45, seconds: 1 }]))
    const { frames } = trackF0(audio, { minHz: 30, maxHz: 400 })
    const voiced = frames.filter((f) => f.voiced)
    expect(medianOf(voiced.map((f) => f.clarity))).toBeGreaterThan(0.7)
  })

  it('marks loud, non-tonal signal unvoiced rather than pitch-matching noise', () => {
    // Silence is already caught by the RMS floor; this fixture is loud
    // (comfortably above it) but has no dominant period, so this is the only
    // fixture that actually exercises the clarity gate. Checked by mutation:
    // dropping `clarity >= voicedThreshold` from the voiced expression takes
    // this from 0/79 voiced to 79/79.
    const audio = decodeWav(bandLimitedNoise(1))
    const { frames } = trackF0(audio, { minHz: 30, maxHz: 400 })
    expect(Math.min(...frames.map((f) => f.rms))).toBeGreaterThan(0.01)
    const voiced = frames.filter((f) => f.voiced)
    expect(voiced.length).toBeLessThan(frames.length * 0.1)
  })

  it('works in the lead register too', () => {
    const audio = decodeWav(toneSequence([{ midi: 72, seconds: 0.8 }]))
    const { frames } = trackF0(audio, { minHz: 150, maxHz: 2000, windowSize: 2048 })
    const voiced = frames.filter((f) => f.voiced)
    expect(voiced.length).toBeGreaterThan(frames.length * 0.6)
    expect(medianOf(voiced.map((f) => f.midi))).toBeCloseTo(72, 0)
  })
})

describe('segmentNotes', () => {
  it('turns a held tone into one note', () => {
    const audio = decodeWav(toneSequence([{ midi: 41, seconds: 1 }]))
    const notes = segmentNotes(trackF0(audio, { minHz: 30, maxHz: 400 }))
    expect(notes).toHaveLength(1)
    expect(Math.round(notes[0].midi)).toBe(41)
    expect(notes[0].endSec - notes[0].startSec).toBeGreaterThan(0.7)
  })

  it('splits at a change of pitch', () => {
    const audio = decodeWav(toneSequence([
      { midi: 41, seconds: 0.5 },
      { midi: 46, seconds: 0.5 },
      { midi: 41, seconds: 0.5 },
    ]))
    const notes = segmentNotes(trackF0(audio, { minHz: 30, maxHz: 400 }))
    expect(notes).toHaveLength(3)
    expect(notes.map((n) => Math.round(n.midi))).toEqual([41, 46, 41])
  })

  it('splits at silence', () => {
    const audio = decodeWav(toneSequence(
      [{ midi: 41, seconds: 0.4 }, { midi: 41, seconds: 0.4 }],
      { silenceBetween: 0.4 },
    ))
    const notes = segmentNotes(trackF0(audio, { minHz: 30, maxHz: 400 }))
    expect(notes).toHaveLength(2)
  })

  it('drops fragments too short to be notes', () => {
    const audio = decodeWav(toneSequence([{ midi: 41, seconds: 0.02 }]))
    const notes = segmentNotes(trackF0(audio, { minHz: 30, maxHz: 400 }))
    expect(notes).toEqual([])
  })

  it('returns nothing for silence rather than throwing', () => {
    const silent = writeWavBuffer({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: [new Float32Array(SAMPLE_RATE)],
    })
    const notes = segmentNotes(trackF0(decodeWav(silent), { minHz: 30, maxHz: 400 }))
    expect(notes).toEqual([])
  })
})

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
