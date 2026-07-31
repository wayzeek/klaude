/**
 * Melody-vs-accompaniment separation by note-affinity graph clustering.
 *
 * `selectMelodicLine` (melody.mjs) picks a monophonic line note-by-note: a
 * weighted interval-scheduling DP that decides, one note at a time, "is this
 * worth adding to the chain." Measured against the reference track's 462-event
 * ground truth, that ceiling is 12.6% exact-MIDI - a
 * real, if modest, lift over chance, but a ceiling, not a moving target: every
 * weight swept against it plateaus in the same place. The literature reframes
 * the problem as *global*, not per-onset: Hsiao & Su, ISMIR 2021 ("Learning
 * Note-to-Note Affinity for Voice Segregation and Melody Line Identification")
 * report 84.8% F1 against skyline's 73.7% by first deciding, for every *pair*
 * of notes in a passage, how likely they are to belong to the same voice, then
 * partitioning the whole note set from that affinity graph at once - a note
 * gets to be influenced by every other note in the passage, not just whichever
 * chain already reached it.
 *
 * Their affinity itself is learned (a trained pairwise model); what is kept
 * here is the *structure*, not the model: build affinity from hand-crafted
 * kernels a monophonic line is known to obey - two notes that overlap in time
 * cannot be the same voice (the physical premise `foldToLoop`'s own
 * `oneEventPerStep` and `selectMelodicLine`'s own non-overlap DP constraint
 * both already lean on); two non-overlapping notes close together in time and
 * pitch are voice-leading, evidence *for* the same voice; and register/
 * duration similarity as softer corroborating signals - then split the graph
 * into two groups with spectral clustering (k=2: melody vs. everything else),
 * the textbook use of a graph's second-smallest Laplacian eigenvector (the
 * "Fiedler vector") to bipartition it. `pickMelodyCluster` decides which of
 * the two resulting groups is the lead - measured (see below) to be mostly a
 * matter of *size*, not the salience/register reasoning `selectMelodicLine`
 * already relies on per-note; that reasoning is kept as a tie-break, not the
 * primary signal.
 *
 * Spectral clustering needs an eigendecomposition. For the few-hundred-note
 * sections this pipeline sections tracks into, a full eigensolver is
 * unnecessary machinery: `fiedlerVector` below is plain power iteration on the
 * normalized Laplacian, deflating the one eigenvector already known in closed
 * form (`I - D^-1/2 W D^-1/2`'s smallest eigenvalue is always 0, eigenvector
 * `D^1/2 * 1`) so the iteration converges to the *next* one instead - no
 * dependency, and deterministic: every seed power iteration starts from is
 * one of a handful of fixed patterns, never `Math.random()`, so the same
 * input always produces the same split. A single fixed seed is not actually
 * safe here - found in independent review, and `fiedlerVector`'s own doc
 * comment covers it in full - so several structurally different fixed seeds
 * are tried and the one that converges to the largest eigenvalue is kept.
 *
 * The verdict, measured in full: this reaches 8.3% exact-MIDI post-fold on
 * the reference track, below both
 * `selectMelodicLine` alone (12.6%) and the shipped `detectMelodySalience`
 * path (15.4%), so `transcribeMelody` (melody.mjs) does not call the
 * pipeline built on this module (`transcribeMelodyByAffinity`). That number
 * is measured against the FIXED Fiedler solver (see `fiedlerVector`'s own
 * doc comment) - an earlier, buggy version of the solver had measured
 * 13.4%, ahead of the DP baseline, and independent review both found the
 * bug and prompted the re-measurement that revealed the corrected number is
 * actually worse, not better. Kept and tested for the same reason this
 * codebase keeps every other measured-but-not-shipped idea: the structure
 * (now correct) is sound on its own terms, and it is a reasonable base for
 * whoever picks this back up - a fixed k=2 is a real limitation on a stem
 * with more than two real voices (this pipeline's `other` stem regularly has
 * four or five), and a hierarchical or learned-k version is the obvious next
 * step neither this module nor the time available for this task attempted.
 */

