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
import { CHROMA_FFT, fft, makeHann } from '../dsp.mjs'
import { bandEnergy, bandEnergyRise, bandNovelty } from './transcribe/bands.mjs'
import { DRUM_ROLES } from './transcribe/drums.mjs'
import { beatChroma } from './transcribe/harmony.mjs'
import { LAYERS, gridFromJson, sectionRange } from './transcribe/quantize.mjs'
import { RESYNTH_SAMPLE_RATE, renderSection } from './resynth.mjs'

/**
 * Calibrated 2026-07-29 from Task 11's Step 5 self-consistency probe: a
 * transcription scored against a synthesis of itself, so nothing in the fixture
 * can be wrong and the resulting score is each layer's ceiling. Not measured
 * against a recording - a real stem has bleed, timbre and background content a
 * synthetic fixture does not, so this is the best case, not a typical one.
 *
 * Measured ceiling: kick 1.000, snare 0.861, hats 0.998, bass 0.994, chords
 * 1.000. Each threshold is half its own layer's ceiling, rounded to two
 * decimals - half is the fraction that admits a layer more right than wrong.
 *
 * Per layer rather than one number per family, because snare's ceiling sits
 * well below the other drum roles': a kick's broadband splatter leaks into the
 * snare band regardless of transcription quality (see `detectorCurve` above),
 * so even a perfect snare transcription cannot correlate as tightly as kick or
 * hats can. A single `drums` threshold set from kick and hats would reject
 * correct snares; snare is calibrated against its own ceiling instead.
 *
 * `lead` has no entry: that transcriber is disabled (see melody.mjs) and never
 * reaches this check, so there is no ceiling to calibrate it against.
 *
 * These numbers rest on one synthetic fixture, calibrated to one real track
 * (the-chase) for the round trip that exercises them - the same n=1 limitation
 * the beat grid carries.
 *
 * Consequence measured on the-chase, worth flagging rather than burying: kick
 * and snare score near 0 on nearly every section of *real* audio, at any
 * threshold below their ceiling - not because the transcription is wrong (the
 * pre-hearing-check kick transcription hits 288/302 true onsets, and its stem
 * slices peak within 4 analysis hops, ~46ms, of the real recording's own
 * energy peaks) but because `detectorCurve`'s `bandEnergyRise` is far sparser
 * for a resynthesised decaying tone than for a real drum's messier, bleed-
 * carrying decay: correlating the two *rise* curves lands near 0 even where
 * correlating the underlying (non-derivative) `bandEnergy` curves lands
 * around 0.5. Task 11's self-consistency ceiling can't expose this because
 * both sides of that probe are the same synthetic curve. Raising or lowering
 * `HEARING_THRESHOLDS.kick`/`.snare` cannot fix it - the scores cluster at the
 * bottom of the range regardless of threshold - so this is left as a known
 * limitation for whoever next touches `detectorCurve` or the drum voices in
 * resynth.mjs, not patched here.
 */
export const HEARING_THRESHOLDS = {
  kick: 0.5,
  snare: 0.43,
  hats: 0.5,
  bass: 0.5,
  chords: 0.5,
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
 *
 * Values below the role's own floor are zeroed before the curves are compared.
 * That floor is the same one `detectDrumHits` calibrates onset-picking against
 * - not `pickBandOnsets`'s flux-tuned default - and it exists to say "this
 * level is indistinguishable from noise for this band," which is exactly the
 * content a raw correlation should not be allowed to line up on by chance.
 */
function detectorCurve(samples, role) {
  const audio = asAudio(samples)
  const raw = role.detector === 'energyRise' ? bandEnergyRise(bandEnergy(audio, role)) : bandNovelty(audio, role)
  if (!raw || role.floor == null) return raw
  const gated = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) gated[i] = raw[i] >= role.floor ? raw[i] : 0
  return gated
}

/**
 * How well a rendered layer matches the stem it came from.
 *
 * Pitched layers compare chroma, because chroma is invariant to the things
 * resynthesis gets wrong on purpose - timbre, voicing, octave register of the
 * synthesis voice - and sensitive to the thing that matters, which is which
 * notes are sounding. Chroma alone cannot see an octave error, so single-voice
 * pitched layers (not chords - `.voicing()` chooses its own register by
 * design) also carry a register term: the spectral centroid moves with the
 * octave even though chroma does not, and getting the octave right is #42's
 * headline criterion.
 *
 * Drums compare the shape of the role's own detection curve rather than pitch,
 * because a drum layer has no pitch content and what we want to know is
 * whether hits land where we said they do and how the attack/decay envelope
 * they produce compares - a zero-lag correlation of that curve is sensitive to
 * timing (a hit that moved is a curve that no longer lines up) without being
 * an all-or-nothing count of discrete onsets, which a same-band bleed from a
 * louder neighbouring role (a kick's broadband splatter reaching into the
 * snare band, for instance - see drums.mjs's own `suppressKickBleed`) would
 * otherwise punish as if every bit of bleed were a missing or spurious hit.
 */
export function scoreLayer(rendered, stemSlice, layer, grid) {
  const hasSignal = (buffer) => buffer.some((sample) => sample !== 0)
  if (!hasSignal(rendered) || !hasSignal(stemSlice)) return 0

  const role = DRUM_ROLES.find((candidate) => candidate.name === layer)
  if (role) {
    const a = detectorCurve(rendered, role)
    const b = detectorCurve(stemSlice, role)
    return correlate(a, b)
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

function spectralCentroid(samples, fftSize = CHROMA_FFT) {
  if (samples.length < fftSize) return 0
  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const bins = fftSize / 2
  const binHz = RESYNTH_SAMPLE_RATE / fftSize
  const hops = Math.max(1, Math.floor((samples.length - fftSize) / fftSize))
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
    const { layers: rendered } = renderSection(section, grid)
    const range = sectionRange(grid, section)
    const layers = {}

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

/** Zero-lag normalised cross-correlation, clamped to 0..1. `null` (too short
 *  to analyse) counts as no agreement rather than throwing. */
function correlate(a, b) {
  if (!a || !b) return 0
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > 0 ? Math.max(0, num / den) : 0
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
