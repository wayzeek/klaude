import { describe, expect, it } from 'vitest'
import { CHROMA_FFT } from '../dsp.mjs'
import { writeWavBuffer } from '../__fixtures__/make-wav.mjs'
import { renderSection } from './resynth.mjs'
import { gridFromJson } from './transcribe/quantize.mjs'
import { HEARING_THRESHOLDS, scoreLayer, spectralCentroid, verifyHearing } from './verify-hearing.mjs'

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
  // `sub` shares the `bass` stem (`LAYER_STEM.sub === 'bass'`): a real Demucs
  // separation puts both in the same "bass" source category, and `sub` is a
  // register split of the same transcribed line, not a second instrument -
  // see `bass.mjs`'s `splitByRegister`. Summed in here rather than kept
  // separate, so a test that never sets `sub` (every test above this comment)
  // adds a silent buffer and sees no change at all.
  const bass = new Float32Array(layers.bass.length)
  for (let i = 0; i < bass.length; i++) bass[i] = layers.bass[i] + layers.sub[i]
  const wrap = (samples) => writeWavBuffer({ sampleRate: SAMPLE_RATE, channels: 1, samples: [samples] })
  return { drums: wrap(drums), bass: wrap(bass), other: wrap(other) }
}

// Bass scoring now runs `trackF0` (YIN) over both the rendered buffer and the
// stem, twice per `verifyHearing` call in tests that compare a correct and a
// corrupted score - real work, not the near-instant math the other layers
// use, and slow enough on these fixtures (~2s per verifyHearing call
// measured directly) to need a longer-than-default test timeout.
const BASS_TEST_TIMEOUT = 15000

