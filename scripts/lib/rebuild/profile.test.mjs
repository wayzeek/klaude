import { describe, expect, it } from 'vitest'
import { rhythmClip, synthClip } from '../__fixtures__/make-wav.mjs'
import { profileReference } from './profile.mjs'

describe('profileReference', () => {
  const profile = profileReference(synthClip({ seconds: 12, bpm: 120, key: 'A minor' }), { title: 'test clip' })

  it('carries the source metadata it was given', () => {
    expect(profile.source.title).toBe('test clip')
  })

  /**
   * Tempo gets its own fixture. synthClip's sustained triad is not bin-aligned
   * to the onset FFT, so its leakage swamps the kicks and the tempo estimate is
   * read off the leakage - it reports 178.2 for a clip generated at 120.
   * rhythmClip has no pitched content for exactly this reason and measures
   * 120.185 at full confidence, so a real assertion is possible here.
   *
   * Key cannot ride along on rhythmClip: with nothing pitched, detection is
   * noise. That is why these are two blocks and two fixtures rather than one.
   */
  it('reports the reference tempo, with a confidence in [0, 1]', () => {
    const rhythmic = profileReference(rhythmClip({ seconds: 12, bpm: 120 }))
    expect(rhythmic.tempo.bpm).toBeCloseTo(120, 0)
    expect(rhythmic.tempo.confidence).toBeGreaterThan(0)
    expect(rhythmic.tempo.confidence).toBeLessThanOrEqual(1)
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
