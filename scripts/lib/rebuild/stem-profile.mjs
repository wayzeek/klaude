/**
 * What a stem actually sounds like, measured.
 *
 * `profile.mjs` measures the finished mix against `analyze.mjs`'s six-band
 * balance, so the reference has a number for "is this dark" or "is this
 * wide." Nothing before this module ever asked the same question of the
 * *stems* - and the stems are the honest comparison, because moltek's own
 * render is one dry sound per layer. Comparing our render to the mix
 * conflates every instrument at once; comparing it to the stem it actually
 * replaces isolates exactly the delta that render is missing.
 *
 * Three things per stem, all reused rather than reimplemented:
 *  - band balance and stereo width, straight from `analyzeWavBuffer` (same
 *    FFT, same `BANDS`, same correlation `profile.mjs` already trusts);
 *  - a decay/space estimate: onset-aligned envelope tails, built on
 *    `dsp.mjs`'s FFT and `transcribe/bands.mjs`'s onset picker, never a new
 *    FFT of its own.
 *
 * `profileDrumRoles` goes one step further for the drums stem specifically,
 * reusing `drums.mjs`'s own `DRUM_ROLES` (band + detector + floor, already
 * calibrated against real material) to get a kick/snare/hats decay each,
 * rather than one number blending all three. That is what makes "the
 * record's kick is boomier than our dry 909" a measurable claim instead of a
 * guess: the kick band's own tail, isolated the same way `drums.mjs` already
 * isolates it for transcription.
 *
 * `profileOnsetTimbre` goes a different direction from the same machinery:
 * not "how does this whole stem sit in the mix" but "what does the source
 * actually sound like at the specific instants a melodic line plays" - the
 * measurement `voice-select.mjs` uses to stop hardcoding a lead instrument
 * that only matches one reference track. See its own doc comment for why
 * that has to be onset-aligned rather than a read of the whole stem.
 */

import { BANDS, analyzeWavBuffer } from '../../analyze.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty, fft, makeHann, pickOnsets } from '../dsp.mjs'
import { bandEnergy, bandEnergyRise, pickBandOnsets } from './transcribe/bands.mjs'
import { DRUM_ROLES } from './transcribe/drums.mjs'
import { LEAD_RANGE } from './transcribe/melody.mjs'

/** How far below an onset's own peak the envelope may fall and still count as
 *  "still ringing." A dry hit clears this in tens of ms; a reverbed one takes
 *  hundreds - see the module doc comment on the report this feeds. */
const TAIL_FLOOR_DB = -30
/** How far past an onset to look for its tail. Long enough for a genuinely
 *  wet room tone, short enough that a busy passage's next hit does not get
 *  borrowed as if it were this one's own decay (see the next-onset clamp
 *  below, which usually cuts this shorter anyway). */
const DECAY_WINDOW_SECONDS = 0.5
/** The attack may take a hop or two to reach full level; searching a few hops
 *  past the onset for the peak avoids normalising against a pre-attack
 *  sample and understating the true peak. */
const PEAK_SEARCH_HOPS = 4
/** Fewer onsets than this and a mean decay is noise, not a measurement. */
const MIN_DECAY_ONSETS = 3

/**
 * Mean "-30dB tail length" across a set of onsets, in seconds.
 *
 * `energy` is a linear-magnitude envelope sampled every `hopSeconds` (from
 * `bandEnergy` or equivalent); `onsetsSeconds` are onset times in the same
 * units. Each onset's window is capped at the next onset (or the buffer's
 * end), so a dense passage never lets one hit's tail run into the next hit's
 * own attack and get measured as ring rather than a fresh onset.
 *
 * Returns `{ seconds: null, count }` rather than guessing when there are too
 * few onsets to trust - `count` is always the number actually used, so a
 * caller can report exactly why nothing was measured.
 */
