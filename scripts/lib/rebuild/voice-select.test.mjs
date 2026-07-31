import { describe, expect, it } from 'vitest'
import { deriveLeadVoice, layerOnsets, LEAD_VOICES, selectLeadVoice } from './voice-select.mjs'

const GRID = { bpm: 120, beatSeconds: 0.5, barSeconds: 2, downbeatSeconds: 0, beatsPerBar: 4 }

const noteEvent = (step, midi) => ({ step, length: 1, velocity: 0.8, confidence: 0.9, midi, symbol: null, driftSteps: 0 })

function transcription(sections) {
  return { grid: GRID, key: { name: 'C minor', confidence: 0.5 }, stepsPerBeat: 4, sections }
}

describe('layerOnsets', () => {
  it('returns nothing for a track with no lead loops', () => {
    const t = transcription([{ index: 0, startBar: 0, bars: 2, label: 'a', sameAs: null, loops: { lead: null } }])
    expect(layerOnsets(t, 'lead')).toEqual([])
  })

  it('expands a folded loop across every repetition in its section, in seconds', () => {
    // loopBars 1 folded across a 2-bar (32-step) section repeats twice; each
    // rep's step offset is `rep * loopSteps` added to the loop's own event
    // step, converted to seconds via the grid (perStep = beatSeconds/4 =
    // 0.125s, perBar = 16 steps = 2s, matching barSeconds).
    const lead = { loopBars: 1, events: [noteEvent(0, 60), noteEvent(8, 64)], confidence: 0.9 }
    const t = transcription([{ index: 0, startBar: 0, bars: 2, label: 'a', sameAs: null, loops: { lead } }])
    const onsets = layerOnsets(t, 'lead')
    expect(onsets).toEqual([
      { seconds: 0, midi: 60 },
      { seconds: 1, midi: 64 },
      { seconds: 2, midi: 60 },
      { seconds: 3, midi: 64 },
    ])
  })

  it('offsets a later section by its own start bar', () => {
    const lead = { loopBars: 1, events: [noteEvent(0, 67)], confidence: 0.9 }
    const t = transcription([
      { index: 0, startBar: 0, bars: 1, label: 'a', sameAs: null, loops: { lead: null } },
      { index: 1, startBar: 1, bars: 1, label: 'b', sameAs: null, loops: { lead } },
    ])
    // Section 1 starts at bar 1 = 2 seconds in.
    expect(layerOnsets(t, 'lead')).toEqual([{ seconds: 2, midi: 67 }])
  })

  it('reads a different layer independently', () => {
    const bass = { loopBars: 1, events: [noteEvent(0, 40)], confidence: 0.9 }
    const lead = { loopBars: 1, events: [noteEvent(0, 72)], confidence: 0.9 }
    const t = transcription([{ index: 0, startBar: 0, bars: 1, label: 'a', sameAs: null, loops: { bass, lead } }])
    expect(layerOnsets(t, 'bass')).toEqual([{ seconds: 0, midi: 40 }])
    expect(layerOnsets(t, 'lead')).toEqual([{ seconds: 0, midi: 72 }])
  })
})

describe('LEAD_VOICES', () => {
  it('never collides with another layer\'s sound string', () => {
    // bass=sawtooth, sub=sine, chords=gm_epiano1, kick/snare/hats are sample
    // sounds - verify-emission.mjs sorts a queried event into a layer by
    // matching its `sound` against exactly one of these, so a collision would
    // silently misattribute every lead event to whichever layer comes first.
    const otherSounds = new Set(['bd', 'rim', 'hh', 'sawtooth', 'sine', 'gm_epiano1'])
    expect(otherSounds.has(LEAD_VOICES.mellow.sound)).toBe(false)
    expect(otherSounds.has(LEAD_VOICES.bright.sound)).toBe(false)
    expect(LEAD_VOICES.mellow.sound).not.toBe(LEAD_VOICES.bright.sound)
  })

  it('is never gm_tenor_sax', () => {
    expect(LEAD_VOICES.mellow.sound).not.toBe('gm_tenor_sax')
    expect(LEAD_VOICES.bright.sound).not.toBe('gm_tenor_sax')
  })
})

/** A features object with every signal null, so a test only has to set what
 *  it actually wants to exercise. */
const features = (overrides = {}) => ({
  count: 5,
  centroidHz: null,
  brightRatio: null,
  oddEvenRatio: null,
  attack: { seconds: null, count: 0 },
  sustain: { seconds: null, count: 0 },
  ...overrides,
})

