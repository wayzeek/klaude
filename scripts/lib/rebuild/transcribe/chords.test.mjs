import { describe, expect, it } from 'vitest'
import {
  CHORD_QUALITIES,
  CHORD_TEMPLATES,
  chordSymbol,
  diatonicTemplates,
  scoreChroma,
  smoothChordPath,
} from './chords.mjs'

/** A chroma vector with energy only on the given pitch classes. */
function chromaOf(pitchClasses, { noise = 0 } = {}) {
  const chroma = new Array(12).fill(noise)
  for (const pc of pitchClasses) chroma[pc] = 1
  return chroma
}

const indexOf = (symbol) => CHORD_TEMPLATES.findIndex((t) => t.symbol === symbol)

describe('the chord vocabulary', () => {
  it('is documented and frozen', () => {
    expect(CHORD_QUALITIES.map((q) => q.name)).toEqual([
      'maj', 'min', 'dim', 'maj7', 'min7', 'dom7', 'sus4',
    ])
    expect(Object.isFrozen(CHORD_QUALITIES)).toBe(true)
    expect(Object.isFrozen(CHORD_TEMPLATES)).toBe(true)
  })

  it('is twelve roots times seven qualities', () => {
    expect(CHORD_TEMPLATES).toHaveLength(84)
    expect(new Set(CHORD_TEMPLATES.map((t) => t.symbol)).size).toBe(84)
  })

  it('names chords from PITCH_NAMES, sharps and all', () => {
    expect(chordSymbol(indexOf('C'))).toBe('C')
    expect(chordSymbol(indexOf('Fm7'))).toBe('Fm7')
    expect(chordSymbol(indexOf('C7'))).toBe('C7')
    // PITCH_NAMES spells root 1 as C#. moltek's own tracks write Db^7 for the
    // same chord; respelling to flats is the emitter's job (Task 12), because
    // it depends on the key and this table is key-independent and frozen.
    expect(chordSymbol(indexOf('C#^7'))).toBe('C#^7')
    expect(indexOf('Db^7')).toBe(-1)
  })
})

describe('scoreChroma', () => {
  it('picks the exact triad it was given', () => {
    // C major: C E G = 0, 4, 7.
    const scores = scoreChroma(chromaOf([0, 4, 7]))
    const best = argmax(scores)
    expect(CHORD_TEMPLATES[best].symbol).toBe('C')
  })

  it('distinguishes major from minor', () => {
    expect(CHORD_TEMPLATES[argmax(scoreChroma(chromaOf([5, 8, 0])))].symbol).toBe('Fm')
    expect(CHORD_TEMPLATES[argmax(scoreChroma(chromaOf([5, 9, 0])))].symbol).toBe('F')
  })

  it('picks a seventh over the triad when the seventh is present', () => {
    // C E G Bb = C7.
    expect(CHORD_TEMPLATES[argmax(scoreChroma(chromaOf([0, 4, 7, 10])))].symbol).toBe('C7')
  })

  it('survives noise on the other pitch classes', () => {
    const scores = scoreChroma(chromaOf([5, 8, 0], { noise: 0.25 }))
    expect(CHORD_TEMPLATES[argmax(scores)].symbol).toBe('Fm')
  })

  it('returns a score per template, all finite', () => {
    const scores = scoreChroma(chromaOf([0, 4, 7]))
    expect(scores).toHaveLength(84)
    for (const score of scores) expect(Number.isFinite(score)).toBe(true)
  })

  it('scores a flat chroma without preferring anything strongly', () => {
    const scores = scoreChroma(new Array(12).fill(1))
    const sorted = [...scores].sort((a, b) => b - a)
    expect(sorted[0] - sorted[1]).toBeLessThan(0.05)
  })
})

