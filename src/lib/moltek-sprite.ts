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
 *
 * NO COLOURS LIVE HERE. Every rect declares a `role`, which is a CSS class
 * defined per theme in themes.generated.css. That is what makes "the mascot and
 * the UI are always in sync" true by construction: there is nothing to keep in
 * step, because the sprite has no opinion about colour at all. Roles are also
 * why the booth cannot accidentally inherit the headphones' colour, which is
 * exactly what happened when both read from one shared constant.
 */

/** A role is a CSS class from the `.m-*` set in globals.css. */
export type Role =
  | 'm-body'
  | 'm-gear'
  | 'm-pad'
  | 'm-eye'
  | 'm-accent'
  | 'm-chrome-top'
  | 'm-chrome'
  | 'm-chrome-deep'
  | 'm-chrome-hi'
  | 'm-cap'
  | 'm-cap-2'
  | 'm-wall-1'
  | 'm-wall-2'
  | 'm-wall-3'
  | 'm-wall-4'
  | 'm-floor'
  | 'm-stack'
  | 'm-stack-in'
  | 'm-grille'
  | 'm-truss-hi'
  | 'm-led'
  | 'm-lamp'

export type Rect = { x: number; y: number; w: number; h: number; role: Role }

/** The origin the body rotates about. */
export const PIVOT = { x: 53, y: 65 } as const
export const GROUND_Y = 86
/**
 * Widened from the sprite box to leave room for the headphones above and the
 * booth to either side. Moltek himself still occupies exactly 0..107.
 */
export const VIEWBOX = { x: -56, y: -48, w: 219, h: 152 } as const

export const BODY: Rect = { x: 11, y: 0, w: 85, h: 65, role: 'm-body' }

/** Screen order: left, right. Character-relative names are the reverse. */
export const HANDS: Rect[] = [
  { x: 0, y: 21, w: 22, h: 23, role: 'm-body' },
  { x: 85, y: 21, w: 22, h: 23, role: 'm-body' },
]

export const EYES: Rect[] = [
  { x: 21, y: 11, w: 11, h: 11, role: 'm-eye' },
  { x: 75, y: 11, w: 11, h: 11, role: 'm-eye' },
]

export const LEGS: Rect[] = [
  { x: 11, y: 60, w: 11, h: 26, role: 'm-body' },
  { x: 32, y: 60, w: 11, h: 26, role: 'm-body' },
  { x: 64, y: 60, w: 11, h: 26, role: 'm-body' },
  { x: 85, y: 60, w: 11, h: 26, role: 'm-body' },
]

/**
 * Over-ear headphones. The cups straddle the body edges at x=11 and x=96 so
 * they read as clamped to his head rather than floating beside it. The right
 * cup is drawn separately so it can ride high, pushed off the ear.
 *
 * The cans are pale rather than slate: slate is the same value as the room, so
 * the band and both arms vanished into it and only the sliver of cup overlapping
 * the body ever showed, which left him not visibly wearing headphones at all.
 * The gate holds this at 3:1 against the room and 2:1 against the body.
 */
export const CANS: Rect[] = [
  { x: 20, y: -10, w: 67, h: 7, role: 'm-gear' },
  { x: 14, y: -7, w: 6, h: 10, role: 'm-gear' },
  { x: 87, y: -7, w: 6, h: 10, role: 'm-gear' },
  { x: 5, y: 1, w: 14, h: 25, role: 'm-gear' },
  { x: 8, y: 6, w: 8, h: 15, role: 'm-pad' },
]

/** The pushed-off cup, offset by (3, -11) from its clamped position. */
export const CUP_OFF: Rect[] = [
  { x: 88, y: 1, w: 14, h: 25, role: 'm-gear' },
  { x: 91, y: 6, w: 8, h: 15, role: 'm-pad' },
]
export const CUP_OFF_OFFSET = { x: 3, y: -11 } as const

/** Keeps legs from stretching through the floor. Geometry only, never filled. */
export const GROUND_CLIP = { x: -20, y: -50, w: 160, h: 136 } as const

/**
 * The booth. Its top edge sits at y=58, which is above the leg tops at y=60,
 * so it reads as gear he stands behind while the last 10 units of leg stay
 * visible underneath. Drawn after the body and before the claws, so the claws
 * rest on the surface rather than behind it.
 */
export const BOOTH: Rect[] = [
  { x: -28, y: 58, w: 163, h: 4, role: 'm-chrome-top' },
  { x: -28, y: 62, w: 163, h: 14, role: 'm-chrome-deep' },
  { x: -22, y: 64, w: 28, h: 10, role: 'm-chrome' },
  { x: 101, y: 64, w: 28, h: 10, role: 'm-chrome' },
  { x: 38, y: 63, w: 31, h: 12, role: 'm-chrome' },
  { x: 41, y: 71, w: 25, h: 3, role: 'm-chrome-deep' },
]

/** Jog wheels, one per deck. */
export const BOOTH_JOGS: Rect[] = [
  { x: -15, y: 66, w: 8, h: 6, role: 'm-chrome-hi' },
  { x: 112, y: 66, w: 8, h: 6, role: 'm-chrome-hi' },
]