describe('verifyHearing', () => {
  it('scores a transcription against a synthesis of itself near perfect', () => {
    const transcription = transcriptionWith(BASE_LOOPS)
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.kick.score).toBeGreaterThan(0.85)
    expect(result.sections[0].layers.bass.score).toBeGreaterThan(0.85)
    expect(result.overall).toBeGreaterThan(0.85)
  }, BASS_TEST_TIMEOUT)

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
  }, BASS_TEST_TIMEOUT)

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
  }, BASS_TEST_TIMEOUT)

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
  }, BASS_TEST_TIMEOUT)

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
  }, BASS_TEST_TIMEOUT)

  it('notices a bassline transcribed an octave low', () => {
    // `bassAgreement` compares full MIDI pitch from `trackF0`, not pitch
    // class, so an octave error is just a wrong note to it - unlike chroma,
    // which folds octaves together on purpose and would need a separate
    // register term to catch this at all (see verify-hearing.mjs's history:
    // that used to be true here too, back when bass scored on chroma).
    // Measured directly: this fixture scores 1.000 correct and 0.000 octave
    // down, not a partial credit - #42's headline criterion (correct octave)
    // fails completely rather than plausibly for a bass line, which is
    // exactly what should happen.
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
    expect(low).toBeLessThan(right - 0.2)
  }, BASS_TEST_TIMEOUT)

  it('scores lower when the chord progression is tritone-transposed', () => {
    // Before this test, nothing in the suite exercised chord discrimination
    // at all: forcing scoreLayer's `if (layer === 'chords') return harmonic`
    // to `return 1` (a constant, ignoring the stem entirely) broke 0 of 384
    // tests. Tritone is the clean, well-separated case (see
    // `HEARING_THRESHOLDS`'s comment) - a same-key wrong chord is only
    // partly caught, but a wrong key is not caught at all under a constant,
    // so this is the corruption that actually proves the mechanism runs.
    const chords = {
      loopBars: 1,
      events: [{ step: 0, length: 16, velocity: 0.6, confidence: 0.9, midi: null, symbol: 'Fm7', driftSteps: 0 }],
      confidence: 0.9,
      outOfKey: 0,
    }
    const truth = transcriptionWith({ ...BASE_LOOPS, chords })
    const stems = stemsFromTranscription(truth)
    const tritone = transcriptionWith({
      ...BASE_LOOPS,
      chords: { ...chords, events: [{ ...chords.events[0], symbol: 'Bm7' }] },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.chords
    const wrong = verifyHearing(tritone, stems).sections[0].layers.chords
    console.log(`tritone-transposed chords: correct=${right.score.toFixed(3)} tritone=${wrong.score.toFixed(3)}`)
    expect(right.score).toBeGreaterThan(0.85)
    expect(wrong.score).toBeLessThan(HEARING_THRESHOLDS.chords)
    expect(right.pass).toBe(true)
    expect(wrong.pass).toBe(false)
  }, BASS_TEST_TIMEOUT)

  it('documents that a same-key wrong chord currently passes - a known gap, not a fix', () => {
    // This is not a regression if it stays true. `HEARING_THRESHOLDS`'s
    // comment already discloses that chroma cannot reliably separate a
    // same-key substitution from the real progression (measured on
    // the-chase: 0.817 correct vs 0.685 tonic-substituted, overlapping
    // ranges). Pinning it here puts that knowledge in the suite instead of
    // only in a comment - if this later starts failing (the substituted
    // score drops below threshold), that's an improvement to update this
    // test for, not a bug to fix.
    const chords = {
      loopBars: 2,
      events: [
        { step: 0, length: 16, velocity: 0.6, confidence: 0.9, midi: null, symbol: 'Fm7', driftSteps: 0 },
        { step: 16, length: 16, velocity: 0.6, confidence: 0.9, midi: null, symbol: 'Ab^7', driftSteps: 0 },
      ],
      confidence: 0.9,
      outOfKey: 0,
    }
    const truth = transcriptionWith({ ...BASE_LOOPS, chords }, 8)
    const stems = stemsFromTranscription(truth)
    const tonicThroughout = transcriptionWith(
      { ...BASE_LOOPS, chords: { ...chords, events: chords.events.map((e) => ({ ...e, symbol: 'Fm7' })) } },
      8,
    )
    const right = verifyHearing(truth, stems).sections[0].layers.chords
    const wrong = verifyHearing(tonicThroughout, stems).sections[0].layers.chords
    console.log(`same-key substitution: correct=${right.score.toFixed(3)} tonic-throughout=${wrong.score.toFixed(3)}`)
    expect(right.score).toBeGreaterThan(0.85)
    expect(wrong.score).toBeGreaterThanOrEqual(HEARING_THRESHOLDS.chords)
    expect(wrong.pass).toBe(true)
  }, BASS_TEST_TIMEOUT)

  it('reports null for an omitted layer rather than a zero score', () => {
    const transcription = transcriptionWith(BASE_LOOPS)
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.snare).toBeNull()
    expect(result.sections[0].layers.lead).toBeNull()
  }, BASS_TEST_TIMEOUT)

  // `HEARING_THRESHOLDS` used to have no `lead` entry at all, and
  // `verifyHearing`'s `thresholds[layer] ?? Infinity` fallback turned that
  // absence into `score >= Infinity` - always false. That was invisible while
  // `transcribeMelody` emitted nothing (no section ever had a real `lead`
  // loop to score), and would have silently dropped every lead layer the
  // moment melody extraction was enabled, regardless of quality. This pins
  // the fix: a `lead` loop scored against a synthesis of itself - the same
  // "perfect case" every other layer's threshold is calibrated against -
  // must be able to pass.
  it('a lead loop can actually pass, not just chords/kick/bass/hats', () => {
    const lead = { loopBars: 1, events: [note(0, 65, 4), note(4, 68, 4), note(8, 72, 4), note(12, 68, 4)], confidence: 0.8 }
    const transcription = transcriptionWith({ ...BASE_LOOPS, lead })
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.lead).not.toBeNull()
    expect(result.sections[0].layers.lead.pass).toBe(true)
  })

  // Placed on steps 4-7/12-15, where BASE_LOOPS.bass (steps 0-3/8-11) is
  // silent - not because sub and bass never overlap in real material (the
  // reference track's own sub and bass frequently sound at once), but because
  // `bassAgreement` tracks one fundamental at a time and two real,
  // simultaneous notes an octave-plus apart is a genuine, separate limitation
  // of monophonic F0 tracking on a summed stem, not something this dispatch
  // test is trying to characterise (Glue's own end-to-end run is where that
  // gets measured on real audio).
  it('scores a sub loop against the (shared) bass stem, same mechanism as bass', () => {
    const sub = { loopBars: 1, events: [note(4, 24, 4), note(12, 27, 4)], confidence: 0.8 }
    const transcription = transcriptionWith({ ...BASE_LOOPS, sub })
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.sub).not.toBeNull()
    expect(result.sections[0].layers.sub.score).toBeGreaterThan(0.85)
    expect(result.sections[0].layers.sub.pass).toBe(true)
  }, BASS_TEST_TIMEOUT)

  it('scores a sub loop lower when it is transposed a semitone off the stem', () => {
    const sub = { loopBars: 1, events: [note(4, 24, 4), note(12, 27, 4)], confidence: 0.8 }
    const truth = transcriptionWith({ ...BASE_LOOPS, sub })
    const stems = stemsFromTranscription(truth)

    const wrong = transcriptionWith({
      ...BASE_LOOPS,
      sub: { loopBars: 1, events: sub.events.map((e) => ({ ...e, midi: e.midi + 1 })), confidence: 0.8 },
    })
    const right = verifyHearing(truth, stems).sections[0].layers.sub.score
    const off = verifyHearing(wrong, stems).sections[0].layers.sub.score
    console.log(`semitone-off sub: correct=${right.toFixed(3)} wrong=${off.toFixed(3)}`)
    expect(right).toBeGreaterThan(0.85)
    expect(off).toBeLessThan(right - 0.1)
  }, BASS_TEST_TIMEOUT)

  it('reports null for sub when the section carries no sub loop', () => {
    const transcription = transcriptionWith(BASE_LOOPS)
    const result = verifyHearing(transcription, stemsFromTranscription(transcription))
    expect(result.sections[0].layers.sub).toBeNull()
  }, BASS_TEST_TIMEOUT)

  it('handles a section with no layers at all', () => {
    const empty = transcriptionWith({
      kick: null, snare: null, hats: null, bass: null, chords: null, lead: null,
    })
    const result = verifyHearing(empty, stemsFromTranscription(transcriptionWith(BASE_LOOPS)))
    expect(result.sections[0].layers.kick).toBeNull()
    expect(Number.isFinite(result.overall)).toBe(true)
  })
})

