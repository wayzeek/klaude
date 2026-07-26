import { describe, expect, it } from 'vitest'
import {
  BODY,
  BOOTH,
  BOOTH_FADERS,
  BOOTH_JOGS,
  BOOTH_LEDS,
  BOOTH_XFADER,
  BEAMS,
  CANS,
  CUP_OFF,
  CUP_OFF_OFFSET,
  EYES,
  GRILLES,
  GROUND_CLIP,
  GROUND_Y,
  HANDS,
  HAZE_BACK,
  HAZE_FRONT,
  LAMPS,
  LED_HOT_FROM,
  LEGS,
  PIVOT,
  STACKS,
  TRUSS,
  VIEWBOX,
  WALL_BANDS,
  WOOFERS,
  FLOOR,
  type Rect,
} from '@/lib/moltek-sprite'

describe('moltek sprite', () => {
  it('matches the locked geometry exactly', () => {
    expect(BODY).toEqual({ x: 11, y: 0, w: 85, h: 65, role: 'm-body' })
    expect(HANDS).toEqual([
      { x: 0, y: 21, w: 22, h: 23, role: 'm-body' },
      { x: 85, y: 21, w: 22, h: 23, role: 'm-body' },
    ])
    expect(EYES).toEqual([
      { x: 21, y: 11, w: 11, h: 11, role: 'm-eye' },
      { x: 75, y: 11, w: 11, h: 11, role: 'm-eye' },
    ])
    expect(LEGS.map((l) => l.x)).toEqual([11, 32, 64, 85])
    expect(LEGS.every((l) => l.y === 60 && l.w === 11 && l.h === 26)).toBe(true)
  })

  it('is built only from squares', () => {
    const all = [BODY, ...LEGS, ...HANDS, ...EYES, ...CANS]
    expect(all.every((r) => r.w > 0 && r.h > 0)).toBe(true)
  })

  it('pins every leg exactly, including role', () => {
    expect(LEGS).toEqual([
      { x: 11, y: 60, w: 11, h: 26, role: 'm-body' },
      { x: 32, y: 60, w: 11, h: 26, role: 'm-body' },
      { x: 64, y: 60, w: 11, h: 26, role: 'm-body' },
      { x: 85, y: 60, w: 11, h: 26, role: 'm-body' },
    ])
  })

  it('pins the headphone geometry exactly', () => {
    expect(CANS).toEqual([
      { x: 20, y: -10, w: 67, h: 7, role: 'm-gear' },
      { x: 14, y: -7, w: 6, h: 10, role: 'm-gear' },
      { x: 87, y: -7, w: 6, h: 10, role: 'm-gear' },
      { x: 5, y: 1, w: 14, h: 25, role: 'm-gear' },
      { x: 8, y: 6, w: 8, h: 15, role: 'm-pad' },
    ])
    expect(CUP_OFF).toEqual([
      { x: 88, y: 1, w: 14, h: 25, role: 'm-gear' },
      { x: 91, y: 6, w: 8, h: 15, role: 'm-pad' },
    ])
    expect(CUP_OFF_OFFSET).toEqual({ x: 3, y: -11 })
  })

  it('pins the rig constants exactly: pivot, ground, viewbox, clip', () => {
    expect(PIVOT).toEqual({ x: 53, y: 65 })
    expect(GROUND_Y).toBe(86)
    expect(VIEWBOX).toEqual({ x: -56, y: -48, w: 219, h: 152 })
    // Geometry only. It clips, it is never painted, so it carries no role.
    expect(GROUND_CLIP).toEqual({ x: -20, y: -50, w: 160, h: 136 })
  })

  it('keeps the booth clear of the sprite and inside the viewBox', () => {
    const parts = [...BOOTH, ...BOOTH_JOGS, ...BOOTH_FADERS, BOOTH_XFADER, ...BOOTH_LEDS]
    for (const r of parts) {
      expect(r.x).toBeGreaterThanOrEqual(VIEWBOX.x)
      expect(r.x + r.w).toBeLessThanOrEqual(VIEWBOX.x + VIEWBOX.w)
      expect(r.y + r.h).toBeLessThanOrEqual(VIEWBOX.y + VIEWBOX.h)
    }
    // The surface must sit above the leg tops so the legs stay partly visible
    // underneath rather than reading as four detached blocks.
    const surface = Math.min(...BOOTH.map((r) => r.y))
    expect(surface).toBe(58)
    expect(surface).toBeLessThan(LEGS[0].y)
    expect(LEGS[0].y + LEGS[0].h).toBeGreaterThan(Math.max(...BOOTH.map((r) => r.y + r.h)))
  })

  it('carries no colour of its own, only roles', () => {
    const every: Rect[] = [
      BODY, ...HANDS, ...EYES, ...LEGS, ...CANS, ...CUP_OFF,
      ...BOOTH, ...BOOTH_JOGS, ...BOOTH_FADERS, BOOTH_XFADER, ...BOOTH_LEDS,
      ...WALL_BANDS, FLOOR, ...TRUSS, ...LAMPS, ...BEAMS,
      ...STACKS, ...WOOFERS, ...GRILLES, ...HAZE_BACK, ...HAZE_FRONT,
    ]
    for (const r of every) {
      // A stray hex anywhere here is a rect that will not follow a theme switch,
      // which is the exact bug roles exist to make impossible.
      expect(JSON.stringify(r)).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      expect(r.role).toMatch(/^m-[a-z0-9-]+$/)
    }
  })

  it('separates the headphones from the booth furniture', () => {
    // These shared one constant once, so changing the cans to pale silently
    // turned the booth pale too. Different roles are what stops that recurring.
    const cans = new Set(CANS.map((r) => r.role))
    const booth = new Set(BOOTH.map((r) => r.role))
    for (const role of cans) expect(booth.has(role)).toBe(false)
  })

  it('drives the meter by state, not by colour', () => {
    expect(BOOTH_LEDS).toHaveLength(12)
    expect(BOOTH_LEDS.every((l) => l.role === 'm-led')).toBe(true)
    // The top two segments read hot; anything else would silently change what
    // clipping looks like.
    expect(LED_HOT_FROM).toBe(10)
    expect(BOOTH_LEDS.length - LED_HOT_FROM).toBe(2)
  })
})
