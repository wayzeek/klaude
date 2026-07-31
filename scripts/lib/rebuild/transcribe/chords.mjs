/**
 * Chord vocabulary, template scoring and path smoothing.
 *
 * Deliberately free of audio and of the grid: everything here is a function of
 * a twelve-value chroma vector, which makes the whole module exhaustively
 * testable without a WAV file. `harmony.mjs` supplies the vectors.
 *
 * The vocabulary is seven qualities, which is a choice with consequences worth
 * stating. Chroma discards voicing, inversion and octave, so a rootless voicing
 * and a slash chord both collapse onto whichever template happens to fit. Adding
 * ninths and elevenths to the vocabulary would not fix that - it would make the
 * templates less distinguishable from each other and the answers worse. Seven
 * qualities is the point where the vocabulary is expressive enough to hold a
 * real progression and small enough that the templates stay apart.
 *
 * The suffixes are the spellings Strudel's `.voicing()` actually understands,
 * which are iReal Pro's jazz shorthand rather than pop notation. `o` is
 * diminished and `sus` is a suspended fourth; the obvious `dim` and `sus4`
 * parse but produce no notes at all. `strudel-node.mjs` keeps a table of these
 * traps in CHORD_SUGGESTIONS - read it before adding a quality.
 */

import { PITCH_NAMES } from '../../dsp.mjs'

/** The vocabulary. `suffix` is what moltek writes: see tracks/MINUIT for the
 *  house style - `Fm9`, `Db^7`, `C7`, `Bbm7`. */
export const CHORD_QUALITIES = Object.freeze([
  Object.freeze({ name: 'maj', suffix: '', intervals: Object.freeze([0, 4, 7]) }),
  Object.freeze({ name: 'min', suffix: 'm', intervals: Object.freeze([0, 3, 7]) }),
  Object.freeze({ name: 'dim', suffix: 'o', intervals: Object.freeze([0, 3, 6]) }),
  Object.freeze({ name: 'maj7', suffix: '^7', intervals: Object.freeze([0, 4, 7, 11]) }),
  Object.freeze({ name: 'min7', suffix: 'm7', intervals: Object.freeze([0, 3, 7, 10]) }),
  Object.freeze({ name: 'dom7', suffix: '7', intervals: Object.freeze([0, 4, 7, 10]) }),
  Object.freeze({ name: 'sus4', suffix: 'sus', intervals: Object.freeze([0, 5, 7]) }),
])

function buildTemplates() {
  const templates = []
  for (let root = 0; root < 12; root++) {
    for (const quality of CHORD_QUALITIES) {
      const vector = new Float32Array(12)
      for (const interval of quality.intervals) vector[(root + interval) % 12] = 1
      // L2-normalise once, so scoring is a dot product rather than a cosine.
      let norm = 0
      for (const value of vector) norm += value * value
      norm = Math.sqrt(norm)
      for (let i = 0; i < 12; i++) vector[i] /= norm
      templates.push(
        Object.freeze({
          index: templates.length,
          root,
          quality: quality.name,
          suffix: quality.suffix,
          symbol: `${PITCH_NAMES[root]}${quality.suffix}`,
          vector,
        }),
      )
    }
  }
  return Object.freeze(templates)
}

/** 84 templates: twelve roots by seven qualities. */
export const CHORD_TEMPLATES = buildTemplates()

/** Cosine similarity between a chroma vector and every template. */
export function scoreChroma(chroma) {
  const scores = new Float32Array(CHORD_TEMPLATES.length)
  let norm = 0
  for (const value of chroma) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0) return scores
  for (const template of CHORD_TEMPLATES) {
    let dot = 0
    for (let i = 0; i < 12; i++) dot += chroma[i] * template.vector[i]
    scores[template.index] = dot / norm
  }
  return scores
}

/**
 * Best chord per row, with a bonus for staying put.
 *
 * A plain per-beat argmax flickers: two neighbouring templates score within a
 * hair of each other on ambiguous material, and the answer alternates bar to
 * bar, which is both wrong and unreadable. This is a Viterbi pass with a flat
 * self-transition bonus - the smallest thing that fixes it. A full transition
 * matrix trained on real progressions would be better and is not worth it here,
 * because the material this runs on is one stem's worth of bleed-contaminated
 * chroma and the extra precision would be spent on noise.
 */
