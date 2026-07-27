import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeWavBuffer } from './analyze.mjs'
import { synthClip } from './lib/__fixtures__/make-wav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(here, 'lib/__fixtures__/analysis-baseline.json')

/**
 * These clips are the contract. If a refactor changes any number here it has
 * changed behaviour, whether or not that was the intent.
 *
 * Floating point is compared to 6 decimal places rather than exactly, because
 * the order of summation in a refactored loop can differ in the last bit
 * without meaning anything.
 */
const CLIPS = [
  { name: 'stereo-120-Aminor', args: { seconds: 8, bpm: 120, key: 'A minor' } },
  { name: 'stereo-140-Fmajor', args: { seconds: 8, bpm: 140, key: 'F major' } },
  { name: 'mono-90-Cminor', args: { seconds: 8, bpm: 90, key: 'C minor', channels: 1 } },
]

/** Recursively round every number so bit-level noise does not fail the test. */
function round(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Number(value.toFixed(6))
  }
  if (Array.isArray(value)) return value.map(round)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]))
  }
  return value
}

describe('analyzeWavBuffer', () => {
  const actual = {}
  for (const clip of CLIPS) {
    actual[clip.name] = round(analyzeWavBuffer(synthClip(clip.args)))
  }

  it('matches the frozen baseline', () => {
    if (!fs.existsSync(BASELINE)) {
      fs.writeFileSync(BASELINE, `${JSON.stringify(actual, null, 2)}\n`)
      throw new Error('Baseline written. Inspect it, commit it, then re-run.')
    }
    const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    expect(actual).toEqual(expected)
  })

  it('recovers the tempo it was given', () => {
    expect(actual['stereo-120-Aminor'].tempo.bpm).toBeCloseTo(120, 0)
    expect(actual['stereo-140-Fmajor'].tempo.bpm).toBeCloseTo(140, 0)
  })
})
