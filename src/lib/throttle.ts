/**
 * =============================================================================
 * THROTTLE
 * =============================================================================
 *
 * Leading-edge throttle with a flush, for controls that are dragged.
 *
 * The distinction from a debounce is the whole point. A debounce restarts its
 * timer on every move, so a slider held in motion sends nothing at all until
 * the pointer stops. A throttle sends the first move at once and then at most
 * one move per interval, which is what lets a fader be ridden.
 *
 * Deliveries are also serialized. `send` is a network request here, so two in
 * flight at once can be processed out of order: an older value landing last
 * overwrites the newer one and the control snaps back to a position the
 * listener already left. The first send still goes out synchronously, so a
 * fader never feels laggy; only a send that would overlap one still in flight
 * waits its turn.
 */

export type Throttle<T> = {
  /** Offer a value. Sends now, or schedules the newest value. */
  push: (value: T) => void
  /** Send any pending value immediately. Call on pointer-up. */
  flush: () => void
  /** Drop any pending value. Call on unmount. */
  cancel: () => void
}

export function createThrottle<T>(
  send: (value: T) => void | Promise<unknown>,
  intervalMs: number,
): Throttle<T> {
  let lastSentAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  /** Deliveries still unresolved, and the tail to chain the next one onto. */
  let inFlight = 0
  let chain: Promise<unknown> = Promise.resolve()

  const fire = (value: T) => {
    lastSentAt = Date.now()
    inFlight += 1
    const settle = () => {
      inFlight -= 1
    }
    // Nothing outstanding: deliver in this tick, so the leading edge is truly
    // immediate. Otherwise queue behind the send already in flight.
    chain =
      inFlight === 1
        ? Promise.resolve(send(value))
            .catch(() => {})
            .finally(settle)
        : chain
            .then(() => send(value))
            .catch(() => {})
            .finally(settle)
  }

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    push(value: T) {
      const now = Date.now()
      const waited = now - lastSentAt
      if (waited >= intervalMs) {
        clear()
        pending = null
        fire(value)
        return
      }
      // Inside the window: keep only the newest value, and make sure exactly
      // one timer is armed to deliver it.
      pending = { value }
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          if (pending !== null) {
            const { value: latest } = pending
            pending = null
            fire(latest)
          }
        }, intervalMs - waited)
      }
    },
    flush() {
      clear()
      if (pending !== null) {
        const { value } = pending
        pending = null
        fire(value)
      }
    },
    cancel() {
      clear()
      pending = null
    },
  }
}