export function smoothChordPath(rows, { selfBonus = 0.15 } = {}) {
  if (selfBonus < 0) {
    throw new Error(
      `smoothChordPath: selfBonus must be non-negative, got ${selfBonus}. The O(n) ` +
        "shortcut below picks a single global-best predecessor instead of running the " +
        'full O(n^2) recurrence, which only reproduces Viterbi\'s answer when "staying ' +
        'put" can never lose to a worse-scoring neighbour being mistaken for the true ' +
        'best-of-the-others. A negative bonus breaks that: it lets `moving` win using ' +
        "previous[bestPrevious] as a stand-in for the best predecessor *other than i*, " +
        'which is wrong precisely when i itself is bestPrevious. That divergence is ' +
        'silent - no throw, no NaN - so it must be caught here instead.',
    )
  }
  if (!rows.length) return []
  const n = CHORD_TEMPLATES.length
  let previous = Float32Array.from(rows[0])
  const backpointers = []

  for (let step = 1; step < rows.length; step++) {
    const current = new Float32Array(n)
    const back = new Int16Array(n)
    // The best predecessor is either the same chord (with the bonus) or the
    // globally best chord from the previous step (without it). Finding the
    // global best once keeps this O(n) per step instead of O(n^2).
    let bestPrevious = 0
    for (let i = 1; i < n; i++) if (previous[i] > previous[bestPrevious]) bestPrevious = i

    for (let i = 0; i < n; i++) {
      const staying = previous[i] + selfBonus
      const moving = previous[bestPrevious]
      if (staying >= moving) {
        current[i] = rows[step][i] + staying
        back[i] = i
      } else {
        current[i] = rows[step][i] + moving
        back[i] = bestPrevious
      }
    }
    backpointers.push(back)
    previous = current
  }

  let best = 0
  for (let i = 1; i < n; i++) if (previous[i] > previous[best]) best = i
  const path = new Array(rows.length)
  path[rows.length - 1] = best
  for (let step = rows.length - 2; step >= 0; step--) {
    path[step] = backpointers[step][path[step + 1]]
  }
  return path
}

export function chordSymbol(index) {
  return CHORD_TEMPLATES[index]?.symbol ?? null
}

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11]
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10]

/**
 * Template indices whose notes all fall inside the key.
 *
 * Used to flag a run of chords that does not belong, per #43. Not used to
 * restrict the search: a borrowed dominant is a real and common thing - the
 * C7 in the-chase is exactly that - and a transcriber that cannot hear one is
 * worse than one that hears one and says it is unusual.
 */
export function diatonicTemplates(keyName) {
  const match = /^([A-G][#b]?)\s+(major|minor)$/i.exec((keyName ?? '').trim())
  if (!match) return new Set()
  const root = PITCH_NAMES.findIndex((name) => name.toLowerCase() === normaliseRoot(match[1]))
  if (root < 0) return new Set()
  const degrees = match[2].toLowerCase() === 'major' ? MAJOR_DEGREES : MINOR_DEGREES
  const scale = new Set(degrees.map((degree) => (root + degree) % 12))

  const inKey = new Set()
  for (const template of CHORD_TEMPLATES) {
    const quality = CHORD_QUALITIES.find((q) => q.name === template.quality)
    if (quality.intervals.every((interval) => scale.has((template.root + interval) % 12))) {
      inKey.add(template.index)
    }
  }
  return inKey
}

/** PITCH_NAMES uses sharps for C#/F# and flats for Eb/Ab/Bb. Accept either
 *  spelling on input and map to whichever the table holds. */
const ENHARMONIC = { db: 'c#', 'd#': 'eb', gb: 'f#', 'g#': 'ab', 'a#': 'bb' }

function normaliseRoot(text) {
  const lower = text.toLowerCase()
  return ENHARMONIC[lower] ?? lower
}
