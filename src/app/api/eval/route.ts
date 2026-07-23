/**
 * =============================================================================
 * EVAL RESULT API ENDPOINT
 * =============================================================================
 *
 * POST /api/eval - The browser reports the outcome of evaluating a revision.
 *
 * This closes the agent's feedback loop: after pushing code, the agent checks
 * /api/status → lastEval to learn whether the push actually produced sound or
 * threw. Results are keyed by revision + playEpoch so stale reports for old
 * pushes can't masquerade as fresh ones.
 *
 * Body: {
 *   clientId: string,
 *   revision: number,
 *   playEpoch: number,
 *   ok: boolean,
 *   error?: string
 * }
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { clientId, revision, playEpoch, ok, error } = (body ?? {}) as {
    clientId?: unknown
    revision?: unknown
    playEpoch?: unknown
    ok?: unknown
    error?: unknown
  }

  if (
    typeof clientId !== 'string' ||
    typeof revision !== 'number' ||
    typeof playEpoch !== 'number' ||
    typeof ok !== 'boolean'
  ) {
    return NextResponse.json(
      { error: 'Body must include clientId (string), revision (number), playEpoch (number), ok (boolean)' },
      { status: 400 },
    )
  }

  state.recordEval({
    clientId,
    revision,
    playEpoch,
    ok,
    error: typeof error === 'string' ? error : null,
    at: Date.now(),
  })

  return NextResponse.json({ recorded: true })
}
