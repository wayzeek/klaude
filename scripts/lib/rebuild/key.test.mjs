import { describe, expect, it } from 'vitest'
import { detectKey } from '../dsp.mjs'
import { ALBRECHT_SHANAHAN_MAJOR_PROFILE, ALBRECHT_SHANAHAN_MINOR_PROFILE, detectKeyFromNotes, pitchClassHistogram } from './key.mjs'

const note = (midi, startSec, dur, velocity = 0.8) => ({ startSec, endSec: startSec + dur, midi, velocity })

/** Lay out one note per pitch class in `degrees` (repeated `reps` times),
 *  each held for its own `weights[i]` seconds - the duration-weighted note
 *  stream every test below builds its fixture from. */
function scaleNotes(degrees, weights, { reps = 6, octave = 4 } = {}) {
  const notes = []
  let t = 0
  for (let rep = 0; rep < reps; rep++) {
    for (let i = 0; i < degrees.length; i++) {
      notes.push(note(12 * (octave + 1) + degrees[i], t, weights[i]))
      t += weights[i]
    }
  }
  return notes
}

describe('pitchClassHistogram', () => {
  it('weights each pitch class by total note duration, not note count', () => {
    const notes = [note(60, 0, 3), note(60, 3, 1), note(67, 4, 1)] // C held 3s, C again 1s, G 1s
    const histogram = pitchClassHistogram(notes)
    expect(histogram[0]).toBeCloseTo(4, 6) // C: 3 + 1
    expect(histogram[7]).toBeCloseTo(1, 6) // G: 1
    expect(histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 6)
  })

  it('merges any number of note lists', () => {
    const bass = [note(36, 0, 2)] // C
    const other = [note(64, 0, 3)] // E
    const histogram = pitchClassHistogram(bass, other)
    expect(histogram[0]).toBeCloseTo(2, 6)
    expect(histogram[4]).toBeCloseTo(3, 6)
  })

  it('ignores a note whose end is not after its start', () => {
    const histogram = pitchClassHistogram([note(60, 0, 0), note(60, 5, -1)])
    expect(histogram.reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('skips null/undefined note lists rather than throwing', () => {
    expect(() => pitchClassHistogram(null, undefined, [note(60, 0, 1)])).not.toThrow()
  })
})

describe('detectKeyFromNotes', () => {
  it('returns null with no notes at all', () => {
    expect(detectKeyFromNotes([], [])).toBeNull()
  })

  it('returns null when every note has zero duration', () => {
    expect(detectKeyFromNotes([], [note(60, 0, 0)])).toBeNull()
  })

  it('names C major for a C major scale that leans on the tonic and fifth', () => {
    // C D E F G A B, tonic (C) and fifth (G) held twice as long as the rest -
    // the same "which degrees carry the harmonic weight" shape a real bass
    // and chord part would produce.
    const degrees = [0, 2, 4, 5, 7, 9, 11]
    const weights = [2, 1, 1, 1, 2, 1, 1]
    const notes = scaleNotes(degrees, weights)
    const result = detectKeyFromNotes([], notes)
    expect(result.name).toBe('C major')
    expect(result.confidence).toBeGreaterThan(0.1)
  })

  /**
   * The case this module exists for: Krumhansl-Kessler's own profile
   * correlation, fed the exact same duration-weighted pitch-class data, picks
   * the wrong key (the relative major) for a real minor-mode shape - a
   * harmonic-minor phrase (raised leading tone, so the note set is genuinely
   * A minor's own, not identical to C major's) that leans on its mediant and
   * dominant rather than constantly restating the tonic, a shape ordinary
   * minor-mode writing produces (e.g. i-V-III movement) far more often than
   * a bare, evenly-weighted scale run. Albrecht & Shanahan's corpus-trained
   * minor profile, scoring the identical histogram, still resolves it
   * correctly - which is the entire reason this module exists instead of
   * reusing `detectKey`. If this ever starts failing, either the profile
   * constants were changed (e.g. swapped for Krumhansl-Kessler's own, or the
   * major/minor arrays were swapped with each other) or the correlation math
   * diverged from `detectKey`'s - both are real regressions this guards.
   */
  it('names A minor for a harmonic-minor phrase where Krumhansl-Kessler names the relative major instead', () => {
    // A B C D E F G# (raised 7th), weighted low(tonic/2nd/4th/6th/7th) / high(mediant/dominant).
    const degrees = [9, 11, 0, 2, 4, 5, 8]
    const weights = [0.5, 0.5, 2, 1.5, 3, 0.5, 0.5]
    const notes = scaleNotes(degrees, weights)

    const histogram = pitchClassHistogram(notes)
    const total = histogram.reduce((a, b) => a + b, 0)
    const chroma = histogram.map((value) => value / total)
    const kk = detectKey(chroma)
    expect(kk.best.name).toBe('C major') // the documented K-K failure on this shape

    const result = detectKeyFromNotes([], notes)
    expect(result.name).toBe('A minor')
    expect(result.confidence).toBeGreaterThan(0.1)
  })

  it('reads bass + other together, not just one stem', () => {
    // Both stems agree on C major but at different strengths (a modest triad
    // in "other", a stronger one in "bass"). If `detectKeyFromNotes` only
    // read one of its two arguments, the combined call would land exactly on
    // one or the other's own confidence; averaging the two histograms
    // together before scoring instead lands strictly between them, which is
    // only possible if both were actually merged.
    const other = scaleNotes([0, 4, 7], [1, 1, 1], { octave: 4 })
    const bass = scaleNotes([0, 4, 7], [3, 2, 2], { reps: 4, octave: 2 })

    const otherOnly = detectKeyFromNotes([], other)
    const bassOnly = detectKeyFromNotes(bass, [])
    const combined = detectKeyFromNotes(bass, other)

    expect(combined.name).toBe('C major')
    expect(combined.confidence).toBeGreaterThan(bassOnly.confidence)
    expect(combined.confidence).toBeLessThan(otherOnly.confidence)
  })

  describe('relative-major/minor tiebreak', () => {
    // A duration-weighted mix of the seven notes C major and A minor both
    // share, tuned to sit inside RELATIVE_TIE_MARGIN of the two candidates -
    // by construction, indistinguishable from pitch content alone. This is
    // the exact ambiguity `keysMatch` in dsp.mjs already treats as
    // unresolvable from audio; the point of the fixture is to show a second,
    // independent signal (the bass line's own tonic) CAN resolve it.
    const degrees = [0, 2, 4, 5, 7, 9, 11] // C D E F G A B
    const weights = [0.5, 0.5, 0.75, 0.5, 1.25, 1.25, 0.5]
    const otherNotes = scaleNotes(degrees, weights)

    it('is genuinely ambiguous with no bass evidence at all', () => {
      const result = detectKeyFromNotes([], otherNotes)
      expect(['A minor', 'C major']).toContain(result.name)
      expect(result.confidence).toBeLessThan(0.02)
      // No bass notes means no differentiating tonic-duration evidence -
      // `tiebreak` must say so plainly rather than claiming a bass-root call
      // that never actually happened (both tonics tie at zero duration).
      expect(result.tiebreak).toBeNull()
    })

    it('a bass note toward C settles it as C major, overriding the raw correlation order', () => {
      const bass = [note(12 * 3, 0, 0.2)] // low C, brief
      const result = detectKeyFromNotes(bass, otherNotes)
      expect(result.name).toBe('C major')
      expect(result.tiebreak).toBe('bass-root')
    })

    it('a bass note toward A confirms A minor via the same tiebreak path', () => {
      // Small enough (0.01s) that the merged correlation margin stays under
      // RELATIVE_TIE_MARGIN on its own (see the C-leaning case above, where
      // 0.2s already crosses it) - this specifically exercises
      // `breakRelativeTie`'s bass-evidence branch confirming the
      // correlation's own pick, not just the correlation resolving itself.
      const bass = [note(12 * 3 + 9, 0, 0.01)] // low A, very brief
      const result = detectKeyFromNotes(bass, otherNotes)
      expect(result.name).toBe('A minor')
      expect(result.tiebreak).toBe('bass-root')
    })

    it('does not fire the tiebreak on a confidently-decided pair', () => {
      // The plain C-major-scale fixture from above is nowhere near a tie
      // (confidence > 0.1 with no bass at all). Even a substantial A-leaning
      // bass note - enough to pull the runner-up from "C minor" to "A minor"
      // - should not be able to flip the winner via the relative-pair path,
      // because the margin never drops into `RELATIVE_TIE_MARGIN`.
      const degrees2 = [0, 2, 4, 5, 7, 9, 11]
      const weights2 = [2, 1, 1, 1, 2, 1, 1]
      const notes = scaleNotes(degrees2, weights2)
      const bassTowardA = [note(12 * 2 + 9, 0, 8)]
      const result = detectKeyFromNotes(bassTowardA, notes)
      expect(result.name).toBe('C major')
      expect(result.runnerUp).toBe('A minor')
      expect(result.tiebreak).toBeNull()
    })
  })
})

describe('Albrecht-Shanahan profile constants', () => {
  it('match the published values exactly, index by index', () => {
    // Transcribed by hand from `optimizer/key_profiles.py`'s
    // `albrecht_shanahan1` entry in github.com/napulen/justkeydding (see
    // key.mjs's own doc comment for the full provenance) - an exact,
    // per-index check, not just shape/sum, so a single mistyped digit in any
    // position (not only the tonic or the fifth) fails this test.
    expect(ALBRECHT_SHANAHAN_MAJOR_PROFILE).toEqual([0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081])
    expect(ALBRECHT_SHANAHAN_MINOR_PROFILE).toEqual([0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052])
  })

  it('are the published 12-value major/minor probability vectors, tonic-first', () => {
    // Sums to ~1: these are probabilities, and matching the paper's own
    // rounding (1.000 major, 0.998 minor) is part of what confirms these are
    // the literal published values rather than a re-fit or a typo.
    const sum = (a) => a.reduce((x, y) => x + y, 0)
    expect(sum(ALBRECHT_SHANAHAN_MAJOR_PROFILE)).toBeCloseTo(1, 6)
    expect(sum(ALBRECHT_SHANAHAN_MINOR_PROFILE)).toBeCloseTo(0.998, 6)
    // Tonic (index 0) and fifth (index 7) carry the most weight in both -
    // the same shape dsp.mjs's own Krumhansl-Kessler pair has, confirming
    // the "semitones above tonic" indexing convention matches.
    expect(ALBRECHT_SHANAHAN_MAJOR_PROFILE[0]).toBeGreaterThan(Math.max(...ALBRECHT_SHANAHAN_MAJOR_PROFILE.slice(1)))
    expect(ALBRECHT_SHANAHAN_MAJOR_PROFILE[7]).toBeGreaterThan(Math.max(...ALBRECHT_SHANAHAN_MAJOR_PROFILE.slice(1, 7), ...ALBRECHT_SHANAHAN_MAJOR_PROFILE.slice(8)))
    expect(ALBRECHT_SHANAHAN_MINOR_PROFILE[0]).toBeGreaterThan(Math.max(...ALBRECHT_SHANAHAN_MINOR_PROFILE.slice(1)))
    expect(ALBRECHT_SHANAHAN_MINOR_PROFILE[7]).toBeGreaterThan(Math.max(...ALBRECHT_SHANAHAN_MINOR_PROFILE.slice(1, 7), ...ALBRECHT_SHANAHAN_MINOR_PROFILE.slice(8)))
  })
})
