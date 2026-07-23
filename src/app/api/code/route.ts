/**
 * =============================================================================
 * CODE API ENDPOINT
 * =============================================================================
 *
 * Handles reading and updating the Strudel code stored on the server.
 * Changes are automatically broadcast to connected clients via SSE.
 *
 * ENDPOINTS:
 *   GET  /api/code  - Retrieve the current code and playing status
 *   POST /api/code  - Update the stored code
 */

import { NextResponse } from 'next/server'
import { state } from '../state'

/**
 * GET /api/code
 *
 * Returns the current Strudel code and playing status.
 */
export async function GET() {
  return NextResponse.json({
    code: state.code,
    isPlaying: state.isPlaying,
  })
}

/** Upper bound on pushed code size - far above any real track, catches runaway payloads */
const MAX_CODE_LENGTH = 100_000

/**
 * POST /api/code
 *
 * Updates the stored Strudel code.
 * Change is broadcast to all connected SSE clients.
 * Returns 400 on malformed JSON or non-string code, 413 on oversized code.
 */
export async function POST(request: Request) {
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

  const { code } = body as { code?: unknown }
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
    state.code = code
  }

  return NextResponse.json({
    code: state.code,
    isPlaying: state.isPlaying,
  })
}
