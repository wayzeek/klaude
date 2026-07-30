import { describe, expect, it } from 'vitest'
import { BANDS } from '../../analyze.mjs'
import { SOUNDS } from './emit.mjs'
import { deriveTrackEffects } from './sound-match.mjs'

const idx = Object.fromEntries(BANDS.map((band, i) => [band.name, i]))

/** A minimal stem profile: six-band tilt, width, loudness and an optional
 *  decay/roles - just what `sound-match.mjs` actually reads. */
function tilt({ sub = 0, bass = 0, lowMid = 0, mid = 0, highMid = 0, air = 0 } = {}) {
  const values = new Array(BANDS.length).fill(0)
  values[idx.sub] = sub
  values[idx.bass] = bass
  values[idx['low-mid']] = lowMid
  values[idx.mid] = mid
  values[idx['high-mid']] = highMid
  values[idx.air] = air
  return values
}

function profile({ tiltDb = tilt(), correlation = 0.9, confidence = 1, rmsDb = -20, decay = { seconds: null, count: 0 }, roles } = {}) {
  return {
    bands: { names: BANDS.map((b) => b.name), tiltDb },
    width: { correlation, confidence },
    loudness: { rmsDb },
    decay,
    ...(roles ? { roles } : {}),
  }
}

const NO_DECAY = { seconds: null, count: 0 }
const TOO_FEW = { seconds: 0.3, count: 2 }
const DRY = { seconds: 0.02, count: 5 }
const WET = { seconds: 0.3, count: 8 }
const VERY_WET = { seconds: 1, count: 8 } // beyond saturation
const JUST_PAST_DRY = { seconds: 0.052, count: 5 } // rounds to room(0.00)

describe('deriveTrackEffects - space (room)', () => {
  it('emits no room when a role has too few onsets to trust', () => {
    const effects = deriveTrackEffects({ drums: profile({ roles: { kick: TOO_FEW, snare: NO_DECAY, hats: NO_DECAY } }) })
    expect(effects.kick.chain).not.toContain('.room(')
    expect(effects.kick.notes.join(' ')).toMatch(/not enough to trust/)
  })

  it('emits no room when the measured decay is already dry (tens of ms)', () => {
    const effects = deriveTrackEffects({ drums: profile({ roles: { kick: DRY, snare: NO_DECAY, hats: NO_DECAY } }) })
    expect(effects.kick.chain).not.toContain('.room(')
    expect(effects.kick.notes.join(' ')).toMatch(/tens-of-ms/)
  })

  it('scales a measured decay into a room amount below the 0.6 ceiling', () => {
    const effects = deriveTrackEffects({ drums: profile({ roles: { kick: WET, snare: NO_DECAY, hats: NO_DECAY } }) })
    // (0.3 - 0.05) / (0.45 - 0.05) * 0.6 = 0.375
    expect(effects.kick.chain).toContain('.room(0.38)')
  })

  it('saturates room at 0.6 for a decay well past the wet reference', () => {
    const effects = deriveTrackEffects({ drums: profile({ roles: { kick: VERY_WET, snare: NO_DECAY, hats: NO_DECAY } }) })
    expect(effects.kick.chain).toContain('.room(0.6)')
    expect(effects.kick.chain).not.toMatch(/room\(0\.[7-9]/)
  })

  // Regression: a decay just past the dry floor scales to a room value that
  // rounds to 0.00 at two decimal places. `build()` correctly omits `.room()`
  // for a non-positive value, but an earlier version still worded the note
  // as "room(0)" - claiming an effect that was never written into the chain.
  it('does not claim a room effect that rounds away to nothing', () => {
    const effects = deriveTrackEffects({ drums: profile({ roles: { kick: JUST_PAST_DRY, snare: NO_DECAY, hats: NO_DECAY } }) })
    expect(effects.kick.chain).not.toContain('.room(')
    expect(effects.kick.notes.join(' ')).not.toMatch(/room\(0\)/)
    expect(effects.kick.notes.join(' ')).toMatch(/rounds to no audible room/)
  })

  it('measures kick, snare and hats decay independently from their own bands', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: DRY, snare: WET, hats: NO_DECAY } }),
    })
    expect(effects.kick.chain).not.toContain('.room(')
    expect(effects.snare.chain).toContain('.room(')
    expect(effects.hats.chain).not.toContain('.room(')
  })

  it('gives bass and chords/lead their own broadband decay, shared between chords and lead', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
      bass: profile({ decay: WET }),
      other: profile({ decay: WET }),
    })
    expect(effects.bass.chain).toContain('.room(')
    expect(effects.chords.chain).toContain('.room(')
    expect(effects.lead.chain).toContain('.room(')
    // Same measurement, same room value on both layers that share the stem.
    expect(effects.chords.chain.match(/\.room\(([\d.]+)\)/)[1]).toBe(effects.lead.chain.match(/\.room\(([\d.]+)\)/)[1])
  })
})

