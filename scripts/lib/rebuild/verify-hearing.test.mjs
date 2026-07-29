import { describe, expect, it } from 'vitest'
import { writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { renderSection } from './resynth.mjs'
import { gridFromJson } from './transcribe/quantize.mjs'
import { verifyHearing } from './verify-hearing.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const GRID_JSON = { bpm: BPM, beatSeconds: 60 / BPM, barSeconds: (60 / BPM) * 4, downbeatSeconds: 0, beatsPerBar: 4 }
const grid = gridFromJson(GRID_JSON)

const drum = (step, velocity = 0.8) => ({
  step, length: 1, velocity, confidence: 0.9, midi: null, symbol: null, driftSteps: 0,
})
const note = (step, midi, length = 4) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0,
})

function transcriptionWith(loops, bars = 4) {
  return {
    grid: GRID_JSON,
    key: { name: 'F minor', confidence: 0.5 },
    stepsPerBeat: 4,
    sections: [{ index: 0, startBar: 0, bars, label: 'mid', sameAs: null, loops }],
  }
}

const BASE_LOOPS = {
  kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
  snare: null,
  hats: null,
  bass: { loopBars: 1, events: [note(0, 41, 4), note(8, 44, 4)], confidence: 0.8 },
  chords: null,
  lead: null,
}

/** Turn a transcription's own rendering into stem buffers. Scoring a
 *  transcription against a synthesis of itself is the perfect case, and it is
 *  what calibrates every threshold. */
function stemsFromTranscription(transcription) {
  const section = transcription.sections[0]
  const { layers } = renderSection(section, gridFromJson(transcription.grid))
  const drums = new Float32Array(layers.kick.length)
  for (let i = 0; i < drums.length; i++) drums[i] = layers.kick[i] + layers.snare[i] + layers.hats[i]
  const other = new Float32Array(layers.chords.length)
  for (let i = 0; i < other.length; i++) other[i] = layers.chords[i] + layers.lead[i]
  const wrap = (samples) => writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [samples] })
  return { drums: wrap(drums), bass: wrap(layers.bass), other: wrap(other) }
}

describe('verifyHearing', () => {
  it('scores a transcription against a synthesis of itself near perfect', () => {
    const transcription = transcriptionWith(BASE_LOOPS)
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.kick.score).toBeGreaterThan(0.85)
    expect(result.sections[0].layers.bass.score).toBeGreaterThan(0.85)
    expect(result.overall).toBeGreaterThan(0.85)
  })

  it('scores lower when the bass is transposed a semitone', () => {
    const truth = transcriptionWith(BASE_LOOPS)
    const stems = stemsFromTranscription(truth)

    const wrong = transcriptionWith({
      ...BASE_LOOPS,
      bass: {
        loopBars: 1,
        events: BASE_LOOPS.bass.events.map((e) => ({ ...e, midi: e.midi + 1 })),
        confidence: 0.8,
      },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.bass.score
    const off = verifyHearing(wrong, stems).sections[0].layers.bass.score
    // Both numbers matter: a test that only checks the ordering would pass
    // just as happily if both scores were near zero, which proves nothing
    // about whether the check actually discriminates a semitone error.
    console.log(`semitone-off bass: correct=${right.toFixed(3)} wrong=${off.toFixed(3)}`)
    expect(right).toBeGreaterThan(0.85)
    expect(off).toBeLessThan(right - 0.1)
  })

  it('scores lower when the drums are shifted by a step', () => {
    const truth = transcriptionWith(BASE_LOOPS)
    const stems = stemsFromTranscription(truth)

    const shifted = transcriptionWith({
      ...BASE_LOOPS,
      kick: {
        loopBars: 1,
        events: BASE_LOOPS.kick.events.map((e) => ({ ...e, step: (e.step + 1) % 16 })),
        confidence: 0.9,
      },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.kick.score
    const off = verifyHearing(shifted, stems).sections[0].layers.kick.score
    console.log(`step-shifted kick: correct=${right.toFixed(3)} shifted=${off.toFixed(3)}`)
    expect(right).toBeGreaterThan(0.85)
    expect(off).toBeLessThan(right - 0.1)
  })

  it('scores lower when half the drum hits are dropped', () => {
    const truth = transcriptionWith(BASE_LOOPS)
    const stems = stemsFromTranscription(truth)

    const sparse = transcriptionWith({
      ...BASE_LOOPS,
      kick: { loopBars: 1, events: [drum(0), drum(8)], confidence: 0.9 },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.kick.score
    const off = verifyHearing(sparse, stems).sections[0].layers.kick.score
    console.log(`half-dropped kick: correct=${right.toFixed(3)} sparse=${off.toFixed(3)}`)
    expect(right).toBeGreaterThan(0.85)
    expect(off).toBeLessThan(right)
  })

  it('passes a correct layer and fails a nonsense one', () => {
    // Both halves matter. Asserting only that the wrong layer fails would be
    // satisfied by an implementation whose `pass` is always false.
    const truth = transcriptionWith(BASE_LOOPS)
    const stems = stemsFromTranscription(truth)
    expect(verifyHearing(truth, stems).sections[0].layers.bass.pass).toBe(true)

    const nonsense = transcriptionWith({
      ...BASE_LOOPS,
      bass: { loopBars: 1, events: [note(0, 70, 16)], confidence: 0.8 },
    })
    expect(verifyHearing(nonsense, stems).sections[0].layers.bass.pass).toBe(false)
  })

  it('notices a bassline transcribed an octave low', () => {
    // Chroma alone cannot see this - the pitch classes are identical - so this
    // test fails against any implementation that scores on chroma only. It is
    // the reason scoreLayer carries a register term. This only proves the
    // register term catches an octave error against the *right* instrument's
    // stem; it says nothing about content that is genuinely in-band but
    // belongs to a different source (see the module doc comment).
    const truth = transcriptionWith(BASE_LOOPS)
    const stems = stemsFromTranscription(truth)
    const octaveDown = transcriptionWith({
      ...BASE_LOOPS,
      bass: {
        loopBars: 1,
        events: BASE_LOOPS.bass.events.map((e) => ({ ...e, midi: e.midi - 12 })),
        confidence: 0.8,
      },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.bass.score
    const low = verifyHearing(octaveDown, stems).sections[0].layers.bass.score
    console.log(`octave-low bass: correct=${right.toFixed(3)} octave-down=${low.toFixed(3)}`)
    expect(right).toBeGreaterThan(0.85)
    // A wide margin, not the usual 0.1: the octave-down note's own second
    // harmonic lands exactly on the correct note's fundamental (that is what
    // "an octave down" means), so chroma alone - with no register term at all
    // - still reports a deceptively high 0.886 here on aliased harmonic
    // content. 0.2 is comfortably below this implementation's real gap
    // (~0.37) and above that alias floor, so a register term that stopped
    // doing anything (e.g. always agreeing) would fail this assertion instead
    // of sliding through on the alias.
    expect(low).toBeLessThan(right - 0.2)
  })

  it('reports null for an omitted layer rather than a zero score', () => {
    const transcription = transcriptionWith(BASE_LOOPS)
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.snare).toBeNull()
    expect(result.sections[0].layers.lead).toBeNull()
  })

  it('handles a section with no layers at all', () => {
    const empty = transcriptionWith({
      kick: null, snare: null, hats: null, bass: null, chords: null, lead: null,
    })
    const result = verifyHearing(empty, stemsFromTranscription(transcriptionWith(BASE_LOOPS)))
    expect(result.sections[0].layers.kick).toBeNull()
    expect(Number.isFinite(result.overall)).toBe(true)
  })
})