describe('smoothChordPath', () => {
  it('holds a chord through a single bad beat', () => {
    const fm = indexOf('Fm')
    const c7 = indexOf('C7')
    const rows = []
    for (let beat = 0; beat < 8; beat++) {
      const row = new Float32Array(84).fill(0.1)
      // Beat 3 mistakenly favours C7 by a hair.
      if (beat === 3) { row[c7] = 0.72; row[fm] = 0.70 } else { row[fm] = 0.9 }
      rows.push(row)
    }
    const path = smoothChordPath(rows, { selfBonus: 0.15 })
    expect(path.every((index) => index === fm)).toBe(true)
  })

  it('holds a chord through two consecutive ambiguous beats', () => {
    // A single bad beat doesn't distinguish real smoothing from a plain
    // per-row argmax that happens to get lucky; two in a row does, because
    // argmax has no memory and would flip both.
    const fm = indexOf('Fm')
    const c7 = indexOf('C7')
    const rows = []
    for (let beat = 0; beat < 8; beat++) {
      const row = new Float32Array(84).fill(0.1)
      if (beat === 3 || beat === 4) { row[c7] = 0.72; row[fm] = 0.70 } else { row[fm] = 0.9 }
      rows.push(row)
    }
    const path = smoothChordPath(rows, { selfBonus: 0.15 })
    expect(path.every((index) => index === fm)).toBe(true)
  })

  it('breaks a tie between staying and moving in favour of staying', () => {
    // Beat 0 scores C7 higher than Fm on its own (0.75 vs 0.5), so a plain
    // argmax reads it as C7. But with selfBonus 0.25, staying at Fm from beat
    // 0 (0.5 + 0.25 = 0.75) scores exactly the same as moving to whatever's
    // globally best at beat 0 (C7, also 0.75) once beat 1 strongly favours Fm.
    // `staying >= moving` must resolve that exact tie in favour of staying,
    // or the reconstructed beat 0 flips to C7 even though Fm dominates
    // everywhere else.
    const fm = indexOf('Fm')
    const c7 = indexOf('C7')
    const rows = []
    const first = new Float32Array(84).fill(0.1)
    first[fm] = 0.5
    first[c7] = 0.75
    rows.push(first)
    for (let beat = 1; beat < 4; beat++) {
      const row = new Float32Array(84).fill(0.1)
      row[fm] = 0.9
      rows.push(row)
    }
    const path = smoothChordPath(rows, { selfBonus: 0.25 })
    expect(path.every((index) => index === fm)).toBe(true)
  })

  it('rejects a negative selfBonus instead of silently diverging from Viterbi', () => {
    // The O(n) shortcut only matches the full O(n^2) recurrence because
    // "staying" can never lose to a competitor being mistaken for the best
    // predecessor other than itself. A negative bonus breaks that guarantee
    // silently - no throw, no NaN - so the guard has to live here.
    const rows = [new Float32Array(84).fill(0.5), new Float32Array(84).fill(0.5)]
    expect(() => smoothChordPath(rows, { selfBonus: -0.1 })).toThrow(/non-negative/)
  })

  it('still follows a real change', () => {
    const fm = indexOf('Fm')
    const db = indexOf('C#^7') // the flat sixth of F minor, PITCH_NAMES spelling
    const rows = []
    for (let beat = 0; beat < 8; beat++) {
      const row = new Float32Array(84).fill(0.1)
      row[beat < 4 ? fm : db] = 0.9
      rows.push(row)
    }
    const path = smoothChordPath(rows, { selfBonus: 0.15 })
    expect(path.slice(0, 4).every((i) => i === fm)).toBe(true)
    expect(path.slice(4).every((i) => i === db)).toBe(true)
  })

  it('returns one index per row', () => {
    const rows = Array.from({ length: 5 }, () => new Float32Array(84).fill(0.5))
    expect(smoothChordPath(rows, { selfBonus: 0.15 })).toHaveLength(5)
  })

  it('handles an empty input', () => {
    expect(smoothChordPath([], { selfBonus: 0.15 })).toEqual([])
  })
})

describe('diatonicTemplates', () => {
  it('includes the tonic and the subdominant of F minor', () => {
    const set = diatonicTemplates('F minor')
    expect(set.has(indexOf('Fm'))).toBe(true)
    expect(set.has(indexOf('Bbm'))).toBe(true)
    // The flat sixth, spelled C# by PITCH_NAMES.
    expect(set.has(indexOf('C#'))).toBe(true)
  })

  it('excludes a chord foreign to the key', () => {
    const set = diatonicTemplates('F minor')
    expect(set.has(indexOf('E'))).toBe(false)
  })

  it('returns an empty set for an unparseable key rather than throwing', () => {
    expect(diatonicTemplates('not a key').size).toBe(0)
  })
})

function argmax(values) {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i
  return best
}
