import { describe, expect, it } from 'vitest'
import { SOUNDS, barToMini, emitTrack, midiToNoteName, prefersFlats, respell } from './emit.mjs'

const GRID = { bpm: 138, beatSeconds: 60 / 138, barSeconds: (60 / 138) * 4, downbeatSeconds: 0.348, beatsPerBar: 4 }

const drum = (step, velocity = 0.8) => ({
  step, length: 1, velocity, confidence: 0.9, midi: null, symbol: null, driftSteps: 0,
})
const note = (step, midi, length = 4) => ({
  step, length, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0,
})
const chord = (step, symbol, length = 16) => ({
  step, length, velocity: 0.7, confidence: 0.8, midi: null, symbol, driftSteps: 0,
})

const FOUR_ON_THE_FLOOR = { loopBars: 1, events: [drum(0), drum(4), drum(8), drum(12)], confidence: 0.9 }

function transcription(sections) {
  return {
    grid: GRID,
    key: { name: 'F minor', confidence: 0.09 },
    stepsPerBeat: 4,
    sections,
  }
}

const emptyLoops = () => ({ kick: null, snare: null, hats: null, bass: null, sub: null, chords: null, lead: null })

describe('midiToNoteName', () => {
  it('names notes with octaves', () => {
    expect(midiToNoteName(41)).toBe('f2')
    expect(midiToNoteName(69)).toBe('a4')
    expect(midiToNoteName(60)).toBe('c4')
  })

  it('spells with flats when asked', () => {
    expect(midiToNoteName(61, { flats: false })).toBe('c#4')
    expect(midiToNoteName(61, { flats: true })).toBe('db4')
  })

  it('picks the spelling from the mode, not just the root', () => {
    // D minor takes one flat; D major takes two sharps. Same root, opposite
    // spelling, so the root alone cannot decide.
    expect(prefersFlats('D minor')).toBe(true)
    expect(prefersFlats('D major')).toBe(false)
    expect(prefersFlats('F minor')).toBe(true)
    expect(prefersFlats('E major')).toBe(false)
  })
})

describe('respell', () => {
  it('turns sharps into flats in a flat key', () => {
    expect(respell('C#^7', { flats: true })).toBe('Db^7')
    expect(respell('F#m7', { flats: true })).toBe('Gbm7')
  })

  it('leaves a chord alone when it has no accidental', () => {
    expect(respell('Fm9', { flats: true })).toBe('Fm9')
    expect(respell('C7', { flats: true })).toBe('C7')
  })

  it('leaves sharps alone in a sharp key', () => {
    expect(respell('C#^7', { flats: false })).toBe('C#^7')
  })
})

describe('barToMini', () => {
  it('writes a lone hit against a weighted rest', () => {
    const slots = new Array(16).fill(null)
    slots[0] = { token: 'bd', length: 1 }
    expect(barToMini(slots)).toBe('bd ~@15')
  })

  it('writes single-step rests as bare tildes', () => {
    const slots = new Array(16).fill(null)
    for (const step of [0, 2, 4, 6, 8, 10, 12, 14]) slots[step] = { token: 'hh', length: 1 }
    expect(barToMini(slots)).toBe('hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~')
  })

  it('collapses a held note into a weighted step', () => {
    const slots = new Array(16).fill(null)
    slots[0] = { token: 'f2', length: 8 }
    slots[8] = { token: 'ab2', length: 8 }
    expect(barToMini(slots)).toBe('f2@8 ab2@8')
  })

  it('collapses runs of rests', () => {
    const slots = new Array(16).fill(null)
    slots[0] = { token: 'bd', length: 1 }
    slots[8] = { token: 'bd', length: 1 }
    expect(barToMini(slots)).toBe('bd ~@7 bd ~@7')
  })

  it('is all rest for an empty bar', () => {
    expect(barToMini(new Array(16).fill(null))).toBe('~')
  })
})

