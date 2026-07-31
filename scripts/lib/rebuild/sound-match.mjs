/**
 * Measured stem deltas become Strudel effect parameters.
 *
 * `emit.mjs` writes every layer with a fixed, dry sound: a 909 kit, one
 * sawtooth bass, one epiano. That is a deliberate approximation (see its own
 * module comment) but it is also why a rebuilt track reads as "close but
 * flat" next to the record - the record's drums sit in a processed, spatial
 * mix, and nothing before this module ever looked at that.
 *
 * The method throughout is: measure the stem `stem-profile.mjs` already
 * built, compare it to what the dry palette implies (a documented default,
 * never a rendered guess - this pipeline cannot render real audio through
 * Strudel offline), and only emit a parameter when the comparison points in
 * one direction clearly enough to defend. A flat, unmeasured delta leaves
 * that parameter alone - a dry-but-honest layer beats a guessed wet one, per
 * this module's own brief.
 *
 * Four kinds of parameter, each with its own defensible measurement:
 *  - space (`.room`): the stem's onset-aligned decay tail, scaled into
 *    Strudel's 0-0.6 wet range. `profileDrumRoles` isolates kick, snare and
 *    hats separately; bass and the shared `other` stem (chords, lead) each
 *    get one broadband estimate.
 *  - tone (`.lpf`): spectral tilt (dB density relative to the stem's own
 *    loudest band, already in `stem-profile.mjs`'s output) compared between
 *    adjacent bands. A steep drop-off means the stem is measurably darker up
 *    there than the dry default assumes; a shallow one means brighter. This
 *    only ever moves lpf - hpf is left alone everywhere, because defending a
 *    change there needs a low-end baseline this pass does not have (see
 *    `deriveTrackEffects`'s per-layer comments for exactly what was skipped
 *    and why).
 *  - width (`.pan`): stereo correlation, already in the profile. A single
 *    static pan cannot recreate true decorrelated width, so this uses the
 *    established humanize idiom for a subtle spread (`.pan("0.35 0.65")`) -
 *    but only for kick/snare/hats, whose events are always exactly one step
 *    long (`drums.mjs` hardcodes `length: 1`). Measured directly (probe
 *    script, not committed): a sustained `note()`/`chord()` event whose span
 *    crosses the pan pattern's own half-cycle boundary is not panned, it is
 *    *duplicated* - Strudel's control-pattern join emits one hap per
 *    (note, pan-value) overlap rather than clipping the note to each
 *    segment, so a single 14-step lead note came back as two full-length
 *    haps, one per pan value, and a real render would sound it twice. A
 *    single-step drum hit can never straddle that boundary (its own span is
 *    far shorter than either half), so it is provably safe there and nowhere
 *    else this pipeline emits notes from. `.jux()` was considered and
 *    rejected for the same class of reason: it duplicates every hap into a
 *    reversed second copy regardless of note length, which would double
 *    event counts unconditionally and break `verify-emission.mjs`'s
 *    one-event-per-onset comparison. Bass, chords and lead keep their dry
 *    default pan - width was measured, but nothing safe to emit followed
 *    from it - and kick stays centered regardless, per standard practice;
 *    each layer's own stem correlation is recorded either way, to confirm
 *    (or flag) that call rather than silently assume it.
 *  - gain: a relative-loudness comparison against the drums stem (the
 *    reference is kick/snare/hats' default gains combined in quadrature, not
 *    kick alone - see `COMBINED_DRUM_GAIN`'s comment for why that matters),
 *    only ever trimming down, never past `SOUNDS`' own ceilings - "the
 *    loudest an event ever gets" is a hard line this module does not move.
 *    Only bass, chords and lead get this: kick/snare/hats share one blended
 *    "drums" stem measurement that cannot be attributed to one role alone.
 */

import { BANDS } from '../../analyze.mjs'
import { SOUNDS } from './emit.mjs'

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const round2 = (value) => Math.round(value * 100) / 100

// --- space --------------------------------------------------------------------

/** "A dry hit decays in tens of ms" - the module brief's own words, taken
 *  literally as the floor below which there is nothing to add space for. */