describe('deriveTrackEffects - tone (lpf)', () => {
  it('leaves hats lpf alone when air is within 10dB of high-mid', () => {
    const effects = deriveTrackEffects({
      drums: profile({ tiltDb: tilt({ highMid: -10, air: -15 }), roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
    })
    expect(effects.hats.chain).not.toContain('.lpf(')
    expect(effects.hats.notes.join(' ')).toMatch(/not darker than the dry default/)
  })

  it('cuts hats lpf to 6000 when air reads clearly darker than high-mid', () => {
    const effects = deriveTrackEffects({
      drums: profile({ tiltDb: tilt({ mid: -5, highMid: -8, air: -25 }), roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
    })
    expect(effects.hats.chain).toContain('.lpf(6000)')
  })

  it('cuts hats lpf further to 3500 when high-mid has also rolled off hard from mid', () => {
    const effects = deriveTrackEffects({
      drums: profile({ tiltDb: tilt({ mid: -5, highMid: -20, air: -40 }), roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
    })
    expect(effects.hats.chain).toContain('.lpf(3500)')
  })

  it('never touches snare tone - the blended drums stem cannot isolate it', () => {
    const effects = deriveTrackEffects({
      drums: profile({ tiltDb: tilt({ mid: -5, highMid: -20, air: -40 }), roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
    })
    expect(effects.snare.chain).not.toContain('.lpf(')
    expect(effects.snare.notes.join(' ')).toMatch(/cannot be attributed to the snare alone/)
  })

  it('never touches kick tone', () => {
    const effects = deriveTrackEffects({
      drums: profile({ tiltDb: tilt({ mid: -5, highMid: -20, air: -40 }), roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
    })
    expect(effects.kick.chain).not.toContain('.lpf(')
  })

  it('darkens chords and lead together from the shared other stem', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
      other: profile({ tiltDb: tilt({ mid: -5, highMid: -8, air: -25 }) }),
    })
    expect(effects.chords.chain).toContain('.lpf(5000)')
    expect(effects.lead.chain).toContain('.lpf(5000)')
  })

  it('leaves bass lpf alone when its mid band already rolls off steeply from low-mid', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
      bass: profile({ tiltDb: tilt({ lowMid: -5, mid: -25 }) }),
    })
    expect(effects.bass.chain).not.toContain('.lpf(')
  })

  it('raises bass lpf to 900 when mid content is nearly as strong as low-mid', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
      bass: profile({ tiltDb: tilt({ lowMid: -5, mid: -3 }) }),
    })
    expect(effects.bass.chain).toContain('.lpf(900)')
  })

  it('raises bass lpf only to 600 for a moderate drop', () => {
    const effects = deriveTrackEffects({
      drums: profile({ roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }),
      bass: profile({ tiltDb: tilt({ lowMid: -5, mid: -13 }) }),
    })
    expect(effects.bass.chain).toContain('.lpf(600)')
  })
})

describe('deriveTrackEffects - width (pan)', () => {
  const noRoom = { roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }

  it('never pans kick, even when the drums stem measures wide', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.1 }) })
    expect(effects.kick.chain).not.toContain('.pan(')
    expect(effects.kick.notes.join(' ')).toMatch(/kept centered/)
  })

  // Regression: staying centered is "standard practice", but the brief also
  // asks to check the measurement agrees with that - an earlier version
  // always said "agrees" once width was measurable at all, regardless of
  // what the correlation actually read.
  it('says so when a centered layer\'s own measured width does not actually agree', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.1 }) })
    expect(effects.kick.notes.join(' ')).not.toMatch(/agrees/)
    expect(effects.kick.notes.join(' ')).toMatch(/reads wider than a centered source usually would/)
  })

  it('confirms agreement when a centered layer\'s own measured width is narrow', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.95 }) })
    expect(effects.kick.notes.join(' ')).toMatch(/agrees/)
  })

  it('never pans bass, even when the bass stem measures wide', () => {
    const effects = deriveTrackEffects({
      drums: profile(noRoom),
      bass: profile({ correlation: 0.1 }),
    })
    expect(effects.bass.chain).not.toContain('.pan(')
  })

  it('leaves hats pan alone when the drums stem reads narrow', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.95 }) })
    expect(effects.hats.chain).not.toContain('.pan(')
  })

  it('spreads hats when the drums stem reads wide', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.3 }) })
    expect(effects.hats.chain).toContain('.pan("0.35 0.65")')
  })

  it('does not pan when width was not confidently measured', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.1, confidence: 0 }) })
    expect(effects.hats.chain).not.toContain('.pan(')
    expect(effects.hats.notes.join(' ')).toMatch(/not confidently measurable/)
  })

  it('spreads snare too - its events are also always exactly one step long', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, correlation: 0.3 }) })
    expect(effects.snare.chain).toContain('.pan("0.35 0.65")')
  })

  // Regression: `.pan("0.35 0.65")` does not pan a sustained note whose span
  // crosses the pattern's own half-cycle boundary - it duplicates the hap,
  // once per pan value, both at the note's full length. Measured directly
  // (probe script, not committed): a 14-step lead note came back as two
  // full-length haps instead of one, which `verify-emission.mjs` correctly
  // flags as an unexpected event and a real render would sound twice. Kick
  // and bass are exempt by being centered; chords and lead are not centered,
  // so they need their own guard.
  it('never pans bass, chords or lead, even when their stem measures wide - only single-step drum hits are safe', () => {
    const effects = deriveTrackEffects({
      drums: profile(noRoom),
      bass: profile({ correlation: 0.1 }),
      other: profile({ correlation: 0.1 }),
    })
    expect(effects.bass.chain).not.toContain('.pan(')
    expect(effects.chords.chain).not.toContain('.pan(')
    expect(effects.lead.chain).not.toContain('.pan(')
    expect(effects.chords.notes.join(' ')).toMatch(/notes vary in length/)
    expect(effects.lead.notes.join(' ')).toMatch(/notes vary in length/)
  })

  it('still reports the other stem correlation for chords/lead when narrow, without proposing a pan', () => {
    const effects = deriveTrackEffects({
      drums: profile(noRoom),
      other: profile({ correlation: 0.95 }),
    })
    expect(effects.chords.chain).not.toContain('.pan(')
    expect(effects.chords.notes.join(' ')).toMatch(/reads narrow/)
  })
})

