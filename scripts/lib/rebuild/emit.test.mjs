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

const emptyLoops = () => ({ kick: null, snare: null, hats: null, bass: null, chords: null, lead: null })

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
    for (const layer of ['kick', 'snare', 'hats', 'bass', 'chords', 'lead']) {
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
})