/**
 * The four kernel-scale constants below are the winner of a grid search
 * (~190 combinations, crossed with the "prefer the smaller cluster" policy in
 * `pickMelodyCluster`) against the reference track's 462-event ground truth,
 * measured end to end through `selectMelodicLine` -> quantise -> `foldToLoop`
 * -> unfold, exactly the pipeline `transcribeMelodyByAffinity` runs - but
 * against an earlier, buggy version of `fiedlerVector` (see that function's
 * own doc comment for what was wrong and how it was found and fixed). This
 * search was not re-run against the fixed solver: the fixed solver's result
 * (8.3% exact-MIDI post-fold) already misses both `selectMelodicLine`'s own
 * baseline (12.6%) and the shipped `detectMelodySalience` path (15.4%)
 * clearly enough that re-tuning would need to close a much larger gap than
 * the original, buggy-solver result's 1.5-point miss did. The constants
 * below are still the measured best *of what was tried against the solver
 * that existed at the time*, not defaults picked by feel, and remain a
 * reasonable starting point for whoever re-tunes this against the fixed
 * solver, rather than starting from scratch.
 */

/** How quickly affinity falls off with time gap between two non-overlapping
 *  notes, in seconds. At this value, a gap of half a beat at 120 BPM (0.25s)
 *  keeps 61% of full affinity - close enough in time to plausibly be the same
 *  phrase - while a gap of two bars (4s) is down to 0.03%. */
const TIME_CONSTANT_SECONDS = 0.5

/** How quickly affinity falls off with pitch distance for the fine-grained
 *  "voice-leading" kernel, in semitones. A whole tone (2 semitones) keeps 85%
 *  affinity; an octave (12) is down to 37% - most real melodic movement is
 *  stepwise or a small leap, so this kernel mainly separates "plausibly the
 *  same line" from "a very different register entirely." */
const PITCH_SEMITONE_SCALE = 12

/** The coarser register kernel's falloff, in semitones. The sweep found no
 *  separating power between making this wider than `PITCH_SEMITONE_SCALE`
 *  (the original design intent - see the comment on `registerKernel`) and
 *  simply matching it; kept as its own named constant and its own kernel call
 *  anyway, since a future track's material might reintroduce the gap this one
 *  was written for. */
const REGISTER_SEMITONE_SCALE = 24

/** How quickly affinity falls off with duration difference, in seconds. Two
 *  notes of similar length are weak evidence of the same rhythmic character
 *  (a lead's short, moving notes vs. a pad's long, held ones). */
const DURATION_SCALE_SECONDS = 0.4

/** How quickly affinity falls off with velocity difference (0..1 scale).
 *  Added after the first cut of this module (pitch/time/register/duration
 *  only) measured below the plain per-note DP - two notes struck at a similar
 *  loudness are weak evidence of the same layer, the same intuition
 *  `selectMelodicLine`'s own `salienceScore` already leans on per-note, here
 *  applied pairwise instead. */
const VELOCITY_SCALE = 0.2

/** No two real notes in the same voice can sound at once - `oneEventPerStep`
 *  and `selectMelodicLine`'s own DP already assume this. A pair that overlaps
 *  completely (one wholly inside the other) gets affinity 0; a pair that just
 *  grazes (a small overlap relative to either note's own length) gets a value
 *  CLOSE TO 1, not close to 0 - `1 - overlapFraction`, and a graze's fraction
 *  is small - since a sliver of overlap is as likely to be a segmentation-
 *  boundary artifact as a genuine second voice, and should barely count
 *  against the pair. Affinity only drops toward 0 as the overlap grows toward
 *  covering one note's whole length. */
function overlapKernel(a, b) {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec)
  if (overlap > 0) {
    const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec)
    const overlapFraction = shorter > 0 ? Math.min(1, overlap / shorter) : 1
    return 1 - overlapFraction
  }
  return Math.exp(overlap / TIME_CONSTANT_SECONDS) // overlap <= 0 here, so this is exp(-gap / tau)
}

