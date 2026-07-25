/**
 * =============================================================================
 * MOLTEK MOTION
 * =============================================================================
 *
 * The spring rig. Pure: no DOM, no clock, no audio. It takes the beats that
 * just landed, the current spectrum, and how much time has passed, and returns
 * a pose.
 *
 * Springs rather than tweens, because a tween owns its own clock and music
 * does not. At 150bpm the hats retrigger every 100ms, which thrashes a
 * timeline but merely adds energy to a spring, so retriggering is free and
 * layers never fight each other.
 *
 * Three properties keep it stable, and all three are load-bearing:
 *   - elapsed time is clamped, so a backgrounded tab cannot integrate one
 *     enormous step on the frame it comes back
 *   - integration runs at a fixed substep, so stiff springs stay stable
 *     regardless of frame rate
 *   - impulses are bucketed per frame and saturated, so coincident layers
 *     cannot sum without bound and the pose never depends on callback order
 */

import type { Role } from '@/lib/sound-roles'

export type Bands = { rms: number; sub: number; bass: number; mid: number; high: number }
export type Pulse = { role: Role; intensity: number; cyclePos: number; cps: number }

export type Pose = {
  body: { x: number; y: number; rotation: number; scaleY: number }
  legs: { rotation: number; scaleY: number }[]
  hands: { x: number; y: number; rotation: number }[]
  eyes: { x: number; y: number; scaleY: number }
  /** Whole-figure vertical offset. Negative is airborne. */
  lift: number
  strobe: number
}

/** Roughly three frames. Anything longer is a stall, not a frame. */
export const MAX_DT = 0.05
/** Fixed integration substep, independent of display refresh rate. */
const SUBSTEP = 1 / 240
/**
 * Ceiling on velocity injected into any one channel in a single frame. Raised
 * from the original 90 because the retuned thump-to-body impulse alone needs
 * ~290 at ordinary levels (MOVE 1.7, intensity 1) to reach the 8-unit
 * landing depth; 400 leaves that comfortably unsaturated (289 of 400) at a
 * single ordinary hit. An accented hit (intensity 2) or several coincident
 * layers can still reach it, which is exactly its job: bound the pose no
 * matter how many pulses land in the same frame.
 */
const MAX_IMPULSE = 400

/** Walk-cycle arrays. The graduation is what stops him reading as a box. */
const LEG_ROT = [-7, -8, -8, -9]
const LEG_SCALE = [1.35, 1.3, 1.2, 1.15]
/**
 * Each leg's share of any whole-body leg gesture, from the graduated scale
 * array. The beat response has always used this graduation; the moves did not,
 * which is why the shimmy came out as two pairs of legs moving in lockstep.
 */
const LEG_WEIGHT = LEG_SCALE.map((s) => (s - 1) / 0.35)
/**
 * The movement setting every gain in this file is quoted against (`MOVE` in
 * moltek.tsx). Impulses scale with `m` directly, but a hold is expressed in
 * final pose units, so it divides by this to stay honest at other settings.
 */
const MOVE_REF = 1.7

type Spring = { x: number; v: number; target: number; k: number; c: number }

function spring(k: number, rest = 0): Spring {
  // c = 2*sqrt(k) is critical damping: fastest return to rest with no overshoot.
  return { x: rest, v: 0, target: rest, k, c: 2 * Math.sqrt(k) }
}

function integrate(s: Spring, dt: number): void {
  let remaining = dt
  while (remaining > 0) {
    const h = Math.min(SUBSTEP, remaining)
    s.v += (-s.k * (s.x - s.target) - s.c * s.v) * h
    s.x += s.v * h
    remaining -= h
  }
}

function impulse(s: Spring, amount: number): void {
  s.v = Math.max(-MAX_IMPULSE, Math.min(MAX_IMPULSE, s.v + amount))
}

