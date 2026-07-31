/**
 * Did we hear it right?
 *
 * Comparing emitted code against the transcription only proves the emitter did
 * its job. If the transcriber hears C sharp where the record plays C, the
 * emitted C sharp matches the transcription perfectly and scores clean. A
 * self-consistency check is not an accuracy check, and for a clone the
 * transcription is exactly where accuracy matters.
 *
 * So: synthesize the transcription (Task 10), and compare that synthesis to the
 * stem it was derived from. Chroma for the pitched layers, onset agreement for
 * the drums. Pure math over buffers, no Strudel and no browser, which is what
 * makes this genuinely free.
 *
 * What this cannot do: the comparison is always against the stem in the role's
 * own frequency band, so content that genuinely sits in that band but belongs
 * to a different instrument scores as a match. This catches a wrong note (or a
 * wrong hit position) against the right source; it cannot catch a right-sounding
 * part transcribed from the wrong source entirely. Snare is a deliberate
 * example, not an exception: it legitimately absorbs rim and stick content
 * living in its band (see drums.mjs), and scoring well against that is correct,
 * not a false pass.
 *
 * It can tell you a layer is wrong. It cannot fix one: the remedy is to retry
 * with different parameters, then omit.
 */

import { decodeWav } from '../decoded-audio.mjs'
import { CHROMA_FFT, ONSET_HOP, fft, makeHann } from '../dsp.mjs'
import { bandEnergy, bandEnergyRise, bandNovelty, pickBandOnsets } from './transcribe/bands.mjs'
import { BASS_RANGE, SUB_BASS_MAX_MIDI } from './transcribe/bass.mjs'
import { DRUM_ROLES } from './transcribe/drums.mjs'
import { midiToHz, trackF0 } from './transcribe/f0.mjs'
import { beatChroma } from './transcribe/harmony.mjs'
import { LAYERS, gridFromJson, sectionRange } from './transcribe/quantize.mjs'
import { RESYNTH_SAMPLE_RATE, renderSection } from './resynth.mjs'