function pitchKernel(a, b) {
  return Math.exp(-Math.abs(a.midi - b.midi) / PITCH_SEMITONE_SCALE)
}

function registerKernel(a, b) {
  return Math.exp(-Math.abs(a.midi - b.midi) / REGISTER_SEMITONE_SCALE)
}

function durationKernel(a, b) {
  const da = a.endSec - a.startSec
  const db = b.endSec - b.startSec
  return Math.exp(-Math.abs(da - db) / DURATION_SCALE_SECONDS)
}

function velocityKernel(a, b) {
  return Math.exp(-Math.abs(a.velocity - b.velocity) / VELOCITY_SCALE)
}

/**
 * Pairwise affinity: the product of all five kernels, each in `[0, 1]` -
 * `overlapKernel` alone can reach exactly `0` (complete overlap), the other
 * four are strictly positive (`(0, 1]`, an exponential decay never reaching
 * 0). A product (not a sum) is deliberate - any single kernel voting
 * strongly against the same voice (most importantly `overlapKernel`, which
 * hits exactly 0 for two fully concurrent notes) should be able to veto the
 * pair outright, which a weighted sum cannot do without the veto kernel
 * dominating every other term's weight too.
 */
export function noteAffinity(a, b) {
  return overlapKernel(a, b) * pitchKernel(a, b) * registerKernel(a, b) * durationKernel(a, b) * velocityKernel(a, b)
}

/** Dense affinity matrix over `notes`, zero on the diagonal (no self-loops -
 *  a note's affinity to itself carries no separating information and would
 *  only inflate its own degree). Dense, not sparse: sections here run at most
 *  a few hundred notes, so an O(n^2) matrix is negligible, and every pair
 *  needs a weight anyway since `noteAffinity` is never exactly 0 except at
 *  the complete-overlap edge case. */
export function buildAffinityMatrix(notes) {
  const n = notes.length
  const matrix = Array.from({ length: n }, () => new Float64Array(n))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = noteAffinity(notes[i], notes[j])
      matrix[i][j] = w
      matrix[j][i] = w
    }
  }
  return matrix
}

/**
 * Fixed, deterministic seed patterns for `fiedlerVector`'s power iteration -
 * never `Math.random()`. A SINGLE fixed seed is not safe in general: power
 * iteration converges to whichever eigenvector the seed has the largest
 * component along, and a symmetric-enough graph can make a "nice-looking"
 * seed like plain alternation collinear (or near it) with a *lower*
 * eigenvalue's eigenvector instead of the one actually wanted. Concretely
 * (found in independent review, reproduced directly): four notes in two
 * pairs, each pair internally close (affinity 1) and the two pairs cross-
 * linked at half that (affinity 0.5), is a graph where the alternating seed
 * `[1,-1,1,-1]` **is already an exact eigenvector** of a *smaller* eigenvalue
 * (0.5) than the true Fiedler eigenvalue (1, eigenvector `[1,1,-1,-1]`, the
 * actual pair-vs-pair split) - power iteration seeded there never leaves it,
 * converging to the wrong split with full numerical confidence. Four
 * structurally different fixed patterns, scored after convergence and the
 * best kept (see `fiedlerVector` below), make that specific coincidence need
 * to hit all four at once rather than just one - not a formal guarantee for
 * every possible graph, but a large, deterministic improvement over betting
 * everything on a single seed shape.
 */
