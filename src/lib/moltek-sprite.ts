/**
 * =============================================================================
 * MOLTEK SPRITE
 * =============================================================================
 *
 * Moltek is built only from squares, no curves. Nine rects in a 107x86 box
 * with the ground at y=86, plus the headphones that make him a DJ.
 *
 * The ids are character-relative, which is why `left` sits on screen right.
 * Do not adjust these numbers to taste: the regression test exists because a
 * one-unit drift in an eye is invisible in review and obvious on screen.
 */

export type Rect = { x: number; y: number; w: number; h: number; fill: string }

/**
 * The body sits brighter than the accent so it clears the floor: 5.83:1
 * against the slate background, where the 3:1 floor is what keeps the sprite
 * readable. See scripts/themes.mjs, which fails the build if it drops below.
 */
export const MOLTEK_BODY = '#E0714F'
const EYE_BLACK = '#000000'

/**
 * The studio palette. The gear and the room are built from the cold end of it
 * and the warm accent is reserved for things that are actually lit, so what
 * separates the mascot from his equipment is temperature rather than hue. That
 * rule is why a booth painted in the accent does not swallow him.
 */
export const BRAND = {
  orange: '#D97757',
  ivory: '#F0EEE6',
  cream: '#E8E6DC',
  light: '#C6C4BA',
  mid: '#B0AEA5',
  neutral: '#87867F',
  dark: '#3D3D3A',
  slate: '#141413',
} as const

/**
 * The cans are pale, not slate. Slate gear is the same value as the background,
 * so the band and both arms sit above the head and vanish into the room: only
 * the sliver of cup overlapping the body ever shows, and the DJ read is lost.
 * Pale clears both floors at once, 12.1:1 on the room and 2.07:1 on the body.
 * GEAR_PAD is the ear pad inside the cup, so it sits *darker* than the cup to
 * read as a recess.
 */
const GEAR = '#D5D1C6'
const GEAR_PAD = BRAND.mid

/** The origin the body rotates about. */
export const PIVOT = { x: 53, y: 65 } as const
export const GROUND_Y = 86
/**
 * Widened from the sprite box to leave room for the headphones above and the
 * booth to either side. Moltek himself still occupies exactly 0..107.
 */
export const VIEWBOX = { x: -56, y: -48, w: 219, h: 152 } as const

export const BODY: Rect = { x: 11, y: 0, w: 85, h: 65, fill: MOLTEK_BODY }

/** Screen order: left, right. Character-relative names are the reverse. */
export const HANDS: Rect[] = [
  { x: 0, y: 21, w: 22, h: 23, fill: MOLTEK_BODY },
  { x: 85, y: 21, w: 22, h: 23, fill: MOLTEK_BODY },
]

export const EYES: Rect[] = [
  { x: 21, y: 11, w: 11, h: 11, fill: EYE_BLACK },
  { x: 75, y: 11, w: 11, h: 11, fill: EYE_BLACK },
]

export const LEGS: Rect[] = [
  { x: 11, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
  { x: 32, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
  { x: 64, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
  { x: 85, y: 60, w: 11, h: 26, fill: MOLTEK_BODY },
]

/**
 * Over-ear headphones. The cups straddle the body edges at x=11 and x=96 so
 * they read as clamped to his head rather than floating beside it. The right
 * cup is drawn separately so it can ride high, pushed off the ear.
 */
export const CANS: Rect[] = [
  { x: 20, y: -10, w: 67, h: 7, fill: GEAR },
  { x: 14, y: -7, w: 6, h: 10, fill: GEAR },
  { x: 87, y: -7, w: 6, h: 10, fill: GEAR },
  { x: 5, y: 1, w: 14, h: 25, fill: GEAR },
  { x: 8, y: 6, w: 8, h: 15, fill: GEAR_PAD },
]

/** The pushed-off cup, offset by (3, -11) from its clamped position. */
export const CUP_OFF: Rect[] = [
  { x: 88, y: 1, w: 14, h: 25, fill: GEAR },
  { x: 91, y: 6, w: 8, h: 15, fill: GEAR_PAD },
]
export const CUP_OFF_OFFSET = { x: 3, y: -11 } as const

/** Keeps legs from stretching through the floor. */
export const GROUND_CLIP: Rect = { x: -20, y: -50, w: 160, h: 136, fill: 'none' }

/**
 * The booth. Its top edge sits at y=58, which is above the leg tops at y=60,
 * so it reads as gear he stands behind while the last 10 units of leg stay
 * visible underneath. Drawn after the body and before the claws, so the claws
 * rest on the surface rather than behind it.
 */
export const BOOTH: Rect[] = [
  { x: -28, y: 58, w: 163, h: 4, fill: BRAND.neutral },
  { x: -28, y: 62, w: 163, h: 14, fill: GEAR },
  { x: -22, y: 64, w: 28, h: 10, fill: BRAND.dark },
  { x: 101, y: 64, w: 28, h: 10, fill: BRAND.dark },
  { x: 38, y: 63, w: 31, h: 12, fill: BRAND.dark },
  { x: 41, y: 71, w: 25, h: 3, fill: GEAR },
]

/** Jog wheels, one per deck. */
export const BOOTH_JOGS: Rect[] = [
  { x: -15, y: 66, w: 8, h: 6, fill: BRAND.mid },
  { x: 112, y: 66, w: 8, h: 6, fill: BRAND.mid },
]

/** Channel faders and the crossfader. Cream caps, so they read as gear. */
export const BOOTH_FADERS: Rect[] = [
  { x: 42, y: 65, w: 4, h: 5, fill: BRAND.ivory },
  { x: 49, y: 65, w: 4, h: 5, fill: BRAND.ivory },
  { x: 56, y: 65, w: 4, h: 5, fill: BRAND.ivory },
]
export const BOOTH_XFADER: Rect = { x: 47, y: 70, w: 6, h: 5, fill: BRAND.light }

/** Level LEDs across the right of the booth, lit from the master level. */
export const BOOTH_LEDS: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: 74 + i * 4.5,
  y: 66,
  w: 3,
  h: 5,
  fill: BRAND.dark,
}))
/**
 * Meter colours, deliberately cold. These sit inches from the mascot, and
 * the brand orange is close enough to his own #E0714F that an orange LED
 * here reads as a stray piece of him. The warm orange lives up in the light
 * rig instead, where the distance makes it read as light rather than body.
 */
