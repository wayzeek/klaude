/**
 * =============================================================================
 * EVENTS API ENDPOINT (Server-Sent Events)
 * =============================================================================
 *
 * Streams state changes to connected clients in real-time.
 *
 * ENDPOINT:
 *   GET /api/events?clientId=<uuid> - Opens an SSE stream
 *
 * The clientId registers the browser tab in the client registry so
 * /api/status can report who is connected and ready. Readiness details
 * (editor loaded, audio unlocked) arrive separately via POST /api/clients.
 *
 * EVENTS:
 *   - message: fired on every state change
 *     data: BroadcastState (code, revision, desiredPlaying, playEpoch,
 *           gain, nowPlaying, command)
 */

import { state } from '../state'

export const dynamic = 'force-dynamic'

/** Interval between SSE heartbeat comments, keeps idle connections alive through proxies */
const HEARTBEAT_MS = 25_000

export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get('clientId')

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let isClosed = false

  if (clientId) {
    state.registerClient(clientId)
  }

  const cleanup = () => {
    if (isClosed) return
    isClosed = true
    if (heartbeat) clearInterval(heartbeat)
    if (unsubscribe) unsubscribe()
    if (clientId) state.unregisterClient(clientId)
  }

  const stream = new ReadableStream({
    start(controller) {
      // Send initial state
      const initial = `data: ${JSON.stringify(state.broadcast)}\n\n`
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