const FIEDLER_SEEDS = [
  (i) => (i % 2 === 0 ? 1 : -1), // alternating parity
  (i, n) => (i < n / 2 ? 1 : -1), // first half vs second half
  (i) => (i % 3 === 0 ? 1 : -1), // period 3 - breaks period-2 symmetry
  // Golden-ratio low-discrepancy sequence: `(i * phi) mod 1` spreads points
  // near-uniformly over [0, 1) without repeating any small period, so it is
  // very unlikely to be collinear with a low eigenvector of a graph built
  // from a small, regular note pattern the way the period-2/half/period-3
  // seeds above can be. Still a fixed, deterministic function of `i` alone.
  (i) => (((i * 0.6180339887498949) % 1) - Math.floor((i * 0.6180339887498949) % 1) < 0.5 ? 1 : -1),
]

/**
 * The Fiedler vector of the symmetric normalized Laplacian `L = I - D^-1/2 W
 * D^-1/2`, by power iteration - no dense eigensolver, no dependency.
 *
 * `L`'s smallest eigenvalue is always 0, with eigenvector `D^1/2 * 1` (checked
 * directly: `(D^-1/2 W D^-1/2)(D^1/2 * 1) = D^-1/2 W 1 = D^-1/2 (D * 1) = D^1/2
 * * 1`, using `W * 1 = D * 1` by the definition of degree). The Fiedler vector
 * is the eigenvector of the *next* smallest eigenvalue - which is exactly what
 * plain power iteration cannot find on its own, since it converges to the
 * *largest*-magnitude eigenvalue's eigenvector, and the known trivial one
 * would dominate every time.
 *
 * Two standard tricks make plain power iteration find it anyway, both applied
 * to `M = I + D^-1/2 W D^-1/2` rather than `L` directly:
 *
 * 1. **Shift.** `M`'s eigenvalues are `2 - eigenvalues(L)`, all in `[0, 2]`
 *    since a normalized Laplacian's eigenvalues sit in `[0, 2]` - so on `M`,
 *    unlike on `L`, "largest eigenvalue" and "largest magnitude" always agree,
 *    which plain power iteration needs to converge to the eigenvalue actually
 *    wanted rather than whichever is furthest from zero in either direction.
 * 2. **Deflation.** `M`'s own top eigenvector is the same trivial `D^1/2 * 1`
 *    (eigenvalue 2, i.e. `L`'s 0). Projecting it out of the working vector
 *    after every multiply - not just at the start - stops rounding error from
 *    slowly reintroducing it over many iterations, which a one-time-only
 *    projection would let happen.
 *
 * `M`'s second-largest eigenvector is then `L`'s second-*smallest* - the
 * Fiedler vector.
 *
 * Run from each of `FIEDLER_SEEDS` independently (see that constant's own
 * doc comment for why one seed is not enough), and the result with the
 * largest converged eigenvalue estimate is kept: at convergence, `current` is
 * a unit-length eigenvector of `M` with eigenvalue `λ`, so `M @ current =
 * λ * current`, and since `current` is already deflated (orthogonal to the
 * trivial eigenvector), `‖deflate(M @ current)‖ = |λ|` exactly - which is
 * exactly the `norm` this function already computes every iteration as part
 * of normalising. Reusing it as a score costs nothing extra. Picking the
 * *largest* such estimate across seeds is correct because every eigenvalue
 * of `M` other than the deflated trivial one (2) is `<= 1` in this graph
 * family (`L`'s eigenvalues are `>= 0`, `M`'s are `2 - eigenvalues(L)`), so
 * whichever seed's result has the largest score is the one that found the
 * *true* second-largest eigenvalue (the Fiedler eigenvalue), not a smaller
 * one some other seed got stuck on.
 */