describe('deriveTrackEffects - gain', () => {
  const noRoom = { roles: { kick: NO_DECAY, snare: NO_DECAY, hats: NO_DECAY } }

  it('leaves bass gain alone when its measured level matches the assumed gap to drums', () => {
    // assumed gap = 20*log10(0.35 / combinedDrumGain) ~ -5.50dB, where
    // combinedDrumGain is kick/snare/hats' default gains combined in
    // quadrature (~0.660) - not kick alone, since the measured side is the
    // *whole* drums stem. Measured -3dB is within the 3dB threshold of that.
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -17 }),
      bass: profile({ rmsDb: -20 }),
    })
    expect(effects.bass.gainTrim).toBe(1)
  })

  it('trims bass gain down when it measures notably quieter than the assumed gap', () => {
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -17 }),
      bass: profile({ rmsDb: -26 }),
    })
    // measured gap -9dB, assumed ~-5.50dB, delta ~-3.50dB -> 10^(-3.5/20) ~ 0.67
    expect(effects.bass.gainTrim).toBeCloseTo(0.67, 2)
    expect(effects.bass.gainTrim).toBeLessThan(1)
  })

  // Regression: an earlier version compared the measured gap against kick's
  // gain alone, not a combined kick+snare+hats reference. That is comparing
  // a layer to one drum, not to "the drums stem" it is actually measured
  // against - a mix of all three, consistently louder in RMS than kick by
  // itself, which trimmed an otherwise correctly balanced bass. -7dB from
  // drums is close enough to the combined-drum reference that it must NOT
  // trim, even though it would have under the old kick-only one.
  it('does not trim a bass that measures close to a combined kick+snare+hats reference', () => {
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -17 }),
      bass: profile({ rmsDb: -24 }),
    })
    expect(effects.bass.gainTrim).toBe(1)
  })

  it('never trims below the floor even for a very large measured gap', () => {
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -10 }),
      bass: profile({ rmsDb: -40 }),
    })
    expect(effects.bass.gainTrim).toBe(0.6)
  })

  it('never boosts gain when the stem measures louder than assumed', () => {
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -30 }),
      bass: profile({ rmsDb: -5 }),
    })
    expect(effects.bass.gainTrim).toBe(1)
  })

  it('never applies a gain trim to kick, snare or hats', () => {
    const effects = deriveTrackEffects({ drums: profile({ ...noRoom, rmsDb: -40 }), bass: profile({ rmsDb: -5 }) })
    expect(effects.kick.gainTrim).toBe(1)
    expect(effects.snare.gainTrim).toBe(1)
    expect(effects.hats.gainTrim).toBe(1)
  })

  it('trims chords and lead independently, since their default gains differ', () => {
    // Both layers measure -10.5dB from the drums stem, but their assumed
    // gaps differ (chords 0.3, lead 0.35, against the same combined-drum
    // reference), so the same measured gap trims them by different amounts.
    const effects = deriveTrackEffects({
      drums: profile({ ...noRoom, rmsDb: -17 }),
      other: profile({ rmsDb: -27.5 }),
    })
    expect(SOUNDS.chords.gain).not.toBe(SOUNDS.lead.gain)
    expect(effects.chords.gainTrim).toBeLessThan(1)
    expect(effects.lead.gainTrim).toBeLessThan(1)
    expect(effects.chords.gainTrim).not.toBe(effects.lead.gainTrim)
  })
})

describe('deriveTrackEffects - overall shape', () => {
  it('returns every layer with a chain string and at least one note, even with no profiles at all', () => {
    const effects = deriveTrackEffects({})
    for (const layer of ['kick', 'snare', 'hats', 'bass', 'chords', 'lead']) {
      expect(typeof effects[layer].chain).toBe('string')
      expect(effects[layer].notes.length).toBeGreaterThan(0)
      expect(effects[layer].gainTrim).toBe(1)
    }
  })

  it('does not throw when called with undefined stem profiles', () => {
    expect(() => deriveTrackEffects(undefined)).not.toThrow()
  })
})