const DRY_TAIL_SECONDS = 0.05
/** "...a reverbed one in hundreds [of ms]" - where the room mapping saturates. */
const WET_TAIL_SECONDS = 0.45
const ROOM_MAX = 0.6
/** Matches `stem-profile.mjs`'s own `MIN_DECAY_ONSETS`; restated here because
 *  the two modules stay decoupled on purpose (see this file's own precedent
 *  in `verify-hearing.mjs`/`verify-emission.mjs` for duplicating rather than
 *  importing a private threshold), and because this is the number this
 *  module needs to explain a `null` decay to a human reader, not an
 *  implementation detail of how the envelope was walked. */
const MIN_DECAY_ONSETS = 3

/** Decay tail -> `.room()` amount, or null with the reason nothing was emitted. */
function roomFromDecay(decay, label) {
  if (!decay || decay.count < MIN_DECAY_ONSETS || decay.seconds == null) {
    return { room: null, note: `space left alone on ${label} - only ${decay?.count ?? 0} onset(s) measured, not enough to trust a decay estimate` }
  }
  if (decay.seconds <= DRY_TAIL_SECONDS) {
    return {
      room: null,
      note: `space left alone on ${label} - measured decay ${Math.round(decay.seconds * 1000)}ms is already in the tens-of-ms range a dry hit occupies`,
    }
  }
  const t = clamp((decay.seconds - DRY_TAIL_SECONDS) / (WET_TAIL_SECONDS - DRY_TAIL_SECONDS), 0, 1)
  const room = round2(t * ROOM_MAX)
  // A decay just past the dry floor can round to 0.00 at two decimal places -
  // `build()` omits `.room()` for a non-positive value, so the note has to
  // agree with that, not claim `room(0)` for an effect that was not written.
  if (room <= 0) {
    return {
      room: null,
      note: `space left alone on ${label} - measured decay ${Math.round(decay.seconds * 1000)}ms rounds to no audible room at this scale`,
    }
  }
  return {
    room,
    note: `room(${room}) on ${label} - measured decay averages ${Math.round(decay.seconds * 1000)}ms across ${decay.count} onsets, well past the tens-of-ms a dry hit occupies`,
  }
}

// --- tone (lpf only - see module comment for why hpf is never touched) --------

const bandIndex = (name) => BANDS.findIndex((band) => band.name === name)
const tiltAt = (profile, name) => {
  const value = profile?.bands?.tiltDb?.[bandIndex(name)]
  return Number.isFinite(value) ? value : null
}

/** How much darker the higher band has to read, in dB of tilt, before it
 *  counts as a measured drop rather than noise in a coarse six-band split. */
const DARK_DROP_DB = 10
/** A second, steeper drop from the band below that pushes the cutoff lower
 *  still - the stem is not just missing its top octave, it has rolled off
 *  earlier than that too. */
const DARKER_DROP_DB = 10

/**
 * Compare a stem's high band to the one below it; darker than that by
 * `DARK_DROP_DB` or more earns an `.lpf()` at `darkCutoffHz` (or
 * `darkerCutoffHz` if the band below that has *also* rolled off hard).
 * Brighter than the drop, or missing data entirely, leaves lpf alone - the
 * dry default is effectively "no filter," so any emitted number is already a
 * cut below it; there is no matching "raise the cutoff" case for a bright
 * high band, because the dry samples are already full-range there.
 */
function lpfFromTilt(profile, label, { brightBand, midBand, belowMidBand, darkCutoffHz, darkerCutoffHz }) {
  const bright = tiltAt(profile, brightBand)
  const mid = tiltAt(profile, midBand)
  if (bright === null || mid === null) {
    return { lpf: null, note: `tone left alone on ${label} - its ${brightBand} band carries no measurable energy to compare` }
  }
  const drop = mid - bright
  if (drop < DARK_DROP_DB) {
    return {
      lpf: null,
      note: `tone left alone on ${label} - its ${brightBand} band sits within ${drop.toFixed(1)}dB of ${midBand}, not darker than the dry default's full range`,
    }
  }
  const below = belowMidBand ? tiltAt(profile, belowMidBand) : null
  const secondDrop = below !== null ? below - mid : 0
  const cutoff = secondDrop >= DARKER_DROP_DB ? darkerCutoffHz : darkCutoffHz
  return {
    lpf: cutoff,
    note: `lpf(${cutoff}) on ${label} - its ${brightBand} band measures ${drop.toFixed(1)}dB darker than ${midBand} (tilt ${bright.toFixed(1)} vs ${mid.toFixed(1)})`,
  }
}

