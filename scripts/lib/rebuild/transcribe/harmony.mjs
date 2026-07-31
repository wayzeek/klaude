/**
 * Harmony transcription: beat-synchronous chroma becomes a chord progression.
 *
 * Chroma discards voicing, inversion and octave, and the stem this reads
 * carries melody and percussion bleed alongside the chords. Expect triads and
 * sevenths, not accurate voicings - #43 says so explicitly and the vocabulary
 * in chords.mjs is sized to match.
 */

import { decodeWav } from '../../decoded-audio.mjs'
import { CHROMA_FFT, fft, makeHann } from '../../dsp.mjs'
import { CHORD_TEMPLATES, diatonicTemplates, scoreChroma, smoothChordPath } from './chords.mjs'
import { STEPS_PER_BEAT, foldToLoop } from './quantize.mjs'

/** Where pitch lives. Same window dsp.mjs's computeChroma uses, and for the
 *  same reason: kicks below and hiss above only blur the answer. */
const CHROMA_MIN_HZ = 80
const CHROMA_MAX_HZ = 2000

/**
 * How far a bin's exact frequency may sit from the pitch class it gets
 * assigned to, in cents, before it is dropped instead of assigned.
 *
 * `computeChroma`/`beatFeatures` assign every bin to its nearest pitch class
 * regardless of distance, which is fine for their purposes (a boundary match
 * or a rough tempo/energy estimate does not hinge on one bin). It is not fine
 * here: a bin near the boundary between two pitch classes is genuinely
 * ambiguous evidence, and handing 100% of a large, leaked magnitude to
 * whichever pitch happens to be nearest can manufacture a note that is not
 * there.
 *
 * Measured directly (a synthetic C#4 tone at CHROMA_FFT=4096/44.1kHz, in
 * `harmony.test.mjs`'s two-chord fixture): the bin carrying most of the
 * root's own spectral leakage sits 49.2 cents from C - one 44.1kHz/4096 bin is
 * about two thirds of a semitone wide in that register, so a bin can be this
 * far from its nearest note and still be that note's own leakage, not a
 * different one. Handed to the nearest-pitch-class rule, that leakage lands
 * squarely on the major seventh of a C# major triad and turns it into a
 * confident (and wrong) C#maj7 - the two chords differ by exactly the note the
 * mis-binned energy supplies. Dropping bins past 35 cents removes exactly that
 * bin while keeping true near-center bins (measured at -21.5 and +17.1 cents
 * on the same tone) untouched, and recovers the plain triad.
 */
const MAX_CENTS_FROM_PITCH = 35

/** How many analysis windows to spread across each beat. Three at 4096 samples
 *  covers 280ms of a 435ms beat at 138 BPM, which is the sustain rather than
 *  the attack. One window would see only the attack; more than three buys
 *  nothing and costs an FFT each. */
const WINDOWS_PER_BEAT = 3