export function fiedlerVector(weights, { iterations = 200 } = {}) {
  const n = weights.length
  if (n === 0) return new Float64Array(0)
  if (n === 1) return new Float64Array([0])

  const degree = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) sum += weights[i][j]
    degree[i] = sum
  }
  const invSqrtDegree = new Float64Array(n)
  for (let i = 0; i < n; i++) invSqrtDegree[i] = degree[i] > 0 ? 1 / Math.sqrt(degree[i]) : 0

  // The trivial top eigenvector of M, normalised to unit length.
  const trivial = new Float64Array(n)
  let trivialNorm = 0
  for (let i = 0; i < n; i++) {
    trivial[i] = Math.sqrt(degree[i])
    trivialNorm += trivial[i] * trivial[i]
  }
  trivialNorm = Math.sqrt(trivialNorm)
  // Every degree is 0 - no note has any affinity to any other at all (e.g.
  // every pair fully overlaps in time). There is no signal to split on;
  // returning all-zero is the honest answer, and `partitionBySign`'s
  // fallback chain turns it into a deterministic (if arbitrary) split rather
  // than every entry silently landing on the same side by sign convention.
  if (trivialNorm === 0) return new Float64Array(n)
  for (let i = 0; i < n; i++) trivial[i] /= trivialNorm

  function deflateAndNormalize(v) {
    let dot = 0
    for (let i = 0; i < n; i++) dot += v[i] * trivial[i]
    for (let i = 0; i < n; i++) v[i] -= dot * trivial[i]
    let norm = 0
    for (let i = 0; i < n; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm)
    return norm
  }

  function seeded(pattern) {
    const v = new Float64Array(n)
    for (let i = 0; i < n; i++) v[i] = pattern(i, n)
    const norm = deflateAndNormalize(v)
    if (norm <= 1e-9) return null // collinear with the trivial vector - unusable, try the next seed
    for (let i = 0; i < n; i++) v[i] /= norm
    return v
  }

  function runFrom(seedVector) {
    const u = new Float64Array(n)
    const wu = new Float64Array(n)
    let current = seedVector
    let eigenvalueEstimate = 0
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) u[i] = current[i] * invSqrtDegree[i]
      for (let i = 0; i < n; i++) {
        let sum = 0
        const row = weights[i]
        for (let j = 0; j < n; j++) sum += row[j] * u[j]
        wu[i] = sum
      }
      const next = new Float64Array(n)
      for (let i = 0; i < n; i++) next[i] = current[i] + wu[i] * invSqrtDegree[i]
      const norm = deflateAndNormalize(next)
      if (norm < 1e-9) break // converged onto the trivial direction itself - nothing left to iterate
      eigenvalueEstimate = norm
      for (let i = 0; i < n; i++) next[i] /= norm
      current = next
    }
    return { vector: current, eigenvalueEstimate }
  }

  let best = null
  for (const pattern of FIEDLER_SEEDS) {
    const seedVector = seeded(pattern)
    if (!seedVector) continue
    const result = runFrom(seedVector)
    if (!best || result.eigenvalueEstimate > best.eigenvalueEstimate) best = result
  }
  return best ? best.vector : new Float64Array(n) // every seed was degenerate: no basis to split on
}

/**
 * Split `notes` into two groups by the sign of their Fiedler-vector entry.
 *
 * A sign split can degenerate on a small or unlucky graph (every entry lands
 * on the same side). When that happens, falls back to a median split, which
 * always produces two non-empty groups for `n >= 2` distinct-valued inputs;
 * if even that fails (every entry identical - a fully symmetric or fully
 * degenerate affinity graph), the second half of `notes` in their original
 * order becomes group B, an arbitrary but deterministic tie-break rather than
 * either group silently coming back empty.
 */
export function partitionBySign(notes, vector) {
  let a = []
  let b = []
  for (let i = 0; i < notes.length; i++) (vector[i] >= 0 ? a : b).push(notes[i])
  if (a.length > 0 && b.length > 0) return [a, b]

  const sorted = [...vector].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  a = []
  b = []
  for (let i = 0; i < notes.length; i++) (vector[i] < median ? a : b).push(notes[i])
  if (a.length > 0 && b.length > 0) return [a, b]

  const half = Math.floor(notes.length / 2) || 1
  return [notes.slice(0, half), notes.slice(half)]
}

/** Min-max range of a set of notes' velocities - same convention
 *  `melody.mjs`'s own `velocityRange` uses, duplicated here rather than
 *  imported so this module stays free of a dependency on `melody.mjs` (it is
 *  `melody.mjs` that will depend on this, not the other way around). */
