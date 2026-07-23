/**
 * =============================================================================
 * REACTIONS API ENDPOINT
 * =============================================================================
 *
 * The listener's way to talk back without typing - the browser's reaction bar
 * posts here, and the agent reads the room between phases.
 *
 * ENDPOINTS:
 *   POST /api/reactions { "kind": "fire" | "love" | "sleep" }
 *        Each reaction is tagged with the current revision and HUD section.
 *   GET  /api/reactions - Recent reactions, oldest first, plus serverTime for
 *        judging freshness.
 *   DELETE /api/reactions - Clear the room (new set, or test cleanup).
 */

import { NextResponse } from 'next/server'
import { state, REACTION_KINDS, type ReactionKind } from '../state'
import { rejectCrossOrigin } from '../guard'

const RECENT_LIMIT = 50

export async function GET() {
  return NextResponse.json({
    reactions: state.reactions.slice(-RECENT_LIMIT),
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

  const kind = (body as { kind?: unknown })?.kind
  if (typeof kind !== 'string' || !REACTION_KINDS.includes(kind as ReactionKind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${REACTION_KINDS.join(', ')}` },
      { status: 400 },
    )
  }

  return NextResponse.json({ reaction: state.addReaction(kind as ReactionKind) })
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.clearReactions()
  return NextResponse.json({ reactions: [] })
}