/** Bass gets its own comparison: 'mid' (400-2000Hz) against 'low-mid'
 *  (150-400Hz), the band straddling the dry default's `lpf(440)`. A steep
 *  drop there means the default already matches or exceeds the record's own
 *  rolloff; a shallow one means real harmonic content extends past it. */
const BASS_DARK_DROP_DB = 15
const BASS_BRIGHT_DROP_DB = 5

function lpfFromBassTilt(profile) {
  const lowMid = tiltAt(profile, 'low-mid')
  const mid = tiltAt(profile, 'mid')
  if (lowMid === null || mid === null) {
    return { lpf: null, note: "tone left alone on bass - the bass stem's low-mid/mid bands carry no measurable energy to compare" }
  }
  const drop = lowMid - mid
  if (drop >= BASS_DARK_DROP_DB) {
    return {
      lpf: null,
      note: `tone left alone on bass - its mid band is ${drop.toFixed(1)}dB down from low-mid, already darker than or matching the dry default's lpf(440)`,
    }
  }
  const lpf = drop <= BASS_BRIGHT_DROP_DB ? 900 : 600
  return {
    lpf,
    note: `lpf(${lpf}) on bass - its mid band is only ${drop.toFixed(1)}dB down from low-mid (tilt ${mid.toFixed(1)} vs ${lowMid.toFixed(1)}), brighter than the dry default's lpf(440) assumes`,
  }
}

// --- width ----------------------------------------------------------------------

/** Matches `analyze.mjs`'s own "narrow" label boundary - reused rather than
 *  invented, so this module's idea of "wide enough to spread" agrees with
 *  the language the rest of the pipeline already reports width in. */
const WIDE_CORRELATION_THRESHOLD = 0.7
/** The established humanize idiom for a gentle stereo spread on a pattern
 *  this pipeline emits as a single voice - see the module comment for why
 *  `.jux()` is not used here. */
const SPREAD_PAN = '0.35 0.65'

function widthPan(profile, label, { centered = false } = {}) {
  const { correlation, confidence } = profile?.width ?? {}
  const measured = confidence === 1 && correlation !== null && correlation !== undefined

  if (centered) {
    if (!measured) {
      return { pan: null, note: `kept centered on ${label} - standard practice; width was not confidently measurable to check it against` }
    }
    // "Agrees" has to mean the correlation actually reads narrow - asserting
    // agreement unconditionally would make this check decorative rather than
    // the "check the measurement agrees" the brief actually asks for.
    const agrees = correlation >= WIDE_CORRELATION_THRESHOLD
    return {
      pan: null,
      note: agrees
        ? `kept centered on ${label} - standard practice, and the stem's own correlation (${correlation.toFixed(2)}) agrees`
        : `kept centered on ${label} - standard practice, though the stem's own correlation (${correlation.toFixed(2)}) reads wider than a centered source usually would`,
    }
  }
  if (!measured) {
    return { pan: null, note: `pan left alone on ${label} - width was not confidently measurable` }
  }
  if (correlation >= WIDE_CORRELATION_THRESHOLD) {
    return { pan: null, note: `pan left alone on ${label} - correlation ${correlation.toFixed(2)} reads narrow, nothing to spread` }
  }
  return { pan: SPREAD_PAN, note: `pan("${SPREAD_PAN}") on ${label} - correlation ${correlation.toFixed(2)} reads wide` }
}

/**
 * Width for a layer whose notes vary in length (bass, chords, lead) - never
 * emits a pan, because `SPREAD_PAN` is only safe for single-step drum hits
 * (see the module comment). Still reports what was measured, so "left alone"
 * says why rather than looking like the measurement was never taken.
 */
function widthUnsafeForSustainedNotes(profile, label) {
  const { correlation, confidence } = profile?.width ?? {}
  const measured = confidence === 1 && correlation !== null && correlation !== undefined
  if (!measured) {
    return { note: `pan left alone on ${label} - width was not confidently measurable` }
  }
  if (correlation >= WIDE_CORRELATION_THRESHOLD) {
    return { note: `pan left alone on ${label} - correlation ${correlation.toFixed(2)} reads narrow, nothing to spread` }
  }
  return {
    note: `pan left alone on ${label} - correlation ${correlation.toFixed(2)} reads wide, but its notes vary in length and a static alternating pan can duplicate one that spans the pan pattern's own cycle boundary; safe only for the single-step drum hits`,
  }
}