/** Channel faders and the crossfader. Pale caps, so they read as gear. */
export const BOOTH_FADERS: Rect[] = [
  { x: 42, y: 65, w: 4, h: 5, role: 'm-cap' },
  { x: 49, y: 65, w: 4, h: 5, role: 'm-cap' },
  { x: 56, y: 65, w: 4, h: 5, role: 'm-cap' },
]
export const BOOTH_XFADER: Rect = { x: 47, y: 70, w: 6, h: 5, role: 'm-cap-2' }

/**
 * Level LEDs across the right of the booth, lit from the master level.
 *
 * Deliberately cold. These sit inches from the mascot, and the accent is close
 * enough to his own body colour that an accent-coloured LED here reads as a
 * stray piece of him. The warm accent lives up in the light rig instead, where
 * the distance makes it read as light rather than body.
 *
 * Lit state is a `data-lit` attribute the animation loop sets, not a fill it
 * writes, so a theme switch reaches them like everything else.
 */
export const BOOTH_LEDS: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: 74 + i * 4.5,
  y: 66,
  w: 3,
  h: 5,
  role: 'm-led' as Role,
}))
/** Threshold index above which an LED goes from `on` to `hot`. */
export const LED_HOT_FROM = 10

/* ===========================================================================
   THE ROOM
   A Berlin back room: bare wall, a light rig overhead, a stack either side,
   and haze. Built from the same squares as everything else so the scene never
   reads as a different medium from the sprite.
   =========================================================================== */

export const ROOM = { x: -56, y: -48, w: 219, h: 152 } as const

/** Stepped wall bands, darkest at the top. A smooth gradient would fight the
    hard pixel edges, so the fade is quantised into flat strips instead. */
export const WALL_BANDS: Rect[] = [
  { x: -56, y: -48, w: 219, h: 26, role: 'm-wall-1' },
  { x: -56, y: -22, w: 219, h: 26, role: 'm-wall-2' },
  { x: -56, y: 4, w: 219, h: 26, role: 'm-wall-3' },
  { x: -56, y: 30, w: 219, h: 30, role: 'm-wall-4' },
]
/** Floor, lifted off the wall so what stands on it reads. */
export const FLOOR: Rect = { x: -56, y: 60, w: 219, h: 44, role: 'm-floor' }

/** Overhead truss and its lamps. The lamps flash on the kick. */
export const TRUSS: Rect[] = [
  { x: -46, y: -44, w: 199, h: 5, role: 'm-chrome' },
  { x: -46, y: -39, w: 199, h: 2, role: 'm-truss-hi' },
]
export const LAMPS: Rect[] = Array.from({ length: 7 }, (_, i) => ({
  x: -34 + i * 29,
  y: -37,
  w: 9,
  h: 6,
  role: 'm-lamp' as Role,
}))
/**
 * The cone of light under each lamp, opacity driven by the beat.
 *
 * The rig is where the accent belongs: warm light thrown from above and behind,
 * far from the mascot. What stays cold is the hardware he actually touches,
 * because an accent down at the booth reads as stray pieces of him rather than
 * as equipment.
 */
export const BEAMS: Rect[] = LAMPS.flatMap((l) => [
  { x: l.x - 2, y: l.y + 6, w: l.w + 4, h: 16, role: 'm-accent' as Role },
  { x: l.x - 7, y: l.y + 22, w: l.w + 14, h: 16, role: 'm-accent' as Role },
  { x: l.x - 13, y: l.y + 38, w: l.w + 26, h: 18, role: 'm-accent' as Role },
])
/** Per-segment opacity, so the three stacked rects read as a widening cone. */
export const BEAM_ALPHAS = [0.34, 0.2, 0.1]

/** Speaker stacks either side. The woofer square pumps with the bass. */
export const STACKS: Rect[] = [
  { x: -54, y: -6, w: 26, h: 66, role: 'm-stack' },
  { x: -52, y: -4, w: 22, h: 62, role: 'm-stack-in' },
  { x: 135, y: -6, w: 26, h: 66, role: 'm-stack' },
  { x: 137, y: -4, w: 22, h: 62, role: 'm-stack-in' },
]
export const WOOFERS: Rect[] = [
  { x: -48, y: 8, w: 14, h: 14, role: 'm-chrome' },
  { x: 141, y: 8, w: 14, h: 14, role: 'm-chrome' },
]
/** Grille slots, purely texture. */
export const GRILLES: Rect[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    x: -49, y: 28 + i * 6, w: 16, h: 2, role: 'm-grille' as Role,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    x: 140, y: 28 + i * 6, w: 16, h: 2, role: 'm-grille' as Role,
  })),
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
  { x: -200, y: 18, w: 520, h: 16, role: 'm-accent' },
  { x: -200, y: 34, w: 520, h: 20, role: 'm-cap' },
]
export const HAZE_BACK_ALPHAS = [0.05, 0.04]
export const HAZE_BACK_DRIFT = [6, -4]

export const HAZE_FRONT: Rect[] = [
  { x: -200, y: 64, w: 520, h: 14, role: 'm-cap' },
  { x: -200, y: 78, w: 520, h: 16, role: 'm-accent' },
  { x: -200, y: 92, w: 520, h: 18, role: 'm-cap' },
]
export const HAZE_FRONT_ALPHAS = [0.05, 0.07, 0.09]
/** Units per second. Opposing directions keep it from reading as a slide. */
export const HAZE_FRONT_DRIFT = [-5, 7, -3]
