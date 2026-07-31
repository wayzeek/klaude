import { describe, expect, it } from 'vitest'
import {
  buildAffinityMatrix,
  clusterMelodyCandidates,
  fiedlerVector,
  noteAffinity,
  partitionBySign,
  pickMelodyCluster,
} from './affinity.mjs'

function note(startSec, endSec, midi, velocity = 0.6) {
  return { startSec, endSec, midi, velocity }
}

describe('noteAffinity', () => {
  it('is highest for two adjacent, pitch-close, similar-duration notes', () => {
    const a = note(0, 0.3, 60)
    const b = note(0.3, 0.6, 62)
    expect(noteAffinity(a, b)).toBeGreaterThan(0.5)
  })

  it('drops to exactly 0 for two fully-overlapping notes, regardless of pitch', () => {
    const a = note(0, 1, 60)
    const b = note(0.1, 0.5, 60) // wholly inside a
    expect(noteAffinity(a, b)).toBe(0)
  })

  it('is lower for concurrent (overlapping) notes than for sequential notes at the same pitch distance', () => {
    const sequential = noteAffinity(note(0, 0.3, 60), note(0.31, 0.6, 64))
    const concurrent = noteAffinity(note(0, 0.5, 60), note(0.1, 0.4, 64))
    expect(concurrent).toBeLessThan(sequential)
  })

  it('decays with pitch distance for otherwise-identical sequential notes', () => {
    const close = noteAffinity(note(0, 0.3, 60), note(0.3, 0.6, 61))
    const far = noteAffinity(note(0, 0.3, 60), note(0.3, 0.6, 84))
    expect(close).toBeGreaterThan(far)
  })

  it('decays with duration difference for otherwise-identical sequential notes', () => {
    const similar = noteAffinity(note(0, 0.3, 60), note(0.3, 0.6, 62))
    const different = noteAffinity(note(0, 0.3, 60), note(0.3, 4.3, 62))
    expect(similar).toBeGreaterThan(different)
  })

  it('decays with a larger time gap between sequential notes', () => {
    const near = noteAffinity(note(0, 0.3, 60), note(0.31, 0.6, 60))
    const far = noteAffinity(note(0, 0.3, 60), note(5, 5.3, 60))
    expect(near).toBeGreaterThan(far)
  })
})

describe('buildAffinityMatrix', () => {
  it('is symmetric with a zero diagonal', () => {
    const notes = [note(0, 0.3, 60), note(0.3, 0.6, 64), note(0.1, 0.5, 72)]
    const m = buildAffinityMatrix(notes)
    for (let i = 0; i < notes.length; i++) {
      expect(m[i][i]).toBe(0)
      for (let j = 0; j < notes.length; j++) expect(m[i][j]).toBeCloseTo(m[j][i], 10)
    }
  })
})

