/**
 * =============================================================================
 * LAYER TRIMS
 * =============================================================================
 *
 * Per-layer mix trims and the audio maths behind them. Every value is a trim on
 * top of what the track's code already asked for, never a replacement, and
 * every neutral is a true no-op: at neutral these functions hand back the very
 * object they were given.
 *
 * All the numbers live here and nowhere else. This file is pure so they can be
 * tested without a browser, a server, or an audio context, and it deliberately
 * imports nothing so a Node test script can load it directly.
 */

export type LayerTrim = {
  /** Multiplies postgain. 1 is as written. */
  volume: number
  /** Below 0 closes a lowpass, above 0 opens a highpass. 0 is as written. */
  tone: number
  /** Offsets the reverb send. 0 is as written. */
  space: number
  /** Leans the layer early or late. 0 is on the beat. */
  feel: number
  /** Delays off-beat hits. 0 is straight. */
  swing: number
}

export const NEUTRAL_TRIM: LayerTrim = { volume: 1, tone: 0, space: 0, feel: 0, swing: 0 }

/**
 * Look a layer's trim up safely.
 *
 * Layer names come from the track's own code, so nothing stops one being called
 * `constructor` or `toString`. A bare `trims[name] ?? NEUTRAL_TRIM` then returns
 * an inherited function from Object.prototype instead of a trim, and the first
 * thing that reads `.feel` off it gets undefined and shifts the pattern by NaN,
 * which throws inside Strudel and fails the whole evaluation. Every read of a
 * trims map goes through here.
 */
export const trimFor = (trims: Record<string, LayerTrim>, layer: string): LayerTrim =>
  Object.hasOwn(trims, layer) ? trims[layer] : NEUTRAL_TRIM

/** Does this layer carry a stored trim? Own properties only, see trimFor. */
export const hasTrim = (trims: Record<string, LayerTrim>, layer: string): boolean =>
  Object.hasOwn(trims, layer)

export const TRIM_RANGES: Record<keyof LayerTrim, [number, number]> = {
  volume: [0, 2],
  tone: [-1, 1],
  space: [-1, 1],
  feel: [-1, 1],
  swing: [0, 1],
}

/** Cutoff assumed for a layer whose code set no lowpass: effectively open. */
const OPEN_HZ = 20000
/** Darkening stops here rather than reaching silence. */
const DARK_FLOOR_HZ = 120
/** Where the thinning highpass starts, just below audibility. */
const HPF_BASE_HZ = 30
/** How much of the reverb send a full turn of the space knob is worth. */
const SPACE_DEPTH = 0.6
/** Narrowest band the tone knob will leave between a highpass and a lowpass. */
const MIN_BAND_RATIO = 2
/** Float dust this close to a neutral value is that value. */
const NEUTRAL_EPSILON = 1e-9

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

const TRIM_KEYS = Object.keys(TRIM_RANGES) as (keyof LayerTrim)[]

/**
 * Fold a partial patch onto a base trim, clamping each value into range.
 * Out-of-range numbers are clamped rather than rejected, so a slider mid-drag
 * can never produce a state the mixer refuses. Values that are not finite
 * numbers are ignored entirely.
 */
export function clampTrim(patch: Partial<LayerTrim>, base: LayerTrim = NEUTRAL_TRIM): LayerTrim {
  const out: LayerTrim = { ...base }
  for (const key of TRIM_KEYS) {
    const value = patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const [lo, hi] = TRIM_RANGES[key]
      out[key] = clamp(value, lo, hi)
    }
  }
  return out
}

export const isNeutral = (trim: LayerTrim): boolean =>
  trim.volume === 1 && trim.tone === 0 && trim.space === 0 && trim.feel === 0 && trim.swing === 0

/**
 * Does moving from `a` to `b` require the pattern to be rebuilt? Only feel and
 * swing restructure; volume, tone and space are read per event at query time.
 * The whole point of the live fader path is that this returns false for them.
 */
export const isStructuralDifference = (a: LayerTrim, b: LayerTrim): boolean =>
  a.feel !== b.feel || a.swing !== b.swing

/**
 * Apply the per-event trims to one hap value.
 *
 * Volume targets `postgain` rather than `gain`: postgain defaults to a clean 1,
 * sits after the inline effects, and feeds the delay and reverb sends, so a hit
 * and its tails scale together. Multiplying `gain` would preserve per-hit
 * dynamics too, but it starts from an 0.8 default and lands in front of the fx.
 */
