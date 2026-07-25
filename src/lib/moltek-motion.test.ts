import { describe, expect, it } from 'vitest'
import {
  advance,
  createRig,
  JUMP_LIFTOFF,
  MAX_DT,
  type Bands,
  type Pose,
  type Pulse,
} from '@/lib/moltek-motion'

const SILENT: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }
const kick = (intensity = 1, cyclePos = 0): Pulse => ({
  role: 'thump',
  intensity,
  cyclePos,
  cps: 0.5,
})
const snap = (intensity = 1, cyclePos = 0): Pulse => ({
  role: 'snap',
  intensity,
  cyclePos,
  cps: 0.5,
})
const weight = (intensity = 1, cyclePos = 0): Pulse => ({
  role: 'weight',
  intensity,
  cyclePos,
  cps: 0.5,
})

/** Run the rig for `seconds` at 60fps and return the last pose. */
function run(rig: ReturnType<typeof createRig>, seconds: number, pulses: Pulse[] = []) {
  let pose = advance(rig, pulses, SILENT, 1 / 60, 1)
  for (let t = 1 / 60; t < seconds; t += 1 / 60) {
    pose = advance(rig, [], SILENT, 1 / 60, 1)
  }
  return pose
}

/** The production sway constant: how far he moves, per the mascot component. */
const MOVE = 1.7

/**
 * Drive one pulse at MOVE and track the peak magnitude `pick` reaches over
 * the following second, rather than reading a single frame. Every channel
 * here settles well inside a second (the stiffest spring, k=230, peaks around
 * 65ms; the softest tested, k=95, around 100ms), so a 1 second window always
 * contains the true peak with room to spare.
 */
function peakAfter(
  rig: ReturnType<typeof createRig>,
  pulses: Pulse[],
  pick: (pose: Pose) => number,
): number {
  let pose = advance(rig, pulses, SILENT, 1 / 60, MOVE)
  let peak = Math.abs(pick(pose))
  for (let t = 1 / 60; t < 1; t += 1 / 60) {
    pose = advance(rig, [], SILENT, 1 / 60, MOVE)
    peak = Math.max(peak, Math.abs(pick(pose)))
  }
  return peak
}

/** Same idea, but tracks all four legs' peaks in lockstep. */
function legPeaksAfter(
  rig: ReturnType<typeof createRig>,
  pulses: Pulse[],
  pick: (pose: Pose) => number[],
): number[] {
  let pose = advance(rig, pulses, SILENT, 1 / 60, MOVE)
  const peaks = pick(pose).map((v) => Math.abs(v))
  for (let t = 1 / 60; t < 1; t += 1 / 60) {
    pose = advance(rig, [], SILENT, 1 / 60, MOVE)
    pick(pose).forEach((v, i) => {
      peaks[i] = Math.max(peaks[i], Math.abs(v))
    })
  }
  return peaks
}

