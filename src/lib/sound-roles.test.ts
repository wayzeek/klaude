import { describe, expect, it } from 'vitest'
import { roleFor } from '@/lib/sound-roles'

describe('roleFor', () => {
  it('maps drum sounds by sound name, ignoring the layer they sit in', () => {
    // The shipped DEFAULT_CODE puts kick, clap and hats in one `drums` layer,
    // so the sound has to win over the layer name.
    expect(roleFor('bd', 'drums')).toBe('thump')
    expect(roleFor('cp', 'drums')).toBe('snap')
    expect(roleFor('hh', 'drums')).toBe('tick')
    expect(roleFor('sd', 'drums')).toBe('snap')
    expect(roleFor('oh', 'drums')).toBe('tick')
  })

  it('falls back to the layer name when the sound is a synth', () => {
    expect(roleFor('sawtooth', 'bass')).toBe('weight')
    expect(roleFor('triangle', 'lead')).toBe('melody')
  })

  it('falls back to the layer name when there is no sound at all', () => {
    expect(roleFor(undefined, 'kick')).toBe('thump')
    expect(roleFor(undefined, 'pad')).toBe('melody')
  })

  it('is case insensitive on layer names', () => {
    expect(roleFor(undefined, 'Kick')).toBe('thump')
    expect(roleFor(undefined, 'BASS')).toBe('weight')
  })

  it('gives unknown names a stable role rather than a random one', () => {
    const first = roleFor('supersaw', 'wobble')
    expect(roleFor('supersaw', 'wobble')).toBe(first)
    expect(['thump', 'snap', 'tick', 'weight', 'melody']).toContain(first)
  })
})

describe('roles drawn from real tracks', () => {
  it('routes toms by sound, not by the layer that holds them', () => {
    // Blue Hour carries its backbeat on toms inside a layer called "perc".
    // Falling through to the layer name sent them to tick, which left the
    // whole track with no accent role at all.
    expect(roleFor('lt', 'perc')).toBe('weight')
    expect(roleFor('mt', 'perc')).toBe('weight')
    expect(roleFor('ht', 'perc')).toBe('weight')
  })

  it('still reads the standard kit correctly', () => {
    expect(roleFor('bd', 'kick')).toBe('thump')
    expect(roleFor('hh', 'hats')).toBe('tick')
    expect(roleFor('oh', 'open')).toBe('tick')
    expect(roleFor('sd', 'snare')).toBe('snap')
  })

  it('sends pitched material to melody so the eyes have something to follow', () => {
    expect(roleFor('gm_epiano1', 'keys')).toBe('melody')
    expect(roleFor('piano', 'piano')).toBe('melody')
    expect(roleFor('gm_string_ensemble_1', 'strings')).toBe('melody')
  })
})

describe('waveforms defer to the layer, instruments do not', () => {
  it('keeps a sawtooth bass as weight and a sawtooth lead as melody', () => {
    // The same timbre in two roles: only the layer name can tell them apart.
    expect(roleFor('sawtooth', 'bass')).toBe('weight')
    expect(roleFor('sawtooth', 'lead')).toBe('melody')
  })
})