/**
 * How far the best-scoring template must stand clear of the runner-up, in
 * cosine-similarity units, before a bar is trusted enough to contribute a
 * chord event, averaged over the bar's beats.
 *
 * An absolute floor on the best score cannot do this job: with seven
 * qualities across twelve roots, some template always fits any vector
 * reasonably well. A perfectly flat chroma vector scores `sqrt(4/12) =
 * 0.5774` against every four-note template at once (a triad's own floor is
 * `sqrt(3/12) = 0.5`) - a threshold has to clear that structural ceiling to
 * reject anything, and this module's first version, `MIN_CHORD_SCORE: 0.55`,
 * did not. Measured on the real `other` stem (`the-chase`): two sections
 * with no harmony instrument at all in the source (`kickSoft`/`stepsLone`/`air` only) both averaged a
 * *raw* top score above 0.70 per bar - comfortably past 0.55 - while their
 * *margin* to the runner-up averaged 0.016-0.020 and never exceeded 0.028 in
 * either section. Noise ties templates; a real chord does not.
 *
 * Bar, not beat: a single beat's margin is noisy even inside genuinely good
 * material (measured minima near zero in sections that are otherwise
 * confidently and correctly detected - a chord-change instant, or a beat
 * where two candidates are both plausible). A bar is the grid's own
 * chord-change rate here - every progression in `tracks/MINUIT/02-the-
 * chase.md` changes at most once per bar - so averaging margin over a bar
 * is not an arbitrary smoothing window, it is the unit the thing being
 * measured actually varies at. Measured at that grain on the boundary
 * between two adjacent 6-bar halves of one detected section - `bassA` only
 * for the first half, `keysA` entering exactly at the second - bar margins
 * are 0.004-0.027 through the silent half and jump to 0.085-0.111 the beat
 * `keysA` starts, a clean order-of-magnitude gap with no threshold-picking
 * required. 0.03 sits just above the noisy half's measured ceiling (0.028)
 * and comfortably below the real half's floor (0.085). The same measurement
 * on five sections with real, correctly-detected harmony elsewhere in the
 * track found bar margins as low as 0.020-0.032 in three of them - so this
 * threshold does cost a small number of real bars (four, across three
 * sections - see the exact-cost measurement below); it does not cost whole
 * sections.
 *
 * What kind of guarantee this actually is - three different cases, not one:
 *
 * Flat chroma (equal energy on every pitch class) is rejected *by
 * construction*: every template ties, margin is exactly 0, and nothing
 * about `MARGIN_THRESHOLD`'s value matters for that case.
 *
 * Realistic bleed - modelled as small, independent perturbations around a
 * roughly-flat baseline, one draw per beat, then averaged into a bar the
 * same way `barMargins` does - is rejected *empirically*, and the range
 * this holds over was measured, not assumed: a bar-level false-accept rate
 * of 0.000% at relative noise CV 0.1 and 0.15 (0 and 8 hits respectively out
 * of 50,000 trials), climbing to 0.53% at CV 0.2 and 7.76% at CV 0.3. Below
 * roughly CV 0.15 this threshold is solid; past roughly CV 0.3 it is not,
 * and nothing here would detect the difference on a recording this module
 * has not been measured against.
 *
 * I.i.d. uniform noise per pitch class - each of the 12 components drawn
 * independently and uniformly, no shared shape at all - is *not* reliably
 * rejected: at the same bar-level aggregation, the median bar margin is
 * 0.0284 and 45.65% of trials clear 0.03 outright (N=20,000). This is a
 * different, much less structured process than anything an audio stem's
 * bleed actually produces - real noise is coloured, not twelve independent
 * dice rolls - which is why the empirical case above holds while this one
 * does not. Anyone retuning this constant should know which of these three
 * guarantees they are relying on, and should not read a low false-accept
 * rate on realistic bleed as proof against arbitrary noise; it is not one.
 *
 * Raising the threshold to also cover the uniform-noise case is not the fix:
 * this pipeline's actual inputs look like the empirical case (correlated,
 * structured bleed - reverb tails, room tone, a wind sample), not like
 * uncorrelated per-bin noise, and the real cost of 0.03 has already been
 * measured (four real bars, in three sections). A higher
 * threshold buys protection against a distribution this pipeline does not
 * see and pays for it in bars that do carry real harmony.
 */
const MARGIN_THRESHOLD = 0.03

/**
 * A section needs at least this many confident bars, not just one, before
 * its chords are worth emitting.
 *
 * `MARGIN_THRESHOLD` is a per-bar average, not a hard floor with zero
 * false-positive rate - a noise bar can cross it by chance on material this
 * module has not been measured against. Requiring more than one such bar
 * before trusting the result is the same shape of guard as
 * `MIN_HITS_PER_SECTION`/`MIN_NOTES_PER_SECTION` elsewhere in this plan's
 * other transcribers, sized the same way: the smallest number above "one."
 */
const MIN_CONFIDENT_BARS = 2

/** Self-transition bonus for the Viterbi pass. Large enough to hold a chord
 *  through one ambiguous beat, small enough that a real change still wins. */
const SELF_BONUS = 0.15

/**
 * One twelve-value chroma vector per beat, averaged across the beat.
 *
 * Deliberately not `beatFeatures` from sections.mjs: that takes a single 93ms
 * window at the start of each beat, which is the attack transient - the least
 * harmonic part of a note. Averaging several windows spread across the beat
 * measures what is sounding through its sustain rather than what just started.
 * `beatFeatures` is left untouched: repeat matching depends on its exact
 * current output.
 */