describe('moltek-motion', () => {
  it('settles to rest when nothing is playing', () => {
    const rig = createRig()
    // Excite every channel that feeds body.y and body.rotation: a thump
    // drives body.y, a snap drives lean, and a weight pulse drives rock. A
    // pulse that only touched body.y (e.g. a lone kick) would leave lean and
    // rock at their rest value the whole run, making a rotation assertion
    // pass even if their decay (or the rock amplitude itself) were broken.
    advance(rig, [kick(), snap(), weight()], SILENT, 1 / 60, 1)
    let maxY = 0
    let maxRotation = 0
    for (let t = 1 / 60; t < 3; t += 1 / 60) {
      const pose = advance(rig, [], SILENT, 1 / 60, 1)
      // Sample a trailing window rather than only the final frame: the rock
      // term is modulated by sin(phase), which can pass through zero at any
      // single instant even if it carries a broken, non-decaying baseline.
      if (t > 2.5) {
        maxY = Math.max(maxY, Math.abs(pose.body.y))
        maxRotation = Math.max(maxRotation, Math.abs(pose.body.rotation))
      }
    }
    expect(maxY).toBeLessThan(0.01)
    expect(maxRotation).toBeLessThan(0.01)
  })

  it('actually moves when a beat lands', () => {
    const rig = createRig()
    const pose = advance(rig, [kick()], SILENT, 1 / 60, 1)
    expect(Math.abs(pose.body.y)).toBeGreaterThan(0)
  })

  it('does not oscillate past rest on the way back', () => {
    const rig = createRig()
    advance(rig, [kick()], SILENT, 1 / 60, 1)
    let crossings = 0
    let previous = advance(rig, [], SILENT, 1 / 60, 1).body.y
    for (let t = 0; t < 3; t += 1 / 60) {
      const y = advance(rig, [], SILENT, 1 / 60, 1).body.y
      if (Math.sign(y) !== Math.sign(previous) && Math.abs(y) > 0.01) crossings++
      previous = y
    }
    // Critically damped: it returns to rest without swinging through it at all.
    expect(crossings).toBe(0)
  })

  it('saturates instead of summing without bound when layers coincide', () => {
    const rig = createRig()
    const stacked = Array.from({ length: 40 }, () => kick(2))
    const pose = advance(rig, stacked, SILENT, 1 / 60, 1)
    expect(Number.isFinite(pose.body.y)).toBe(true)
    expect(Math.abs(pose.body.y)).toBeLessThan(200)
  })

  it('survives a 150bpm retrigger storm without drifting', () => {
    const rig = createRig()
    // 150bpm sixteenths is a pulse every 100ms, for 30 seconds.
    let sinceHit = 0
    for (let t = 0; t < 30; t += 1 / 60) {
      sinceHit += 1 / 60
      const pulses = sinceHit >= 0.1 ? ((sinceHit = 0), [kick()]) : []
      advance(rig, pulses, SILENT, 1 / 60, 1)
    }
    const pose = run(rig, 3)
    expect(Math.abs(pose.body.y)).toBeLessThan(0.01)
  })

  it('locks its phase to the music rather than free-running', () => {
    const rig = createRig()
    // A pulse at the three-quarter point of the cycle puts the rig there.
    advance(rig, [kick(1, 0.75)], SILENT, 1 / 60, 1)
    expect(rig.phase).toBeGreaterThan(0.7)
    expect(rig.phase).toBeLessThan(0.81)
    // And it takes its tempo from the pulse, not from a hardcoded rate.
    expect(rig.cps).toBe(0.5)
  })

  it('advances phase at the tempo the music reports', () => {
    const rig = createRig()
    advance(rig, [{ role: 'thump', intensity: 1, cyclePos: 0, cps: 1 }], SILENT, 0, 1)
    expect(rig.phase).toBeCloseTo(0, 5)
    // One second at 1 cycle per second wraps exactly once back to zero.
    for (let t = 0; t < 1; t += 1 / 60) advance(rig, [], SILENT, 1 / 60, 1)
    expect(rig.phase).toBeLessThan(0.05)
  })

  it('clamps a huge elapsed time from a backgrounded tab', () => {
    // rAF pauses in a background tab while setTimeout keeps firing. Without a
    // clamp, the first frame back integrates a 30 second step and he leaves
    // the viewport.
    const clamped = createRig()
    const stepped = createRig()
    advance(clamped, [kick()], SILENT, 30, 1)
    advance(stepped, [kick()], SILENT, MAX_DT, 1)
    expect(clamped.body.x).toBeCloseTo(stepped.body.x, 6)
  })
})

