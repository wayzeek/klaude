/**
 * =============================================================================
 * MOLTEK
 * =============================================================================
 *
 * The mascot. Nine rects plus headphones, moved by a spring rig that
 * reads the music: discrete beats from the layer pulse bus, continuous
 * spectrum from the shared audio tap.
 *
 * Nothing here touches React state. Pulses land in a queue, the audio tap
 * drives one frame callback, and poses are written straight onto SVG transform
 * attributes through refs. A re-render per audio event would be wasteful and,
 * at 150bpm across five layers, ruinous.
 */

'use client'

import { useEffect, useRef } from 'react'
import { acknowledge, advance, createRig, type Pulse as MotionPulse } from '@/lib/moltek-motion'
import { roleFor } from '@/lib/sound-roles'
import { onLayerPulse } from '@/lib/layer-pulse'
import { onAck } from '@/lib/ack-bus'
import { subscribeToAudio } from '@/lib/audio-tap'
import {
  BEAMS,
  BEAM_ALPHAS,
  BODY,
  BOOTH,
  HAZE_BACK,
  HAZE_BACK_ALPHAS,
  HAZE_BACK_DRIFT,
  HAZE_FRONT,
  HAZE_FRONT_ALPHAS,
  HAZE_FRONT_DRIFT,
  FLOOR,
  GRILLES,
  LAMPS,
  STACKS,
  TRUSS,
  WALL_BANDS,
  WOOFERS,
  BOOTH_FADERS,
  BOOTH_JOGS,
  BOOTH_LEDS,
  BOOTH_XFADER,
  CANS,
  CUP_OFF,
  CUP_OFF_OFFSET,
  EYES,
  GROUND_CLIP,
  GROUND_Y,
  HANDS,
  LED_HOT_FROM,
  LEGS,
  PIVOT,
  VIEWBOX,
} from '@/lib/moltek-sprite'

/** How much he moves. Raise for a bigger performance. */
const MOVE = 1.7
/** Flashes per second, capped well under the photosensitivity guidance of 3Hz. */
const MAX_STROBE_HZ = 3
/**
 * How long one flash stays lit.
 *
 * Held as a wall-clock duration rather than as a threshold on the rig's decay,
 * so a flash is the same length at any frame rate. It has to be several frames:
 * a full-viewport screen-blend rect lit for a single frame is indistinguishable
 * from a dropped frame, which is what the old gate produced.
 */
const STROBE_MS = 70

function about(ox: number, oy: number, ops: string): string {
  return `translate(${ox} ${oy}) ${ops} translate(${-ox} ${-oy})`
}

