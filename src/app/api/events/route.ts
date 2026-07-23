/**
 * =============================================================================
 * EVENTS API ENDPOINT (Server-Sent Events)
 * =============================================================================
 *
 * Streams state changes to connected clients in real-time.
 *
 * ENDPOINT:
 *   GET /api/events - Opens an SSE stream
 *
 * EVENTS:
 *   - state: Fired when code or isPlaying changes
 *     data: { code: string, isPlaying: boolean }
 */

import { state } from '../state'

export const dynamic = 'force-dynamic'

/** Interval between SSE heartbeat comments, keeps idle connections alive through proxies */
const HEARTBEAT_MS = 25_000

export async function GET() {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let isClosed = false

  const cleanup = () => {
    isClosed = true
    if (heartbeat) clearInterval(heartbeat)
    if (unsubscribe) unsubscribe()
  }

  const stream = new ReadableStream({
    start(controller) {
      // Send initial state
      const initial = `data: ${JSON.stringify(state.state)}\n\n`
      controller.enqueue(encoder.encode(initial))

      // Subscribe to state changes
      unsubscribe = state.subscribe((newState) => {
        if (isClosed) return
        try {
          const message = `data: ${JSON.stringify(newState)}\n\n`
          controller.enqueue(encoder.encode(message))
        } catch {
          // Controller closed, clean up
          cleanup()
        }
      })

      // Periodic comment lines so idle streams aren't torn down
      heartbeat = setInterval(() => {
        if (isClosed) return
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          cleanup()
        }
      }, HEARTBEAT_MS)
    },
    cancel() {
      // Called when client disconnects
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