export type Rig = {
  body: Spring
  bodyX: Spring
  lean: Spring
  squash: Spring
  rock: Spring
  legRot: Spring[]
  legScale: Spring[]
  handY: Spring[]
  handX: Spring[]
  eyeX: Spring
  eyeY: Spring
  blink: Spring
  strobe: number
  leanDir: number
  shuffle: number
  /** Position within the current cycle, [0, 1). */
  phase: number
  /** Cycles per second, taken from the music rather than assumed. */
  cps: number
  /** Whole cycles elapsed, counted from cyclePos wrapping. Drives the stance. */
  cycle: number
  /** Previous cyclePos, so a wrap can be detected. */
  lastPos: number
  /** Snaps seen, so the lean can hold a direction for more than one backbeat. */
  snaps: number
  /** Seconds since the last blink. */
  blinkT: number
  /** Seconds to wait before the next one. */
  blinkGap: number
  /** Alternates so melodic notes pull the eyes both ways. */
  melodyDir: number
  /** Whole-figure hop. Only a move drives this; beats never do. */
  hop: Spring
  /**
   * The showman move in progress, if any. `m` is captured when the move starts
   * rather than read per frame, so dragging the movement slider mid-move cannot
   * scale a landing differently from the takeoff that earned it. `dir` is the
   * move's own lean direction, so a move can dip to one side without rewriting
   * the backbeat weight shift that `leanDir` carries.
   */
  move: { kind: number; t: number; m: number; dir: number } | null
  /** Seconds since the last move ended, for the cooldown. */
  sinceMove: number
  /** Slow bass average, so a surge above it can be recognised as a drop. */
  bassAvg: number
  /** Last cycle a move was considered on, so a phrase edge fires once. */
  lastCycleSeen: number
  /** Moves performed, so the rotation visits all four rather than tracking the clock. */
  moveCount: number
}

/**
 * Stances.
 *
 * Without these he answers every kick identically forever, and the whole
 * performance is one bar long no matter how the track develops. Each stance
 * reweights which parts of him carry the music, and one is held for four
 * cycles, so his behaviour turns over on a sixteen cycle phrase.
 *
 * Stance 0 is neutral on every channel, so a rig that has just been created
 * behaves exactly as it did before stances existed.
 */
type Stance = { drop: number; lean: number; legs: number; hands: number; rock: number }
const STANCES: Stance[] = [
  { drop: 1, lean: 1, legs: 1, hands: 1, rock: 1 },
  { drop: 0.7, lean: 1.45, legs: 0.8, hands: 0.9, rock: 1.5 },
  { drop: 1.35, lean: 0.6, legs: 1.3, hands: 0.8, rock: 0.7 },
  { drop: 0.85, lean: 0.9, legs: 0.9, hands: 1.6, rock: 1.1 },
]

export function createRig(): Rig {
  return {
    body: spring(150),
    bodyX: spring(110),
    lean: spring(95),
    squash: spring(210),
    rock: spring(26),
    legRot: [spring(200), spring(200), spring(200), spring(200)],
    legScale: [spring(230), spring(230), spring(230), spring(230)],
    handY: [spring(120), spring(120)],
    handX: [spring(105), spring(105)],
    eyeX: spring(90),
    eyeY: spring(330),
    blink: spring(520, 1),
    strobe: 0,
    leanDir: 1,
    shuffle: 0,
    phase: 0,
    cps: 0.5,
    cycle: 0,
    lastPos: 0,
    snaps: 0,
    blinkT: 0,
    blinkGap: 3.1,
    melodyDir: 1,
    hop: spring(60),
    move: null,
    sinceMove: 0,
    bassAvg: 0,
    lastCycleSeen: 0,
    moveCount: 0,
  }
}

/** Sum this frame's pulses per role, then saturate. */
function bucket(pulses: Pulse[]): Record<Role, number> {
  const totals: Record<Role, number> = { thump: 0, snap: 0, tick: 0, weight: 0, melody: 0 }
  for (const p of pulses) {
    if (!Number.isFinite(p.intensity)) continue
    totals[p.role] += Math.max(0, Math.min(2, p.intensity))
  }
  for (const role of Object.keys(totals) as Role[]) {
    totals[role] = Math.min(totals[role], 3)
  }
  return totals
}