describe('fiedlerVector', () => {
  it('handles 0 and 1 notes without throwing', () => {
    expect(fiedlerVector([])).toHaveLength(0)
    expect(fiedlerVector([new Float64Array([0])])).toHaveLength(1)
  })

  it('is deterministic: the same weights always produce the same vector', () => {
    const notes = [note(0, 0.3, 60), note(0.3, 0.6, 62), note(0.05, 0.5, 84), note(0.55, 0.9, 86)]
    const weights = buildAffinityMatrix(notes)
    const v1 = fiedlerVector(weights)
    const v2 = fiedlerVector(weights)
    expect([...v1]).toEqual([...v2])
  })

  it('separates two cliques (a low sequential pair, a high sequential pair, concurrent across the pair) by sign', () => {
    // Two two-note "voices": a low voice (60 -> 62) and a high voice
    // (84 -> 86), each internally sequential (good affinity), each note in
    // one voice concurrent with one note in the other (bad affinity, real
    // polyphony). This is the exact shape a melody-over-pad passage has.
    const low1 = note(0, 0.5, 60)
    const low2 = note(0.5, 1.0, 62)
    const high1 = note(0, 0.5, 84)
    const high2 = note(0.5, 1.0, 86)
    const notes = [low1, low2, high1, high2]
    const weights = buildAffinityMatrix(notes)
    const vector = fiedlerVector(weights)
    // The two low-voice entries share a sign, the two high-voice entries
    // share a sign, and the two voices disagree with each other.
    expect(Math.sign(vector[0])).toBe(Math.sign(vector[1]))
    expect(Math.sign(vector[2])).toBe(Math.sign(vector[3]))
    expect(Math.sign(vector[0])).not.toBe(Math.sign(vector[2]))
  })

  it('stays orthogonal to the trivial eigenvector even after many iterations', () => {
    // The doc comment's point 2 (deflate every iteration, not just at the
    // seed) exists to stop rounding error slowly reintroducing the trivial
    // component over many iterations. A one-time-only deflation would still
    // pass a low-iteration test (nothing has drifted yet) - this uses enough
    // notes and iterations that the drift is measurable: `M`'s dominant
    // eigenvalue belongs to the trivial direction, so *any* per-iteration
    // leak back toward it gets re-amplified every subsequent multiply.
    const notes = []
    for (let i = 0; i < 12; i++) notes.push(note(i * 0.3, i * 0.3 + 0.25, 60 + ((i * 5) % 24), 0.3 + (i % 4) * 0.15))
    const weights = buildAffinityMatrix(notes)
    const vector = fiedlerVector(weights, { iterations: 2000 })

    const degree = weights.map((row) => row.reduce((a, b) => a + b, 0))
    const trivial = degree.map((d) => Math.sqrt(d))
    const trivialNorm = Math.sqrt(trivial.reduce((a, b) => a + b * b, 0))
    const unitTrivial = trivial.map((v) => v / trivialNorm)
    const dot = vector.reduce((sum, v, i) => sum + v * unitTrivial[i], 0)
    expect(Math.abs(dot)).toBeLessThan(1e-6)
  })

  it('returns all-zero when every affinity is 0 (nothing to split on)', () => {
    // Four notes that all fully overlap each other -> every off-diagonal
    // weight is exactly 0 (overlapKernel's degenerate case), so degree is 0
    // everywhere and there is no basis to split on.
    const notes = [note(0, 1, 60), note(0, 1, 61), note(0, 1, 62), note(0, 1, 63)]
    const weights = buildAffinityMatrix(notes)
    const vector = fiedlerVector(weights)
    expect([...vector]).toEqual([0, 0, 0, 0])
  })

  it('finds the TRUE Fiedler vector, not just an eigenvector of a smaller eigenvalue a single seed happens to converge to', () => {
    // Found in independent review, reproduced exactly: a graph where two
    // "pairs" (A1-A2, B1-B2) are tightly linked (weight 1) and cross-linked
    // at half that (weight 0.5). Hand-computed eigenvalues of M = I +
    // D^-1/2 W D^-1/2 here: 2 (trivial, [1,1,1,1]), 1 (the TRUE Fiedler
    // eigenvector, the pair-vs-pair split [1,1,-1,-1]), and a degenerate
    // pair at 0.5 - one of which, [1,-1,1,-1], is EXACTLY the alternating
    // seed a single-seed power iteration starts from. A solver seeded only
    // that way converges to the 0.5 eigenvector's split ([A1,B1] vs
    // [A2,B2]) instead of the true, higher-eigenvalue pair-vs-pair split -
    // full numerical confidence, wrong answer. This is exactly the graph
    // shape a real melody-over-pad section can produce (see the "separates
    // two cliques" test above, which uses a similar but less pathological
    // shape and passed even with the bug, because its cross-links are 0,
    // not exactly the coincidental 0.5 that breaks the alternating seed
    // here).
    const weights = [
      [0, 1, 0.5, 0.5],
      [1, 0, 0.5, 0.5],
      [0.5, 0.5, 0, 1],
      [0.5, 0.5, 1, 0],
    ]
    const vector = fiedlerVector(weights)
    // The correct split is {A1, A2} vs {B1, B2} - indices 0,1 share a sign,
    // 2,3 share a sign, and the two pairs disagree.
    expect(Math.sign(vector[0])).toBe(Math.sign(vector[1]))
    expect(Math.sign(vector[2])).toBe(Math.sign(vector[3]))
    expect(Math.sign(vector[0])).not.toBe(Math.sign(vector[2]))
  })
})

describe('partitionBySign', () => {
  it('splits by the vector sign when both sides are non-empty', () => {
    const notes = ['a', 'b', 'c', 'd']
    const [group1, group2] = partitionBySign(notes, [1, 1, -1, -1])
    expect(group1).toEqual(['a', 'b'])
    expect(group2).toEqual(['c', 'd'])
  })

  it('falls back to a median split when every sign is the same', () => {
    const notes = ['a', 'b', 'c', 'd']
    const [group1, group2] = partitionBySign(notes, [1, 2, 3, 4])
    expect(group1.length).toBeGreaterThan(0)
    expect(group2.length).toBeGreaterThan(0)
    expect([...group1, ...group2].sort()).toEqual(notes.sort())
  })

  it('falls back to a positional split when every entry is identical (median split also degenerate)', () => {
    const notes = ['a', 'b', 'c', 'd']
    const [group1, group2] = partitionBySign(notes, [5, 5, 5, 5])
    expect(group1).toEqual(['a', 'b'])
    expect(group2).toEqual(['c', 'd'])
  })
})