describe('emitTrack', () => {
  it('sets the tempo from the grid', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]))
    expect(code).toContain('setcpm(138/4)') // 4/4; a 3/4 grid must emit /3
  })

  it('divides by the grid meter, not a hardcoded 4', () => {
    // setcpm's divisor is grid.beatsPerBar. A track in 3/4 must emit /3 - a
    // hardcoded /4 would play a waltz a third too fast without ever failing
    // the 4/4 case above, which is exactly the trap: this is the only
    // fixture in the suite where the two divisors disagree.
    const waltz = { ...GRID, bpm: 120, beatsPerBar: 3 }
    const code = emitTrack({
      grid: waltz, key: { name: 'F minor', confidence: 0.09 }, stepsPerBeat: 4,
      sections: [{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } }],
    })
    expect(code).toContain('setcpm(120/3)')
    expect(code).not.toContain('setcpm(120/4)')
  })

  it('writes arrange over layers, one entry per section', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
      { index: 1, startBar: 4, bars: 8, label: 'high', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]))
    expect(code).toContain('arrange(')
    expect(code).toMatch(/\[4,\s+sec\(/)
    expect(code).toMatch(/\[8,\s+sec\(/)
  })

  it('names every layer in the section helper, so the studio sees a stable list', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]))
    for (const layer of ['kick', 'snare', 'hats', 'bass', 'sub', 'chords', 'lead']) {
      expect(code).toContain(`${layer}: o.${layer} || S`)
    }
  })

  it('leaves no trace of an omitted layer in the arrange entries', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]))
    const arrangeBlock = code.slice(code.indexOf('arrange('))
    expect(arrangeBlock).toContain('kick:')
    expect(arrangeBlock).not.toContain('lead:')
    expect(arrangeBlock).not.toContain('snare:')
  })

  it('reuses one definition when two sections transcribed identically', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
      { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]
    const code = emitTrack(transcription(sections))
    expect((code.match(/^const s0_kick =/gm) ?? []).length).toBe(1)
    expect(code).not.toContain('const s1_kick =')
    expect((code.match(/kick: s0_kick/g) ?? []).length).toBe(2)
  })

  it('does not reuse when the two sections transcribed differently', () => {
    // This is the false-repeat case: sections.mjs marked section 1 a repeat of
    // section 0, but the transcribers heard different material. The marking is
    // wrong and reuse would write section 0's kick over section 1's.
    const sections = [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
      {
        index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0,
        loops: { ...emptyLoops(), kick: { loopBars: 1, events: [drum(0), drum(6), drum(10)], confidence: 0.9 } },
      },
    ]
    const code = emitTrack(transcription(sections))
    expect(code).toContain('const s1_kick =')
    expect(code).toContain('kick: s1_kick')
  })

  it('does not reuse when the two sections differ only in velocity', () => {
    // Regression: sameLoops compared step/length/midi/symbol but not
    // velocity, so a quiet reprise reused the loud section's definition and
    // was silently emitted at full volume - erasing ghost-note dynamics.
    // Measured directly: kick velocities 1.0 and 0.1 both emitted the one
    // gain(0.5) definition before this fix.
    const sections = [
      {
        index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null,
        loops: { ...emptyLoops(), kick: { loopBars: 1, events: [drum(0, 1), drum(4, 1), drum(8, 1), drum(12, 1)], confidence: 0.9 } },
      },
      {
        index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0,
        loops: { ...emptyLoops(), kick: { loopBars: 1, events: [drum(0, 0.1), drum(4, 0.1), drum(8, 0.1), drum(12, 0.1)], confidence: 0.9 } },
      },
    ]
    const code = emitTrack(transcription(sections))
    expect(code).toContain('const s1_kick =')
    expect(code).toContain('kick: s1_kick')
  })

  it('does not reuse when a repeat runs a different number of bars', () => {
    const sections = [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
      { index: 1, startBar: 4, bars: 8, label: 'mid', sameAs: 0, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]
    expect(emitTrack(transcription(sections))).toContain('const s1_kick =')
  })

  it('emits a bassline as note names with octaves', () => {
    const code = emitTrack(transcription([
      {
        index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null,
        loops: { ...emptyLoops(), bass: { loopBars: 1, events: [note(0, 41, 8), note(8, 44, 8)], confidence: 0.8 } },
      },
    ]))
    expect(code).toContain('f2@8')
    expect(code).toContain('ab2@8')
  })

  it('emits chords respelled for a flat key', () => {
    const code = emitTrack(transcription([
      {
        index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null,
        loops: { ...emptyLoops(), chords: { loopBars: 1, events: [chord(0, 'C#^7')], confidence: 0.7, outOfKey: 0 } },
      },
    ]))
    expect(code).toContain('Db^7')
    expect(code).not.toContain('C#^7')
  })

  it('writes a multi-bar loop as an alternation, one bar per slot', () => {
    const twoBar = {
      loopBars: 2,
      events: [drum(0), drum(4), drum(8), drum(12), drum(16), drum(20), drum(24), drum(28), drum(30)],
      confidence: 0.9,
    }
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: twoBar } },
    ]))
    expect(code).toMatch(/<\[.*\] \[.*\]>/)
  })

  it('stages gain per layer and carries velocity into it', () => {
    const loud = { loopBars: 1, events: [drum(0, 1), drum(8, 0.2)], confidence: 0.9 }
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: loud } },
    ]))
    // `layerExpression` quotes with backticks (not double quotes) so a
    // wrapped, multi-line pattern is still valid JS; this loop is short
    // enough to stay on one line either way.
    const match = /\.gain\(`([^`]+)`\)/.exec(code)
    expect(match).not.toBeNull()
    const values = match[1].split(' ').map((token) => Number(token.split('@')[0]))
    // The accented hit must come out clearly louder than the ghost.
    expect(Math.max(...values)).toBeGreaterThan(Math.min(...values) * 2)
    // And the layer's own base gain is the ceiling - a velocity-1 hit lands
    // at it exactly, matching resynth.mjs's `voice.gain * velocity` and the
    // hand-authored gains in tracks/MINUIT (no extra headroom factor).
    expect(Math.max(...values)).toBeLessThanOrEqual(SOUNDS.kick.gain)
  })

  it('emits sub as a distinct sine voice, under the bass-register gain ceiling', () => {
    const subLoop = { loopBars: 1, events: [note(0, 24, 4), note(8, 27, 4)], confidence: 0.8 }
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), sub: subLoop } },
    ]))
    expect(code).toContain('.s("sine").lpf(130)')
    // A distinct `sound` from every other layer - verify-emission.mjs sorts
    // events back into layers by this field, so a collision would make sub
    // events silently read as bass (or vice versa).
    const otherSounds = ['kick', 'snare', 'hats', 'bass', 'chords', 'lead'].map((l) => SOUNDS[l].sound)
    expect(otherSounds).not.toContain(SOUNDS.sub.sound)
    const match = /note\(`([^`]+)`\)\.s\("sine"\)\.lpf\(130\)\.gain\(`([^`]+)`\)/.exec(code)
    expect(match).not.toBeNull()
    const gains = match[2].split(' ').map((token) => Number(token.split('@')[0]))
    // check.mjs's BASS_GAIN_CEILING is 0.45; SOUNDS.sub.gain must clear it
    // with margin, the same way SOUNDS.bass already does.
    expect(Math.max(...gains)).toBeLessThanOrEqual(0.45)
    expect(Math.max(...gains)).toBeLessThanOrEqual(SOUNDS.sub.gain)
  })

  it('omits sub from the arrangement when no section has one, same as any other layer', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]))
    const arrangeBlock = code.slice(code.indexOf('arrange('))
    expect(arrangeBlock).not.toContain('sub:')
    expect(code).not.toContain('.s("sine")')
  })

  it('sustains a chord across a bar line instead of clipping it', () => {
    // A two-bar loop holding one chord throughout. An alternation would stop
    // the chord at the first bar, so this must come out as a slowed sequence.
    const held = { loopBars: 2, events: [chord(0, 'Fm7', 32)], confidence: 0.7, outOfKey: 0 }
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), chords: held } },
    ]))
    expect(code).toContain('.slow(2)')
    expect(code).not.toMatch(/chord\("<\[/)
  })

  it('emits a header naming the source', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]), { title: 'the chase', source: 'recordings/the-chase.wav' })
    // tracks/MINUIT/02-the-chase.md:12 renders its own title in caps
    // ("THE CHASE"); the header matches that house style.
    expect(code).toContain('THE CHASE')
    expect(code).toContain('138 BPM')
    expect(code).toContain('F minor')
  })

  it('produces something for a transcription with no layers at all', () => {
    const code = emitTrack(transcription([
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: emptyLoops() },
    ]))
    expect(code).toContain('arrange(')
    expect(code).toContain('sec({})')
  })

  describe('with a soundMatch', () => {
    const sections = () => [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]

    it('emits no extra chain, gain trim or header without a soundMatch', () => {
      const code = emitTrack(transcription(sections()))
      expect(code).not.toContain('sound match')
      expect(code).not.toContain('.room(')
      expect(code).not.toContain('.pan(')
    })

    it('splices the chain in after the dry suffix and before .gain()', () => {
      const soundMatch = { kick: { chain: '.room(0.3)', gainTrim: 1, notes: ['room test'] } }
      const code = emitTrack(transcription(sections()), { soundMatch })
      expect(code).toMatch(/\.bank\("RolandTR909"\)\.room\(0\.3\)\.gain\(/)
    })

    it('prints one header block naming the measurement behind each layer', () => {
      const soundMatch = {
        kick: { chain: '', gainTrim: 1, notes: ['kick note one', 'kick note two'] },
        snare: { chain: '', gainTrim: 1, notes: ['snare note'] },
      }
      const code = emitTrack(transcription(sections()), { soundMatch })
      expect(code).toContain('sound match: measured against the source stems')
      expect(code).toContain('kick note one')
      expect(code).toContain('kick note two')
      expect(code).toContain('snare note')
      // The header appears once, not once per section definition.
      expect((code.match(/kick note one/g) ?? []).length).toBe(1)
    })

    it('skips a layer in the header when it carries no notes', () => {
      const soundMatch = { kick: { chain: '', gainTrim: 1, notes: [] } }
      const code = emitTrack(transcription(sections()), { soundMatch })
      expect(code).not.toContain('// kick:')
    })

    it('scales the emitted gain ceiling by gainTrim, never past it', () => {
      const soundMatch = { kick: { chain: '', gainTrim: 0.6, notes: ['trim test'] } }
      const code = emitTrack(transcription(sections()), { soundMatch })
      const match = /\.gain\(`([^`]+)`\)/.exec(code)
      const values = match[1].split(' ').map((token) => Number(token.split('@')[0]))
      // A velocity-1 hit lands at the trimmed ceiling (0.5 * 0.6 = 0.3), not
      // the untrimmed SOUNDS.kick.gain (0.5).
      expect(Math.max(...values)).toBeCloseTo(SOUNDS.kick.gain * 0.6, 5)
      expect(Math.max(...values)).toBeLessThan(SOUNDS.kick.gain)
    })

    it('keeps identical output under gainTrim: 1 (the default)', () => {
      const withDefault = emitTrack(transcription(sections()), {
        soundMatch: { kick: { chain: '', gainTrim: 1, notes: ['n'] } },
      })
      const withoutSoundMatch = emitTrack(transcription(sections()))
      const gainsOf = (code) => /\.gain\(`([^`]+)`\)/.exec(code)[1]
      expect(gainsOf(withDefault)).toBe(gainsOf(withoutSoundMatch))
    })
  })

  describe('with dynamics', () => {
    const sections = () => [
      { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
    ]

    it('emits nothing extra and no comment without dynamics', () => {
      const code = emitTrack(transcription(sections()))
      expect(code).not.toContain('.orbit(')
      expect(code).not.toContain('.duckorbit(')
      expect(code).not.toContain('duck:')
    })

    it('splices the chain in before .gain()/.slow(), not onto the arrange() reference', () => {
      // A held two-bar chord - the one shape where a control applied *after*
      // .slow() duplicates a sustained hap (checked directly against the
      // runtime, not assumed - see layerExpression's own comment). Baking the
      // chain in here, ahead of .slow(2), is what this test is guarding.
      const held = { loopBars: 2, events: [{ step: 0, length: 32, velocity: 0.7, confidence: 0.8, midi: null, symbol: 'Fm7', driftSteps: 0 }], confidence: 0.7 }
      const dynamics = { 0: { layers: { chords: { chain: '.orbit(2)' } }, summary: 'duck: other dips 30%' } }
      const code = emitTrack(
        transcription([{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), chords: held } }]),
        { dynamics },
      )
      expect(code).toMatch(/\.orbit\(2\)\.gain\(`[^`]+`\)\.slow\(2\)/)
      expect(code).not.toMatch(/\.slow\(2\)\.orbit\(2\)/)
      expect(code).toContain('duck: other dips 30%')
      // The comment lands once, by the const definition - not on the
      // arrange() line, which this section's own const already carries it.
      const arrangeBlock = code.slice(code.indexOf('arrange('))
      expect(arrangeBlock).not.toContain('duck:')
    })

    it('does not reuse a definition across sections whose dynamics differ', () => {
      const loops = { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR }
      const dynamics = { 1: { layers: { kick: { chain: '.duckorbit(2).duckdepth(0.3).duckattack(0.1)' } }, summary: 'duck: other' } }
      const code = emitTrack(
        transcription([
          { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops },
          { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops },
        ]),
        { dynamics },
      )
      // Both get their own const - section 1 cannot borrow section 0's,
      // which carries no duck at all.
      expect(code).toContain('const s0_kick')
      expect(code).toContain('const s1_kick')
      const arrangeBlock = code.slice(code.indexOf('arrange('))
      expect(arrangeBlock).not.toContain('repeats section 0')
    })

    it('still reuses a definition when both sections share the same dynamics', () => {
      const loops = { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR }
      const dynamics = {
        0: { layers: { kick: { chain: '.duckorbit(2).duckdepth(0.3).duckattack(0.1)' } }, summary: 'duck: other' },
        1: { layers: { kick: { chain: '.duckorbit(2).duckdepth(0.3).duckattack(0.1)' } }, summary: 'duck: other' },
      }
      const code = emitTrack(
        transcription([
          { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops },
          { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops },
        ]),
        { dynamics },
      )
      expect(code).toContain('const s0_kick')
      expect(code).not.toContain('const s1_kick')
      const arrangeBlock = code.slice(code.indexOf('arrange('))
      expect(arrangeBlock).toContain('repeats section 0')
    })

    describe('a sweep/riser lpf ramp', () => {
      // A sweep is exposed as raw {lpfStart, lpfEnd} numbers (dynamics.mjs
      // does not know the loop's own .slow() factor); layerExpression has to
      // scale the sweep's own .slow() by section.bars / that factor, or the
      // ramp completes at the wrong rate - see sweepChain's own comment for
      // the runtime-checked reasoning.
      const lead = (loopBars, events) => ({ loopBars, events, confidence: 0.8 })
      const noteEvent = (step, midi) => ({ step, length: 1, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0 })

      it('scales the ramp by the full section length when the loop carries no .slow() of its own', () => {
        // A plain 1-bar loop (loopBars 1) inside a 4-bar section: outerSlow
        // is 1, so the sweep needs .slow(4) to span the whole section.
        const oneBarLead = lead(1, [noteEvent(0, 60), noteEvent(8, 64)])
        const dynamics = { 0: { layers: { lead: { sweepLpf: { lpfStart: 500, lpfEnd: 3000 } } } } }
        const code = emitTrack(
          transcription([{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), lead: oneBarLead } }]),
          { dynamics },
        )
        expect(code).toContain('.lpf(saw.range(500, 3000).slow(4))')
      })

      it('divides out the loop\'s own .slow() so the ramp still spans the whole section, not a multiple of it', () => {
        // A 2-bar "crosses a bar" loop (outerSlow 2) repeated 3x across a
        // 6-bar section: the sweep needs .slow(6/2=3), not .slow(6) (which
        // the loop's own outer .slow(2) would then double to 6) or a bare
        // saw.range (which would ramp once every 2 bars, six times over).
        const crossing = lead(2, [{ step: 0, length: 32, velocity: 0.8, confidence: 0.9, midi: 60, symbol: null, driftSteps: 0 }])
        const dynamics = { 0: { layers: { lead: { sweepLpf: { lpfStart: 500, lpfEnd: 3000 } } } } }
        const code = emitTrack(
          transcription([{ index: 0, startBar: 0, bars: 6, label: 'mid', sameAs: null, loops: { ...emptyLoops(), lead: crossing } }]),
          { dynamics },
        )
        expect(code).toContain('.lpf(saw.range(500, 3000).slow(3))')
        expect(code).not.toContain('.slow(6))')
      })

      it('omits a redundant .slow(1) when the ratio is exactly 1', () => {
        // A loop whose own .slow() already equals the section length: the
        // ramp already spans the whole section with no further scaling.
        const wholeSection = lead(4, [{ step: 0, length: 64, velocity: 0.8, confidence: 0.9, midi: 60, symbol: null, driftSteps: 0 }])
        const dynamics = { 0: { layers: { lead: { sweepLpf: { lpfStart: 500, lpfEnd: 3000 } } } } }
        const code = emitTrack(
          transcription([{ index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), lead: wholeSection } }]),
          { dynamics },
        )
        expect(code).toContain('.lpf(saw.range(500, 3000))')
        expect(code).not.toMatch(/saw\.range\(500, 3000\)\.slow/)
      })
    })
  })

  describe('fills and one-off variation (#23)', () => {
    const fillLoop = {
      loopBars: 1,
      events: [drum(0), drum(4), drum(8), drum(12)],
      confidence: 0.9,
      variation: {
        kind: 'fill',
        bar: 3,
        events: [drum(1, 0.6), drum(3, 0.7), drum(5, 0.8)],
        note: '3 discarded events in bar 3, density 3 vs loop baseline 0',
      },
    }
    const crashLoop = {
      loopBars: 1,
      events: [drum(0, 0.5), drum(4, 0.5), drum(8, 0.5), drum(12, 0.5)],
      confidence: 0.9,
      variation: {
        kind: 'crash',
        bar: 0,
        events: [drum(0, 0.9)],
        note: '1 discarded event at bar 0 step 0, velocity 0.90 vs loop max 0.50',
      },
    }

    it('emits nothing extra when a loop carries no variation', () => {
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
      ]))
      expect(code).not.toContain('.lastOf(')
      expect(code).not.toContain('.every(')
      expect(code).not.toContain('.superimpose(')
    })

    it('emits a fill as a .lastOf(sectionBars, ...) superimposition, after .gain()', () => {
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: fillLoop } },
      ]))
      expect(code).toMatch(/\.gain\(`[^`]+`\)\.lastOf\(4, x => x\.superimpose\(\(\) => s\(`[^`]+`\)\.bank\("RolandTR909"\)\.gain\(`[^`]+`\)\)\)/)
      expect(code).not.toContain('.every(')
      expect(code).toContain('kick fill: 3 discarded events in bar 3')
    })

    it('emits a crash as an .every(sectionBars, ...) superimposition, not .lastOf', () => {
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: crashLoop } },
      ]))
      expect(code).toMatch(/\.gain\(`[^`]+`\)\.every\(4, x => x\.superimpose\(\(\) => s\(`[^`]+`\)\.bank\("RolandTR909"\)\.gain\(`[^`]+`\)\)\)/)
      expect(code).not.toContain('.lastOf(')
      expect(code).toContain('kick crash: 1 discarded event at bar 0 step 0')
    })

    it('stages the fill\'s gain under the same ceiling as the rest of the layer', () => {
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: crashLoop } },
      ]))
      const superimposed = /\.superimpose\(\(\) => s\(`[^`]+`\)\.bank\("RolandTR909"\)\.gain\(`([^`]+)`\)\)/.exec(code)
      expect(superimposed).not.toBeNull()
      const values = superimposed[1].split(' ').map((token) => Number(token.split('@')[0]))
      expect(Math.max(...values)).toBeLessThanOrEqual(SOUNDS.kick.gain)
    })

    it('carries each fill event\'s own velocity into its gain, not a flat ceiling for every hit', () => {
      // fillLoop's three events carry distinct velocities (0.6/0.7/0.8) -
      // a mutation that dropped velocity and always emitted the ceiling gain
      // would pass the ceiling check above without this, since ceiling is
      // still an upper bound either way.
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: fillLoop } },
      ]))
      const superimposed = /\.superimpose\(\(\) => s\(`[^`]+`\)\.bank\("RolandTR909"\)\.gain\(`([^`]+)`\)\)/.exec(code)
      const values = superimposed[1].split(' ').map((token) => Number(token.split('@')[0]))
      expect(new Set(values).size).toBeGreaterThan(1)
      expect(values).toContain(Math.round(SOUNDS.kick.gain * 0.6 * 100) / 100)
      expect(values).toContain(Math.round(SOUNDS.kick.gain * 0.8 * 100) / 100)
    })

    it('places each fill event at its own exact step, not merely somewhere in the closing bar', () => {
      // Closes a shared-function blind spot found by independent review:
      // `expandVariation` computes both the emitter's mini-notation slots
      // and verify-emission.mjs's expected steps, so a bug in its step
      // arithmetic (e.g. an off-by-one) would be invisible to every round-
      // trip test - both sides would shift together and still agree. This
      // reads the emitted mini-notation directly and checks the actual rest
      // widths, independent of that shared function's own correctness.
      const code = emitTrack(transcription([
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: fillLoop } },
      ]))
      const superimposed = /\.superimpose\(\(\) => s\(`([^`]+)`\)/.exec(code)
      expect(superimposed).not.toBeNull()
      const tokens = superimposed[1].trim().split(/\s+/)
      // fillLoop's variation carries three hits at local steps 1, 3, 5 in a
      // 16-step bar: rest, hit, rest, hit, rest, hit, then ten rests of gap.
      expect(tokens).toEqual(['~', 'bd', '~', 'bd', '~', 'bd', '~@10'])
    })

    it('carries the same sound-match and dynamics chain as the rest of the layer, not a dry/undocked copy', () => {
      // Found by independent review: without this, a kick's fill/crash hits
      // carried only `.bank(...)` and `.gain(...)` while the loop's own hits
      // also carried room, pan and duck controls - the fill played dry and
      // never drove the section's own sidechain, an audible inconsistency
      // `verify-emission.mjs` cannot see (it only compares timing, pitch,
      // length and gain).
      const soundMatch = { kick: { chain: '.room(0.3)', gainTrim: 1, notes: ['room test'] } }
      const dynamics = { 0: { layers: { kick: { chain: '.duckorbit(2).duckdepth(0.3).duckattack(0.1)' } }, summary: 'duck: other' } }
      const code = emitTrack(
        transcription([
          { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: crashLoop } },
        ]),
        { soundMatch, dynamics },
      )
      const superimposed = /\.superimpose\(\(\) => s\(`[^`]+`\)\.bank\("RolandTR909"\)([^]*?)\.gain\(`[^`]+`\)\)\)/.exec(code)
      expect(superimposed).not.toBeNull()
      expect(superimposed[1]).toContain('.room(0.3)')
      expect(superimposed[1]).toContain('.duckorbit(2).duckdepth(0.3).duckattack(0.1)')
    })

    it('does not reuse a definition when one section carries a fill and the other does not', () => {
      const sections = [
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: FOUR_ON_THE_FLOOR } },
        { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops: { ...emptyLoops(), kick: fillLoop } },
      ]
      const code = emitTrack(transcription(sections))
      expect(code).toContain('const s1_kick =')
      expect(code).toContain('kick: s1_kick')
    })

    it('does not reuse a definition when two sections carry different fills', () => {
      const otherFill = {
        ...fillLoop,
        variation: { ...fillLoop.variation, events: [drum(2, 0.6), drum(4, 0.7), drum(6, 0.8)] },
      }
      const sections = [
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: fillLoop } },
        { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops: { ...emptyLoops(), kick: otherFill } },
      ]
      const code = emitTrack(transcription(sections))
      expect(code).toContain('const s1_kick =')
      expect(code).toContain('kick: s1_kick')
    })

    it('still reuses a definition when both sections carry the identical fill', () => {
      const sections = [
        { index: 0, startBar: 0, bars: 4, label: 'mid', sameAs: null, loops: { ...emptyLoops(), kick: fillLoop } },
        { index: 1, startBar: 4, bars: 4, label: 'mid', sameAs: 0, loops: { ...emptyLoops(), kick: { ...fillLoop } } },
      ]
      const code = emitTrack(transcription(sections))
      expect(code).toContain('const s0_kick =')
      expect(code).not.toContain('const s1_kick =')
      const arrangeBlock = code.slice(code.indexOf('arrange('))
      expect(arrangeBlock).toContain('repeats section 0')
    })
  })
})
