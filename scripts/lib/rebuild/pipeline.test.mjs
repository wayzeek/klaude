import { describe, expect, it } from 'vitest'
import { loadStrudel } from '../strudel-node.mjs'
import { writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { emitTrack, SOUNDS } from './emit.mjs'
import { renderSection } from './resynth.mjs'
import { transcribeBass } from './transcribe/bass.mjs'
import { transcribeDrums } from './transcribe/drums.mjs'
import { gridFromJson } from './transcribe/quantize.mjs'
import { querySectionStrict, verifyEmission } from './verify-emission.mjs'
import { verifyHearing } from './verify-hearing.mjs'

const SAMPLE_RATE = 44100
const BPM = 120
const GRID_JSON = { bpm: BPM, beatSeconds: 60 / BPM, barSeconds: (60 / BPM) * 4, downbeatSeconds: 0, beatsPerBar: 4 }
const grid = gridFromJson(GRID_JSON)

const drum = (step) => ({ step, length: 1, velocity: 0.8, confidence: 0.9, midi: null, symbol: null, driftSteps: 0 })
const note = (step, midi, length) => ({ step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0 })

/**
 * The whole pipeline, closed on itself: build a transcription, render it to
 * audio, transcribe that audio back, and check the result survives emission.
 *
 * This is the round-trip test in miniature. It does not need Demucs, ffmpeg or
 * a recording, so it runs in CI, and it exercises every seam between the
 * modules - which is where the failures nobody predicted actually live.
 */
describe('the pipeline, end to end', () => {
  const truth = {
    grid: GRID_JSON,
    key: { name: 'F minor', confidence: 0.5 },
    stepsPerBeat: 4,
    sections: [
      {
        index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null,
        loops: {
          kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
          snare: null,
          hats: null,
          bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 },
          chords: null,
          lead: null,
        },
      },
    ],
  }

  const rendered = renderSection(truth.sections[0], grid)
  const wrap = (samples) => writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [samples] })
  const sections = [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null }]

  it('recovers the kick from its own rendering', () => {
    const kick = transcribeDrums(wrap(rendered.layers.kick), grid, sections).kick[0]
    expect(kick).not.toBeNull()
    expect(kick.events.map((e) => e.step)).toEqual([0, 4, 8, 12])
  })

  it('recovers the bass from its own rendering', () => {
    const bass = transcribeBass(wrap(rendered.layers.bass), grid, sections)[0]
    expect(bass).not.toBeNull()
    expect(bass.events.map((e) => e.midi)).toEqual([41, 44])
  })

  it('scores its own rendering as heard correctly', () => {
    const stems = { drums: wrap(rendered.layers.kick), bass: wrap(rendered.layers.bass), other: wrap(rendered.layers.chords) }
    const hearing = verifyHearing(truth, stems)
    expect(hearing.sections[0].layers.kick.pass).toBe(true)
    expect(hearing.sections[0].layers.bass.pass).toBe(true)
  })

  it('emits code whose events match the transcription', async () => {
    const result = await verifyEmission(emitTrack(truth), truth)
    expect(result.defects).toEqual([])
    expect(result.ok).toBe(true)
  })
})

/**
 * The same round trip across several sections.
 *
 * A single-section fixture cannot fail the way a real track fails. It cannot
 * catch a per-layer query that ignores the arrangement, a chord that stops at
 * the bar line, or a repeat reused over material that differs — all of which
 * are silent until there is more than one section to get wrong.
 */
describe('the pipeline across several sections', () => {
  const kickA = { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 }
  const kickB = { loopBars: 1, events: [drum(0), drum(6), drum(10)], confidence: 0.9 }
  const chordsHeld = {
    loopBars: 2,
    events: [
      { step: 0, length: 32, velocity: 0.6, confidence: 0.8, midi: null, symbol: 'Fm7', driftSteps: 0 },
    ],
    confidence: 0.8,
    outOfKey: 0,
  }
  const bassA = { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 }

  const layered = (loops) => ({ kick: null, snare: null, hats: null, bass: null, chords: null, lead: null, ...loops })

  const truth = {
    grid: GRID_JSON,
    key: { name: 'F minor', confidence: 0.5 },
    stepsPerBeat: 4,
    sections: [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: layered({ kick: kickA, bass: bassA }) },
      { index: 1, startBar: 4, bars: 4, label: 'high', sameAs: null, loops: layered({ kick: kickA, bass: bassA, chords: chordsHeld }) },
      // Marked a repeat of section 0 and genuinely identical: reuse is safe.
      { index: 2, startBar: 8, bars: 4, label: 'mid', sameAs: 0, loops: layered({ kick: kickA, bass: bassA }) },
      // Marked a repeat of section 0 but NOT identical: this is the false-match
      // shape Phase 1 measured, and reuse here would overwrite real material.
      { index: 3, startBar: 12, bars: 4, label: 'mid', sameAs: 0, loops: layered({ kick: kickB, bass: bassA }) },
    ],
  }

  it('emits every section with its own material, reusing only true duplicates', () => {
    const code = emitTrack(truth)
    expect(code).not.toContain('const s2_kick =') // identical to section 0
    expect(code).toContain('const s3_kick =') // differs, so it keeps its own
    expect((code.match(/\[4, sec\(/g) ?? []).length).toBe(4)
  })

  it('round-trips every section through the emission check', async () => {
    const result = await verifyEmission(emitTrack(truth), truth)
    expect(result.defects).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('keeps the held chord sounding through both of its bars', async () => {
    const code = emitTrack(truth)
    const result = await verifyEmission(code, truth)
    const chords = result.sections.find((section) => section.index === 1).layers.chords
    expect(chords.missing).toBe(0)
    expect(chords.extra).toBe(0)

    // `verifyEmission`'s comparison is step/pitch only, blind to duration - a
    // chord cut at the bar line and silently restarted lands an onset at
    // exactly the same step a genuinely sustained chord's second repetition
    // would, so missing/extra alone cannot tell the two apart. Query the
    // pattern directly and check the note actually spans both bars (2 cycles,
    // since one bar is one cycle here), not one bar followed by a restart.
    const strudel = await loadStrudel()
    const track = await strudel.evaluateTrack(code)
    const { events } = querySectionStrict(track.pattern, 4, 8) // section 1: cycles 4..8
    const chordEvents = events.filter((event) => event.value.s === SOUNDS.chords.sound)
    expect(chordEvents.length).toBeGreaterThan(0)
    for (const event of chordEvents) {
      expect(event.end - event.begin).toBeCloseTo(2, 1)
    }
  })
})