// --- gain -------------------------------------------------------------------

/** Below this measured-vs-assumed gap (in dB), the difference is noise, not
 *  a real "this is quieter than our default staging assumes" signal. */
const GAIN_TRIM_THRESHOLD_DB = 3
/** Never trim more than this much off a layer's base gain - a measurement
 *  error should not be able to silence a layer outright. */
const GAIN_TRIM_FLOOR = 0.6

/**
 * What "the drums" are worth in gain terms, for comparing against a measured
 * whole-drums-stem loudness. Anchoring on kick's gain alone (an earlier
 * version of this function did) compares apples to a fruit basket: the real
 * drums *stem* is kick, snare and hats sounding together, consistently
 * louder in RMS terms than the kick alone, so every layer measured against
 * it read as quieter-than-assumed even when correctly balanced. Combining
 * the three default gains in quadrature (RMS-style) is the same assumption
 * `resynth.mjs`'s own multi-voice mixing already makes (`gain / sqrt(n)` per
 * voice, i.e. independent voices summing in power) - not a rendered
 * measurement, since this pipeline cannot render real audio through Strudel
 * offline, but a documented, internally-consistent model rather than an
 * arbitrary one.
 */
const COMBINED_DRUM_GAIN = Math.sqrt(SOUNDS.kick.gain ** 2 + SOUNDS.snare.gain ** 2 + SOUNDS.hats.gain ** 2)

/**
 * Only ever trims down, never up: raising a layer past `SOUNDS`' own gain is
 * the ceiling this module does not move (see the module comment). Applied
 * only to bass/chords/lead, each measured against the drums stem's whole
 * loudness, compared against `COMBINED_DRUM_GAIN` rather than any single
 * role's gain - kick/snare/hats themselves are not trimmed this way, because
 * that same blended stem measurement cannot be attributed to one of them.
 */
function gainTrim(layerGain, stemRmsDb, drumsRmsDb, label) {
  if (!Number.isFinite(stemRmsDb) || !Number.isFinite(drumsRmsDb)) {
    return { trim: 1, note: `gain left alone on ${label} - loudness could not be measured against the drums stem` }
  }
  const measuredGapDb = stemRmsDb - drumsRmsDb
  const assumedGapDb = 20 * Math.log10(layerGain / COMBINED_DRUM_GAIN)
  const delta = measuredGapDb - assumedGapDb
  if (delta >= -GAIN_TRIM_THRESHOLD_DB) {
    const relation = delta >= 0 ? 'at or above' : `within ${GAIN_TRIM_THRESHOLD_DB}dB of`
    return {
      trim: 1,
      note: `gain left alone on ${label} - measures ${measuredGapDb.toFixed(1)}dB from the drums stem, ${relation} the ${assumedGapDb.toFixed(1)}dB gap the default gains assume`,
    }
  }
  const trim = round2(clamp(Math.pow(10, delta / 20), GAIN_TRIM_FLOOR, 1))
  return {
    trim,
    note: `gain trimmed to ${trim}x on ${label} - measures ${measuredGapDb.toFixed(1)}dB from the drums stem, ${Math.abs(delta).toFixed(1)}dB quieter than the default gain gap assumes`,
  }
}

// --- assembly -----------------------------------------------------------------

function build({ lpf, room, pan, gainTrim: trim = 1, notes }) {
  let chain = ''
  if (Number.isFinite(lpf)) chain += `.lpf(${lpf})`
  if (Number.isFinite(room) && room > 0) chain += `.room(${room})`
  if (pan) chain += `.pan("${pan}")`
  return { chain, gainTrim: trim, notes: notes.filter(Boolean) }
}

/**
 * Per-layer effect parameters, derived from `stem-profile.mjs`'s
 * `{ drums, bass, other }` (drums carrying `.roles.{kick,snare,hats}`).
 *
 * Always returns an entry for every layer in `LAYERS`, and every entry
 * always carries at least one note - "left alone" is a first-class outcome
 * here, not the absence of one, so the emitted track can say so.
 */