export function applyValueTrim<V extends Record<string, unknown>>(value: V, trim: LayerTrim): V {
  if (trim.volume === 1 && trim.tone === 0 && trim.space === 0) return value

  const next: Record<string, unknown> = { ...value }

  if (trim.volume !== 1) {
    const postgain = typeof value.postgain === 'number' ? value.postgain : 1
    next.postgain = postgain * trim.volume
  }

  if (trim.tone !== 0) {
    const base = typeof value.cutoff === 'number' ? value.cutoff : OPEN_HZ
    if (trim.tone < 0) {
      // Never brighter than written, and never above the code's own cutoff when
      // that already sits below the floor: a flat 120 would *raise* it.
      //
      // Also never below an authored highpass. A lowpass dropped under an
      // existing hpf leaves no pass band at all and the layer vanishes, which
      // is the one thing a "muffled" knob must not do. A layer whose author
      // already made the band this narrow is left where it is rather than
      // widened.
      const hpf = typeof value.hcutoff === 'number' ? value.hcutoff : 0
      const floor = Math.min(base, Math.max(DARK_FLOOR_HZ, hpf * MIN_BAND_RATIO))
      next.cutoff = clamp(base * 2 ** (4 * trim.tone), floor, base)
    } else {
      const existing = typeof value.hcutoff === 'number' ? value.hcutoff : 0
      const target = HPF_BASE_HZ * 2 ** (6 * trim.tone)
      // Cap under the lowpass so the two filters cannot close on each other and
      // silence the layer, but never below a highpass the code asked for. On a
      // layer that is both lowpassed and highpassed those rules conflict, and
      // this picks narrowing the band over overriding the author.
      const cap = Math.max(base / 4, existing)
      next.hcutoff = Math.min(Math.max(existing, target), cap)
    }
  }

  if (trim.space !== 0) {
    const room = typeof value.room === 'number' ? value.room : 0
    next.room = clamp(room + SPACE_DEPTH * trim.space, 0, 1)
  }

  return next as V
}

/** How far a full turn of the feel knob leans a layer, in cycles. */
const FEEL_CYCLES = 1 / 64
/** Slices per cycle that swing works within: quarter-slices, so eighths lope. */
const SWING_SUBDIVISION = 4
/** Delay at full swing, as a fraction of a half-slice. */
const SWING_DEPTH = 2 / 3

/**
 * The pattern surface the structural trims need. Declared structurally rather
 * than imported so this file stays free of Strudel.
 */
export type StructuralPattern<P> = {
  inside: (n: number, fn: (pattern: P) => P) => P
  within: (start: number, end: number, fn: (pattern: P) => P) => P
  late: (amount: number) => P
  early: (amount: number) => P
}

/**
 * Apply the trims that rebuild the pattern. Swing first, then feel: swing
 * rearranges hits inside the bar, feel leans the finished layer against the
 * beat. Measured against this engine the two commute on ordinary patterns, so
 * the order is not load-bearing today; it is fixed and owned in one place so
 * behaviour cannot drift if either transform changes.
 *
 * Swing is deliberately not Strudel's `swingBy`. That is
 * `pat.inside(n, late(seq(0, swing / 2)))`, whose patterned `late` multiplies
 * structure: an event longer than half a slice spans both argument values and is
 * emitted twice, which flams held notes instead of swinging them. Routing each
 * event through `within` sends it down exactly one branch, so the event count is
 * preserved on every layer.
 */
export function applyStructuralTrim<P extends StructuralPattern<P>>(pattern: P, trim: LayerTrim): P {
  let out = pattern
  if (trim.swing > 0) {
    const delay = (SWING_DEPTH * trim.swing) / 2
    out = out.inside(SWING_SUBDIVISION, (slice) => slice.within(0.5, 1, (half) => half.late(delay)))
  }
  if (trim.feel !== 0) {
    const shift = Math.abs(trim.feel) * FEEL_CYCLES
    out = trim.feel > 0 ? out.late(shift) : out.early(shift)
  }
  return out
}

/**
 * Fader travel to volume, and back.
 *
 * The taper is quadratic so unity sits about 71% up the throw and the useful
 * quiet range is not crammed into the bottom of it. A fader linear in
 * amplitude spends most of its travel on differences nobody can hear. The
 * engine applies its own gain curve to postgain, which is identity by
 * default; this assumes that default rather than depending on it.
 */
export const faderVolume = (position: number): number => {
  const volume = clamp(2 * position * position, TRIM_RANGES.volume[0], TRIM_RANGES.volume[1])
  // Unity sits at sqrt(0.5), and squaring that gives 1.0000000000000002, so a
  // fader parked exactly on unity would store a trim that is not neutral: a
  // star that never clears and a postgain written onto every event of the layer
  // to no audible purpose. Snap the dust away.
  return Math.abs(volume - NEUTRAL_TRIM.volume) < NEUTRAL_EPSILON ? NEUTRAL_TRIM.volume : volume
}

export const faderPosition = (volume: number): number =>
  Math.sqrt(clamp(volume, TRIM_RANGES.volume[0], TRIM_RANGES.volume[1]) / 2)