describe('pickMelodyCluster', () => {
  it('prefers the smaller cluster even when it is quieter and lower', () => {
    // The measured-best rule: a lead is one voice, "everything else" is
    // usually several at once, so it wins on count even when it loses on
    // loudness/register.
    const quietLowSmall = [note(0, 0.3, 48, 0.2), note(0.3, 0.6, 50, 0.2)]
    const loudHighBig = [
      note(0, 0.3, 80, 0.9),
      note(0.3, 0.6, 82, 0.9),
      note(0.6, 0.9, 84, 0.9),
      note(0.9, 1.2, 85, 0.9),
    ]
    expect(pickMelodyCluster(quietLowSmall, loudHighBig)).toBe(quietLowSmall)
    expect(pickMelodyCluster(loudHighBig, quietLowSmall)).toBe(quietLowSmall)
  })

  it('falls back to loudness/register only when both clusters are the same size', () => {
    const quietLow = [note(0, 0.3, 48, 0.2), note(0.3, 0.6, 50, 0.2)]
    const loudHigh = [note(0, 0.3, 80, 0.9), note(0.3, 0.6, 82, 0.9)]
    expect(pickMelodyCluster(quietLow, loudHigh)).toBe(loudHigh)
    expect(pickMelodyCluster(loudHigh, quietLow)).toBe(loudHigh)
  })

  it('returns whichever cluster is non-empty when the other is empty', () => {
    const cluster = [note(0, 0.3, 60, 0.5)]
    expect(pickMelodyCluster(cluster, [])).toBe(cluster)
    expect(pickMelodyCluster([], cluster)).toBe(cluster)
  })
})

describe('clusterMelodyCandidates', () => {
  it('separates a real lead-over-pad passage into (mostly) the lead', () => {
    // A four-note lead line, loud and moving, over a six-note pad/chord bed:
    // low, quiet, and denser than the lead - "everything else" in a real stem
    // is usually several voices at once, so it outnumbers the one-voice lead.
    // Every pad note overlaps at least one lead note (real concurrency); the
    // lead notes are sequential with each other, and so are the pad notes.
    const lead = [note(0, 0.4, 72, 0.8), note(0.4, 0.8, 74, 0.8), note(0.8, 1.2, 76, 0.8), note(1.2, 1.6, 79, 0.8)]
    const pad = [
      note(0, 0.27, 48, 0.2),
      note(0.27, 0.53, 48, 0.2),
      note(0.53, 0.8, 48, 0.2),
      note(0.8, 1.07, 48, 0.2),
      note(1.07, 1.33, 48, 0.2),
      note(1.33, 1.6, 48, 0.2),
    ]
    const notes = [...lead, ...pad]
    const result = clusterMelodyCandidates(notes)
    const leadCount = result.filter((n) => lead.includes(n)).length
    const padCount = result.filter((n) => pad.includes(n)).length
    expect(leadCount).toBeGreaterThan(padCount)
    expect(leadCount).toBeGreaterThanOrEqual(3)
  })

  it('handles 0 and 1 notes without throwing', () => {
    expect(clusterMelodyCandidates([])).toEqual([])
    const single = [note(0, 0.3, 60)]
    expect(clusterMelodyCandidates(single)).toEqual(single)
  })

  it('returns everything unchanged when nothing overlaps - no second voice to split off', () => {
    // A clean, already-monophonic line. A forced k=2 split has nothing real
    // to separate here and would only discard half of the one true line -
    // see `hasOverlap`'s own doc comment for how this was found.
    const solo = [note(0, 0.4, 65), note(0.4, 0.8, 68), note(0.8, 1.2, 72), note(1.2, 1.6, 68)]
    expect(clusterMelodyCandidates(solo)).toEqual(solo)
  })

  it('does not split a clean line over a 1ms boundary graze - overlap noise, not real polyphony', () => {
    // Found in independent review: without a tolerance, a millisecond of
    // overlap at a shared boundary (plausible Basic Pitch segmentation
    // noise) reads as "real polyphony" and a forced k=2 split discards half
    // the line - the exact failure `hasOverlap` exists to prevent, just one
    // step removed from the case it already covers.
    const grazing = [
      { startSec: 0, endSec: 0.401, midi: 65, velocity: 0.7 },
      { startSec: 0.4, endSec: 0.8, midi: 68, velocity: 0.7 },
      { startSec: 0.8, endSec: 1.2, midi: 72, velocity: 0.7 },
      { startSec: 1.2, endSec: 1.6, midi: 68, velocity: 0.7 },
    ]
    expect(clusterMelodyCandidates(grazing)).toEqual(grazing)
  })

  it('drops a note with zero affinity to everything rather than letting it corrupt the split of a genuinely connected line', () => {
    // Found in independent review, reproduced directly: a sustained pad
    // spanning a sequential four-note melody line fully overlaps every
    // melody note (overlapKernel's complete-overlap case -> affinity
    // exactly 0 to each), so it has degree 0 and no real relationship to
    // anything. Before the fix, this isolated note's frozen, arbitrary
    // value in the Fiedler vector corrupted the normalisation enough to
    // split the otherwise-connected 4-note melody line in two, discarding
    // half of it. The pad itself must not appear in the result either - it
    // is not evidence FOR the melody cluster any more than against it.
    const pad = note(0, 1.6, 48, 0.2)
    const melody = [note(0, 0.4, 72, 0.8), note(0.4, 0.8, 74, 0.8), note(0.8, 1.2, 76, 0.8), note(1.2, 1.6, 79, 0.8)]
    const result = clusterMelodyCandidates([pad, ...melody])
    expect(result.map((n) => n.midi)).toEqual([72, 74, 76, 79])
    expect(result).not.toContain(pad)
  })
})