/**
 * The jump arc.
 *
 * Up over 0.42s on a sine ease-out, hold at the apex until 0.6s, then fall
 * over 0.2s on a cubic ease-in. The hang and the asymmetry between rise and
 * fall are what give it weight; with a symmetric arc it reads like a balloon.
 *
 * `t` is measured from liftoff rather than from the start of the move, because
 * the move spends JUMP_LIFTOFF on the floor first, loading the legs. That
 * crouch was always in the code and always fired concurrently with the rise,
 * so he left the ground at maximum compression: he read as crumpling upward
 * instead of pushing off, because there was nothing to push off from.
 *
 * Two deliberate departures. The height is not a full 90: this scene
 * frames him in a room, and 90 units would put his head through the lighting
 * truss and out of the top of the viewBox, so it is scaled to what the frame
 * allows. A full jump would travel horizontally as well; he cannot,
 * because he is standing behind a booth.
 *
 * Ballistic rather than sprung, because a spring at any height worth having
 * peaks in about 0.13s and is nearly home by 0.42s, so a landing timed to the
 * arc above would fire while he is already down and drive him through
 * the floor.
 */
/**
 * Anticipation: seconds spent loading the legs on the floor before the
 * arc begins. Short enough not to read as a stall, long enough that the crouch
 * completes before he leaves the ground.
 */
export const JUMP_LIFTOFF = 0.2
const JUMP_UP = 0.42
const JUMP_HANG_UNTIL = 0.6
const JUMP_DOWN = 0.2
const JUMP_END = JUMP_HANG_UNTIL + JUMP_DOWN
/** When the arc puts him back on the floor, on the move's own clock. */
const JUMP_LAND = JUMP_LIFTOFF + JUMP_END
/** Clears the truss at y=-37 with room to spare; a full-height jump would not. */
const JUMP_HEIGHT = 18

/** Claws reach the top fast, stay there, and then come down on their own. */
const CLAW_RELEASE = 0.62
/** The dip crosses centre and overshoots the other way here. */
const DIP_SNAP = 0.42
/**
 * ...and lets the second side go here. Late enough that the second side has
 * arrived and held: the swing across centre takes most of four tenths on its
 * own, so releasing any earlier means he turns for home the moment he gets
 * there and the far side of the dip never reads as a pose at all.
 */
const DIP_RELEASE = 0.95
/** How long the dip takes to cross from one side to the other. */
const DIP_CROSS = 0.22
/** Out-and-back passes of the shimmy wave across one move. */
const SHIMMY_CYCLES = 1.75

/**
 * Smootherstep: zero velocity *and* zero acceleration at both ends.
 *
 * Which is the whole point of using it on a target rather than stepping the
 * target. An impulse into a critically damped spring gives a smooth position
 * with a discontinuous velocity, and that discontinuity is what makes a hit
 * read as a hit; it is exactly wrong for a pose he is supposed to move into.
 * A stepped target has the same problem one derivative up: the spring is at
 * rest, the target jumps, and it lurches into motion from nothing.
 */
function ease(u: number): number {
  const c = u <= 0 ? 0 : u >= 1 ? 1 : u
  return c * c * c * (c * (c * 6 - 15) + 10)
}

/** Ease up over `rise`, hold, ease back down over `fall`, zero outside. */
function envelope(t: number, rise: number, until: number, fall: number): number {
  if (t <= 0) return 0
  if (t < rise) return ease(t / rise)
  if (t < until) return 1
  if (t < until + fall) return 1 - ease((t - until) / fall)
  return 0
}

/**
 * Which way the dip is leaning, from -1 to 1, crossing smoothly rather than
 * flipping. Multiplying this by the amplitude envelope works because the
 * crossing passes through zero, so the two compose without a seam.
 */
function dipSwing(t: number): number {
  if (t < DIP_SNAP) return 1
  return 1 - 2 * ease((t - DIP_SNAP) / DIP_CROSS)
}

/**
 * Full fold of the legs at the bottom of the take-off crouch.
 *
 * Quoted as a target, and the springs only ever reach roughly two thirds of it:
 * they settle in about 66ms and the fold reverses into the push well before
 * that has played out. So this is deliberately deeper than the compression it
 * produces, which is what keeps the crouch visible without slowing it down.
 */