function velocityRange(notes) {
  let min = Infinity
  let max = -Infinity
  for (const note of notes) {
    if (note.velocity < min) min = note.velocity
    if (note.velocity > max) max = note.velocity
  }
  return [min, max]
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

/**
 * Which of the two clusters is the melody.
 *
 * The first version of this function scored each cluster by mean loudness and
 * mean register - `selectMelodicLine`'s own two measured-useful per-note
 * signals, applied to a whole cluster's mean instead of one note. Measured
 * against the reference track's ground truth against the (then buggy - see
 * `fiedlerVector`'s doc comment) Fiedler solver, that lost outright to a much
 * simpler rule: **prefer the smaller cluster** (9.3% vs. 13.4% exact-MIDI
 * post-fold, same kernel, same everything else downstream). Re-checked after
 * the solver was fixed: the gap closed and reversed at a small margin
 * (loudness/register 9.6% vs. size-preference 8.3%) - kept as-is rather than
 * swapped, since re-optimising a pick rule's default is a different exercise
 * than fixing the solver bugs that prompted the re-check, and both numbers
 * are well short of both `selectMelodicLine`'s own baseline (12.6%) and the
 * shipped path (15.4%) regardless of which one ships. The likely reason size
 * preference helps at all: a lead line is one voice; "everything else" in a
 * polyphonic stem (chord tones, pads, bass) is several voices at once, so
 * Basic Pitch simply produces far more note detections for the accompaniment
 * side of any real split than for the melody side - a structural asymmetry,
 * not a loudness or register one. This
 * is a single-track measurement (see the report's own caveats) - it may not
 * generalise to a mix where the accompaniment is genuinely sparser than the
 * lead, which is why the loudness/register scoring is kept as a tie-break
 * rather than deleted outright.
 */
export function pickMelodyCluster(clusterA, clusterB) {
  if (clusterA.length === 0) return clusterB
  if (clusterB.length === 0) return clusterA
  if (clusterA.length !== clusterB.length) return clusterA.length < clusterB.length ? clusterA : clusterB

  const all = [...clusterA, ...clusterB]
  const [velMin, velMax] = velocityRange(all)
  const normVelocity = (notes) => {
    const v = mean(notes.map((n) => n.velocity))
    return velMax > velMin ? (v - velMin) / (velMax - velMin) : 1
  }
  const meanMidi = (notes) => mean(notes.map((n) => n.midi))
  const midiAll = all.map((n) => n.midi)
  const midiMin = Math.min(...midiAll)
  const midiMax = Math.max(...midiAll)
  const normRegister = (notes) => (midiMax > midiMin ? (meanMidi(notes) - midiMin) / (midiMax - midiMin) : 1)

  const scoreA = 3 * normVelocity(clusterA) + 1 * normRegister(clusterA)
  const scoreB = 3 * normVelocity(clusterB) + 1 * normRegister(clusterB)
  return scoreA >= scoreB ? clusterA : clusterB
}

/**
 * How much time-overlap between two notes counts as real, evidentiary
 * polyphony rather than segmentation noise at a shared boundary. The same
 * value `melody.mjs`'s `selectMelodicLine` already uses for exactly this
 * distinction (`OVERLAP_TOLERANCE_SECONDS`) - duplicated, not imported, per
 * this module's own stated convention of staying dependency-free of
 * `melody.mjs` (see `velocityRange`'s doc comment above for the same
 * reasoning). Found in independent review: without this tolerance, two
 * Basic Pitch fragments of what is really one clean, monophonic line can
 * graze by a millisecond at a shared boundary, `hasOverlap` reads that as
 * "real polyphony," and the forced k=2 split then discards half the line -
 * precisely the failure mode `hasOverlap` already exists to prevent, just
 * one boundary-noise step removed from the case it was written for.
 */
const OVERLAP_TOLERANCE_SECONDS = 0.03

/** Is there any real polyphony at all - two notes that actually sound at
 *  once, by more than boundary noise (`OVERLAP_TOLERANCE_SECONDS`)? Found
 *  while testing `clusterMelodyCandidates`: a k=2 spectral split splits into
 *  two groups *unconditionally*, even when the input is already a single
 *  clean monophonic line with nothing to separate it from - the Fiedler
 *  vector still finds *some* bipartition (typically an arbitrary early
 *  half / late half split along the one voice's own timeline), and
 *  `pickMelodyCluster` then discards half of the only real line there was.
 *  Clustering can only ever help when there is a second voice to separate
 *  from the first; with none, it can only hurt. */
function hasOverlap(notes) {
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const overlap = Math.min(notes[i].endSec, notes[j].endSec) - Math.max(notes[i].startSec, notes[j].startSec)
      if (overlap > OVERLAP_TOLERANCE_SECONDS) return true
    }
  }
  return false
}