/**
 * Recalibrated across two rounds on 2026-07-29, each correcting a wrong
 * measurement basis in the previous one. The first calibration set every
 * threshold at half of Task 11's *self-consistency* ceiling (a transcription
 * scored against a synthesis of itself, so nothing could be wrong) - that
 * dropped kick and snare from nearly every the-chase section regardless of
 * accuracy, fixed by moving drum scoring to `onsetAgreement`. That fix was
 * declared done without asking the same question of bass and chords, which
 * is the mistake this second round corrects: bass's chroma-based comparison
 * turned out to be just as broken as the drums' curve-correlation had been,
 * for an unrelated reason, and a review reproduced hats scoring a corrupted
 * section as ~correct because the first hats corruption test was itself
 * flawed (see below). Every number here is a known-good transcription (a
 * loop built from the-chase's ground-truth event list, not from the
 * transcriber's own output) scored against the *real* stem, then corrupted
 * and rescored, on every the-chase section with true content for that layer.
 *
 * **Bass moved off chroma entirely** (see `bassAgreement`'s comment): chroma
 * excludes everything below 80 Hz, and this track's bass roots (MIDI 24-41,
 * 32.7-87.3 Hz) sit mostly below that floor, so chroma was scoring harmonics
 * that don't reliably track the true note - a single wrong note held across
 * an entire section scored *higher* (0.510) than a correct transcription
 * (0.322 mean). Bass now compares F0 pitch directly via `trackF0`, the same
 * machinery `transcribeBass` already uses and for the same documented reason
 * (f0.mjs's own module comment already said chroma can't do this). Correct
 * scores 0.530 across 11 sections; every corruption tried (semitone, tritone,
 * octave, a fixed wrong pattern, a held drone) scores 0.000-0.056 - the
 * gap is real and large, unlike chroma's.
 *
 * **Hats' apparent "cannot discriminate a half-dropped pattern" finding did
 * not reproduce, and the reason matters as much as the correction.** The
 * ground-truth hi-hat loop was built from the-chase's `hh`/`oh` event list
 * without deduplicating first; 467 of 575 real hi-hat positions have a
 * near-duplicate entry at the exact same bar/step (two overlapping hi-hat
 * voices in the source track), so filtering "every other array index"
 * mostly dropped redundant copies rather than distinct onsets and understated
 * the corruption (0.764 vs a 0.774 ceiling). Deduplicating first and testing
 * three independently-shaped half-drops gives a real gap: correct 0.774,
 * half-dropped 0.551-0.560 depending on which half. The corrected threshold
 * (0.67) still lets roughly one in seven half-dropped sections through where
 * the old one (0.51) let five of seven through - a real improvement, not a
 * full fix; see the disclosed limit below.
 *
 * **Chords keep chroma** - it measures real signal against real stems (0.817
 * mean correct, a tritone transposition falls to 0.349, cleanly separable)
 * - but a same-key wrong chord (the track's own tonic substituted throughout)
 * is only partly caught (0.685 mean, overlapping the correct range at the
 * tails). The threshold is set to catch the clean case; the same-key case is
 * a disclosed limit, not a fixed one.
 *
 * Thresholds are the midpoint between the correct mean and the worst
 * *discriminable* corruption's mean - proven per layer, not assumed as half
 * of any ceiling (half-of-ceiling was checked and would still pass the worst
 * corruption for every layer touched here):
 *   kick:   correct 0.805, worst (drop-half) 0.605 -> 0.70 (rounded down from
 *           the exact midpoint 0.705 - the-chase's own section 6 kick scores
 *           0.7089, and 0.71 would have dropped a real correct section)
 *   snare:  correct 0.637, worst (drop-half) 0.344 -> 0.49
 *   hats:   correct 0.774, worst (drop-half, deduplicated) 0.560 -> 0.67
 *   bass:   correct 1.0, worst discriminable *coverage* corruption (75% of
 *           notes dropped) 0.39 -> 0.45 (rounded up from the exact midpoint
 *           0.69 - see below for why the midpoint itself is not used)
 *   chords: correct 0.817, worst *discriminable* (tritone) 0.349 -> 0.58
 *
 * `bass`/`sub` were recalibrated (previously 0.29) once `bassAgreement`
 * started scoring voiced-frame coverage as well as pitch agreement (see that
 * function's own doc comment for why the old formula was blind to a
 * severely incomplete transcription). The pitch-only corruptions the
 * original 0.29 was calibrated against are unaffected by this - coverage
 * stays near 1 when only the pitch, not the timing, is wrong, so a synthetic
 * fixture with every note transposed a semitone still scores 0.011 and an
 * octave down still scores 0 - but the exact midpoint between an idealised
 * correct rendering (1.0) and the coverage corruption this pipeline is
 * actually being fixed to catch (a candidate rendering only one of four real
 * notes, 0.39) would be 0.69, well above the real reference track's own
 * *good* sections (0.74-0.93 measured on the-chase) only by luck of this one
 * corruption's exact severity - 0.45 is used instead, high enough to fail
 * the 75%-dropped case with room to spare and low enough not to threaten any
 * real section that scored above the old 0.29 by a wide margin. This does
 * cost real coverage: three the-chase `sub` sections that scored 0.33-0.35
 * under the old formula (already close to its own floor) now fail outright,
 * on top of the one (0.25) that already did - a real, measured drop in pass
 * rate, not a free fix. `bass` itself is unaffected in practice: its own
 * the-chase sections score 0.92-0.93 either way, since a genuinely present
 * bass line's coverage was already near-total.
 *
 * `lead` is deliberately not calibrated the same way, and that is a real gap,
 * not an oversight - stated plainly rather than dressed up as a threshold it
 * is not. `verifyHearing` falls back to `Infinity` for any layer missing from
 * this table (`thresholds[layer] ?? Infinity`), which makes `score >=
 * threshold` false unconditionally - the correct behaviour while
 * `transcribeMelody` emitted nothing (no `lead` loop, so this check was never
 * reached for it), and a silent trap the moment melody extraction was
 * enabled: every section that got a real lead would have failed this check
 * and been dropped regardless of quality, with nothing in the test suite
 * pointing at why, because no test exercised a non-null `lead` loop here. The
 * proper fix is the same corruption-calibrated measurement the other five
 * layers got (correct-mean vs worst-discriminable-corruption-mean), which
 * needs its own dedicated pass; that has not been done. `lead:
 * MIN_LEAD_SCORE` below is a placeholder chosen only to stop the `Infinity`
 * trap, not a calibrated quality bar. It is a small positive number, not 0:
 * `scoreLayer`'s own `hasSignal` check floors a genuinely silent comparison
 * at *exactly* 0, and `score >= threshold` with `threshold: 0` would let
 * that exact value through (0 >= 0) - the one degenerate case this table
 * exists to catch. `MIN_LEAD_SCORE` only needs to clear that single value;
 * it is not a quality bar and should not be read as accepting anything more
 * than "produced some real, non-zero agreement with the stem," which is
 * still a very low bar. Measured directly on the reference
 * track's real (post-salience) lead output: scores ranged 0.109-0.503 across
 * the nine emitting sections, and that range did not track the same
 * sections' ground-truth exact-MIDI accuracy - the two most accurate
 * sections (67% and 64% exact-MIDI) scored 0.298 and 0.270, both *lower*
 * than several 0%-accuracy sections (0.461, 0.468, 0.477, 0.503). Chroma/
 * register agreement against a stem that itself holds several other pitched
 * instruments is evidently a weak proxy for whether a monophonic line
 * extracted from it is the right one, which is exactly why this was not
 * pushed further into a threshold that would look calibrated without being
 * so.
 *
 * Honest limits, not smoothed over:
 * - Hats still cannot fully discriminate a half-dropped pattern even after
 *   the deduplication fix - the corrected gap (~0.21) is real but not large
 *   enough for a single threshold to reject every half-dropped section
 *   without also rejecting some correct ones; 0.67 accepts every correct
 *   section measured and roughly one in seven half-dropped sections still
 *   slips through.
 * - Chords do not reliably catch a same-key wrong chord (see above) - only a
 *   change of key or quality that moves the chroma vector further than that.
 * - Kick and hats both needed a "replace with an unrelated pattern" corruption
 *   distinct from swapping in another section's real pattern, because
 *   the-chase's own material (four-on-the-floor kick, dense regular hats) is
 *   similar enough section to section that swapping real patterns understates
 *   the corruption. Swap scores are still reported for transparency but did
 *   not set the threshold.
 * - None of these thresholds perfectly separate correct from corrupted at the
 *   individual-section level (e.g. kick: one dropped-half section scores
 *   0.815, above another section's correct 0.730). They separate the *means*
 *   with a real, measured margin - a single scalar threshold over noisy real
 *   audio cannot do better than that without also rejecting some correct
 *   sections, which is the trade this plan avoids on purpose.
 * - `bass`/`sub`'s new 0.45 does not reliably catch a HALF-dropped line
 *   either: a synthetic fixture with 2 of 4 notes rendered scores 0.65,
 *   comfortably above the threshold. It reliably catches 75%-dropped (0.39)
 *   and everything worse; a coverage gap smaller than that is a disclosed
 *   gap, the same shape as hats' half-dropped limit above, not a fixed one.
 *
 * These numbers rest on one real track (the-chase, the only recording with
 * exact ground truth) - the same n=1 limitation the beat grid carries.
 *
 * `sub` shares `bass`'s own threshold and mechanism (`scoreLayer` calls the
 * same `bassAgreement`, register-restricted to `sub`'s own half of
 * `BASS_RANGE` - see `SUB_TRACK_RANGE`) rather than being independently
 * corruption-calibrated: it is a register-filtered subset of the same
 * transcribed line (`bass.mjs`'s `splitByRegister`), and the coverage
 * corruption `bass`'s own threshold was calibrated against (notes dropped)
 * is exactly the failure mode `sub` needs the same protection from.
 */
