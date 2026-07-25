import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { subscribeToAudio } from '@/lib/audio-tap'

/**
 * These tests drive the shared tap's refcounting without any real audio
 * graph. The test environment is Node, so `window`, `requestAnimationFrame`,
 * and `cancelAnimationFrame` do not exist here: we stub minimal versions on
 * globalThis before each test and restore whatever was there afterward.
 *
 * The fake requestAnimationFrame queues callbacks rather than running them,
 * so a test can inspect how many animation chains are pending at any moment
 * and can advance the loop deliberately with tick().
 *
 * Every subscription is also registered with `cleanups`, and afterEach walks
 * that list unconditionally. That way, if one test's own assertion throws
 * partway through (which is exactly what we expect pre-fix), its dangling
 * subscription still gets torn down before the next test runs, so a caught
 * regression in an early test cannot cascade into false failures later in
 * the file.
 */

type FrameCallback = (now: number) => void

let queue: Map<number, FrameCallback>
let nextId: number
let totalStarts: number
let cleanups: Array<() => void>

function fakeRequestAnimationFrame(cb: FrameCallback): number {
  const id = nextId++
  queue.set(id, cb)
  totalStarts += 1
  return id
}

function fakeCancelAnimationFrame(id: number): void {
  queue.delete(id)
}

/** Invoke every callback currently pending, exactly once each. */
function tick(now = 0): void {
  const pending = Array.from(queue.values())
  queue.clear()
  for (const cb of pending) cb(now)
}

/** Subscribe and register the unsubscribe with the afterEach safety net. */
function subscribe(listener: () => void): () => void {
  const unsub = subscribeToAudio(listener)
  cleanups.push(unsub)
  return unsub
}

const hadWindow = 'window' in globalThis
const hadRaf = 'requestAnimationFrame' in globalThis
const hadCancelRaf = 'cancelAnimationFrame' in globalThis
const savedWindow = (globalThis as { window?: unknown }).window
const savedRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
const savedCancelRaf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame

describe('audio-tap refcounting', () => {
  beforeEach(() => {
    queue = new Map()
    nextId = 1
    totalStarts = 0
    cleanups = []
    // No getAudioContext / getSuperdoughAudioController, so currentNodes()
    // always reports null and no real audio API is ever touched.
    ;(globalThis as unknown as { window: unknown }).window = {}
    ;(globalThis as unknown as { requestAnimationFrame: typeof fakeRequestAnimationFrame }).requestAnimationFrame =
      fakeRequestAnimationFrame
    ;(globalThis as unknown as { cancelAnimationFrame: typeof fakeCancelAnimationFrame }).cancelAnimationFrame =
      fakeCancelAnimationFrame
  })

  afterEach(() => {
    // Best-effort teardown of anything a test (or its own failed assertion)
    // left subscribed, so state never leaks into the next test.
    for (const fn of cleanups.splice(0)) {
      try {
        fn()
      } catch {
        // A prior assertion failure shouldn't cascade into a second error.
      }
    }
    if (hadWindow) (globalThis as unknown as { window: unknown }).window = savedWindow
    else delete (globalThis as { window?: unknown }).window
    if (hadRaf) (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = savedRaf
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    if (hadCancelRaf) (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = savedCancelRaf
    else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
  })

  it('subscribing the same function reference twice starts only one loop', () => {
    const listener = () => {}
    subscribe(listener)
    subscribe(listener)
    expect(totalStarts).toBe(1)
    expect(queue.size).toBe(1)
  })

  it('stops the loop once every subscriber has left', () => {
    const a = () => {}
    const b = () => {}
    const unsubA = subscribe(a)
    const unsubB = subscribe(b)
    tick() // let the chain reschedule itself at least once
    expect(queue.size).toBe(1)

    unsubA()
    unsubB()
    expect(queue.size).toBe(0)

    const startsAfterStop = totalStarts
    tick() // nothing pending: nothing should fire, nothing should reschedule
    expect(totalStarts).toBe(startsAfterStop)
  })

  it('calling an unsubscribe twice is harmless while another subscriber remains', () => {
    const a = () => {}
    const b = () => {}
    const unsubA = subscribe(a)
    subscribe(b)

    unsubA()
    expect(queue.size).toBe(1) // b keeps the loop alive
    expect(() => unsubA()).not.toThrow()
    expect(queue.size).toBe(1) // no phantom teardown from the repeat call
  })

  it('subscribing again after everything unsubscribed starts cleanly', () => {
    const a = () => {}
    const unsubA = subscribe(a)
    unsubA()
    expect(queue.size).toBe(0)

    const b = () => {}
    subscribe(b)
    expect(queue.size).toBe(1)
  })

  it('a stale unsubscribe cannot tear down a later live subscription of the same reference', () => {
    // This is the scenario the earlier "calling unsubscribe twice is
    // harmless" test does not discriminate: there, only one subscription of
    // `a` ever exists, so a repeat delete is a no-op on the Set regardless of
    // whether the idempotency guard exists. Here, `a` is unsubscribed, then
    // re-subscribed with the exact same reference before the stale
    // unsubscribe is called again, so the Set legitimately contains `a`
    // again when the stale call runs. Without the `released` guard,
    // `listeners.delete(a)` would succeed a second time and tear down the
    // live subscription out from under it.
    let calls = 0
    const a = () => {
      calls += 1
    }

    // 1. subscribe with reference a, keep the returned unsubscribe as `first`
    const first = subscribe(a)
    // 2. call first() - the loop stops
    first()
    expect(queue.size).toBe(0)

    // 3. subscribe again with the SAME reference a - the loop restarts, and
    // this is a live subscription, independent of `first`.
    subscribe(a)
    expect(queue.size).toBe(1)

    // 4. call the STALE first() a second time
    first()

    // The live subscription from step 3 must survive: the loop is still
    // running, and it still delivers frames to `a`.
    expect(queue.size).toBe(1)
    tick()
    expect(calls).toBeGreaterThan(0)
  })
})
