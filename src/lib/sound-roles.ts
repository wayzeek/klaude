/**
 * =============================================================================
 * SOUND ROLES
 * =============================================================================
 *
 * Decides which part of the mascot a musical event moves.
 *
 * The sound wins over the layer name, because a single layer routinely holds
 * several instruments: the shipped DEFAULT_CODE plays kick, clap and hats out
 * of one `drums` layer, and only `hap.value.s` can tell them apart. Strudel's
 * drum names are standardised, so this is both more precise and more stable
 * than reading the name the track author chose.
 *
 * The layer name is the fallback for melodic layers, whose sound is a synth
 * name like `sawtooth`. Names are user-editable (the editor syncs hand edits
 * back), so anything unrecognised hashes to a fixed slot: a given track always
 * moves the same way, even when we have no idea what it is.
 */

export type Role = 'thump' | 'snap' | 'tick' | 'weight' | 'melody'

export const ROLES: readonly Role[] = ['thump', 'snap', 'tick', 'weight', 'melody']

/** Matched against Strudel's standard sound names. */
const BY_SOUND: ReadonlyArray<readonly [RegExp, Role]> = [
  [/^(bd|kick)/, 'thump'],
  [/^(sd|sn|snare|cp|clap|rim|rs)/, 'snap'],
  [/^(hh|oh|hat|sh|shaker|ride|cr|perc|tb)/, 'tick'],
  // Toms are accents, not timekeeping, so they move his weight rather than
  // his wrists. They go to weight rather than snap because a tom fill runs
  // many hits to the bar, and routing that to the lean would flip him from
  // side to side several times a cycle.
  [/^(lt|mt|ht|tom)/, 'weight'],
  [/^(bass|sub|808)/, 'weight'],
  // Named instruments are melodic whatever layer they sit in. Raw waveform
  // names are deliberately absent: sawtooth is a timbre, not an instrument,
  // and it is just as likely to be the bass as the lead, so those defer to
  // the layer name instead.
  [/^(piano|epiano|rhodes|organ|bell|choir|string|brass|flute|vibra|marimba|gm_)/, 'melody'],
  // Noise sources are texture. They tend to run at sixteenths, so they belong
  // in the wrists with the hats, never on the lean.
  [/^(pink|white|brown|noise)/, 'tick'],
]

/** Matched against the layer name when the sound tells us nothing. */
const BY_NAME: ReadonlyArray<readonly [RegExp, Role]> = [
  [/kick|(^|[^a-z])bd([^a-z]|$)/, 'thump'],
  [/snare|clap|rim/, 'snap'],
  [/hat|hh|shaker|perc/, 'tick'],
  [/bass|sub|low/, 'weight'],
  [/lead|mel|arp|pad|chord|key|pluck|stab/, 'melody'],
  // Atmosphere and effects layers. Named so they cannot land on a percussive
  // role by hash: Blue Hour's fx layer is pink noise at sixteenths, and the
  // hash had been sending it to the lean, which would have thrown him from
  // side to side eight times a bar.
  [/fx|air|atmos|ambient|amb|texture|wind|noise|riser|swell/, 'melody'],
]

/** FNV-1a. Any stable hash works; this one is short and has no dependencies. */
function hash(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function roleFor(sound: string | undefined, layer: string): Role {
  if (sound) {
    const s = sound.toLowerCase()
    for (const [pattern, role] of BY_SOUND) if (pattern.test(s)) return role
  }
  const name = layer.toLowerCase()
  for (const [pattern, role] of BY_NAME) if (pattern.test(name)) return role
  return ROLES[hash(name) % ROLES.length]
}