const JUMP_FOLD = 0.095
/** ...and how far they extend driving him off the floor. */
const JUMP_PUSH = 0.034
/** How long he spends sinking into the crouch before pushing back out of it. */
const JUMP_FOLD_IN = 0.13

/**
 * Leg load across a jump: negative folds them under him, positive extends them.
 * Eased at every boundary, so the fold, the push and the release are one
 * continuous movement rather than three targets snapping between each other.
 *
 * The extension completes *at* liftoff rather than beginning there, because the
 * extension is what puts him in the air. Pushing off after he has already left
 * the floor is the same mistake as crouching after it, one stage later.
 */
function jumpLegs(t: number): number {
  if (t < JUMP_FOLD_IN) return -JUMP_FOLD * ease(t / JUMP_FOLD_IN)
  if (t < JUMP_LIFTOFF) {
    const u = (t - JUMP_FOLD_IN) / (JUMP_LIFTOFF - JUMP_FOLD_IN)
    return -JUMP_FOLD + (JUMP_FOLD + JUMP_PUSH) * ease(u)
  }
  const u = t - JUMP_LIFTOFF
  // The extension is held briefly into the rise. The leg springs settle in
  // about 66ms, so a target that peaks at liftoff and immediately decays is
  // gone before they can reach it and he leaves the floor still folded.
  if (u < 0.1) return JUMP_PUSH
  // Then they relax to neutral for the hang.
  if (u < 0.32) return JUMP_PUSH * (1 - ease((u - 0.1) / 0.22))
  return 0
}

function jumpArc(t: number): number {
  if (t <= 0) return 0
  if (t < JUMP_UP) return JUMP_HEIGHT * Math.sin((t / JUMP_UP) * (Math.PI / 2))
  if (t < JUMP_HANG_UNTIL) return JUMP_HEIGHT
  const u = (t - JUMP_HANG_UNTIL) / JUMP_DOWN
  if (u >= 1) return 0
  return JUMP_HEIGHT * (1 - u * u * u)
}

/** Seconds of quiet between moves, so they stay events rather than a habit. */
const MOVE_COOLDOWN = 7

/**
 * How long each move owns the rig: its own length plus the time its springs
 * need to settle. One figure for all four held the slot open through six tenths
 * of a second of nothing after the short moves, which blocked the next move
 * and, for the jump, pinned the hop spring at zero long after he had landed.
 */
const MOVE_DUR = [JUMP_LAND + 0.34, CLAW_RELEASE + 0.42, DIP_RELEASE + 0.44, 0.9]

type Move = NonNullable<Rig['move']>

/** Opening beat of each move. */
function startMove(rig: Rig, mv: Move): void {
  const m = mv.m
  if (mv.kind === 0) {
    // Jump. Both the height and the leg load are driven as eased functions of
    // the move clock in moveHolds, so there is no opening kick at all: the
    // crouch is something he sinks into, not something that hits him.
  } else if (mv.kind === 1) {
    // Both claws up. Throwing them up has real attack, so this keeps an
    // impulse, but a gentle one: sized under the eased target it is heading
    // for, so it accelerates the hands into the pose without overshooting it
    // and sagging back. The old 230 arrived with a jolt and then, having no
    // target to hold, fell straight back out again.
    for (let i = 0; i < 2; i++) impulse(rig.handY[i], -95 * m)
    impulse(rig.body, -45 * m)
  } else if (mv.kind === 2) {
    // Deep dip. The lean and the weight shift are eased targets; the body dip
    // is the one part of it that should land rather than travel.
    impulse(rig.body, 60 * m)
  } else {
    // Shimmy. The legs are driven entirely by the travelling wave in
    // moveHolds, so all that is left here is the sway that carries it.
    impulse(rig.rock, 40 * m)
  }
}