export function beatChroma(audio, grid) {
  const { sampleRate, numFrames, channels, readSample } = audio
  const window = makeHann(CHROMA_FFT)
  const re = new Float32Array(CHROMA_FFT)
  const im = new Float32Array(CHROMA_FFT)
  const bins = CHROMA_FFT / 2
  const binHz = sampleRate / CHROMA_FFT

  const binPitchClass = new Int8Array(bins).fill(-1)
  for (let bin = 1; bin < bins; bin++) {
    const hz = bin * binHz
    if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue
    const midi = 69 + 12 * Math.log2(hz / 440)
    const nearest = Math.round(midi)
    if (Math.abs(midi - nearest) * 100 > MAX_CENTS_FROM_PITCH) continue
    binPitchClass[bin] = ((nearest % 12) + 12) % 12
  }

  const beatFrames = grid.beatSeconds * sampleRate
  const spacing = WINDOWS_PER_BEAT > 1 ? (beatFrames - CHROMA_FFT) / (WINDOWS_PER_BEAT - 1) : 0
  const times = []
  const vectors = []

  for (let beat = 0; ; beat++) {
    const beatStart = Math.round(grid.beatAt(beat) * sampleRate)
    if (beatStart < 0) continue
    // The whole beat's worth of windows must fit, or the last beat reports a
    // zero-padded reading that looks like a quiet chord rather than no data.
    const lastStart = beatStart + Math.max(0, Math.round(spacing * (WINDOWS_PER_BEAT - 1)))
    if (lastStart + CHROMA_FFT > numFrames) break

    const vector = new Float32Array(12)
    for (let w = 0; w < WINDOWS_PER_BEAT; w++) {
      const start = beatStart + Math.round(spacing * w)
      for (let i = 0; i < CHROMA_FFT; i++) {
        let sum = 0
        for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
        re[i] = (sum / channels) * window[i]
        im[i] = 0
      }
      fft(re, im)
      for (let bin = 1; bin < bins; bin++) {
        const pitchClass = binPitchClass[bin]
        if (pitchClass < 0) continue
        vector[pitchClass] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      }
    }

    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < 12; i++) vector[i] /= norm

    times.push(grid.beatAt(beat))
    vectors.push(vector)
  }
  return { times, vectors }
}

/** Best-template score minus runner-up score, per beat - the contrast
 *  measure `MARGIN_THRESHOLD` gates on, computed once from the raw (not
 *  Viterbi-smoothed) per-beat scores. */
function beatMargins(rows) {
  return rows.map((row) => {
    let top1 = -Infinity
    let top2 = -Infinity
    for (const value of row) {
      if (value > top1) {
        top2 = top1
        top1 = value
      } else if (value > top2) {
        top2 = value
      }
    }
    return top1 - top2
  })
}

/** Mean margin per whole bar, indexed by bar number from the track's
 *  downbeat. A bar with fewer than `beatsPerBar` beats of data (the last,
 *  partial bar `beatChroma` produced) is left out rather than padded, so a
 *  short trailing bar cannot average out artificially high or low. */
function barMargins(margins, beatsPerBar) {
  const bars = []
  for (let bar = 0; bar * beatsPerBar + beatsPerBar <= margins.length; bar++) {
    let sum = 0
    for (let b = bar * beatsPerBar; b < bar * beatsPerBar + beatsPerBar; b++) sum += margins[b]
    bars.push(sum / beatsPerBar)
  }
  return bars
}

/**
 * One chord progression per section.
 *
 * The Viterbi pass runs over the whole track rather than per section, so a
 * chord held across a section boundary stays one chord. Sections are cut out
 * of the resulting path afterwards.
 *
 * Confidence is decided per bar, not per section, before events are formed:
 * a section can straddle the exact point where real harmony starts (see
 * `MARGIN_THRESHOLD`'s doc comment), and a single section-wide gate cannot
 * tell an unconfident half from a confident one - it can only accept or
 * reject the whole thing. An unconfident bar contributes no event at all,
 * which both ends a run in progress and opens a gap no run can cross.
 */
