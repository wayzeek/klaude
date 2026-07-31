import { describe, expect, it } from 'vitest'
import { emitTrack } from './emit.mjs'
import { compareEvents, verifyEmission } from './verify-emission.mjs'

const GRID = { bpm: 120, beatSeconds: 0.5, barSeconds: 2, downbeatSeconds: 0, beatsPerBar: 4 }
const drum = (step) => ({ step, length: 1, velocity: 0.8, confidence: 0.9, midi: null, symbol: null, driftSteps: 0 })
const note = (step, midi, length = 4) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0,
})
const chordEvent = (step, symbol, length = 16) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi: null, symbol, driftSteps: 0,
})
const emptyLoops = () => ({ kick: null, snare: null, hats: null, bass: null, chords: null, lead: null })

function transcription(loops, bars = 4) {
  return {
    grid: GRID,
    key: { name: 'F minor', confidence: 0.5 },
    stepsPerBeat: 4,
    sections: [{ index: 0, startBar: 0, bars, label: 'mid', sameAs: null, loops }],
  }
}

describe('compareEvents', () => {
  const expected = [
    { step: 0, midi: 41 },
    { step: 4, midi: 44 },
    { step: 8, midi: 48 },
  ]

  it('matches an exact reproduction', () => {
    const result = compareEvents(expected, [...expected], { stepsPerBar: 16 })
    expect(result.matched).toBe(3)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.wrongPitch).toEqual([])
  })

  it('reports a dropped event as missing, not as wrong', () => {
    const result = compareEvents(expected, [expected[0], expected[2]], { stepsPerBar: 16 })
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0].step).toBe(4)
    expect(result.wrongPitch).toEqual([])
  })

  it('reports an added event as extra', () => {
    const result = compareEvents(expected, [...expected, { step: 12, midi: 41 }], { stepsPerBar: 16 })
    expect(result.extra).toHaveLength(1)
    expect(result.extra[0].step).toBe(12)
  })

  it('reports a changed note as wrong pitch, not as missing plus extra', () => {
    const result = compareEvents(expected, [
      { step: 0, midi: 41 },
      { step: 4, midi: 45 },
      { step: 8, midi: 48 },
    ], { stepsPerBar: 16 })
    expect(result.wrongPitch).toHaveLength(1)
    expect(result.wrongPitch[0]).toMatchObject({ step: 4, expected: 44, actual: 45 })
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it('reports timing drift separately from a missing event', () => {
    const result = compareEvents(expected, [
      { step: 0.2, midi: 41 },
      { step: 4, midi: 44 },
      { step: 8, midi: 48 },
    ], { stepsPerBar: 16 })
    expect(result.matched).toBe(3)
    expect(result.missing).toEqual([])
    expect(result.drift).toBeGreaterThan(0)
  })

  it('handles both sides empty', () => {
    const result = compareEvents([], [], { stepsPerBar: 16 })
    expect(result.matched).toBe(0)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it('reports a chord whose pitch classes changed as wrongChord, not a clean match', () => {
    // Regression: the old comparison carried `midi: null` for chord
    // expectations, so a chord's pitch was never compared at all - only its
    // onset. "C" (pitch classes 0,4,7) replaced by "Dm" (2,5,9) shares no
    // pitch class with the original and must be flagged.
    const result = compareEvents(
      [{ step: 0, midi: null, symbol: 'C' }],
      [{ step: 0, midi: null, pitchClasses: [2, 5, 9] }],
      { stepsPerBar: 16 },
    )
    expect(result.matched).toBe(1)
    expect(result.wrongChord).toHaveLength(1)
    expect(result.wrongChord[0]).toMatchObject({ step: 0, expected: 'C' })
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it('does not flag a chord whose voicing shares the same pitch classes', () => {
    // "C" voiced with a doubled third and fifth (E4 G4 C5 E5 G5, the real
    // shape `.voicing()` produces - see Task 12's report) must still compare
    // as correct: the pitch-CLASS set is {0,4,7} either way.
    const result = compareEvents(
      [{ step: 0, midi: null, symbol: 'C' }],
      [{ step: 0, midi: null, pitchClasses: [0, 4, 7] }],
      { stepsPerBar: 16 },
    )
    expect(result.wrongChord).toEqual([])
  })

  it('reports a shortened note as wrongLength, not a clean match', () => {
    // Regression: duration was never compared, so a bar-long chord shortened
    // to one step while keeping its onset returned ok.
    const result = compareEvents(
      [{ step: 0, midi: 41, length: 16 }],
      [{ step: 0, midi: 41, length: 1 }],
      { stepsPerBar: 16 },
    )
    expect(result.matched).toBe(1)
    expect(result.wrongLength).toHaveLength(1)
    expect(result.wrongLength[0]).toMatchObject({ step: 0, expected: 16, actual: 1 })
  })

  it('reports a wrong gain as wrongGain, not a clean match', () => {
    // Regression: gain was discarded from both expected and actual events, so
    // this is also what let two sections differing only in dynamics
    // deduplicate onto one loud definition without the check noticing.
    const result = compareEvents(
      [{ step: 0, midi: 41, gain: 0.4 }],
      [{ step: 0, midi: 41, gain: 0.1 }],
      { stepsPerBar: 16 },
    )
    expect(result.matched).toBe(1)
    expect(result.wrongGain).toHaveLength(1)
    expect(result.wrongGain[0]).toMatchObject({ step: 0, expected: 0.4, actual: 0.1 })
  })

  it('tolerates the rounding emit.mjs itself introduces', () => {
    const result = compareEvents(
      [{ step: 0, midi: 41, length: 4, gain: 0.35 }],
      [{ step: 0, midi: 41, length: 4.001, gain: 0.351 }],
      { stepsPerBar: 16 },
    )
    expect(result.wrongLength).toEqual([])
    expect(result.wrongGain).toEqual([])
  })
})

describe('verifyEmission', () => {
  it('confirms a round trip through the emitter', async () => {
    const t = transcription({
      ...emptyLoops(),
      kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
      bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 },
    })
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
    expect(result.defects).toEqual([])
  })

  it('confirms a round trip for sub, sorted correctly by its own distinct sound', async () => {
    const t = transcription({
      ...emptyLoops(),
      bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 },
      sub: { loopBars: 1, events: [note(4, 24, 4), note(12, 27, 4)], confidence: 0.8 },
    })
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
    expect(result.defects).toEqual([])
    // loopBars: 1 over a 4-bar section repeats each loop's 2 events 4 times.
    expect(result.sections[0].layers.sub.matched).toBe(8)
    expect(result.sections[0].layers.bass.matched).toBe(8)
  })

  it('reports a defect when the code drops a layer', async () => {
    const t = transcription({
      ...emptyLoops(),
      kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
    })
    // Emit, then delete the kick from the arrange entry.
    const broken = emitTrack(t).replace(/kick: s0_kick/g, '')
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    expect(result.defects.length).toBeGreaterThan(0)
  })

  it('reports a thrown query as a defect, never as an empty layer', async () => {
    const t = transcription({
      ...emptyLoops(),
      bass: { loopBars: 1, events: [note(0, 41, 8)], confidence: 0.8 },
    })
    // `.add()` against silence was assumed to make a query throw and does
    // not - measured directly, it silently yields zero events instead, which
    // is exactly the false pass this test exists to rule out. An invalid
    // numeral argument reaching a mini-notation string genuinely throws when
    // the pattern is queried, which is the failure mode this sabotages.
    const broken = emitTrack(t).replace(
      /const s0_bass = (.*)$/m,
      'const s0_bass = note("c3").fast("not-a-number")',
    )
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages.toLowerCase()).toMatch(/threw|error/)
  })

  it('reports unparseable source as a defect rather than throwing', async () => {
    const t = transcription({ ...emptyLoops(), kick: { loopBars: 1, events: [drum(0)], confidence: 0.9 } })
    const result = await verifyEmission('this is not javascript ((((', t)
    expect(result.ok).toBe(false)
    expect(result.defects.length).toBeGreaterThan(0)
  })

  it('accepts a transcription with every layer omitted', async () => {
    const t = transcription(emptyLoops())
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
  })

  it('reports a defect when evaluation errors after a pattern was already built', async () => {
    // `evaluateTrack` assigns `pattern` before running any `all()`/`each()`
    // transform, so a transform that throws leaves `track.error` set on a
    // track whose `track.pattern` is a perfectly valid, non-null object -
    // `!track.pattern` alone would not catch this. Checking `track.error`
    // has to be a check of its own, not a stand-in for a null pattern.
    const t = transcription({ ...emptyLoops(), kick: { loopBars: 1, events: [drum(0)], confidence: 0.9 } })
    const broken = `${emitTrack(t)}\nall((pat) => { throw new Error('boom from an all() transform') })\n`
    const result = await verifyEmission(broken, t)
    expect(result.ok).toBe(false)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages).toMatch(/boom from an all\(\) transform/)
  })

  it('collapses a voiced chord into one onset instead of reporting spurious extras', async () => {
    // `.voicing()` turns a single "C" onset into five simultaneous notes
    // (measured: E4 G4 C5 E5 G5). Uncollapsed, each of the 4 bar-onsets this
    // loop produces would report 4 extra events on top of the 1 matched note.
    const t = transcription({
      ...emptyLoops(),
      chords: { loopBars: 1, events: [chordEvent(0, 'C')], confidence: 0.8 },
    })
    const result = await verifyEmission(emitTrack(t), t)
    expect(result.ok).toBe(true)
    expect(result.sections[0].layers.chords).toMatchObject({ matched: 4, missing: 0, extra: 0, wrongPitch: 0 })
  })

  it('reports a wrong chord as a chord defect, not a clean onset match', async () => {
    // Codex review example: replacing a transcribed C chord with Dm used to
    // return ok: true, because chord expectations carried midi: null and the
    // comparison never looked at pitch class at all - only the onset count
    // survived the voicing collapse.
    const t = transcription({
      ...emptyLoops(),
      chords: { loopBars: 1, events: [chordEvent(0, 'C')], confidence: 0.8 },
    })
    const emitted = emitTrack(t)
    const mutated = emitted.replace('chord(`C@16`)', 'chord(`Dm@16`)')
    expect(mutated).not.toBe(emitted) // sanity: the replace actually matched
    const result = await verifyEmission(mutated, t)
    expect(result.ok).toBe(false)
    // Loops across all 4 bars of the section, so all 4 onsets are wrong.
    expect(result.sections[0].layers.chords.wrongChord).toBe(4)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages).toMatch(/wrong chord/)
  })

  it('reports a shortened chord as a duration defect, not a clean onset match', async () => {
    // Codex review example: shortening a bar-long chord to a single step
    // while keeping its onset used to return ok: true, because duration was
    // discarded from both the expected and the queried event.
    const t = transcription({
      ...emptyLoops(),
      chords: { loopBars: 1, events: [chordEvent(0, 'C')], confidence: 0.8 },
    })
    const emitted = emitTrack(t)
    const mutated = emitted.replace('chord(`C@16`)', 'chord(`C@1 ~@15`)')
    expect(mutated).not.toBe(emitted)
    const result = await verifyEmission(mutated, t)
    expect(result.ok).toBe(false)
    expect(result.sections[0].layers.chords.wrongLength).toBeGreaterThan(0)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages).toMatch(/wrong duration/)
  })

  it('reports a wrong gain as a gain defect, not a clean match', async () => {
    // Gain was discarded from both sides of the comparison, which is also
    // what let sameLoops' missing velocity check (a separate defect, fixed
    // alongside this one) go unnoticed downstream: a reused, wrong-volume
    // definition still reported ok here.
    const t = transcription({
      ...emptyLoops(),
      kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
    })
    const emitted = emitTrack(t)
    const mutated = emitted.replace(/0\.4/g, '0.1')
    expect(mutated).not.toBe(emitted)
    const result = await verifyEmission(mutated, t)
    expect(result.ok).toBe(false)
    expect(result.sections[0].layers.kick.wrongGain).toBeGreaterThan(0)
    const messages = result.defects.map((d) => d.message).join(' ')
    expect(messages).toMatch(/wrong gain/)
  })

  describe('with a sound-match gain trim', () => {
    const t = transcription({
      ...emptyLoops(),
      bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 },
    })
    const soundMatch = { bass: { chain: '.lpf(900)', gainTrim: 0.6, notes: ['test'] } }

    it('passes when the check is told about the same trim the emitter used', async () => {
      const code = emitTrack(t, { soundMatch })
      const result = await verifyEmission(code, t, { soundMatch })
      expect(result.ok).toBe(true)
      expect(result.defects).toEqual([])
    })

    it('reports a wrong-gain defect when the check does not know about the trim', async () => {
      // The emitter wrote gain values scaled by 0.6; without the same
      // soundMatch, verifyEmission's expected gain is still the untrimmed
      // base - proving the two sides have to agree on the trim, not just on
      // SOUNDS[layer].gain.
      const code = emitTrack(t, { soundMatch })
      const result = await verifyEmission(code, t)
      expect(result.ok).toBe(false)
      expect(result.sections[0].layers.bass.wrongGain).toBeGreaterThan(0)
    })
  })

  describe('fills and one-off variation (#23)', () => {
    it('confirms a round trip for a section whose kick carries a real fill', async () => {
      const t = transcription({
        ...emptyLoops(),
        kick: {
          loopBars: 1,
          events: [drum(0), drum(4), drum(8), drum(12)],
          confidence: 0.9,
          variation: {
            kind: 'fill',
            bar: 3,
            events: [
              { step: 1, length: 1, velocity: 0.6, confidence: 0.9, midi: null, symbol: null },
              { step: 3, length: 1, velocity: 0.7, confidence: 0.9, midi: null, symbol: null },
              { step: 5, length: 1, velocity: 0.8, confidence: 0.9, midi: null, symbol: null },
            ],
            note: 'test fill',
          },
        },
      })
      const result = await verifyEmission(emitTrack(t), t)
      expect(result.ok).toBe(true)
      expect(result.defects).toEqual([])
      // 4 bars x 4 loop hits, plus 3 extra onsets in the closing bar only.
      expect(result.sections[0].layers.kick.matched).toBe(4 * 4 + 3)
      expect(result.sections[0].layers.kick.missing).toBe(0)
      expect(result.sections[0].layers.kick.extra).toBe(0)
    })

    it('confirms a round trip for a section whose kick carries a crash on the first downbeat', async () => {
      const t = transcription({
        ...emptyLoops(),
        kick: {
          loopBars: 1,
          events: [drum(0), drum(4), drum(8), drum(12)],
          confidence: 0.9,
          variation: {
            kind: 'crash',
            bar: 0,
            events: [{ step: 0, length: 1, velocity: 0.95, confidence: 0.9, midi: null, symbol: null }],
            note: 'test crash',
          },
        },
      })
      const result = await verifyEmission(emitTrack(t), t)
      expect(result.ok).toBe(true)
      expect(result.defects).toEqual([])
      // 4 bars x 4 loop hits, plus one extra impact stacked on bar 0's own
      // downbeat (the loop already plays a kick at that exact step too).
      expect(result.sections[0].layers.kick.matched).toBe(4 * 4 + 1)
    })

    it('reports a defect when the emitted code is missing the fill the transcription describes', async () => {
      // The contract #23 asks for: a fill present in the transcription but
      // absent from the code must report as missing, not pass silently.
      const t = transcription({
        ...emptyLoops(),
        kick: {
          loopBars: 1,
          events: [drum(0), drum(4), drum(8), drum(12)],
          confidence: 0.9,
          variation: {
            kind: 'fill',
            bar: 3,
            events: [
              { step: 1, length: 1, velocity: 0.6, confidence: 0.9, midi: null, symbol: null },
              { step: 3, length: 1, velocity: 0.7, confidence: 0.9, midi: null, symbol: null },
              { step: 5, length: 1, velocity: 0.8, confidence: 0.9, midi: null, symbol: null },
            ],
            note: 'test fill',
          },
        },
      })
      const emitted = emitTrack(t)
      expect(emitted).toContain('.lastOf(4,')
      // `.lastOf(...)` is the last thing `layerExpression` appends, so
      // truncating from it to end-of-line drops exactly the fill and nothing
      // else - simpler than balancing the nested parens inside `.superimpose`.
      const broken = emitted.replace(/\.lastOf\(4,.*$/m, '')
      expect(broken).not.toBe(emitted)
      const result = await verifyEmission(broken, t)
      expect(result.ok).toBe(false)
      expect(result.sections[0].layers.kick.missing).toBe(3)
    })

    it('reports a defect when the emitted code has a fill the transcription does not describe', async () => {
      // The reverse of the above: something in the code that the artifact
      // never claimed must read as spurious extras, not a clean match -
      // otherwise a fabricated fill could slip through unreported.
      const t = transcription({
        ...emptyLoops(),
        kick: { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 },
      })
      const emitted = emitTrack(t)
      const fabricated = emitted.replace(
        /const s0_kick = (.*)$/m,
        'const s0_kick = $1.lastOf(4, x => x.superimpose(() => s(`~@1 bd ~@14`).bank("RolandTR909").gain(`0.5`)))',
      )
      expect(fabricated).not.toBe(emitted)
      const result = await verifyEmission(fabricated, t)
      expect(result.ok).toBe(false)
      expect(result.sections[0].layers.kick.extra).toBeGreaterThan(0)
    })
  })

  describe('sound-match pan on a sustained-note layer', () => {
    // A single held note spanning most of a bar - the shape a real lead/chord
    // line takes, and exactly the shape that exposed the hazard below.
    const t = transcription({ ...emptyLoops(), lead: { loopBars: 1, events: [note(0, 65, 14)], confidence: 0.8 } })

    // Regression, against the real Strudel engine rather than a probe script:
    // `.pan("0.35 0.65")` does not pan a note whose span crosses the pan
    // pattern's own half-cycle boundary, it *duplicates* the hap - one full-
    // length copy per pan value. `sound-match.mjs` only ever proposes this
    // pan for kick/snare/hats (always exactly one step long, so they can
    // never straddle that boundary - see its own module comment); this test
    // pins the underlying Strudel behaviour that reasoning depends on, so a
    // future Strudel upgrade that changed it would fail loudly here rather
    // than silently reappearing as a duplicated lead note in a real track.
    it('duplicates a sustained note instead of panning it - confirming why sound-match never proposes this for lead', async () => {
      const soundMatch = { lead: { chain: '.pan("0.35 0.65")', gainTrim: 1, notes: ['forced for this test'] } }
      const code = emitTrack(t, { soundMatch })
      const result = await verifyEmission(code, t, { soundMatch })
      expect(result.ok).toBe(false)
      expect(result.sections[0].layers.lead.extra).toBeGreaterThan(0)
    })

    it('stays clean on the same sustained note when sound-match leaves lead pan alone, as it always does', async () => {
      const soundMatch = { lead: { chain: '', gainTrim: 1, notes: ['pan left alone - see module comment'] } }
      const code = emitTrack(t, { soundMatch })
      const result = await verifyEmission(code, t, { soundMatch })
      expect(result.ok).toBe(true)
      expect(result.defects).toEqual([])
    })
  })
})