/** See `HEARING_THRESHOLDS`'s own doc comment: this exists only to reject
 *  the exact `score === 0` degenerate case (`scoreLayer`'s `hasSignal`
 *  guard), not to set any real quality bar. `score >= threshold` with
 *  `threshold: 0` would otherwise let a literal zero-agreement lead through. */
const MIN_LEAD_SCORE = 0.001

export const HEARING_THRESHOLDS = {
  kick: 0.7,
  snare: 0.49,
  hats: 0.67,
  bass: 0.45,
  sub: 0.45,
  chords: 0.58,
  lead: MIN_LEAD_SCORE,
}

/** How much of a pitched layer's score its octave can cost. At 0.7 an octave
 *  error caps the layer near 0.7 of its harmonic (chroma) score, enough to push
 *  a borderline layer under threshold without failing a merely bright one. */
export const REGISTER_WEIGHT = 0.7

/** Which stem each layer was derived from. */
const LAYER_STEM = {
  kick: 'drums',
  snare: 'drums',
  hats: 'drums',
  bass: 'bass',
  sub: 'bass',
  chords: 'other',
  lead: 'other',
}

/** A mono slice of a decoded stem, resampled by nearest neighbour if its rate
 *  differs from the resynth rate. Stems come from ffmpeg at 44100, so the
 *  resample is a no-op in practice and exists so a mismatch is silent-safe
 *  rather than silently wrong. */
