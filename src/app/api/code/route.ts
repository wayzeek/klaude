/**
 * =============================================================================
 * CODE API ENDPOINT
 * =============================================================================
 *
 * Handles reading and updating the Strudel code stored on the server.
 * Changes are automatically broadcast to connected clients via SSE.
 *
 * ENDPOINTS:
 *   GET  /api/code  - Retrieve the current code, revision, and playing state
 *   POST /api/code  - Update the stored code; pass { "play": true } to
 *                     atomically start playback of the new revision
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

export async function GET() {
  return NextResponse.json({
    code: state.code,
    revision: state.revision,
    desiredPlaying: state.desiredPlaying,
    actualPlaying: state.actualPlaying,
  })
}

/** Upper bound on pushed code size - far above any real track, catches runaway payloads */
const MAX_CODE_LENGTH = 100_000

/**
 * POST /api/code
 *
 * Body: { "code": "...", "play": true? }
 * Returns 400 on malformed JSON or non-string code, 413 on oversized code.
 * The response includes the new revision - check /api/status afterwards to
 * see whether the browser evaluated it successfully (lastEval).
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body. Only \\", \\\\, \\n, \\t, \\r, \\/ are valid string escapes.' },
      { status: 400 },
    )
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Body must be a JSON object like {"code": "..."}' },
      { status: 400 },
    )
  }

  const { code, play } = body as { code?: unknown; play?: unknown }
  if (code !== undefined) {
    if (typeof code !== 'string') {
      return NextResponse.json({ error: '"code" must be a string' }, { status: 400 })
    }
    if (code.length > MAX_CODE_LENGTH) {
      return NextResponse.json(
        { error: `"code" exceeds ${MAX_CODE_LENGTH} characters` },
        { status: 413 },
      )
    }
    const before = state.revision
    // Atomic push-and-play emits ONE snapshot; separate setCode + play
    // emissions would make browsers evaluate twice.
    if (play === true) {
      state.pushAndPlay(code)
    } else {
      state.setCode(code)
    }
    return NextResponse.json({
      code: state.code,
      revision: state.revision,
      unchanged: state.revision === before,
      desiredPlaying: state.desiredPlaying,
      playEpoch: state.playEpoch,
    })
  }

  if (play === true) {
    state.play()
  }

  return NextResponse.json({
    code: state.code,
    revision: state.revision,
    desiredPlaying: state.desiredPlaying,
    playEpoch: state.playEpoch,
  })
}