export function deriveTrackEffects(stemProfiles) {
  const drums = stemProfiles?.drums ?? null
  const bass = stemProfiles?.bass ?? null
  const other = stemProfiles?.other ?? null

  const effects = {}

  {
    const space = roomFromDecay(drums?.roles?.kick, 'the kick band')
    const width = widthPan(drums, 'the drums stem', { centered: true })
    effects.kick = build({ room: space.room, notes: [space.note, width.note] })
  }

  {
    const space = roomFromDecay(drums?.roles?.snare, 'the snare band')
    const tone = {
      note: 'tone left alone on snare - the drums stem blends kick, snare and hats, so its spectral balance cannot be attributed to the snare alone',
    }
    // Safe here for the same reason it is safe on hats: every snare event
    // this pipeline emits is exactly one step long (see the module comment).
    const width = widthPan(drums, 'the drums stem')
    effects.snare = build({ room: space.room, pan: width.pan, notes: [space.note, tone.note, width.note] })
  }

  {
    const space = roomFromDecay(drums?.roles?.hats, 'the hats band')
    const tone = lpfFromTilt(drums, 'the drums stem (air/high-mid is almost entirely hats and cymbal content)', {
      brightBand: 'air',
      midBand: 'high-mid',
      belowMidBand: 'mid',
      darkCutoffHz: 6000,
      darkerCutoffHz: 3500,
    })
    const width = widthPan(drums, 'the drums stem')
    effects.hats = build({ room: space.room, lpf: tone.lpf, pan: width.pan, notes: [space.note, tone.note, width.note] })
  }

  {
    const space = roomFromDecay(bass?.decay, 'the bass stem')
    const tone = bass ? lpfFromBassTilt(bass) : { lpf: null, note: 'tone left alone on bass - no bass stem profile available' }
    const width = widthPan(bass, 'the bass stem', { centered: true })
    const gain = gainTrim(SOUNDS.bass.gain, bass?.loudness?.rmsDb, drums?.loudness?.rmsDb, 'bass')
    effects.bass = build({ room: space.room, lpf: tone.lpf, gainTrim: gain.trim, notes: [space.note, tone.note, width.note, gain.note] })
  }

  {
    // `sub` shares the bass stem physically - it is a register split of the
    // same transcribed line (`bass.mjs`'s `splitByRegister`), not a second
    // recorded source - so its decay and loudness are measured from that same
    // stem profile. Tone is the one dimension NOT reused: `lpfFromBassTilt`'s
    // comparison is built around `SOUNDS.bass`'s dry default (`lpf(440)`,
    // considerably brighter than sub's own `lpf(130)`), so a "brighter than
    // assumed, raise the cutoff" call sized for the mid-bass register would
    // be nonsensical applied to a voice already filtered dark by design.
    const space = roomFromDecay(bass?.decay, 'the bass stem')
    const tone = {
      note: "tone left alone on sub - lpfFromBassTilt's comparison is sized for bass's own lpf(440) default, not sub's already-dark lpf(130)",
    }
    const width = widthPan(bass, 'the bass stem', { centered: true })
    const gain = gainTrim(SOUNDS.sub.gain, bass?.loudness?.rmsDb, drums?.loudness?.rmsDb, 'sub')
    effects.sub = build({ room: space.room, gainTrim: gain.trim, notes: [space.note, tone.note, width.note, gain.note] })
  }

  for (const layer of ['chords', 'lead']) {
    const space = roomFromDecay(other?.decay, 'the other stem (chords and lead share it)')
    const tone = lpfFromTilt(other, 'the other stem (chords and lead share it)', {
      brightBand: 'air',
      midBand: 'high-mid',
      belowMidBand: 'mid',
      darkCutoffHz: 5000,
      darkerCutoffHz: 3000,
    })
    const width = widthUnsafeForSustainedNotes(other, 'the other stem')
    const gain = gainTrim(SOUNDS[layer].gain, other?.loudness?.rmsDb, drums?.loudness?.rmsDb, layer)
    effects[layer] = build({ room: space.room, lpf: tone.lpf, gainTrim: gain.trim, notes: [space.note, tone.note, width.note, gain.note] })
  }

  return effects
}