// These pin the rig's amplitudes to moltek's design targets.
// A previous tuning pass left every one of these channels numerically too
// small to see on screen (sub-degree rotations, sub-percent stretches) even
// though the rig was otherwise behaving correctly. Without a test that reads
// the actual pose magnitude, that kind of regression is invisible to the
// existing suite: "moves at all" and "settles to rest" both stay green
// whether the motion is life-sized or a hundred times too small.
describe('amplitude targets (design magnitudes)', () => {
  it('body drop on a thump lands in the design range', () => {
    // A landing drops the body 8 units; 5-10 leaves room to retune
    // without allowing a collapse back toward invisible.
    const rig = createRig()
    const peak = peakAfter(rig, [kick(1)], (pose) => pose.body.y)
    expect(peak).toBeGreaterThan(5)
    expect(peak).toBeLessThan(10)
  })

  it('body rotation on a snap lands in the design range', () => {
    // The lean is 3 degrees of body rotation.
    const rig = createRig()
    const peak = peakAfter(rig, [snap(1)], (pose) => pose.body.rotation)
    expect(peak).toBeGreaterThan(2)
    expect(peak).toBeLessThan(4)
  })

  it('leg rotation on a snap is graduated and lands in the design range', () => {
    // LEG_ROT is [-7, -8, -8, -9]: the graduation, not just the magnitude, is
    // what stops the legs reading as a single rigid box.
    const rig = createRig()
    const peaks = legPeaksAfter(rig, [snap(1)], (pose) => pose.legs.map((l) => l.rotation))
    for (const p of peaks) {
      expect(p).toBeGreaterThan(4)
      expect(p).toBeLessThan(10)
    }
    expect(peaks[0]).toBeLessThan(peaks[1])
    // Legs 1 and 2 both carry LEG_ROT's -8: same formula, same inputs, so
    // this is exact floating-point equality, not an approximation.
    expect(peaks[1]).toBe(peaks[2])
    expect(peaks[2]).toBeLessThan(peaks[3])
  })

  it('leg scaleY on a thump is graduated and lands in the design range', () => {
    // LEG_SCALE is [1.35, 1.3, 1.2, 1.15], used here as relative weights for
    // a landing compression (thump drives legScale negative): leg 0 (the
    // biggest walk-cycle stretch) compresses the most on impact, leg 3 the
    // least. The deviation from 1.0 is what's targeted, not its sign.
    const rig = createRig()
    const peaks = legPeaksAfter(rig, [kick(1)], (pose) => pose.legs.map((l) => l.scaleY - 1))
    for (const p of peaks) {
      expect(p).toBeGreaterThan(0.08)
      expect(p).toBeLessThan(0.3)
    }
    expect(peaks[0]).toBeGreaterThan(peaks[1])
    expect(peaks[1]).toBeGreaterThan(peaks[2])
    expect(peaks[2]).toBeGreaterThan(peaks[3])
  })

  it('hands overshoot the body drop by about 1.25x', () => {
    // On landing, hands travel 10 against the body's 8.
    const rig = createRig()
    let pose = advance(rig, [kick(1)], SILENT, 1 / 60, MOVE)
    let peakBody = Math.abs(pose.body.y)
    // The pose's "17" is the hands' own rest offset (see moltek-motion.ts).
    let peakHand = Math.abs(pose.hands[0].y - 17)
    for (let t = 1 / 60; t < 1; t += 1 / 60) {
      pose = advance(rig, [], SILENT, 1 / 60, MOVE)
      peakBody = Math.max(peakBody, Math.abs(pose.body.y))
      peakHand = Math.max(peakHand, Math.abs(pose.hands[0].y - 17))
    }
    const ratio = peakHand / peakBody
    expect(ratio).toBeGreaterThan(1.1)
    expect(ratio).toBeLessThan(1.5)
  })

  // Not one of the five tracked channels above, but squash was called out
  // in the review as broken the same way (0.045, same as lean and legRot)
  // and would otherwise have no test protecting its retuned value at all.
  it('body squash on a thump is visible without a dedicated numeric target', () => {
    const rig = createRig()
    const peak = peakAfter(rig, [kick(1)], (pose) => pose.body.scaleY - 1)
    expect(peak).toBeGreaterThan(0.05)
    expect(peak).toBeLessThan(0.25)
  })

  it('legScale cannot invert a leg even when thump and weight land on it together', () => {
    // legRot/legScale's 6.2x scale is large enough that two roles landing on
    // the same leg in the same frame, both legal at their own per-role cap of
    // 3, could otherwise drive scaleY negative (a visually flipped leg).
    const rig = createRig()
    // Walk weight's round-robin shuffle to leg 0 before the coincident hit.
    for (let i = 0; i < 3; i++) advance(rig, [weight(1)], SILENT, 1 / 60, MOVE)
    let pose = advance(
      rig,
      [kick(2), kick(1), weight(2), weight(1)],
      SILENT,
      1 / 60,
      MOVE,
    )
    let minScale = Math.min(...pose.legs.map((l) => l.scaleY))
    for (let t = 1 / 60; t < 1; t += 1 / 60) {
      pose = advance(rig, [], SILENT, 1 / 60, MOVE)
      minScale = Math.min(minScale, ...pose.legs.map((l) => l.scaleY))
    }
    expect(minScale).toBeGreaterThan(0)
  })

  it('body rotation stays inside the viewBox when several snaps land in one frame', () => {
    // Three intensity-1 snaps (or one intensity-2 snap) are a legal, ordinary
    // way to reach the bucket's own cap of hits.snap = 3, not a stress test.
    // Unclamped, that swings the headphones' far cup past the viewBox's
    // right edge (x=115); the output clamp below is what prevents it.
    const rig = createRig()
    const peak = peakAfter(rig, [snap(1), snap(1), snap(1)], (pose) => pose.body.rotation)
    expect(peak).toBeLessThanOrEqual(7)
  })
})