export function transcribeHarmony(wavBuf, grid, sections, { key = null } = {}) {
  const audio = decodeWav(wavBuf)
  const { vectors } = beatChroma(audio, grid)
  if (!vectors.length) return sections.map(() => null)

  const rows = vectors.map((vector) => scoreChroma(vector))
  const path = smoothChordPath(rows, { selfBonus: SELF_BONUS })
  const inKey = diatonicTemplates(key)
  const beatsPerBar = grid.beatsPerBar
  const confidentBars = barMargins(beatMargins(rows), beatsPerBar).map((margin) => margin >= MARGIN_THRESHOLD)
  const confidentBeat = (beat) => confidentBars[Math.floor(beat / beatsPerBar)] === true

  return sections.map((section) => {
    const fromBeat = section.startBar * beatsPerBar
    const toBeat = Math.min(path.length, (section.startBar + section.bars) * beatsPerBar)
    if (toBeat - fromBeat < beatsPerBar) return null

    // Collapse runs of the same template into one chord event each. A run
    // also ends - without opening a new one - the moment a beat's bar is not
    // confident, so an unconfident stretch is a gap, never an event.
    const events = []
    let runStart = null
    let confidentBeats = 0
    const closeRun = (end) => {
      if (runStart === null) return
      const template = CHORD_TEMPLATES[path[runStart]]
      let score = 0
      for (let b = runStart; b < end; b++) score += rows[b][path[runStart]]
      score /= end - runStart
      events.push({
        step: (runStart - fromBeat) * STEPS_PER_BEAT + section.startBar * beatsPerBar * STEPS_PER_BEAT,
        length: (end - runStart) * STEPS_PER_BEAT,
        velocity: 0.7,
        confidence: Math.max(0, Math.min(1, score)),
        midi: null,
        symbol: template.symbol,
        driftSteps: 0,
        templateIndex: template.index,
      })
      runStart = null
    }
    for (let beat = fromBeat; beat < toBeat; beat++) {
      if (!confidentBeat(beat)) {
        closeRun(beat)
        continue
      }
      confidentBeats++
      if (runStart !== null && path[beat] !== path[runStart]) closeRun(beat)
      if (runStart === null) runStart = beat
    }
    closeRun(toBeat)
    if (!events.length || confidentBeats < MIN_CONFIDENT_BARS * beatsPerBar) return null

    const meanScore = events.reduce((sum, event) => sum + event.confidence, 0) / events.length

    // Not passing `oneEventPerStep` here (see its doc comment in quantize.mjs,
    // and bass.mjs/melody.mjs's own use of it): a section sounding two
    // different chord symbols at the same folded step would be the same
    // defect class, but it cannot happen from this function's own output.
    // `events` above is one run per contiguous stretch of an unbroken chord
    // path (built by the beat-by-beat loop closing above), so *before*
    // folding, its steps are already strictly increasing - no two runs ever
    // share a step. Folding can still fold two different original runs onto
    // the same position (that is the whole mechanism `oneEventPerStep`
    // exists for), but not into a two-survivor collision: unlike bass/lead,
    // which re-detect pitch independently at every instant and can genuinely
    // read two different things at the same point in two different
    // repetitions, every symbol here comes from one Viterbi path computed
    // once over the whole track, so a single repetition can only ever
    // contribute to one bucket at a given position - which makes
    // `KEEP_FRACTION`'s majority rule (`scoreFold`, `count/reps > 0.5`)
    // sufficient on its own: two disjoint symbols can never each hold a
    // strict majority of the same `reps`-sized partition. The one case that
    // bypasses majority filtering entirely - `reps === 1`, the whole-section
    // fallback that produced the real bass bug - needs two *original* events
    // sharing one step to misfire the same way, which the strictly-
    // increasing-steps guarantee above already rules out (modulo by
    // `loopSteps` is the identity there, so folded and original steps
    // coincide).
    const folded = foldToLoop(
      events.map(({ templateIndex, ...event }) => event),
      section,
      grid,
    )
    if (folded.events.length === 0) return null

    // #43: a run of chords inconsistent with the key is reported, not
    // suppressed. A borrowed dominant is a real thing and worth hearing.
    const outOfKey = inKey.size
      ? events.filter((event) => !inKey.has(event.templateIndex)).length / events.length
      : 0

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: meanScore * Math.max(folded.agreement, 0.25),
      outOfKey,
    }
  })
}

/** A note's own velocity, floored, so a very quiet note still registers as
 *  *some* evidence of its pitch class rather than vanishing from the beat's
 *  vector entirely - a quiet chord tone is still a chord tone. */
const MIN_NOTE_WEIGHT = 0.05

/**
 * One twelve-value pitch-class vector per beat, built from which of Basic
 * Pitch's notes are actually sounding through the beat's centre - the
 * discrete-note analogue of `beatChroma`'s FFT-derived vector above, for use
 * where Basic Pitch's output is available. A beat with nothing sounding
 * produces an all-zero vector, which `scoreChroma` already handles (returns
 * an all-zero score row); unlike FFT-derived chroma, an all-zero reading here
 * is unambiguous evidence of silence rather than a noise floor, so no
 * separate confidence threshold is needed to tell the two apart (see
 * `confidentBeat` below).
 */