/** Later beats of a move, fired as the clock crosses each mark. */
function stepMove(rig: Rig, mv: Move, was: number, now: number): void {
  const crossed = (at: number) => was < at && now >= at
  const m = mv.m
  if (mv.kind === 0) {
    // Push-off. Impulsive on purpose: driving off the floor is a muscular snap,
    // and the leg springs cannot cover the fold-to-extend swing inside the time
    // the arc allows on an eased target alone.
    if (crossed(JUMP_LIFTOFF)) {
      for (let i = 0; i < 4; i++) impulse(rig.legScale[i], 1.4 * m * LEG_WEIGHT[i])
    }
    // Impact, at the exact moment the arc reaches the floor again, and the one
    // place in the whole move where a hard hit is the right answer. Heavier
    // than a kick, because a landing should read as costing him more.
    //
    // Deliberately no strobe. The room's light is the kick's, and a landing
    // lands wherever the arc puts it: at the shipped tempo that is 50ms before
    // a kick, so the flash fired early and then the rate limit swallowed the
    // one that belonged on the beat. A gesture that makes the light stutter
    // reads as a dropped frame. The landing already carries itself through
    // nine units of body drop and the leg cushion under it.
    if (crossed(JUMP_LAND)) {
      impulse(rig.body, 190 * m)
      for (let i = 0; i < 4; i++) impulse(rig.legScale[i], -1.5 * m * LEG_WEIGHT[i])
    }
  }
  // Nothing else has later beats. Every other part of every move is an eased
  // function of the move clock, which is what makes them read as movements
  // rather than as a series of jolts, and it all lives in moveHolds.
}

/**
 * Sustained targets for whichever move is running.
 *
 * Impulses cannot hold a pose. Every channel is critically damped, which by
 * definition returns to its target as fast as it can without overshooting, so
 * "claws up and held" decayed to nothing in about three tenths of a second and
 * the dip was most of the way home before its own snap-back fired. Raising the
 * impulses to compensate only pushed the peaks into the pose clamps, and a
 * clipped peak has no ease at either end: it reads as a mechanical slam. A
 * gesture that holds has to move the target.
 *
 * Written declaratively from the move clock, and every channel it touches is
 * assigned on every frame, so clearing `rig.move` releases all of it at once
 * and no hold can outlive the move that set it.
 */
function moveHolds(rig: Rig): void {
  let handY = 0
  let lean = 0
  let bodyX = 0
  const legScale = [0, 0, 0, 0]
  const mv = rig.move

  if (mv) {
    const g = mv.m / MOVE_REF
    if (mv.kind === 0) {
      // Fold, push, release, all one eased curve. Sized with headroom under the
      // 0.4 pose floor, because a kick on the same frame is the ordinary case
      // for a move that fires on phrase edges and on drops.
      const load = jumpLegs(mv.t)
      for (let i = 0; i < 4; i++) legScale[i] = load * g * LEG_WEIGHT[i]
    } else if (mv.kind === 1) {
      handY = -13 * g * envelope(mv.t, 0.1, CLAW_RELEASE, 0.3)
    } else if (mv.kind === 2) {
      // 7.3 puts body rotation near six degrees through the 0.815 pose gain,
      // which leaves the clamp at seven some headroom for the rock riding on
      // top of it.
      const swing = dipSwing(mv.t) * envelope(mv.t, 0.08, DIP_RELEASE, 0.28) * mv.dir * g
      lean = 7.3 * swing
      bodyX = 2.2 * swing
    } else {
      // A wave travelling down the legs, graduated by LEG_WEIGHT and enveloped
      // so it leaves and returns to rest rather than starting with a jolt.
      const u = Math.min(1, mv.t / MOVE_DUR[3])
      const env = Math.sin(u * Math.PI)
      for (let i = 0; i < 4; i++) {
        const ph = u * SHIMMY_CYCLES * Math.PI * 2 - i * (Math.PI / 2)
        legScale[i] = Math.sin(ph) * 0.105 * env * g * LEG_WEIGHT[i]
      }
    }
  }

  for (let i = 0; i < 2; i++) rig.handY[i].target = handY
  rig.lean.target = lean
  rig.bodyX.target = bodyX
  for (let i = 0; i < 4; i++) rig.legScale[i].target = legScale[i]
}

/**
 * Acknowledge a note from the user.
 *
 * He nods: a quick dip of the body with the eyes following, then the springs
 * bring him back. It reads as a DJ catching your eye across the booth, which
 * is what sending a note actually is. Impulses only, so it composes with
 * whatever the music is already doing to him.
 */