describe('phrasing', () => {
  const SILENT2: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }
  const thumpAt = (cyclePos: number): Pulse => ({
    role: 'thump',
    intensity: 1,
    cyclePos,
    cps: 0.5,
  })

  /** Run silent until every channel has returned to rest. */
  function settle(rig: ReturnType<typeof createRig>) {
    for (let t = 0; t < 3; t += 1 / 60) advance(rig, [], SILENT2, 1 / 60, 1.7)
  }

  /**
   * Drive one kick and return the peak body drop it produces.
   *
   * Settling first is what makes this a measurement of the stance rather than
   * of leftover spring energy: without it the residue from previous hits
   * dominates the peak and the comparison passes no matter what the stance
   * table says.
   */
  function peakDrop(rig: ReturnType<typeof createRig>, cyclePos: number) {
    settle(rig)
    let peak = 0
    advance(rig, [thumpAt(cyclePos)], SILENT2, 1 / 60, 1.7)
    for (let t = 0; t < 1.5; t += 1 / 60) {
      peak = Math.max(peak, advance(rig, [], SILENT2, 1 / 60, 1.7).body.y)
    }
    return peak
  }

  it('counts cycles from cyclePos wrapping', () => {
    const rig = createRig()
    for (let c = 0; c < 6; c++) {
      advance(rig, [thumpAt(0.1)], SILENT2, 1 / 60, 1.7)
      advance(rig, [thumpAt(0.9)], SILENT2, 1 / 60, 1.7)
    }
    // Six passes of 0.1 then 0.9 means five wraps back down to 0.1.
    expect(rig.cycle).toBe(5)
  })

  it('changes how he answers the same kick as the phrase turns over', () => {
    const rig = createRig()
    const first = peakDrop(rig, 0.0)
    // Push him into the next stance: four cycles on.
    for (let c = 0; c < 5; c++) {
      advance(rig, [thumpAt(0.1)], SILENT2, 1 / 60, 1.7)
      advance(rig, [thumpAt(0.9)], SILENT2, 1 / 60, 1.7)
    }
    const later = peakDrop(rig, 0.0)
    // Identical stimulus, different stance, so the answer must differ.
    expect(Math.abs(later - first)).toBeGreaterThan(0.5)
  })

  it('holds a lean direction for two backbeats rather than alternating', () => {
    const rig = createRig()
    const dirs: number[] = []
    for (let i = 0; i < 4; i++) {
      advance(rig, [{ role: 'snap', intensity: 1, cyclePos: 0.5, cps: 0.5 }], SILENT2, 1 / 60, 1.7)
      dirs.push(rig.leanDir)
    }
    // Two of one side, then two of the other: not a strict left-right metronome.
    expect(dirs[0]).toBe(dirs[1])
    expect(dirs[2]).toBe(dirs[3])
    expect(dirs[0]).not.toBe(dirs[2])
  })
})

describe('blinking', () => {
  const Q: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }

  /** Run silent for `seconds` and report how far the eyes ever closed. */
  function run(rig: ReturnType<typeof createRig>, seconds: number) {
    let closest = 1
    let opened = 0
    for (let t = 0; t < seconds; t += 1 / 60) {
      const s = advance(rig, [], Q, 1 / 60, 1.7).eyes.scaleY
      closest = Math.min(closest, s)
      opened = Math.max(opened, s)
    }
    return { closest, opened }
  }

  it('blinks on its own, with no music playing at all', () => {
    // A face that never closes its eyes is the uncanny one, and blinking must
    // not depend on beats arriving: he blinks while the track is stopped too.
    const { closest } = run(createRig(), 12)
    expect(closest).toBeLessThan(0.35)
  })

  it('reopens fully rather than sitting half shut', () => {
    const { opened } = run(createRig(), 12)
    expect(opened).toBeGreaterThan(0.98)
  })

  it('does not blink constantly', () => {
    const rig = createRig()
    let shut = 0
    for (let t = 0; t < 12; t += 1 / 60) {
      if (advance(rig, [], Q, 1 / 60, 1.7).eyes.scaleY < 0.5) shut++
    }
    // Twelve seconds at 60fps is 720 frames; a human is shut for a tiny
    // fraction of that.
    expect(shut).toBeGreaterThan(0)
    expect(shut).toBeLessThan(80)
  })
})