export const LED_OFF = BRAND.dark
export const LED_ON = BRAND.light
export const LED_HOT = BRAND.ivory

/* ===========================================================================
   THE ROOM
   A Berlin back room: bare wall, a light rig overhead, a stack either side,
   and the backs of a few heads. Built from the same squares as everything
   else so the scene never reads as a different medium from the sprite.
   =========================================================================== */

/** Back wall and floor. The wall takes a stepped gradient, see WALL_BANDS. */
export const ROOM = { x: -56, y: -48, w: 219, h: 152 } as const

/** Stepped wall bands, darkest at the top. A smooth gradient would fight the
    hard pixel edges, so the fade is quantised into flat strips instead. */
export const WALL_BANDS: Rect[] = [
  { x: -56, y: -48, w: 219, h: 26, fill: '#0A0A09' },
  { x: -56, y: -22, w: 219, h: 26, fill: '#121211' },
  { x: -56, y: 4, w: 219, h: 26, fill: '#1B1B19' },
  { x: -56, y: 30, w: 219, h: 30, fill: '#232320' },
]
/** Floor, lighter than the wall so the crowd silhouettes read against it. */
export const FLOOR: Rect = { x: -56, y: 60, w: 219, h: 44, fill: '#2A2A26' }

/** Overhead truss and its lamps. The lamps flash on the kick. */
export const TRUSS: Rect[] = [
  { x: -46, y: -44, w: 199, h: 5, fill: BRAND.dark },
  { x: -46, y: -39, w: 199, h: 2, fill: '#2A2A28' },
]
export const LAMPS: Rect[] = Array.from({ length: 7 }, (_, i) => ({
  x: -34 + i * 29,
  y: -37,
  w: 9,
  h: 6,
  fill: BRAND.dark,
}))
/**
 * The cone of light under each lamp, opacity driven by the beat.
 *
 * The rig is where the brand orange belongs: it is warm light thrown from
 * above and behind, far from the mascot. What stays cold is the hardware he
 * actually touches, because orange down at the booth reads as stray pieces
 * of him rather than as equipment.
 */
export const BEAMS: Rect[] = LAMPS.flatMap((l) => [
  { x: l.x - 2, y: l.y + 6, w: l.w + 4, h: 16, fill: BRAND.orange },
  { x: l.x - 7, y: l.y + 22, w: l.w + 14, h: 16, fill: BRAND.orange },
  { x: l.x - 13, y: l.y + 38, w: l.w + 26, h: 18, fill: BRAND.orange },
])
/** Per-segment opacity, so the three stacked rects read as a widening cone. */
export const BEAM_ALPHAS = [0.34, 0.2, 0.1]

/** Speaker stacks either side. The woofer square pumps with the bass. */
export const STACKS: Rect[] = [
  { x: -54, y: -6, w: 26, h: 66, fill: '#0F0F0E' },
  { x: -52, y: -4, w: 22, h: 62, fill: BRAND.slate },
  { x: 135, y: -6, w: 26, h: 66, fill: '#0F0F0E' },
  { x: 137, y: -4, w: 22, h: 62, fill: BRAND.slate },
]
export const WOOFERS: Rect[] = [
  { x: -48, y: 8, w: 14, h: 14, fill: BRAND.dark },
  { x: 141, y: 8, w: 14, h: 14, fill: BRAND.dark },
]
/** Grille slots, purely texture. */
export const GRILLES: Rect[] = [
  ...Array.from({ length: 4 }, (_, i) => ({ x: -49, y: 28 + i * 6, w: 16, h: 2, fill: '#232322' })),
  ...Array.from({ length: 4 }, (_, i) => ({ x: 140, y: 28 + i * 6, w: 16, h: 2, fill: '#232322' })),
]

/**
 * Haze, in place of a crowd.
 *
 * A figure is about ten units tall here, which is too small to read as a
 * person: silhouettes just look like missing tiles. Haze has no shape to
 * misread, it is the most Berghain thing in the room, and it gives the light
 * beams something to land on, which is what makes a beam look like a beam
 * instead of a coloured rectangle.
 *
 * Bands are far wider than the frame so they can drift without their ends
 * ever coming into view.
 */
export const HAZE_BACK: Rect[] = [
  { x: -200, y: 18, w: 520, h: 16, fill: BRAND.orange },
  { x: -200, y: 34, w: 520, h: 20, fill: BRAND.ivory },
]
export const HAZE_BACK_ALPHAS = [0.05, 0.04]
export const HAZE_BACK_DRIFT = [6, -4]

export const HAZE_FRONT: Rect[] = [
  { x: -200, y: 64, w: 520, h: 14, fill: BRAND.ivory },
  { x: -200, y: 78, w: 520, h: 16, fill: BRAND.orange },
  { x: -200, y: 92, w: 520, h: 18, fill: BRAND.ivory },
]
export const HAZE_FRONT_ALPHAS = [0.05, 0.07, 0.09]
/** Units per second. Opposing directions keep it from reading as a slide. */
export const HAZE_FRONT_DRIFT = [-5, 7, -3]