function beatNotePitchClasses(notes, grid, fromBeat, toBeat) {
  const vectors = []
  for (let beat = fromBeat; beat < toBeat; beat++) {
    const center = (grid.beatAt(beat) + grid.beatAt(beat + 1)) / 2
    const vector = new Float32Array(12)
    for (const note of notes) {
      if (note.startSec <= center && note.endSec > center) {
        vector[((note.midi % 12) + 12) % 12] += Math.max(note.velocity, MIN_NOTE_WEIGHT)
      }
    }
    vectors.push(vector)
  }
  return vectors
}

/**
 * A beat counts as confident here once its best-scoring template stands
 * strictly clear of the runner-up - not `transcribeHarmony`'s own
 * `MARGIN_THRESHOLD` (0.03), a much smaller gap, and deliberately so; see
 * `transcribeHarmonyFromNotes`' own doc comment for why reusing that
 * constant directly was tried first and measured to cost real detection
 * for no accuracy gain on this pathway.
 *
 * Sized from the real reference track's own beat-by-beat margins, not
 * assumed: across every non-silent beat of `the-chase`'s "other" stem notes
 * (349 of 404), exactly 21 tie at margin *precisely* 0 - each one either a
 * single sounding pitch class or a bare perfect-fifth dyad, the two
 * genuinely ambiguous shapes this gate exists to reject (see
 * `transcribeHarmonyFromNotes`'s doc comment). Every other beat's margin
 * sits at 0.00059 or above - a real, clean gap, not a continuum this
 * threshold has to guess where to cut. 0.0001 sits inside that gap, several
 * times larger than float32 rounding noise at these magnitudes (~1e-7) and
 * comfortably below the next real value, so it rejects exactly the
 * structural ties without touching a single genuinely-scored beat.
 */
const NOTE_MARGIN_THRESHOLD = 0.0001

/**
 * Harmony transcription from Basic Pitch's note events, in place of
 * beat-synchronous chroma: match the pitch-class set actually sounding at
 * each beat (`beatNotePitchClasses`) against `CHORD_TEMPLATES`, the same
 * Viterbi smoothing (`smoothChordPath`) `transcribeHarmony` uses, and the
 * same run-collapsing and `foldToLoop` call. Scoped per section rather than
 * over the whole track (unlike `transcribeHarmony`'s single whole-track
 * Viterbi pass): Basic Pitch's notes carry no stem-wide state a per-section
 * pass would lose, and scoping this way needs no separate "how many total
 * beats does the stem have" bookkeeping.
 *
 * Confidence gating reuses `transcribeHarmony`'s own `beatMargins` (the
 * margin between the best- and second-best-scoring template at each beat),
 * not a bare "something is sounding" check. An earlier version used exactly
 * that bare check - "a beat built from discrete notes with nothing sounding
 * is exactly zero, unambiguous silence, so a beat only counts as confident
 * when something was actually detected" - and it was wrong: a *single*
 * sounding pitch class is not evidence of a chord, only of a note, and every
 * triad/sus4 template containing that one pitch class scores identically
 * (`scoreChroma`'s dot product against a one-note chroma vector depends only
 * on whether the template contains that pitch class, not on anything else)
 * - measured directly, a lone sustained C ties `C`, `Cm`, `Csus`, `Am`, `F`
 * and every other template holding C at the same top score, margin exactly
 * 0; a bare perfect-fifth dyad (root + fifth, no third) ties three different
 * triads/sus4 at once the same way, also margin 0 - correctly unresolved,
 * since a fifth alone cannot tell major from minor. Because the "other" stem
 * carries melody as well as chords, a monophonic melodic passage with no
 * harmonic accompaniment at all used to acquire an invented chord this way -
 * a probe turned one sustained C4 into a four-bar `C` reading.
 *
 * The margin this beat needs to clear is `NOTE_MARGIN_THRESHOLD`
 * (0.0001), not `transcribeHarmony`'s own `MARGIN_THRESHOLD` (0.03) -
 * measured, not assumed, to be the right size for this pathway specifically:
 * a genuine three-or-four-note chord scores a clean, isolated best (a plain
 * root-third-fifth triad measures margin 0.134 against its nearest rival, a
 * shared seventh-chord superset), which is the same order of magnitude
 * `MARGIN_THRESHOLD` was calibrated against on FFT-derived chroma - but
 * reusing that constant directly, measured against the same real reference
 * track's own note-derived chords, cost far more than it should have:
 * scoreable bars fell from 71 to 34 (52%) while root-match among survivors
 * did not improve (55/71, 77.5%, before; 24/34, 70.6%, after) - real,
 * messier note data (overlapping instruments, passing tones, sustained
 * notes crossing a beat boundary) routinely produces a genuine 3-4-pitch-
 * class beat whose margin sits well under 0.03 without being remotely
 * ambiguous the way a bare tie is. `NOTE_MARGIN_THRESHOLD`'s own doc comment
 * has the measurement that replaced it: a clean, real gap between exact ties
 * (0) and every other beat's margin (>= 0.00059) that this pathway's own
 * discrete pitch-class evidence actually produces, which the continuous,
 * noise-floored FFT case `MARGIN_THRESHOLD` was built for does not have.
 * `MIN_CONFIDENT_BARS` (bars, not raw beats) is reused as-is: the question
 * it answers ("is one confident bar enough to trust, or could that be a
 * fluke") does not change with where the pitch-class vector came from.
 *
 * What `NOTE_MARGIN_THRESHOLD` (0.0001) actually costs, on the same
 * measurement: scoreable bars 71 -> 69, root-match 55/71 (77.5%) -> 53/69
 * (76.8%), exact-match 47/71 (66.2%) -> 45/69 (65.2%) - the two bars it
 * removes are the real reference track's own instances of the exact-tie
 * shape this gate exists to reject, and accuracy among what remains is
 * unchanged within measurement noise. Eliminating the demonstrated
 * false-positive (a monophonic passage acquiring an invented chord) costs
 * close to nothing real, which is the outcome a correctly-sized gate should
 * produce and `MARGIN_THRESHOLD` borrowed wholesale did not.
 */