export function sliceAudio(audio, fromSec, toSec, sampleRate = RESYNTH_SAMPLE_RATE) {
  const frames = Math.max(0, Math.round((toSec - fromSec) * sampleRate))
  const out = new Float32Array(frames)
  const ratio = audio.sampleRate / sampleRate
  const base = fromSec * audio.sampleRate
  for (let i = 0; i < frames; i++) {
    const frame = Math.round(base + i * ratio)
    if (frame < 0 || frame >= audio.numFrames) continue
    out[i] = audio.readMono(frame)
  }
  return out
}

/** Wrap a Float32Array as something `beatChroma` and the band helpers can read. */
function asAudio(samples, sampleRate = RESYNTH_SAMPLE_RATE) {
  return {
    channels: 1,
    sampleRate,
    numFrames: samples.length,
    duration: samples.length / sampleRate,
    float32: true,
    readSample: (frame) => samples[frame] ?? 0,
    readMono: (frame) => samples[frame] ?? 0,
  }
}

/**
 * A role's own detection curve: `bandEnergyRise` needs `bandEnergy` computed
 * first, `bandNovelty` (flux) stands alone. Mirrors the dispatch in drums.mjs's
 * own (unexported) `DETECTORS` map - duplicated rather than imported because
 * that map is private to the transcriber, but the rule it encodes ("each role
 * names its own detector, no hardcoded default") is exactly what the hearing
 * check has to honour too. Using flux for every role, the way a first draft of
 * this function did, over-triggers the kick band specifically: its decaying
 * tone thins out, flux's self-normalised denominator shrinks with it, and
 * ordinary jitter clears the floor for the whole tail (see bands.mjs).
 */
function detectorCurve(samples, role) {
  const audio = asAudio(samples)
  return role.detector === 'energyRise' ? bandEnergyRise(bandEnergy(audio, role)) : bandNovelty(audio, role)
}

/**
 * Where the role's own detection curve peaks - the same onset picker
 * `detectDrumHits` uses for real transcription, applied here to a rendered
 * buffer instead. `hopSeconds` has to be computed from `ONSET_HOP`, not
 * assumed, because `bandEnergy`/`bandEnergyRise` sample at that hop spacing
 * regardless of what sample rate the caller passed in.
 */
function detectorOnsets(samples, role, sampleRate) {
  const curve = detectorCurve(samples, role)
  return pickBandOnsets(curve, ONSET_HOP / sampleRate, { floor: role.floor }).map((onset) => onset.seconds)
}

/**
 * How far apart two onsets may sit and still count as the same hit. Coarser
 * than `MATCH_TOLERANCE_STEPS` in verify-emission.mjs (that compares two
 * already-quantised event lists; this compares raw analysis onsets, which
 * carry their own few-hop jitter before quantisation ever happens) and
 * coarser than the ~46ms gap measured directly between a real kick's energy
 * peak and its own true onset time on the-chase - wide enough to swallow that
 * kind of production/detection lag without also swallowing a genuine
 * quarter-step timing error.
 */