export function decayFromEnvelope(energy, onsetsSeconds, hopSeconds, { floorDb = TAIL_FLOOR_DB, windowSeconds = DECAY_WINDOW_SECONDS } = {}) {
  if (!energy || !onsetsSeconds?.length || !(hopSeconds > 0)) return { seconds: null, count: 0 }
  const windowHops = Math.max(1, Math.round(windowSeconds / hopSeconds))
  const tails = []

  for (let i = 0; i < onsetsSeconds.length; i++) {
    const onsetHop = Math.round(onsetsSeconds[i] / hopSeconds)
    if (onsetHop < 0 || onsetHop >= energy.length) continue
    const nextOnsetHop = i + 1 < onsetsSeconds.length ? Math.round(onsetsSeconds[i + 1] / hopSeconds) : Infinity
    const end = Math.min(energy.length, onsetHop + windowHops, nextOnsetHop)
    if (end <= onsetHop + 1) continue

    let peak = 0
    const peakSearchEnd = Math.min(end, onsetHop + PEAK_SEARCH_HOPS)
    for (let h = onsetHop; h < peakSearchEnd; h++) peak = Math.max(peak, energy[h] ?? 0)
    if (peak <= 0) continue

    const floorLinear = peak * Math.pow(10, floorDb / 20)
    let lastAbove = onsetHop
    for (let h = onsetHop; h < end; h++) {
      if ((energy[h] ?? 0) >= floorLinear) lastAbove = h
    }
    tails.push((lastAbove - onsetHop) * hopSeconds)
  }

  if (tails.length < MIN_DECAY_ONSETS) return { seconds: null, count: tails.length }
  const seconds = tails.reduce((a, b) => a + b, 0) / tails.length
  return { seconds, count: tails.length }
}

/**
 * Mean time from an onset to its own envelope peak, in seconds - the rise
 * `decayFromEnvelope` above does not measure, walked with the identical
 * onset-window idiom (clamp to the next onset so a busy passage never lets
 * one note's rise borrow into the next note's own attack) but forwards: the
 * peak search runs across the whole clamped window rather than
 * `decayFromEnvelope`'s own `PEAK_SEARCH_HOPS`, which is sized for a drum hit
 * that always crests within tens of milliseconds and would silently ceiling
 * out a genuinely slow pad's rise at that same few-hop limit.
 *
 * Same `{ seconds: null, count }` shape as `decayFromEnvelope`, for the same
 * reason: too few onsets is noise, not a measurement, and a caller needs to
 * say why nothing was reported.
 */
export function attackFromEnvelope(energy, onsetsSeconds, hopSeconds, { windowSeconds = DECAY_WINDOW_SECONDS } = {}) {
  if (!energy || !onsetsSeconds?.length || !(hopSeconds > 0)) return { seconds: null, count: 0 }
  const windowHops = Math.max(1, Math.round(windowSeconds / hopSeconds))
  const rises = []

  for (let i = 0; i < onsetsSeconds.length; i++) {
    const onsetHop = Math.round(onsetsSeconds[i] / hopSeconds)
    if (onsetHop < 0 || onsetHop >= energy.length) continue
    const nextOnsetHop = i + 1 < onsetsSeconds.length ? Math.round(onsetsSeconds[i + 1] / hopSeconds) : Infinity
    const end = Math.min(energy.length, onsetHop + windowHops, nextOnsetHop)
    if (end <= onsetHop + 1) continue

    let peak = 0
    let peakHop = onsetHop
    for (let h = onsetHop; h < end; h++) {
      const value = energy[h] ?? 0
      if (value > peak) {
        peak = value
        peakHop = h
      }
    }
    if (peak <= 0) continue
    rises.push((peakHop - onsetHop) * hopSeconds)
  }

  if (rises.length < MIN_DECAY_ONSETS) return { seconds: null, count: rises.length }
  const seconds = rises.reduce((a, b) => a + b, 0) / rises.length
  return { seconds, count: rises.length }
}

/** Broadband decay estimate for a whole stem: envelope and onsets both cover
 *  the full audible range `BANDS` spans, reusing `bandEnergy` for the
 *  envelope (so no new FFT is written) and `dsp.mjs`'s own onset picker
 *  (already tuned generically, not per-band) for where to measure from. */
function stemDecay(audio) {
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const lo = BANDS[0].lo
  const hi = BANDS[BANDS.length - 1].hi
  const energy = bandEnergy(audio, { lo, hi })
  if (!energy) return { seconds: null, count: 0 }
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
  const onsets = novelty ? pickOnsets(novelty, hopSeconds) : []
  return decayFromEnvelope(energy, onsets, hopSeconds)
}

/**
 * Band balance, width and a broadband decay estimate for one stem.
 *
 * Band balance and width are `analyzeWavBuffer`'s own numbers, not
 * recomputed - the same reuse `profile.mjs` already relies on for the mix.
 */