/**
 * The whole pipeline: affinity graph -> Fiedler split -> pick the melody
 * cluster. Returns the *cluster*, not yet a monophonic line - notes inside
 * one cluster can still overlap each other (the graph groups by voice, it
 * does not itself schedule one), so a caller still needs a non-overlap
 * reduction (`melody.mjs`'s `selectMelodicLine` already is one, and is the
 * intended next step - seeing this module's smaller, cleaner candidate pool
 * instead of every note in the section).
 *
 * Notes with zero affinity to *every other* note in the section (a sustained
 * pad/drone that fully overlaps every other note gets exactly 0 affinity to
 * each of them, `overlapKernel`'s complete-overlap case) are excluded before
 * clustering, not included in whichever side the split happens to put them
 * on. Found in independent review, reproduced directly: such a note has
 * `degree` 0, so `invSqrtDegree` for it is 0, so it never actually
 * participates in the power iteration (its own row/column contribute
 * nothing) - but it still occupies a slot in the vector being normalised,
 * and its frozen, arbitrary seed value can dominate the normalisation and
 * corrupt the *other*, genuinely connected notes' signs, splitting a single
 * connected melodic line in two for a reason that has nothing to do with it.
 * A note with zero affinity to everything is definitionally not evidence
 * *for* the melody cluster either way, so dropping it from candidacy
 * entirely (rather than arbitrarily assigning it a side) is both the
 * numerically safe choice and the semantically honest one.
 */
export function clusterMelodyCandidates(notes, options = {}) {
  if (notes.length <= 1) return [...notes]
  if (!hasOverlap(notes)) return [...notes] // nothing concurrent - no second voice to split off, see hasOverlap

  const fullWeights = buildAffinityMatrix(notes)
  const degree = notes.map((_, i) => fullWeights[i].reduce((sum, w) => sum + w, 0))
  const connected = []
  for (let i = 0; i < notes.length; i++) if (degree[i] > 1e-9) connected.push(i)

  // Fewer than two notes have any affinity to anyone: no basis to split on,
  // same reasoning as `hasOverlap`'s "no second voice" case above, just
  // discovered after building the matrix instead of before.
  if (connected.length < 2) return [...notes]

  const connectedNotes = connected.map((i) => notes[i])
  // Dropping the isolated notes can turn what looked like real polyphony
  // (the whole section) into a clean, already-monophonic remainder (e.g. a
  // sustained pad spanning a sequential four-note line: the pad is isolated
  // and dropped above, and the four notes never overlap *each other* at
  // all) - re-checking `hasOverlap` on the surviving connected notes catches
  // that, for the same reason the top-level check exists.
  if (!hasOverlap(connectedNotes)) return connectedNotes

  const weights = connected.map((i) => connected.map((j) => fullWeights[i][j]))
  const vector = fiedlerVector(weights, options)
  const [a, b] = partitionBySign(connectedNotes, vector)
  return pickMelodyCluster(a, b)
}