const ONSET_MATCH_TOLERANCE_SECONDS = 0.06

/**
 * F1 of onset agreement between two curves, matched within a time tolerance.
 *
 * Replaces a plain zero-lag correlation of the two curves (kept in git
 * history, not here - see the commit that introduced this), which measured
 * near zero for kick and snare against every real the-chase stem regardless
 * of transcription accuracy: a resynthesised decaying tone's rise curve is a
 * handful of tall, sparse spikes, while a real drum's rise curve - carrying
 * room tone, harmonic beating and same-band bleed from neighbouring roles -
 * is a much denser, more moderate scatter. Correlating those two shapes
 * directly measures how alike their *statistical texture* is, which a
 * synthetic voice can never match, rather than whether hits land in the same
 * place, which is the only thing this check is supposed to answer. Matching
 * onsets within a tolerance instead asks exactly that question and ignores
 * everything about the curves' shape in between.
 *
 * Measured directly against the-chase (probe script, not committed - see
 * verify-hearing's calibration comment on `HEARING_THRESHOLDS` for the
 * numbers): a known-good kick transcription (95% accurate against ground
 * truth) scores 0.805 by this method against the real drums stem, where the
 * old correlation scored 0.004. The same known-good transcription, shifted a
 * step, missing half its hits, or replaced with an unrelated pattern, scores
 * materially lower every time.
 */
function onsetAgreement(rendered, stemSlice, role, sampleRate) {
  const a = detectorOnsets(rendered, role, sampleRate)
  const b = detectorOnsets(stemSlice, role, sampleRate)
  if (!a.length || !b.length) return 0
  const usedB = new Set()
  let matched = 0
  for (const time of a) {
    let best = -1
    let bestDistance = Infinity
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue
      const distance = Math.abs(b[i] - time)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    if (best >= 0 && bestDistance <= ONSET_MATCH_TOLERANCE_SECONDS) {
      usedB.add(best)
      matched++
    }
  }
  const precision = matched / a.length
  const recall = matched / b.length
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
}

/** Bass F0 tracking window, matching `transcribeBass`'s own (unexported)
 *  `NOTE_WINDOW` - the same value for the same reason: at 44.1kHz a 30Hz
 *  fundamental (`BASS_RANGE.minHz`) needs a window at least twice its
 *  ~1470-sample period to find a full cycle. */
const BASS_F0_WINDOW = 3200

/**
 * `bass` and `sub` are register-filtered subsets of one transcribed line
 * (`bass.mjs`'s `splitByRegister`, boundary `SUB_BASS_MAX_MIDI`), but both
 * are scored against the SAME raw "bass" stem - Demucs separates by
 * instrument source, not by register, so that one stem genuinely carries
 * both. Tracking F0 across the whole of `BASS_RANGE` for either layer lets
 * the OTHER layer's real content register as "voiced" in the stem at times
 * this layer never claims to sound, which `bassCoverage` below would then
 * count as a missed note that was never this layer's to cover in the first
 * place - measured directly: a section with a genuinely correct bass AND
 * sub scored the bass layer at 0.16 with the whole-range tracker, purely
 * because the sub's own real notes (a different register, same stem) were
 * not covered by the bass rendering. Splitting the tracked range at the same
 * boundary `splitByRegister` already used to build the two layers removes
 * the cross-contamination at the source: each layer's coverage is judged
 * only against the slice of the stem it could ever have explained.
 */
const SUB_TRACK_RANGE = Object.freeze({ minHz: BASS_RANGE.minHz, maxHz: midiToHz(SUB_BASS_MAX_MIDI) })
const MID_BASS_TRACK_RANGE = Object.freeze({ minHz: midiToHz(SUB_BASS_MAX_MIDI), maxHz: BASS_RANGE.maxHz })

/** How close two F0 estimates may sit, in semitones, and still count as the
 *  same note - wide enough for ordinary YIN jitter, narrow enough that a
 *  genuine semitone error still fails. */
const BASS_PITCH_TOLERANCE_SEMITONES = 0.5

