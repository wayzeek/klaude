/**
 * =============================================================================
 * NOTES API ENDPOINT
 * =============================================================================
 *
 * Free-text listener feedback, aimed at a named layer or the whole track.
 * The console posts here; the agent reads between phases and acts on it.
 * Each note is stamped with the revision and HUD section playing at the time.
 *
 * ENDPOINTS:
 *   POST /api/notes { "text": string, "layer"?: string }
 *   GET  /api/notes - Recent notes, oldest first, plus serverTime.
 *   DELETE /api/notes - Clear the queue (new session, or test cleanup).
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const RECENT_LIMIT = 50
const MAX_TEXT_LENGTH = 500
const MAX_LAYER_LENGTH = 40

export async function GET() {
  return NextResponse.json({
    notes: state.notes.slice(-RECENT_LIMIT),
    serverTime: Date.now(),
  })
}

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { text, layer } = (body ?? {}) as { text?: unknown; layer?: unknown }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text must be a non-empty string (max ${MAX_TEXT_LENGTH} chars)` },
      { status: 400 },
    )
  }
  if (layer !== undefined && (typeof layer !== 'string' || layer.length === 0 || layer.length > MAX_LAYER_LENGTH)) {
    return NextResponse.json(
      { error: `layer must be a non-empty string (max ${MAX_LAYER_LENGTH} chars)` },
      { status: 400 },
    )
  }

  return NextResponse.json({ note: state.addNote(trimmed, (layer as string | undefined) ?? null) })
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.clearNotes()
  return NextResponse.json({ notes: [] })
}