export function profileStem(wavBuf) {
  const audio = decodeWav(wavBuf)
  const analysis = analyzeWavBuffer(wavBuf)
  return {
    duration: analysis.duration,
    channels: analysis.channels,
    loudness: {
      rmsDb: Number.isFinite(analysis.overallRmsDb) ? analysis.overallRmsDb : null,
      peakDb: Number.isFinite(analysis.peakDb) ? analysis.peakDb : null,
    },
    bands: {
      names: BANDS.map((band) => band.name),
      pct: analysis.bandPct,
      tiltDb: analysis.bandTiltDb.map((value) => (Number.isFinite(value) ? value : null)),
    },
    width: {
      correlation: analysis.avgCorr,
      confidence: analysis.channels === 2 && analysis.avgCorr !== null ? 1 : 0,
    },
    decay: stemDecay(audio),
  }
}

/**
 * Per-role decay for the drums stem: kick, snare and hats each isolated in
 * their own band, using exactly `drums.mjs`'s `DRUM_ROLES` - the same bands,
 * the same `bandEnergyRise` detector, the same calibrated floors - so a
 * role's measured tail is directly comparable to how `transcribeDrums`
 * itself hears that role, not a fresh, uncalibrated guess at where kick
 * energy lives.
 */
export function profileDrumRoles(wavBuf) {
  const audio = decodeWav(wavBuf)
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const roles = {}
  for (const role of DRUM_ROLES) {
    const energy = bandEnergy(audio, role)
    if (!energy) {
      roles[role.name] = { seconds: null, count: 0 }
      continue
    }
    const curve = bandEnergyRise(energy)
    const onsets = pickBandOnsets(curve, hopSeconds, { floor: role.floor }).map((onset) => onset.seconds)
    roles[role.name] = decayFromEnvelope(energy, onsets, hopSeconds)
  }
  return roles
}

/**
 * The full per-stem profile the sound-match stage consumes: `{ drums, bass,
 * other }`, each shaped like `profileStem`'s return, plus `drums.roles` for
 * the kick/snare/hats breakdown only the drums stem can support.
 *
 * `stemBuffers` matches `separate.mjs`'s `STEMS` naming (`drums`, `bass`,
 * `other`) - whatever keys it is given are profiled, so a caller missing a
 * stem (should not happen downstream of a real `separate()` call) simply
 * gets no entry for it rather than a thrown error.
 */
export function profileStems(stemBuffers) {
  const profile = {}
  for (const [stem, buf] of Object.entries(stemBuffers)) {
    if (!buf) continue
    profile[stem] = profileStem(buf)
  }
  if (profile.drums && stemBuffers.drums) {
    profile.drums = { ...profile.drums, roles: profileDrumRoles(stemBuffers.drums) }
  }
  return profile
}

// --- onset-aligned timbre (for voice-select.mjs) -------------------------------

/** FFT size for one onset-aligned spectrum frame - the same resolution every
 *  other per-hop measurement in this module already reads at (`bandEnergy`'s
 *  own default), so a caller comparing this against those numbers is
 *  comparing like for like. */
const TIMBRE_FFT_SIZE = 1024
/** How far past an onset to start the analysis window, so it captures the
 *  tone rather than the click of the attack transient itself landing at bin
 *  edges. */
const TIMBRE_ATTACK_SKIP_SECONDS = 0.04
/** Fewer onsets than this and an averaged spectrum is one or two notes'
 *  idiosyncrasies, not the instrument's timbre - same floor as
 *  `MIN_DECAY_ONSETS` above, restated for the same reason `sound-match.mjs`
 *  restates it: this module needs it to explain a `null` result to a human,
 *  not just to gate internally. */
const MIN_TIMBRE_ONSETS = 3
/** The fundamental region a `brightRatio` is measured against - matches
 *  `analyze.mjs`'s BANDS `mid` (400-2000Hz), the same band `sound-match.mjs`
 *  already treats as "the body of the note" for its own tone comparisons. */
const FUNDAMENTAL_LO_HZ = 400
const FUNDAMENTAL_HI_HZ = 2000
/** "Energy above ~3kHz relative to the fundamental region" - the brief's own
 *  number for what counts as harmonic richness. Capped at 8kHz rather than
 *  Nyquist so a source's noise floor and cymbal/hat bleed sitting in the
 *  `other` stem do not get counted as the lead's own harmonic content. */