export function Moltek({ size = 180 }: { size?: number }) {
  const bodyRef = useRef<SVGGElement>(null)
  const eyesRef = useRef<SVGGElement>(null)
  const eyesBodyRef = useRef<SVGGElement>(null)
  const strobeRef = useRef<SVGRectElement>(null)
  const legRefs = useRef<(SVGRectElement | null)[]>([])
  const handRefs = useRef<(SVGGElement | null)[]>([])
  const jogRefs = useRef<(SVGRectElement | null)[]>([])
  const xfaderRef = useRef<SVGRectElement>(null)
  // Last written lit state per element, so the loop can skip no-op attribute
  // writes. Style recalculation, not painting, was the cost.
  const ledStateRef = useRef<string[]>([])
  const lampStateRef = useRef<string[]>([])
  const ledRefs = useRef<(SVGRectElement | null)[]>([])
  const lampRefs = useRef<(SVGRectElement | null)[]>([])
  const beamRefs = useRef<(SVGRectElement | null)[]>([])
  const wooferRefs = useRef<(SVGRectElement | null)[]>([])
  const hazeBackRefs = useRef<(SVGRectElement | null)[]>([])
  const hazeFrontRefs = useRef<(SVGRectElement | null)[]>([])
  const figureRef = useRef<SVGGElement>(null)
  const figureTopRef = useRef<SVGGElement>(null)

  useEffect(() => {
    const rig = createRig()
    const queue: MotionPulse[] = []
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    /* -Infinity, not 0. performance.now() is milliseconds since navigation, so
       zero is a real recent timestamp: on the first frames of a fresh load it
       is under STROBE_MS, which lit the strobe with nothing playing, and it is
       under the onset gate, which then swallowed the first genuine kick. */
    let lastStrobe = -Infinity
    let hazeT = 0

    const stopPulses = onLayerPulse(({ layer, sound, intensity, cyclePos, cps }) => {
      // Bounded: a stalled frame loop must not let this grow without limit.
      if (queue.length > 64) queue.shift()
      queue.push({ role: roleFor(sound, layer), intensity, cyclePos, cps })
    })

    // A note landing makes him nod. Flagged here and consumed on the next
    // frame so the gesture is applied on the animation loop like everything
    // else, rather than from whatever context the note was sent in.
    let nodPending = false
    const stopAck = onAck(() => {
      nodPending = true
    })

    const stopAudio = subscribeToAudio((bands, dt) => {
      if (nodPending) {
        nodPending = false
        acknowledge(rig, reduced.matches ? 0.35 : MOVE)
      }
      const pulses = queue.splice(0, queue.length)
      const move = reduced.matches ? 0.35 : MOVE
      const pose = advance(rig, pulses, bands, dt, move)

      const bodyTransform =
        `translate(${pose.body.x.toFixed(2)} ${pose.body.y.toFixed(2)}) ` +
        about(
          PIVOT.x,
          PIVOT.y,
          `rotate(${pose.body.rotation.toFixed(3)}) scale(1 ${pose.body.scaleY.toFixed(4)})`,
        )
      if (bodyRef.current) bodyRef.current.setAttribute('transform', bodyTransform)
      // The eyes live outside the body group so they draw over the claws, so
      // they have to carry the body's own movement themselves.
      if (eyesBodyRef.current) eyesBodyRef.current.setAttribute('transform', bodyTransform)

      pose.legs.forEach((leg, i) => {
        const el = legRefs.current[i]
        if (!el) return
        el.setAttribute(
          'transform',
          `translate(${(pose.body.x * 0.35).toFixed(2)} ${(pose.body.y * 0.5).toFixed(2)}) ` +
            about(
              LEGS[i].x + LEGS[i].w / 2,
              GROUND_Y,
              `rotate(${leg.rotation.toFixed(2)}) scale(1 ${leg.scaleY.toFixed(4)})`,
            ),
        )
      })

      pose.hands.forEach((hand, i) => {
        const el = handRefs.current[i]
        if (!el) return
        el.setAttribute(
          'transform',
          // The +17 in pose.hands.y is kept, not cancelled: it is what brings
          // the claws down onto the booth surface at y=58.
          `translate(${hand.x.toFixed(2)} ${hand.y.toFixed(2)}) ` +
            about(i === 0 ? 22 : 85, 32, `rotate(${hand.rotation.toFixed(2)})`),
        )
      })

      // The gear answers the music too: jogs nudge with the body, the
      // crossfader slides with the lean, the LEDs read the master level.
      const nudge = pose.body.y * 0.25
      if (jogRefs.current[0]) jogRefs.current[0].setAttribute('transform', `translate(${-nudge.toFixed(2)} 0)`)
      if (jogRefs.current[1]) jogRefs.current[1].setAttribute('transform', `translate(${nudge.toFixed(2)} 0)`)
      if (xfaderRef.current) {
        xfaderRef.current.setAttribute(
          'transform',
          `translate(${(pose.body.rotation * 1.6).toFixed(2)} 0)`,
        )
      }
      const lit = Math.max(0, Math.min(1, bands.rms * 3.2)) * ledRefs.current.length
      ledRefs.current.forEach((led, i) => {
        if (!led) return
        // A state attribute, not a fill: writing hex here is what used to
        // strand the meter on the previous theme after a switch.
        //
        // Only written when it actually changes. An attribute that participates
        // in selector matching forces a style recalculation, so writing all
        // twelve every frame cost far more than the old paint-only fill write
        // and made the whole rig judder.
        const want = i < lit ? (i >= LED_HOT_FROM ? 'hot' : 'on') : 'off'
        if (ledStateRef.current[i] !== want) {
          ledStateRef.current[i] = want
          led.setAttribute('data-lit', want)
        }
      })

      // The room answers too. Lamps and beams ride the same envelope as the
      // strobe but stay on continuously rather than flashing, so the rig
      // reads as lighting rather than as a second strobe.
      const glow = Math.max(0, Math.min(1, pose.strobe * 0.8 + bands.bass * 0.5))
      lampRefs.current.forEach((lamp, i) => {
        if (!lamp) return
        // Alternate lamps favour the off-beat, so the rig chases rather than
        // pulsing all at once.
        const bias = i % 2 === 0 ? glow : glow * 0.45 + bands.high * 0.4
        const lampWant = bias > 0.35 ? 'on' : 'off'
        if (lampStateRef.current[i] !== lampWant) {
          lampStateRef.current[i] = lampWant
          lamp.setAttribute('data-lit', lampWant)
        }
      })
      beamRefs.current.forEach((beam, i) => {
        if (!beam) return
        // Three rects per lamp, so the lamp index is i/3 and the cone segment
        // is i%3. Segments fade downward, which is what makes the stack read
        // as a widening beam rather than three bars.
        const bias = Math.floor(i / 3) % 2 === 0 ? glow : glow * 0.45
        beam.setAttribute('opacity', (bias * BEAM_ALPHAS[i % 3]).toFixed(3))
      })
      wooferRefs.current.forEach((w, i) => {
        if (!w) return
        const punch = 1 + Math.min(0.5, bands.bass * 0.8 + pose.strobe * 0.25)
        const cx = WOOFERS[i].x + WOOFERS[i].w / 2
        const cy = WOOFERS[i].y + WOOFERS[i].h / 2
        w.setAttribute('transform', about(cx, cy, `scale(${punch.toFixed(3)})`))
      })
      // Haze: thickens with the bass and drifts sideways, each band at its
      // own speed and direction so the room never reads as one sliding sheet.
      // Both halves of the figure lift together; the booth between them does not.
      const lift = `translate(0 ${pose.lift.toFixed(2)})`
      if (figureRef.current) figureRef.current.setAttribute('transform', lift)
      if (figureTopRef.current) figureTopRef.current.setAttribute('transform', lift)

      hazeT += dt
      const density = 0.55 + Math.min(1, bands.bass * 1.6) * 0.45
      hazeBackRefs.current.forEach((h, i) => {
        if (!h) return
        h.setAttribute('opacity', (HAZE_BACK_ALPHAS[i] * density).toFixed(3))
        h.setAttribute('transform', `translate(${((hazeT * HAZE_BACK_DRIFT[i]) % 60).toFixed(1)} 0)`)
      })
      hazeFrontRefs.current.forEach((h, i) => {
        if (!h) return
        h.setAttribute('opacity', (HAZE_FRONT_ALPHAS[i] * density).toFixed(3))
        h.setAttribute('transform', `translate(${((hazeT * HAZE_FRONT_DRIFT[i]) % 60).toFixed(1)} 0)`)
      })

      if (eyesRef.current) {
        eyesRef.current.setAttribute(
          'transform',
          `translate(${pose.eyes.x.toFixed(2)} ${pose.eyes.y.toFixed(2)}) ` +
            about(53, 16.5, `scale(1 ${pose.eyes.scaleY.toFixed(3)})`),
        )
      }

      if (strobeRef.current) {
        // Hard on/off, rate limited, and off entirely under reduced motion.
        //
        // The rate limit gates when a flash may *start*, and the flash then
        // runs for its own length. Re-stamping the gate on every lit frame
        // instead conflated the two: the next frame was inside the window, so
        // every flash was cut to exactly one frame no matter how long the rig
        // held it up, and one frame of full-frame ivory reads as a glitch.
        const now = performance.now()
        if (!reduced.matches && pose.strobe > 0.5 && now - lastStrobe > 1000 / MAX_STROBE_HZ) {
          lastStrobe = now
        }
        const on = !reduced.matches && now - lastStrobe < STROBE_MS
        strobeRef.current.setAttribute('opacity', on ? '0.28' : '0')
      }
    })

    return () => {
      stopPulses()
      stopAck()
      stopAudio()
    }
  }, [])

  const height = Math.round((size * VIEWBOX.h) / VIEWBOX.w)

  return (
    <svg
      width={size}
      height={height}
      viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      // The room's bands are far wider than the frame so they can drift
      // without their ends ever showing, which means the sprite must clip
      // itself. Left visible, they streak across the whole page anywhere the
      // parent is not already hiding overflow.
      style={{ overflow: 'hidden', display: 'block' }}
    >
      <defs>
        <clipPath id="moltek-ground">
          <rect x={GROUND_CLIP.x} y={GROUND_CLIP.y} width={GROUND_CLIP.w} height={GROUND_CLIP.h} />
        </clipPath>
      </defs>

      {/* The room, behind everything. */}
      <g>
        {WALL_BANDS.map((r, i) => (
          <rect key={`wall-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        <rect x={FLOOR.x} y={FLOOR.y} width={FLOOR.w} height={FLOOR.h} className={FLOOR.role} />
        {BEAMS.map((r, i) => (
          <rect
            key={`beam-${i}`}
            ref={(el) => {
              beamRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
            opacity="0"
          />
        ))}
        {TRUSS.map((r, i) => (
          <rect key={`truss-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        {LAMPS.map((r, i) => (
          <rect
            key={`lamp-${i}`}
            ref={(el) => {
              lampRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
          />
        ))}
        {STACKS.map((r, i) => (
          <rect key={`stack-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        {GRILLES.map((r, i) => (
          <rect key={`grille-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        {WOOFERS.map((r, i) => (
          <rect
            key={`woofer-${i}`}
            ref={(el) => {
              wooferRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
          />
        ))}
        {/* Haze behind him, so the beams have something to land on. */}
        {HAZE_BACK.map((r, i) => (
          <rect
            key={`haze-b-${i}`}
            ref={(el) => {
              hazeBackRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
            opacity="0"
          />
        ))}
      </g>

      {/* Everything that leaves the floor when he jumps. The room and the
          booth deliberately stay put. */}
      <g ref={figureRef}>
      <g clipPath="url(#moltek-ground)">
        {LEGS.map((leg, i) => (
          <rect
            key={i}
            ref={(el) => {
              legRefs.current[i] = el
            }}
            x={leg.x}
            y={leg.y}
            width={leg.w}
            height={leg.h}
            className={leg.role}
          />
        ))}
      </g>

      <g ref={bodyRef}>
        <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} className={BODY.role} />
        {CANS.map((r, i) => (
          <rect key={`can-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        <g transform={`translate(${CUP_OFF_OFFSET.x} ${CUP_OFF_OFFSET.y})`}>
          {CUP_OFF.map((r, i) => (
            <rect key={`cup-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
          ))}
        </g>
      </g>

      </g>

      {/* The booth: after the body so it covers his lower half, before the
          claws so they rest on the surface. It is deliberately outside both
          lift groups, because the gear stays bolted to the floor when he
          leaves it. */}
      <g>
        {BOOTH.map((r, i) => (
          <rect key={`booth-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        {BOOTH_JOGS.map((r, i) => (
          <rect
            key={`jog-${i}`}
            ref={(el) => {
              jogRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
          />
        ))}
        {BOOTH_FADERS.map((r, i) => (
          <rect key={`fader-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} className={r.role} />
        ))}
        <rect
          ref={xfaderRef}
          x={BOOTH_XFADER.x}
          y={BOOTH_XFADER.y}
          width={BOOTH_XFADER.w}
          height={BOOTH_XFADER.h}
          className={BOOTH_XFADER.role}
        />
        {BOOTH_LEDS.map((r, i) => (
          <rect
            key={`led-${i}`}
            ref={(el) => {
              ledRefs.current[i] = el
            }}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={r.role}
          />
        ))}
      </g>

      {/* Second lift group: the claws and eyes rise with him, but they have
          to draw after the booth so the claws stay on top of the gear. */}
      <g ref={figureTopRef}>
      {HANDS.map((hand, i) => (
        <g
          key={`hand-${i}`}
          ref={(el) => {
            handRefs.current[i] = el
          }}
        >
          <rect x={hand.x} y={hand.y} width={hand.w} height={hand.h} className={hand.role} />
        </g>
      ))}

      {/* Eyes last, so a raised claw can never cover them. They ride the body,
          so they carry the body transform on an outer group plus their own
          blink and parallax on an inner one. */}
      <g ref={eyesBodyRef}>
        <g ref={eyesRef}>
          {EYES.map((eye, i) => (
            <rect key={`eye-${i}`} x={eye.x} y={eye.y} width={eye.w} height={eye.h} className={eye.role} />
          ))}
        </g>
      </g>
      </g>

      {/* Foreground haze, in front of everything but the strobe. */}
      {HAZE_FRONT.map((r, i) => (
        <rect
          key={`haze-f-${i}`}
          ref={(el) => {
            hazeFrontRefs.current[i] = el
          }}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          className={r.role}
          opacity="0"
        />
      ))}

      <rect
        ref={strobeRef}
        x={VIEWBOX.x}
        y={VIEWBOX.y}
        width={VIEWBOX.w}
        height={VIEWBOX.h}
        className="m-cap"
        opacity="0"
        style={{ mixBlendMode: 'screen' }}
      />
    </svg>
  )
}