/**
 * Of the frames where both sides happen to be voiced, the fraction that also
 * agree on pitch - full pitch, not pitch class, so an octave error costs the
 * same as any other wrong note.
 *
 * Deliberately blind to whether both sides are voiced at the SAME rate at
 * all - `bassCoverage` below answers that question. A rendering missing most
 * of the real line still gets full credit here on whatever little it does
 * share with the stem, which is correct for this function's narrow job (of
 * the notes both sides agree exist, are they the same note) and exactly why
 * `bassAgreement` must never use this alone - see its own doc comment.
 */
function bassPitchAgreement(a, b, n) {
  let voicedBoth = 0
  let agree = 0
  for (let i = 0; i < n; i++) {
    if (!a[i].voiced || !b[i].voiced) continue
    voicedBoth++
    if (Math.abs(a[i].midi - b[i].midi) <= BASS_PITCH_TOLERANCE_SEMITONES) agree++
  }
  return voicedBoth > 0 ? agree / voicedBoth : 0
}

/**
 * F1 of voiced-frame coverage between the two signals, independent of
 * whether the pitch at those instants agrees.
 *
 * This is the term `bassAgreement` was missing entirely: dividing only by
 * jointly-voiced frames (`bassPitchAgreement`, on its own) discards every
 * frame where the stem has a real note and the rendering has nothing -
 * exactly the frames a severely incomplete transcription is missing.
 * Measured directly: a candidate rendering only one of a real four-note
 * bass line's notes scored 0.975 by the old formula alone (the one shared,
 * correctly-pitched note divided by itself) - far above the 0.29 pass
 * threshold, for a line missing three quarters of its real content. The
 * same shape `onsetAgreement` above already uses for drums (precision and
 * recall of matched instants, combined by harmonic mean) applies here
 * without change: "voiced" stands in for "an onset was detected."
 */
function bassCoverage(a, b, n) {
  let aVoiced = 0
  let bVoiced = 0
  let both = 0
  for (let i = 0; i < n; i++) {
    if (a[i].voiced) aVoiced++
    if (b[i].voiced) bVoiced++
    if (a[i].voiced && b[i].voiced) both++
  }
  const precision = aVoiced > 0 ? both / aVoiced : 0
  const recall = bVoiced > 0 ? both / bVoiced : 0
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
}

/**
 * How well a rendered bass/sub line matches the stem it came from - coverage
 * (are the same instants voiced at all) combined with pitch agreement (of
 * the ones that are, do they agree), multiplied together so a candidate must
 * clear both: missing most of the real line costs it through `bassCoverage`
 * even if every note it does render is pitched exactly right, and a
 * consistently wrong pitch costs it through `bassPitchAgreement` even if its
 * voicing timing is perfect.
 *
 * Bass-specific, and not a small tweak: chroma (used for chords and, if it
 * were ever enabled, lead) excludes everything below `CHROMA_MIN_HZ` (80 Hz,
 * see harmony.mjs), and this track's bass roots sit at MIDI 24-41 - 32.7 to
 * 87.3 Hz - so chroma was scoring mostly harmonics, never the fundamental.
 * Measured directly against the-chase: a known-good bass transcription (its
 * events built straight from ground truth, not from `transcribeBass`) scored
 * a 0.322 mean by chroma against the real bass stem, and a single wrong note
 * held across an entire section - the harshest corruption tried - scored
 * 0.510, *higher* than correct, because chroma had no reliable signal to
 * lose in the first place. `trackF0` reads the fundamental directly (bass.mjs
 * already relies on it for the same reason, per its own module comment,
 * which says as much about chroma and basslines explicitly).
 */
function bassAgreement(rendered, stemSlice, range = BASS_RANGE) {
  const a = trackF0(asAudio(rendered), { ...range, windowSize: BASS_F0_WINDOW }).frames
  const b = trackF0(asAudio(stemSlice), { ...range, windowSize: BASS_F0_WINDOW }).frames
  if (!a.length || !b.length) return 0
  const n = Math.min(a.length, b.length)
  return bassCoverage(a, b, n) * bassPitchAgreement(a, b, n)
}