const BRIGHT_LO_HZ = 3000
const BRIGHT_HI_HZ = 8000
/** The centroid's own analysis band: `LEAD_RANGE.minHz` at the bottom (the
 *  same floor `melody.mjs` already draws between the lead register and the
 *  bass), `BRIGHT_HI_HZ` at the top for the same noise-floor reason. */
const CENTROID_LO_HZ = LEAD_RANGE.minHz
const CENTROID_HI_HZ = BRIGHT_HI_HZ
/** `LEAD_RANGE` itself is shaped `{ minHz, maxHz }` for `melody.mjs`'s own
 *  callers (`trackF0`, `computeMelodyContour`); `bandEnergy` (bands.mjs)
 *  reads `{ lo, hi }` - `detectMelodySalience` remaps the equivalent
 *  `SALIENCE_RANGE` the same way when it calls `bandNovelty`, so this mirrors
 *  an existing, already-correct precedent rather than assuming the two
 *  shapes line up. */
const ATTACK_ENVELOPE_BAND = Object.freeze({ lo: LEAD_RANGE.minHz, hi: LEAD_RANGE.maxHz })
/** Harmonics considered for the odd/even balance, bounded below 90% of
 *  Nyquist regardless - a harmonic that close to the fold is aliasing noise,
 *  not signal. */
const MAX_HARMONIC = 8

/** One Hann-windowed magnitude spectrum, `TIMBRE_ATTACK_SKIP_SECONDS` past
 *  each usable onset - `readMono`/`fft`/`makeHann` are exactly what
 *  `bandNovelty`/`bandEnergy` in bands.mjs already build a per-hop version of;
 *  this is the same primitive at a single, onset-chosen instant instead of
 *  swept across the whole clip. Onsets too close to either end of the stem to
 *  fit a full window are skipped rather than padded, so a short clip
 *  legitimately reports fewer usable onsets instead of a padded, misleading
 *  spectrum. */
function onsetSpectra(audio, notedOnsets, fftSize) {
  const { numFrames, sampleRate, readMono } = audio
  const window = makeHann(fftSize)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const skipFrames = Math.round(TIMBRE_ATTACK_SKIP_SECONDS * sampleRate)
  const spectra = []

  for (const { seconds, midi } of notedOnsets) {
    const start = Math.round(seconds * sampleRate) + skipFrames
    if (start < 0 || start + fftSize > numFrames) continue
    for (let i = 0; i < fftSize; i++) {
      re[i] = readMono(start + i) * window[i]
      im[i] = 0
    }
    fft(re, im)
    const mags = new Float32Array(fftSize / 2)
    for (let bin = 0; bin < mags.length; bin++) mags[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    spectra.push({ mags, midi: Number.isFinite(midi) ? midi : null })
  }
  return spectra
}

/** Odd/even harmonic energy balance at each onset's own known fundamental -
 *  no pitch detection needed, since the caller already transcribed the note.
 *  Only onsets carrying a `midi` contribute; `null` (not zero) when fewer
 *  than `MIN_TIMBRE_ONSETS` do, the same "say why, don't guess" convention
 *  every other measurement in this module follows.
 *
 *  This is reported as a data point, not a decision input, for a reason
 *  worth stating plainly: a real instrument's odd/even skew is a property of
 *  its resonator's *shape* (a clarinet's cylindrical, closed-at-one-end bore
 *  suppresses even harmonics; a saxophone's conical one does not, and
 *  produces close to a full harmonic series). Nothing here can infer bore
 *  shape, so this cannot be read as "reedy" or "not reedy" - see
 *  `voice-select.mjs` for how it is actually used. */
function oddEvenRatio(spectra, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize
  const nyquist = sampleRate / 2
  const pitched = spectra.filter((s) => s.midi !== null)
  if (pitched.length < MIN_TIMBRE_ONSETS) return null

  let odd = 0
  let even = 0
  for (const { mags, midi } of pitched) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12)
    for (let harmonic = 1; harmonic <= MAX_HARMONIC; harmonic++) {
      const hz = f0 * harmonic
      if (hz >= nyquist * 0.9) break
      const bin = Math.round(hz / binHz)
      if (bin < 0 || bin >= mags.length) continue
      if (harmonic % 2 === 1) odd += mags[bin]
      else even += mags[bin]
    }
  }
  return even > 0 ? odd / even : null
}