describe('showman moves', () => {
  const Q: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }
  const LOUD: Bands = { rms: 0.3, sub: 0.5, bass: 0.6, mid: 0.3, high: 0.2 }
  const QUIET: Bands = { rms: 0.05, sub: 0.06, bass: 0.06, mid: 0.05, high: 0.03 }

  /** Play `cycles` cycles of four-on-the-floor at the given spectrum. */
  function play(rig: ReturnType<typeof createRig>, cycles: number, bands: Bands) {
    let peakLift = 0
    let moves = 0
    let inMove = false
    for (let c = 0; c < cycles; c++) {
      for (let s = 0; s < 4; s++) {
        const pos = s / 4
        for (let f = 0; f < 30; f++) {
          const pulses: Pulse[] =
            f === 0 ? [{ role: 'thump', intensity: 1, cyclePos: pos, cps: 0.5 }] : []
          const pose = advance(rig, pulses, bands, 1 / 60, 1.7)
          peakLift = Math.min(peakLift, pose.lift)
          if (!!rig.move !== inMove) {
            if (rig.move) moves++
            inMove = !!rig.move
          }
        }
      }
    }
    return { peakLift, moves }
  }

  it('does something of its own on a phrase edge', () => {
    // Sixteen cycles covers two phrase edges even with the cooldown.
    const { moves } = play(createRig(), 20, Q)
    expect(moves).toBeGreaterThan(0)
  })

  it('gets off the floor when the jump comes up', () => {
    // Kind 0 is the jump and it is first in the rotation, so the opening
    // phrase edge should lift him.
    const { peakLift } = play(createRig(), 20, Q)
    expect(peakLift).toBeLessThan(-3)
  })

  it('fires on a drop, not only on the count', () => {
    const rig = createRig()
    play(rig, 4, QUIET)          // establish a quiet bass average
    const before = rig.sinceMove
    rig.sinceMove = 99           // clear the cooldown so only the drop can fire
    play(rig, 2, LOUD)           // bass surges well above its average
    expect(rig.sinceMove).toBeLessThan(before + 99)
  })

  it('keeps them rare rather than constant', () => {
    const { moves } = play(createRig(), 24, Q)
    // 24 cycles at 126bpm is roughly 46 seconds; a showman does not do a
    // trick every bar.
    expect(moves).toBeLessThan(10)
  })

  it('always comes back to rest afterwards', () => {
    const rig = createRig()
    play(rig, 20, Q)
    for (let t = 0; t < 4; t += 1 / 60) advance(rig, [], Q, 1 / 60, 1.7)
    const pose = advance(rig, [], Q, 1 / 60, 1.7)
    expect(Math.abs(pose.lift)).toBeLessThan(0.01)
    expect(Math.abs(pose.body.y)).toBeLessThan(0.01)
  })
})

describe('the jump arc', () => {
  const Q: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }
  /**
   * The arc is timed from the moment he leaves the floor, not from the
   * start of the move: the anticipation crouch runs first. Every time below is
   * therefore relative to liftoff, which keeps the published 0.42 / 0.6 / 0.2
   * figures legible in the assertions.
   */
  const L = JUMP_LIFTOFF

  /** Force a jump and sample lift across the whole move. */
  function jumpTrace() {
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    const trace: Array<{ t: number; lift: number }> = []
    for (let t = 0; t < 1.6; t += 1 / 120) {
      const pose = advance(rig, [], Q, 1 / 120, 1.7)
      trace.push({ t, lift: pose.lift })
    }
    return trace
  }

  it('never goes below the floor', () => {
    // The sprung version drove lift positive on landing, which put him
    // underground. Ballistic arc, so this can only ever be zero or negative.
    const worst = Math.max(...jumpTrace().map((s) => s.lift))
    expect(worst).toBeLessThanOrEqual(0.001)
  })

  it('gets meaningfully off the floor', () => {
    const peak = Math.min(...jumpTrace().map((s) => s.lift))
    expect(peak).toBeLessThan(-15)
  })

  it('hangs at the apex before falling, as the timeline does', () => {
    const trace = jumpTrace()
    const at = (t: number) => trace.find((s) => s.t >= t)!.lift
    // Rise completes at 0.42 and the fall does not start until 0.6.
    expect(at(L + 0.45)).toBeCloseTo(at(L + 0.55), 1)
    // And by 0.8 he is back down.
    expect(Math.abs(at(L + 0.85))).toBeLessThan(0.5)
  })

  it('falls faster than it rises', () => {
    const trace = jumpTrace()
    const at = (t: number) => trace.find((s) => s.t >= t)!.lift
    const rise = Math.abs(at(L + 0.21))      // halfway through the 0.42s rise
    const fall = Math.abs(at(L + 0.7))       // halfway through the 0.2s fall
    // Sine ease-out is already past half height at the midpoint of the rise;
    // cubic ease-in is still near full height at the midpoint of the fall.
    expect(rise).toBeGreaterThan(Math.abs(at(L)) + 8)
    expect(fall).toBeGreaterThan(8)
  })
})