describe('scoreLayer', () => {
  it('does not report a false perfect score when one side is genuinely silent', () => {
    // beatChroma samples three fixed 4096-sample windows per beat (start,
    // middle, end) and reads nothing in between. A signal placed entirely in
    // one of those gaps is real by any raw-amplitude measure - `hasSignal`
    // sees it, and so would a human ear - but invisible to beatChroma, which
    // reports it as silent every beat, same as true silence would. When the
    // *other* side really is silent, both sides land on an all-zero chroma
    // vector for every beat, and the harmonic average's "no evidence either
    // way" fallback (`counted > 0 ? ... : 1`) reports a perfect 1.0 - correct
    // when both sides are actually silent, wrong when one side has real
    // content the analysis simply didn't sample. Catching that distinction is
    // the `hasSignal` guard's only non-redundant job: `cosine`/`correlate`
    // already return 0 for ordinary one-sided silence *inside* a sampled
    // window on their own, which is why the other seven tests here don't
    // exercise this path.
    //
    // Window bounds for this grid (beatSeconds 0.5, CHROMA_FFT 4096): window 0
    // covers samples [0, 4096), window 1 starts at 8977 - so [4200, 4900) is
    // untouched by any window, confirmed directly with a probe script before
    // this test was written.
    const frames = Math.round(1 * SAMPLE_RATE) // 1 second, enough for two beats
    const rendered = new Float32Array(frames)
    for (let i = 4200; i < 4900; i++) {
      rendered[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)
    }
    const trueSilence = new Float32Array(frames)

    expect(scoreLayer(rendered, trueSilence, 'bass', grid)).toBe(0)
  })

  // `HEARING_THRESHOLDS.lead` is a placeholder that exists only to reject the
  // exact `score === 0` degenerate case - `thresholds[layer] ?? Infinity`'s
  // own comment explains why `lead: 0` would not do that (`0 >= 0` is true).
  // This pins the one case that constant has to catch.
  it('a genuinely silent lead comparison does not clear HEARING_THRESHOLDS.lead', () => {
    const frames = Math.round(1 * SAMPLE_RATE)
    const rendered = new Float32Array(frames)
    for (let i = 0; i < frames; i++) rendered[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)
    const trueSilence = new Float32Array(frames)

    const score = scoreLayer(rendered, trueSilence, 'lead', grid)
    expect(score).toBe(0)
    expect(score >= HEARING_THRESHOLDS.lead).toBe(false)
  })
})

describe('spectralCentroid', () => {
  it('measures the second of exactly two full FFT blocks, not just the first', () => {
    // A buffer of precisely 2 * CHROMA_FFT samples sits exactly on the
    // boundary the hop-count fix targets: `floor((2*CHROMA_FFT - CHROMA_FFT)
    // / CHROMA_FFT)` is 1, so without the `+ 1` only hop 0 (the first block)
    // gets measured and the second block - a second, fully valid
    // CHROMA_FFT-sized window - is silently dropped. The first half carries a
    // low tone, the second half a much higher one, so dropping the second
    // half understates the centroid by a wide, unmistakable margin rather
    // than a rounding sliver. Measured directly (see the probe this test
    // replaced): the buggy hop count (only the first block) scores ~200 Hz -
    // the low tone's own frequency; counting both blocks scores ~6100 Hz.
    const lowHz = 200
    const highHz = 12000
    const samples = new Float32Array(2 * CHROMA_FFT)
    for (let i = 0; i < CHROMA_FFT; i++) samples[i] = Math.sin((2 * Math.PI * lowHz * i) / 44100)
    for (let i = 0; i < CHROMA_FFT; i++) {
      samples[CHROMA_FFT + i] = Math.sin((2 * Math.PI * highHz * i) / 44100)
    }

    expect(spectralCentroid(samples)).toBeGreaterThan(2000)
  })
})
