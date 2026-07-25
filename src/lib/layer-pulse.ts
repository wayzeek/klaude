/**
 * =============================================================================
 * LAYER PULSE BUS
 * =============================================================================
 *
 * Tiny pub/sub between the layers() runtime (which learns when a layer's
 * pattern fires an event) and everything that reacts to a beat: the console
 * rows that blink, and the mascot. Module-level so the audio path never
 * touches React state directly.
 *
 * Pulses are scheduled ahead of time and fired when the sound becomes
 * audible, so the bus owns their timers and can cancel them. Without that,
 * pulses queued before a stop still land after it and the mascot twitches at
 * silence.
 */

export type Pulse = {
  layer: string
  /** Strudel's sound name (`bd`, `hh`, `sawtooth`), when the event has one. */
  sound?: string
  /** gain * velocity, clamped to [0, 2]. A ghost note nudges, an accent throws. */
  intensity: number
  /** Normalised position within the current cycle, [0, 1). */
  cyclePos: number
  /** Cycles per second, for tempo-locked motion. */
  cps: number
}

type PulseListener = (pulse: Pulse) => void

const listeners = new Set<PulseListener>()
const pending = new Set<ReturnType<typeof setTimeout>>()

export function onLayerPulse(listener: PulseListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitLayerPulse(pulse: Pulse): void {
  listeners.forEach((listener) => {
    // One listener throwing must not stop delivery to the others.
    try {
      listener(pulse)
    } catch (err) {
      console.error('[moltek] layer pulse listener failed:', err)
    }
  })
}

/** Schedule a pulse for when its sound becomes audible. */
export function schedulePulse(pulse: Pulse, delayMs: number): void {
  const timer = setTimeout(() => {
    pending.delete(timer)
    emitLayerPulse(pulse)
  }, delayMs)
  pending.add(timer)
}

/** Drop every pulse that has not fired yet. Called when playback stops. */
export function clearPendingPulses(): void {
  pending.forEach((timer) => clearTimeout(timer))
  pending.clear()
}