/**
 * How well a rendered layer matches the stem it came from.
 *
 * Bass compares fundamental frequency directly (`bassAgreement`), not
 * chroma - see that function's comment for why chroma cannot work for a bass
 * line at all. Chords keep chroma: it discards voicing, inversion and octave
 * on purpose, which is correct for a `.voicing()`-chosen chord register, and
 * it measures real signal against real stems (0.82 mean correct, a tritone
 * transposition falls to 0.35) even though a same-key wrong chord is only
 * partly caught (see `HEARING_THRESHOLDS`'s comment).
 *
 * Drums compare onset timing rather than pitch, because a drum layer has no
 * pitch content and what we want to know is whether hits land where we said
 * they do. That used to mean a zero-lag correlation of the role's raw
 * detection curve; it does not any more (see `onsetAgreement`'s comment) -
 * correlating curve *shape* could not tell a 95%-accurate real kick
 * transcription from a wrong one, because a synthesised decaying tone's curve
 * and a real drum's curve never share enough texture to correlate well
 * regardless of whether the hits are in the right place. Matching discrete
 * onsets within a tolerance answers the actual question directly, and is
 * still tolerant of same-band bleed from a louder neighbouring role (a kick's
 * broadband splatter reaching into the snare band, for instance - see
 * drums.mjs's own `suppressKickBleed`): a bleed onset is one more unmatched
 * point in the stem's onset set, which costs recall gradually rather than
 * collapsing correlation outright.
 */
export function scoreLayer(rendered, stemSlice, layer, grid) {
  const hasSignal = (buffer) => buffer.some((sample) => sample !== 0)
  if (!hasSignal(rendered) || !hasSignal(stemSlice)) return 0

  const role = DRUM_ROLES.find((candidate) => candidate.name === layer)
  if (role) {
    return onsetAgreement(rendered, stemSlice, role, RESYNTH_SAMPLE_RATE)
  }

  // `sub` is a register-filtered subset of the same transcribed bass line
  // (see `bass.mjs`'s `splitByRegister`), scored against the same stem
  // (`LAYER_STEM.sub`) by the same F0 mechanism - chroma is wrong for it for
  // exactly the reason `bassAgreement`'s own comment gives for `bass`, more
  // so: `sub` sits even further below chroma's 80 Hz floor. Each is tracked
  // only across its own half of `BASS_RANGE` (see `SUB_TRACK_RANGE`/
  // `MID_BASS_TRACK_RANGE`'s own doc comment) so the other's real content,
  // sharing the same physical stem, cannot register as a note this layer
  // was supposed to cover.
  if (layer === 'bass' || layer === 'sub') {
    return bassAgreement(rendered, stemSlice, layer === 'sub' ? SUB_TRACK_RANGE : MID_BASS_TRACK_RANGE)
  }

  // A grid anchored at zero, because both buffers start at the section's
  // downbeat rather than the track's.
  const localGrid = gridFromJson({
    bpm: grid.bpm,
    beatSeconds: grid.beatSeconds,
    barSeconds: grid.barSeconds,
    beatsPerBar: grid.beatsPerBar,
    downbeatSeconds: 0,
  })
  const a = beatChroma(asAudio(rendered), localGrid).vectors
  const b = beatChroma(asAudio(stemSlice), localGrid).vectors
  if (!a.length || !b.length) return 0

  // A beat where both vectors are silent (no chroma energy at all) carries no
  // harmonic information - a bass note lasting 4 of 16 steps is legitimately
  // silent the rest of the bar, in both the rendering and the stem it came
  // from, and that agreement is not what this term measures. Counting it as a
  // mismatch (cosine's zero-norm fallback) would punish a correctly silent gap
  // exactly as hard as a wrong note; counted beats are only those where at
  // least one side has something sounding.
  const beats = Math.min(a.length, b.length)
  let total = 0
  let counted = 0
  for (let beat = 0; beat < beats; beat++) {
    if (isSilent(a[beat]) && isSilent(b[beat])) continue
    total += cosine(a[beat], b[beat])
    counted++
  }
  const harmonic = counted > 0 ? Math.max(0, total / counted) : 1

  if (layer === 'chords') return harmonic
  const register = centroidAgreement(rendered, stemSlice)
  return harmonic * (REGISTER_WEIGHT + (1 - REGISTER_WEIGHT) * register)
}

