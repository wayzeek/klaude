import { describe, expect, it } from 'vitest'
import {
  BODY,
  BOOTH,
  BRAND,
  BOOTH_FADERS,
  BOOTH_JOGS,
  BOOTH_LEDS,
  BOOTH_XFADER,
  CANS,
  MOLTEK_BODY,
  CUP_OFF,
  CUP_OFF_OFFSET,
  EYES,
  GROUND_CLIP,
  GROUND_Y,
  HANDS,
  LEGS,
  PIVOT,
  VIEWBOX,
} from '@/lib/moltek-sprite'

describe('moltek sprite', () => {
  it('matches the locked geometry exactly', () => {
    expect(BODY).toEqual({ x: 11, y: 0, w: 85, h: 65, fill: MOLTEK_BODY })
    expect(HANDS).toEqual([
      { x: 0, y: 21, w: 22, h: 23, fill: MOLTEK_BODY },
      { x: 85, y: 21, w: 22, h: 23, fill: MOLTEK_BODY },
    ])
    expect(EYES).toEqual([
      { x: 21, y: 11, w: 11, h: 11, fill: '#000000' },
      { x: 75, y: 11, w: 11, h: 11, fill: '#000000' },
    ])
    expect(LEGS.map((l) => l.x)).toEqual([11, 32, 64, 85])
    expect(LEGS.every((l) => l.y === 60 && l.w === 11 && l.h === 26)).toBe(true)
  })

  it('uses the themed body colour', () => {
    expect(MOLTEK_BODY).toBe('#E0714F')
  })

  it('is built only from squares', () => {
    const all = [BODY, ...LEGS, ...HANDS, ...EYES, ...CANS]
    expect(all.every((r) => r.w > 0 && r.h > 0)).toBe(true)
  })

  it('pins every leg exactly, including fill', () => {
    expect(LEGS).toEqual([
      { x: 11, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
      { x: 32, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
      { x: 64, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
      { x: 85, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
    ])
  })

  it('pins the headphone geometry exactly', () => {
    // The cans are pale rather than slate: slate matched the background, so the
    // band and both arms vanished into the room and only the sliver of cup
    // overlapping the body ever showed. The pad inside the cup sits darker than
    // the cup so it reads as a recess.
    const CAN = '#D5D1C6'
    expect(CANS).toEqual([
      { x: 20, y: -10, w: 67, h: 7, fill: CAN },
      { x: 14, y: -7, w: 6, h: 10, fill: CAN },
      { x: 87, y: -7, w: 6, h: 10, fill: CAN },
      { x: 5, y: 1, w: 14, h: 25, fill: CAN },
      { x: 8, y: 6, w: 8, h: 15, fill: BRAND.mid },
    ])
    expect(CUP_OFF).toEqual([
      { x: 88, y: 1, w: 14, h: 25, fill: CAN },
      { x: 91, y: 6, w: 8, h: 15, fill: BRAND.mid },
    ])
    expect(CUP_OFF_OFFSET).toEqual({ x: 3, y: -11 })
  })

  it('pins the rig constants exactly: pivot, ground, viewbox, clip', () => {
    expect(PIVOT).toEqual({ x: 53, y: 65 })
    expect(GROUND_Y).toBe(86)
    expect(VIEWBOX).toEqual({ x: -56, y: -48, w: 219, h: 152 })
    expect(GROUND_CLIP).toEqual({ x: -20, y: -50, w: 160, h: 136, fill: 'none' })
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
})