export function acknowledge(rig: Rig, m: number): void {
  impulse(rig.body, 95 * m)
  impulse(rig.eyeY, 9 * m)
  impulse(rig.squash, -0.9 * m)
  impulse(rig.blink, -38)
}

export function advance(
  rig: Rig,
  pulses: Pulse[],
  bands: Bands,
  dt: number,
  move: number,
): Pose {
  const step = Math.min(Math.max(dt, 0), MAX_DT)
  const hits = bucket(pulses)
  const m = move

  /**
   * The strobe decays at the top of the frame, before anything can bump it,
   * so a hit is reported at the value it was given.
   *
   * Decaying last instead made the flash frame-rate dependent: the envelope is
   * only 55ms, so at 30fps a single frame took a fresh kick from 1 to 0.394 and
   * at a clamped step to 0.091, both under the renderer's onset threshold. An
   * isolated beat therefore never flashed at all below 60fps, while the same
   * pattern flashed fine above it.
   */
  rig.strobe = Math.max(0, rig.strobe - step / 0.055)

  // Tempo lock. Every pulse carries the live cps and its exact position in the
  // cycle, so the rock stays with the music instead of free-running and
  // drifting out of phase over a long set.
  for (const p of pulses) {
    if (Number.isFinite(p.cps) && p.cps > 0) rig.cps = p.cps
    if (Number.isFinite(p.cyclePos)) {
      const pos = ((p.cyclePos % 1) + 1) % 1
      // cyclePos runs 0 to 1 and restarts, so a drop means a new cycle.
      if (pos < rig.lastPos - 0.5) rig.cycle++
      rig.lastPos = pos
      rig.phase = pos
    }
  }
  const st = STANCES[Math.floor(rig.cycle / 4) % STANCES.length]

  /* ---------------------------------------------------------------------
     SHOWMAN MOVES

     Stances vary how he answers a beat, but he still only ever answers. A
     move is him doing something of his own: rare, scripted, and over in
     about a second.

     They fire on a phrase edge (every eight cycles) or on a drop, which is
     the bass jumping well above its own slow average. The drop path is the
     one worth having, because it lands the big gesture exactly when the
     track opens up rather than on a fixed count.

     A move is a short sequence of impulses into the same springs the beats
     use, so nothing here can fight the beat response or leave the rig in a
     pose it cannot recover from: the springs still pull everything home.
     --------------------------------------------------------------------- */
  rig.sinceMove += step
  rig.bassAvg += (bands.bass - rig.bassAvg) * Math.min(1, step * 0.5)
  const phraseEdge = rig.cycle !== rig.lastCycleSeen && rig.cycle % 8 === 0
  const drop = rig.bassAvg > 0.03 && bands.bass > rig.bassAvg * 2.2
  rig.lastCycleSeen = rig.cycle

  if (!rig.move && rig.sinceMove > MOVE_COOLDOWN && (phraseEdge || drop)) {
    // A drop always gets the jump, because that is the moment worth the
    // biggest gesture. Otherwise rotate through the set, counted by moves
    // performed rather than by the clock, so all four actually get used.
    const kind = drop ? 0 : rig.moveCount % 4
    // The drop path must not consume a rotation slot, or a drop-heavy track
    // skips whichever move was next and he only ever shows the jump.
    if (!drop) rig.moveCount++
    rig.move = { kind, t: 0, m, dir: rig.leanDir }
    startMove(rig, rig.move)
  }
  if (rig.move) {
    const mv = rig.move
    const was = mv.t
    mv.t += step
    stepMove(rig, mv, was, mv.t)
    if (mv.t > MOVE_DUR[mv.kind]) {
      rig.move = null
      // The cooldown counts from here rather than from the start, so
      // MOVE_COOLDOWN is the quiet between moves that it claims to be.
      rig.sinceMove = 0
    }
  }
  moveHolds(rig)

  /**
   * Channel authority.
   *
   * A move owns the channels it is choreographing, and the beat response into
   * those channels is turned down while it runs. Both readings agree: he is
   * airborne for most of a jump, so there is nothing for his legs to absorb a
   * kick against, and a scripted dip is already a weight shift, so answering
   * the backbeat with another one is saying it twice.
   *
   * Numerically it is what keeps the pose off its clamps. Held targets sit near
   * the limits by design, so an ordinary coincident hit used to push straight
   * through: a snap and a hat landing inside a dip reached 7.4 degrees against
   * a clamp of 7 and pinned it flat for a tenth of a second, and a saturated
   * kick on the landing frame did the same to the leg floor. A clipped extreme
   * has no ease at either end, which is the exact thing these moves were
   * rewritten to stop doing.
   */
  // The jump gets the deepest cut of the three: he is off the floor for most of
  // it, and its landing impulse is the largest single thing in the rig, so a
  // saturated kick arriving on the touchdown frame has the least room of all.
  const legAuth = rig.move ? (rig.move.kind === 0 ? 0.1 : rig.move.kind === 3 ? 0.15 : 1) : 1
  const leanAuth = rig.move && rig.move.kind === 2 ? 0.25 : 1

  if (hits.thump > 0) {
    const a = hits.thump * m
    // 170 lands the body drop at 8 units (MOVE 1.7, intensity 1).
    impulse(rig.body, 170 * a * st.drop)
    impulse(rig.squash, -1.5 * a)
    for (let i = 0; i < 4; i++) {
      impulse(rig.legScale[i], -1.15 * a * st.legs * LEG_WEIGHT[i] * legAuth)
    }
    // Hands overshoot the body, as a landing does (10 against 8).
    // That ratio comes from the shared `body.x * 1.25` term in the hands pose
    // below; this impulse only adds a small bounce of the hands' own.
    for (let i = 0; i < 2; i++) impulse(rig.handY[i], 7.5 * a * st.hands)
    rig.strobe = Math.min(1, rig.strobe + hits.thump)
  }
  if (hits.snap > 0) {
    const a = hits.snap * m
    // Flipping on every snap is a perfect left-right-left metronome. Holding
    // each side for two backbeats reads as weight shifting instead.
    if (rig.snaps % 2 === 0) rig.leanDir *= -1
    rig.snaps++
    impulse(rig.lean, 62 * rig.leanDir * a * leanAuth * st.lean)
    impulse(rig.bodyX, 9 * rig.leanDir * a * leanAuth * st.lean)
    for (let i = 0; i < 4; i++) impulse(rig.legRot[i], LEG_ROT[i] * 1.6 * rig.leanDir * a * st.legs)
    impulse(rig.handY[rig.leanDir > 0 ? 1 : 0], -74 * a * st.hands)
    impulse(rig.eyeX, -15 * rig.leanDir * a)   // eyes lag the lean
  }
  if (hits.tick > 0) {
    const a = hits.tick * m
    // Hats deliberately do not move the eyes. They fire on eighths or
    // sixteenths, so at any club tempo that is four to eight eye twitches a
    // second, which reads as a nervous tic rather than as listening. The
    // hats stay in the wrists and a trace of lean instead.
    impulse(rig.lean, 5 * rig.leanDir * a * leanAuth)
    impulse(rig.handX[1], 5 * a)
  }
  if (hits.weight > 0) {
    const a = hits.weight * m
    rig.shuffle = (rig.shuffle + 1) % 4
    impulse(rig.legScale[rig.shuffle], -1.5 * a)
    impulse(rig.body, 7 * a)
    impulse(rig.rock, 15 * a * st.rock)
  }
  if (hits.melody > 0) {
    impulse(rig.eyeY, -5 * hits.melody * m)
    // The eyes also track melodic movement. Without this they only ever move
    // on a snap, and a track with no snare or clap (which is common: Blue
    // Hour carries its backbeat on toms) leaves him staring straight ahead.
    rig.melodyDir *= -1
    impulse(rig.eyeX, 9 * rig.melodyDir * hits.melody * m)
    impulse(rig.handY[0], -18 * hits.melody * m)
  }

  // The spectrum sets sustained targets rather than kicking anything.
  rig.rock.target = bands.bass * 12
  /**
   * Blinking.
   *
   * The eyes used to twitch on every hi-hat, which was a nervous tic, and
   * removing that left him staring without ever closing them, which is worse:
   * a face that never blinks is the uncanny one. So blinks run on their own
   * slow clock at a human rate instead of on the music.
   *
   * The interval varies with the cycle count rather than with Math.random, so
   * he is never metronomic and the rig stays deterministic and testable.
   */
  rig.blinkT += step
  if (rig.blinkT >= rig.blinkGap) {
    rig.blinkT = 0
    rig.blinkGap = 2.4 + ((rig.cycle * 7) % 5) * 0.55
    // Enough to shut the eye almost fully; k=520 reopens it in about 150ms.
    impulse(rig.blink, -60)
  }
  rig.blink.target = 1

  integrate(rig.body, step)
  integrate(rig.bodyX, step)
  integrate(rig.lean, step)
  integrate(rig.squash, step)
  integrate(rig.rock, step)
  integrate(rig.eyeX, step)
  integrate(rig.eyeY, step)
  integrate(rig.blink, step)
  integrate(rig.hop, step)
  // The jump overrides the hop spring outright while it runs. Applied after
  // integration, or the solver would drag the arc back toward rest each frame
  // and flatten it.
  if (rig.move && rig.move.kind === 0) {
    rig.hop.x = jumpArc(rig.move.t - JUMP_LIFTOFF)
    rig.hop.v = 0
  }
  for (let i = 0; i < 4; i++) {
    integrate(rig.legRot[i], step)
    integrate(rig.legScale[i], step)
  }
  for (let i = 0; i < 2; i++) {
    integrate(rig.handY[i], step)
    integrate(rig.handX[i], step)
  }

  rig.phase = (rig.phase + step * rig.cps) % 1
  // Amplitude comes entirely from the music. A constant baseline here would
  // leave him swaying in silence, which contradicts standing still when
  // nothing plays and makes "settles to rest" untestable.
  const rock = Math.sin(rig.phase * Math.PI * 2) * Math.max(0, rig.rock.x) * 0.5

  return {
    body: {
      x: rig.bodyX.x + rock,
      y: rig.body.x,
      // 0.815 lands snap-driven lean at ~3 degrees of body
      // rotation on an ordinary single hit. Clamped: several snaps landing in
      // the same frame (legal, not just a stress test - three intensity-1
      // snaps or one intensity-2 snap both reach the bucket's own cap of 3)
      // would otherwise swing the headphones' far cup past the viewBox edge.
      rotation: Math.max(-7, Math.min(7, rig.lean.x * 0.815 + rock * 0.18)),
      // 2.1 lands thump-driven squash at a visible but modest compression.
      scaleY: 1 + rig.squash.x * 2.1,
    },
    legs: rig.legRot.map((r, i) => ({
      // 14.1 lands the graduated LEG_ROT weights at their design degrees.
      rotation: r.x * 14.1,
      // 6.2 lands the graduated LEG_SCALE weights in the design compression
      // range (thump drives legScale negative, so this shrinks the legs, the
      // same "absorb the impact" direction as body squash above). Floored so
      // that legScale and weight's separate legScale impulse landing on the
      // same leg in the same frame can't invert it past zero.
      scaleY: Math.max(0.4, 1 + rig.legScale[i].x * 6.2),
    })),
    hands: rig.handY.map((h, i) => ({
      x: rig.handX[i].x + rig.bodyX.x * 0.7 + rock * 0.8,
      y: h.x + rig.body.x * 1.25 + 17,
      rotation: -h.x * 0.3 * (i === 0 ? -1 : 1),
    })),
    // Eye offset is relative to the face, not to the room. The renderer puts
    // the eyes in a group that already carries the body transform, so adding
    // the body's own sway here again would double-count it and the eyes would
    // slide around the head instead of riding it.
    eyes: {
      x: rig.eyeX.x,
      y: rig.eyeY.x,
      scaleY: Math.max(0.06, Math.min(1, rig.blink.x)),
    },
    lift: -rig.hop.x,
    strobe: rig.strobe,
  }
}