export function transcribeHarmonyFromNotes(notes, grid, sections, { key = null } = {}) {
  const beatsPerBar = grid.beatsPerBar
  const inKey = diatonicTemplates(key)

  return sections.map((section) => {
    const fromBeat = section.startBar * beatsPerBar
    const toBeat = (section.startBar + section.bars) * beatsPerBar
    const vectors = beatNotePitchClasses(notes, grid, fromBeat, toBeat)
    const rows = vectors.map((vector) => scoreChroma(vector))
    const path = smoothChordPath(rows, { selfBonus: SELF_BONUS })
    const margins = beatMargins(rows)
    const confidentBeat = (i) => margins[i] >= NOTE_MARGIN_THRESHOLD

    const events = []
    let runStart = null
    let confidentBeats = 0
    const closeRun = (end) => {
      if (runStart === null) return
      const template = CHORD_TEMPLATES[path[runStart]]
      let score = 0
      for (let b = runStart; b < end; b++) score += rows[b][path[runStart]]
      score /= end - runStart
      events.push({
        // `runStart`/`end` are local beat indices within this section's own
        // `[fromBeat, toBeat)` window (index 0 is the section's first beat),
        // but `foldToLoop` expects an absolute step counted from the grid's
        // downbeat - the same convention `stepAt` produces and every other
        // transcriber's events already use. `section.startBar * beatsPerBar`
        // converts the section's own start back into that same absolute
        // frame before scaling to steps.
        step: (section.startBar * beatsPerBar + runStart) * STEPS_PER_BEAT,
        length: (end - runStart) * STEPS_PER_BEAT,
        velocity: 0.7,
        confidence: Math.max(0, Math.min(1, score)),
        midi: null,
        symbol: template.symbol,
        driftSteps: 0,
        templateIndex: template.index,
      })
      runStart = null
    }
    for (let i = 0; i < path.length; i++) {
      if (!confidentBeat(i)) {
        closeRun(i)
        continue
      }
      confidentBeats++
      if (runStart !== null && path[i] !== path[runStart]) closeRun(i)
      if (runStart === null) runStart = i
    }
    closeRun(path.length)
    if (!events.length || confidentBeats < MIN_CONFIDENT_BARS * beatsPerBar) return null

    const meanScore = events.reduce((sum, event) => sum + event.confidence, 0) / events.length

    // See `transcribeHarmony`'s own comment on why `oneEventPerStep` is not
    // needed here: `events` is one run per contiguous stretch of an unbroken
    // Viterbi path, built once per section, so its steps are already
    // strictly increasing before folding - the same guarantee holds
    // regardless of whether the path came from FFT chroma or note-derived
    // pitch classes.
    const folded = foldToLoop(
      events.map(({ templateIndex, ...event }) => event),
      section,
      grid,
    )
    if (folded.events.length === 0) return null

    const outOfKey = inKey.size
      ? events.filter((event) => !inKey.has(event.templateIndex)).length / events.length
      : 0

    return {
      loopBars: folded.loopBars,
      events: folded.events,
      confidence: meanScore * Math.max(folded.agreement, 0.25),
      outOfKey,
    }
  })
}