/**
 * The four showman moves, traced channel by channel.
 *
 * Each of these pins a specific way the impulse-only version misread. They are
 * about the shape of a gesture over time rather than a single peak, so they all
 * work from a full trace of the move.
 */
describe('how the moves read', () => {
  const Q: Bands = { rms: 0, sub: 0, bass: 0, mid: 0, high: 0 }

  type Frame = { t: number; pose: Pose }

  /** Force move `kind` on the opening frame and trace it to completion. */
  function moveTrace(kind: number) {
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    rig.moveCount = kind
    const frames: Frame[] = []
    let t = 0
    let endedAt = Infinity
    for (let f = 0; f < 300; f++) {
      const pose = advance(rig, [], Q, 1 / 120, MOVE)
      t += 1 / 120
      frames.push({ t, pose })
      if (!rig.move && endedAt === Infinity) endedAt = t
    }
    return { frames, endedAt, rig }
  }

  const legs = (f: Frame) => f.pose.legs.map((l) => l.scaleY)

  it('loads the legs on the floor before it leaves it', () => {
    // The crouch used to fire at the same instant as the rise, so he was
    // already airborne at maximum compression, which reads as crumpling
    // upward rather than pushing off.
    //
    // Note the window: everything before the *first* time he leaves the floor.
    // `lift === 0` is also true for the whole post-landing recovery, so a naive
    // grounded filter passes on the landing cushion and never looks at the
    // anticipation at all.
    const { frames } = moveTrace(0)
    const liftoff = frames.findIndex((f) => f.pose.lift < -0.01)
    expect(liftoff).toBeGreaterThan(0)
    const loaded = Math.min(...frames.slice(0, liftoff).flatMap(legs))
    expect(loaded).toBeLessThan(0.78)
  })

  it('extends the legs on the way up rather than staying folded', () => {
    const { frames } = moveTrace(0)
    // Sample once he is clearly airborne but still rising.
    const rising = frames.find((f) => f.pose.lift < -3)!
    expect(Math.max(...legs(rising))).toBeGreaterThan(1)
  })

  it('never drives the leg scale into its clamp', () => {
    // 0.4 is the pose floor. Landing on the floor exactly means the cushion
    // is a flat plateau with no ease, which reads as a mechanical stop.
    for (const kind of [0, 1, 2, 3]) {
      const worst = Math.min(...moveTrace(kind).frames.flatMap(legs))
      expect(worst, `kind ${kind}`).toBeGreaterThan(0.45)
    }
  })

  it('holds the claws up instead of flicking them', () => {
    const { frames } = moveTrace(1)
    // Rest is y=17. Held means still well up a third of a second later, not
    // back home: the sprung version was at 15.1 of 17 by then.
    const held = frames.filter((f) => f.t > 0.18 && f.t < 0.5)
    expect(Math.max(...held.map((f) => f.pose.hands[0].y))).toBeLessThan(9)
  })

  it('releases the claws without dunking them below rest', () => {
    const { frames } = moveTrace(1)
    // The release impulse used to push them to 24.4, well under the 17 rest
    // line, for no musical reason at all.
    expect(Math.max(...frames.map((f) => f.pose.hands[0].y))).toBeLessThan(18.5)
  })

  it('keeps the dip inside the rotation clamp', () => {
    // +-7 is the pose clamp. The dip overdrove it by 42% and sat pinned at
    // the limit for over a tenth of a second on each side, so the gesture had
    // no shape at its extremes.
    const rot = moveTrace(2).frames.map((f) => Math.abs(f.pose.body.rotation))
    expect(Math.max(...rot)).toBeLessThan(6.9)
    // It still has to be a deep dip, not a timid one.
    expect(Math.max(...rot)).toBeGreaterThan(4.5)
  })

  it('dips both ways, and holds a real pose on each side', () => {
    const trace = moveTrace(2).frames
    const rot = trace.map((f) => f.pose.body.rotation)
    // Deep on both sides. Bounded above as well as below, or the old clipped
    // version satisfies this by sitting at exactly +-7.
    for (const peak of [Math.max(...rot), -Math.min(...rot)]) {
      expect(peak).toBeGreaterThan(5)
      expect(peak).toBeLessThan(6.95)
    }
    // And each side is *held*, not merely passed through on the way somewhere.
    // The far side used to arrive exactly as it was released.
    const heldNear = trace.filter((f) => f.pose.body.rotation > 5).length
    const heldFar = trace.filter((f) => f.pose.body.rotation < -5).length
    expect(heldNear, 'near side hold').toBeGreaterThan(12)
    expect(heldFar, 'far side hold').toBeGreaterThan(12)
  })

  it('does not rewrite the backbeat lean direction', () => {
    // The dip flipped rig.leanDir as a side effect, which desynchronised the
    // two-backbeat weight shift that the snap handler maintains.
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    rig.moveCount = 2
    const before = rig.leanDir
    for (let f = 0; f < 300; f++) advance(rig, [], Q, 1 / 120, MOVE)
    expect(rig.leanDir).toBe(before)
  })

  it('shimmies as a travelling wave, not two pairs out of phase', () => {
    // i % 2 moved legs 0 and 2 in lockstep with 1 and 3, which is exactly the
    // uniform motion the graduated arrays exist to avoid.
    //
    // Counting distinct values is not enough to prove this: the per-leg
    // amplitude weights alone make four distinct numbers even when the phases
    // are shared. Nor is comparing peak times, because the wave makes more than
    // one pass and the envelope decides which crest ends up largest.
    //
    // The exact discriminator: divide each leg's deviation by its own amplitude
    // weight. Under `i % 2` legs 0 and 2 differ only in weight, so the two
    // normalised series are identical at every instant; a travelling wave
    // separates them. Same for 1 and 3.
    const W = [1.35, 1.3, 1.2, 1.15].map((s) => (s - 1) / 0.35)
    const { frames } = moveTrace(3)
    const norm = (f: Frame, i: number) => (f.pose.legs[i].scaleY - 1) / W[i]
    for (const [a, b] of [
      [0, 2],
      [1, 3],
    ]) {
      const gap = Math.max(...frames.map((f) => Math.abs(norm(f, a) - norm(f, b))))
      expect(gap, `legs ${a} and ${b} share a phase`).toBeGreaterThan(0.05)
    }
  })

  it('gives the slot back as soon as the gesture is over', () => {
    // A flat 1.4s for every move left the slot open through 0.6s of nothing
    // after the short ones, which blocked the next move and pinned the hop.
    const ends: number[] = []
    for (const kind of [0, 1, 2, 3]) {
      const { frames, endedAt } = moveTrace(kind)
      // Perceptual thresholds, not numerical ones. Every channel is a spring,
      // so all of them have an exponential tail that never reaches zero; 0.25
      // units is about 0.4px at the rendered size, which is the point below
      // which the tail stops being motion anyone can see.
      const moving = (p: Pose) =>
        Math.abs(p.lift) > 0.25 ||
        Math.abs(p.body.y) > 0.25 ||
        Math.abs(p.body.rotation) > 0.15 ||
        Math.abs(p.hands[0].y - 17) > 0.25 ||
        p.legs.some((l) => Math.abs(l.scaleY - 1) > 0.03)
      const lastActive = Math.max(...frames.filter((f) => moving(f.pose)).map((f) => f.t))
      // Not cut off while still moving, and not held open long after settling.
      expect(endedAt, `kind ${kind} cut short`).toBeGreaterThan(lastActive - 0.3)
      expect(endedAt, `kind ${kind} dead tail`).toBeLessThan(lastActive + 0.3)
      ends.push(endedAt)
    }
    // The tolerance above is per-move, so on its own it would still be met by
    // one shared duration for all four. The durations have to actually differ,
    // which is the thing the flat 1.4s got wrong.
    // Two moves may legitimately end up the same length, so this does not
    // demand four distinct values, only that they are not all one.
    expect(new Set(ends.map((e) => e.toFixed(2))).size, 'durations barely differ').toBeGreaterThan(2)
    expect(Math.max(...ends) - Math.min(...ends)).toBeGreaterThan(0.2)
  })

  it('does not clip the legs when a kick lands inside a jump', () => {
    // Moves fire on phrase edges and on drops, so a kick on the same frame as
    // the take-off crouch is the ordinary case. Both compress the legs, and
    // unattenuated they summed into the 0.4 pose floor and held it there for
    // over a fifth of a second.
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8 // the stance with the heaviest leg weighting
    rig.lastCycleSeen = 7
    rig.moveCount = 0
    let worst = 1
    for (let f = 0; f < 220; f++) {
      // Four on the floor at 126bpm, one of them on the opening frame.
      const pulses: Pulse[] =
        f % 57 === 0 ? [{ role: 'thump', intensity: 1, cyclePos: 0, cps: 0.525 }] : []
      const pose = advance(rig, pulses, Q, 1 / 120, MOVE)
      worst = Math.min(worst, ...pose.legs.map((l) => l.scaleY))
    }
    expect(worst).toBeGreaterThan(0.45)
  })

  it('does not clip the legs when a saturated kick lands on the impact frame', () => {
    // The bucket caps a role at 3, which three coincident intensity-1 kicks or
    // one accented pair both reach legally. Landing on the same frame used to
    // push the leading leg onto the 0.4 floor and hold it there.
    for (const kind of [0, 3]) {
      const rig = createRig()
      rig.sinceMove = 999
      rig.cycle = 8 // heaviest leg stance
      rig.lastCycleSeen = 7
      rig.moveCount = kind
      let worst = 1
      for (let f = 0; f < 220; f++) {
        // Four on the floor at 126bpm, every kick saturated, and the grid is
        // offset so that one of them lands on the frame the jump touches down.
        const pulses: Pulse[] =
          (f - 120) % 57 === 0 ? [kick(1, 0), kick(1, 0), kick(1, 0)] : []
        const inMove = rig.move !== null
        const pose = advance(rig, pulses, Q, 1 / 120, MOVE)
        // Only while the move owns the legs. Outside one, a saturated kick does
        // still reach the floor, and that is the clamp doing the job it is
        // documented for: it is the bound on coincident pulses, and rebalancing
        // the ordinary kick response is a separate question from these moves.
        if (inMove) worst = Math.min(worst, ...pose.legs.map((l) => l.scaleY))
      }
      expect(worst, `kind ${kind}`).toBeGreaterThan(0.45)
    }
  })

  it('does not clip the rotation when the backbeat lands inside a dip', () => {
    // A dip runs for over a second, so a snap inside one is ordinary rather
    // than a stress case. The held lean sits near the clamp by design, so an
    // unattenuated snap and hat reached 7.4 degrees against a limit of 7 and
    // pinned it flat for a tenth of a second.
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    rig.moveCount = 2
    let worst = 0
    for (let f = 0; f < 220; f++) {
      const pulses: Pulse[] = f % 10 === 0 ? [snap(1, 0), { ...snap(1, 0), role: 'tick' }] : []
      const pose = advance(rig, pulses, Q, 1 / 120, MOVE)
      worst = Math.max(worst, Math.abs(pose.body.rotation))
    }
    expect(worst).toBeLessThan(6.95)
  })

  it('scales a landing by the movement it took off with', () => {
    // m is captured into the move. Reading it live meant dragging the movement
    // slider mid-jump scaled the landing differently from the take-off.
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    rig.moveCount = 0
    advance(rig, [], Q, 1 / 120, MOVE)
    expect(rig.move?.m).toBe(MOVE)
    // Starve the rig of movement for the rest of the jump; the captured value
    // must survive, so the landing is still the one the take-off earned.
    for (let f = 0; f < 200; f++) advance(rig, [], Q, 1 / 120, 0.1)
    expect(rig.move?.m ?? MOVE).toBe(MOVE)
  })

  it('keeps the dip on the side it started, even if the backbeat flips', () => {
    // The dip carries its own direction. Reading rig.leanDir live meant a snap
    // landing mid-dip inverted the second half of the gesture.
    const rig = createRig()
    rig.sinceMove = 999
    rig.cycle = 8
    rig.lastCycleSeen = 7
    rig.moveCount = 2
    advance(rig, [], Q, 1 / 120, MOVE)
    const dir = rig.move?.dir
    expect(dir).toBeDefined()
    // Snaps throughout, which is what flips leanDir underneath it.
    for (let f = 0; f < 60; f++) advance(rig, [f % 8 === 0 ? snap(1, 0) : []].flat(), Q, 1 / 120, MOVE)
    expect(rig.move?.dir).toBe(dir)
  })

  it('does not let a drop starve the other three moves', () => {
    // A drop always takes the jump. It used to advance the rotation counter
    // anyway, so whichever move was next got skipped.
    const rig = createRig()
    rig.bassAvg = 0.1
    rig.sinceMove = 999
    rig.cycle = 3
    rig.lastCycleSeen = 3
    rig.moveCount = 1
    advance(rig, [], { rms: 0.4, sub: 0.5, bass: 0.9, mid: 0.3, high: 0.2 }, 1 / 120, MOVE)
    expect(rig.move?.kind).toBe(0)
    expect(rig.moveCount).toBe(1)
  })

  it('counts the cooldown from when the move ends', () => {
    // sinceMove was zeroed at the start and kept counting through the move, so
    // the documented seven seconds of quiet was really 7 minus the duration.
    const { rig, endedAt, frames } = moveTrace(0)
    const total = frames[frames.length - 1].t
    expect(rig.sinceMove).toBeCloseTo(total - endedAt, 1)
  })
})