/** 1 when two buffers share a spectral centre of mass, falling off with the
 *  log-frequency distance between them - an octave apart scores 0. */
function centroidAgreement(a, b) {
  const centroidA = spectralCentroid(a)
  const centroidB = spectralCentroid(b)
  if (!centroidA || !centroidB) return 1
  const octaves = Math.abs(Math.log2(centroidA / centroidB))
  return Math.max(0, 1 - octaves)
}

export function spectralCentroid(samples, fftSize = CHROMA_FFT) {
  if (samples.length < fftSize) return 0
  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const bins = fftSize / 2
  const binHz = RESYNTH_SAMPLE_RATE / fftSize
  // The number of whole, non-overlapping `fftSize` blocks that fit in
  // `samples` - hop 0 through `floor((length - fftSize) / fftSize)`
  // inclusive, hence the `+ 1`. Dropping it (as a previous version did)
  // silently discards the last full block: at exactly two blocks
  // (`samples.length === 2 * fftSize`), `floor((2*fftSize - fftSize) /
  // fftSize)` is 1, so only hop 0 ran and hop 1 - a second, fully valid,
  // fftSize-sized block - was never measured. `beatChroma` in dsp.mjs
  // computes the equivalent count with the same `+ 1` already; this brings
  // the two in line.
  const hops = Math.max(1, Math.floor((samples.length - fftSize) / fftSize) + 1)
  let weighted = 0
  let total = 0
  for (let hop = 0; hop < hops; hop++) {
    const start = hop * fftSize
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      weighted += magnitude * bin * binHz
      total += magnitude
    }
  }
  return total > 0 ? weighted / total : 0
}

/**
 * Per section, per layer.
 *
 * `stemBuffers` is `{ drums, bass, other }`, each a WAV buffer. A layer the
 * transcription omitted reports `null` rather than a zero score: there is a
 * difference between "we heard nothing" and "we heard it wrong," and collapsing
 * them would make the overall score punish correct omissions - the `lead`
 * layer is disabled by default (see resynth.mjs) for exactly this reason.
 */
export function verifyHearing(transcription, stemBuffers, { thresholds = HEARING_THRESHOLDS } = {}) {
  const grid = gridFromJson(transcription.grid)
  const stems = {}
  for (const [name, buffer] of Object.entries(stemBuffers)) stems[name] = decodeWav(buffer)

  const sections = []
  const allScores = []

  for (const section of transcription.sections) {
    const range = sectionRange(grid, section)
    const layers = {}

    // Only render what this section can actually be scored against: a layer
    // with no loop, or one whose stem never arrived, is marked `null` below
    // without ever touching `rendered` - so rendering it here would allocate
    // a full-length buffer this function never reads. See `renderSection`'s
    // own doc comment for the memory cost of rendering all seven regardless
    // (plus an unused mix) that this exists to avoid.
    const neededLayers = LAYERS.filter((layer) => section.loops?.[layer] && stems[LAYER_STEM[layer]])
    const { layers: rendered } = renderSection(section, grid, { layers: neededLayers, mix: false })

    for (const layer of LAYERS) {
      if (!section.loops?.[layer]) {
        layers[layer] = null
        continue
      }
      const stem = stems[LAYER_STEM[layer]]
      if (!stem) {
        layers[layer] = null
        continue
      }
      const slice = sliceAudio(stem, range.fromSec, range.toSec)
      const score = scoreLayer(rendered[layer], slice, layer, grid)
      const threshold = thresholds[layer] ?? Infinity
      layers[layer] = { score, pass: score >= threshold }
      allScores.push(score)
    }
    sections.push({ index: section.index, layers })
  }

  return {
    sections,
    overall: allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0,
  }
}

/** A chroma vector `beatChroma` never normalised because it found nothing in
 *  the pitch band during that beat - `beatChroma` leaves it as all zeros
 *  rather than a unit vector, so a plain norm check is the correct test. */
function isSilent(vector) {
  return vector.every((value) => value === 0)
}

function cosine(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const den = Math.sqrt(normA * normB)
  return den > 0 ? dot / den : 0
}
