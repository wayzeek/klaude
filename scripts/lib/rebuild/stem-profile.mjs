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
 */

import { BANDS, analyzeWavBuffer } from '../../analyze.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty, pickOnsets } from '../dsp.mjs'
import { bandEnergy, bandEnergyRise, pickBandOnsets } from './transcribe/bands.mjs'
import { DRUM_ROLES } from './transcribe/drums.mjs'

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