describe('selectLeadVoice', () => {
  it('never returns gm_tenor_sax, across every case below', () => {
    const cases = [
      null,
      features(),
      features({ centroidHz: 5000, brightRatio: 0.9, attack: { seconds: 0.01, count: 5 } }),
      features({ centroidHz: 200, brightRatio: 0.01, attack: { seconds: 0.4, count: 5 } }),
    ]
    for (const f of cases) expect(selectLeadVoice(f).sound).not.toBe('gm_tenor_sax')
  })

  it('defaults to the mellow voice with too few onsets to measure', () => {
    const result = selectLeadVoice(features({ count: 2 }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
    expect(result.notes.join(' ')).toMatch(/only 2 onset/)
  })

  it('defaults to the mellow voice for a null features object (no onsets at all)', () => {
    const result = selectLeadVoice(null)
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
    expect(result.notes.join(' ')).toMatch(/only 0 onset/)
  })

  it('chooses bright when all three signals read bright', () => {
    const result = selectLeadVoice(features({ centroidHz: 4000, brightRatio: 0.8, attack: { seconds: 0.01, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.bright.sound)
    expect(result.suffix).toBe(LEAD_VOICES.bright.suffix)
  })

  it('chooses mellow when all three signals read dark', () => {
    const result = selectLeadVoice(features({ centroidHz: 500, brightRatio: 0.02, attack: { seconds: 0.3, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('is a strict majority vote: two bright signals out of three wins bright', () => {
    const result = selectLeadVoice(features({ centroidHz: 4000, brightRatio: 0.8, attack: { seconds: 0.3, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.bright.sound)
  })

  it('is a strict majority vote: one bright signal out of three loses to mellow', () => {
    const result = selectLeadVoice(features({ centroidHz: 4000, brightRatio: 0.02, attack: { seconds: 0.3, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('resolves a tie (two signals measured, split) to the conservative mellow default', () => {
    const result = selectLeadVoice(features({ centroidHz: 4000, brightRatio: 0.02 }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('trusts a single measured signal on its own when nothing else was measured', () => {
    const bright = selectLeadVoice(features({ centroidHz: 4000 }))
    expect(bright.sound).toBe(LEAD_VOICES.bright.sound)
    const dark = selectLeadVoice(features({ centroidHz: 500 }))
    expect(dark.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('reads the centroid threshold boundary as bright (>=), not dark', () => {
    const result = selectLeadVoice(features({ centroidHz: 2000 }))
    expect(result.sound).toBe(LEAD_VOICES.bright.sound)
    const justUnder = selectLeadVoice(features({ centroidHz: 1999.9 }))
    expect(justUnder.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('reads the brightRatio threshold boundary as bright (>=), not dark', () => {
    const result = selectLeadVoice(features({ brightRatio: 0.33 }))
    expect(result.sound).toBe(LEAD_VOICES.bright.sound)
    const justUnder = selectLeadVoice(features({ brightRatio: 0.329 }))
    expect(justUnder.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('reads the attack threshold boundary as bright (<=), not dark', () => {
    const result = selectLeadVoice(features({ attack: { seconds: 0.035, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.bright.sound)
    const justOver = selectLeadVoice(features({ attack: { seconds: 0.0351, count: 5 } }))
    expect(justOver.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('never lets oddEvenRatio alone decide the voice', () => {
    // Only oddEvenRatio is set - every scored signal (centroid, brightRatio,
    // attack) is null, so `signals` is 0 and the vote cannot resolve to
    // bright regardless of how extreme the ratio is.
    const result = selectLeadVoice(features({ oddEvenRatio: 50 }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('never lets sustain alone decide the voice', () => {
    const result = selectLeadVoice(features({ sustain: { seconds: 0.9, count: 5 } }))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
  })

  it('reports the measured numbers in its notes', () => {
    const result = selectLeadVoice(
      features({ centroidHz: 3210, brightRatio: 0.42, attack: { seconds: 0.02, count: 6 }, sustain: { seconds: 0.15, count: 6 }, oddEvenRatio: 1.5 }),
    )
    const joined = result.notes.join(' ')
    expect(joined).toMatch(/3210Hz/)
    expect(joined).toMatch(/42%/)
    expect(joined).toMatch(/20ms/)
    expect(joined).toMatch(/150ms/)
    expect(joined).toMatch(/1\.50/)
  })

  it('notes when attack could not be measured, without failing the decision', () => {
    const result = selectLeadVoice(features({ centroidHz: 500 }))
    expect(result.notes.join(' ')).toMatch(/attack left unmeasured/)
  })
})

describe('deriveLeadVoice', () => {
  it('falls back to the mellow default when there is no other stem to measure', () => {
    const lead = { loopBars: 1, events: [noteEvent(0, 60), noteEvent(4, 64), noteEvent(8, 67)], confidence: 0.9 }
    const t = transcription([{ index: 0, startBar: 0, bars: 1, label: 'a', sameAs: null, loops: { lead } }])
    const result = deriveLeadVoice(t, null)
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
    expect(result.notes.join(' ')).toMatch(/only 0 onset/)
  })

  it('falls back to the mellow default when the track has no lead at all', () => {
    const t = transcription([{ index: 0, startBar: 0, bars: 1, label: 'a', sameAs: null, loops: { lead: null } }])
    const result = deriveLeadVoice(t, Buffer.alloc(0))
    expect(result.sound).toBe(LEAD_VOICES.mellow.sound)
    expect(result.notes.join(' ')).toMatch(/only 0 onset/)
  })
})