/**
 * Timbre of the source material at specific note onsets, in one stem - not
 * the whole stem's broadband balance (`profileStem` above already measures
 * that, and `sound-match.mjs` already consumes it for tone/room/gain), but
 * only the instants a particular melodic line actually plays. That isolation
 * is the whole point: the `other` stem carries a chords bed sounding the
 * entire time a lead does, so a broadband read of the whole stem cannot tell
 * "the lead is bright" apart from "the pad underneath it is bright."
 *
 * `notedOnsets` is `[{ seconds, midi }]` - `midi` may be omitted or `null`
 * when the caller has no pitch for that onset; only `oddEvenRatio` needs it,
 * and degrades to `null` rather than throwing when none carry one.
 *
 * Four numbers, all built on primitives this module or `dsp.mjs` already has:
 *  - `centroidHz`/`brightRatio`: a long-term average spectrum (one magnitude
 *    spectrum per onset, `fft`/`makeHann` exactly as `bandNovelty`/
 *    `bandEnergy` already use them, averaged bin-for-bin) - averaging the
 *    spectra before reading either number off them is stabler against any
 *    one onset's own noise than averaging per-onset centroids would be.
 *  - `attack`: `bandEnergy` over `LEAD_RANGE` (the same register the lead
 *    itself is transcribed from) fed into `attackFromEnvelope` above.
 *  - `sustain`: the identical envelope fed into `decayFromEnvelope` instead -
 *    no new code, since "how long does a note ring" is exactly what that
 *    function already answers.
 *  - `oddEvenRatio`: see its own doc comment for why this is a data point,
 *    not a decision input.
 */
export function profileOnsetTimbre(wavBuf, notedOnsets, { fftSize = TIMBRE_FFT_SIZE } = {}) {
  const audio = decodeWav(wavBuf)
  const usable = (notedOnsets ?? []).filter((onset) => onset.seconds >= 0 && onset.seconds < audio.duration)

  const spectra = onsetSpectra(audio, usable, fftSize)
  let centroidHz = null
  let brightRatio = null
  if (spectra.length >= MIN_TIMBRE_ONSETS) {
    const bins = fftSize / 2
    const binHz = audio.sampleRate / fftSize
    const averaged = new Float64Array(bins)
    for (const { mags } of spectra) {
      for (let bin = 0; bin < bins; bin++) averaged[bin] += mags[bin]
    }

    const centroidLoBin = Math.max(1, Math.round(CENTROID_LO_HZ / binHz))
    const centroidHiBin = Math.min(bins - 1, Math.round(CENTROID_HI_HZ / binHz))
    let weighted = 0
    let total = 0
    for (let bin = centroidLoBin; bin <= centroidHiBin; bin++) {
      weighted += averaged[bin] * bin * binHz
      total += averaged[bin]
    }
    centroidHz = total > 0 ? weighted / total : null

    const fundFrom = Math.max(1, Math.round(FUNDAMENTAL_LO_HZ / binHz))
    const fundTo = Math.min(bins - 1, Math.round(FUNDAMENTAL_HI_HZ / binHz))
    const brightFrom = Math.max(1, Math.round(BRIGHT_LO_HZ / binHz))
    const brightTo = Math.min(bins - 1, Math.round(BRIGHT_HI_HZ / binHz))
    let fundEnergy = 0
    for (let bin = fundFrom; bin <= fundTo; bin++) fundEnergy += averaged[bin]
    let brightEnergy = 0
    for (let bin = brightFrom; bin <= brightTo; bin++) brightEnergy += averaged[bin]
    brightRatio = fundEnergy > 0 ? brightEnergy / fundEnergy : null
  }

  const hopSeconds = ONSET_HOP / audio.sampleRate
  const onsetSeconds = usable.map((onset) => onset.seconds)
  const envelope = bandEnergy(audio, ATTACK_ENVELOPE_BAND)
  const attack = envelope ? attackFromEnvelope(envelope, onsetSeconds, hopSeconds) : { seconds: null, count: 0 }
  const sustain = envelope ? decayFromEnvelope(envelope, onsetSeconds, hopSeconds) : { seconds: null, count: 0 }

  return {
    count: spectra.length,
    centroidHz,
    brightRatio,
    attack,
    sustain,
    oddEvenRatio: oddEvenRatio(spectra, audio.sampleRate, fftSize),
  }
}
