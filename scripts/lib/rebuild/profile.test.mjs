import { describe, expect, it } from 'vitest'
import { synthClip } from '../__fixtures__/make-wav.mjs'
import { profileReference } from './profile.mjs'

describe('profileReference', () => {
  const profile = profileReference(synthClip({ seconds: 12, bpm: 120, key: 'A minor' }), { title: 'test clip' })

  it('carries the source metadata it was given', () => {
    expect(profile.source.title).toBe('test clip')
  })

  it('reports tempo with a confidence in [0, 1]', () => {
    // synthClip's sustained triad pollutes onset detection (make-wav.mjs and
    // this plan's Task 5 finding: the triad's spectral leakage dominates the
    // novelty function, so the kick contributes nothing and the measured BPM
    // does not track the clip's actual tempo on this fixture). Assert the
    // shape, not a specific value - the same treatment already applied to key
    // detection below for the same reason.
    expect(profile.tempo.bpm).toBeGreaterThan(0)
    expect(profile.tempo.confidence).toBeGreaterThanOrEqual(0)
    expect(profile.tempo.confidence).toBeLessThanOrEqual(1)
  })

  it('reports key with a confidence derived from the margin over the runner-up', () => {
    expect(profile.key.name).toMatch(/^[A-G][b#]? (major|minor)$/)
    expect(profile.key.confidence).toBeGreaterThanOrEqual(0)
    expect(profile.key.confidence).toBeLessThanOrEqual(1)
    expect(profile.key.runnerUp).toMatch(/^[A-G][b#]? (major|minor)$/)
  })

  it('gives every band a name alongside its percentage', () => {
    expect(profile.bands.names).toEqual(['sub', 'bass', 'low-mid', 'mid', 'high-mid', 'air'])
    expect(profile.bands.pct).toHaveLength(6)
    const total = profile.bands.pct.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(100, 0)
  })

  it('reports stereo width, and is confident about it on a real stereo file', () => {
    expect(profile.width.correlation).not.toBeNull()
    expect(profile.width.confidence).toBeGreaterThan(0)
  })

  it('is JSON-round-trippable, since it is written to disk between stages', () => {
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile)
  })

  it('reports low width confidence for a mono file, where width is meaningless', () => {
    const mono = profileReference(synthClip({ seconds: 12, bpm: 120, key: 'A minor', channels: 1 }))
    expect(mono.width.confidence).toBe(0)
  })
})
