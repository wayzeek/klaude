/**
 * =============================================================================
 * HISTORY API ENDPOINT
 * =============================================================================
 *
 * Every pushed revision is kept (up to a cap) and persisted across restarts,
 * so "go back to how it was before" is always possible.
 *
 * ENDPOINTS:
 *   GET  /api/history                    - List revisions (metadata only)
 *   GET  /api/history?revision=N         - Full code of one revision
 *   POST /api/history { "revision": N }  - Restore revision N as a NEW
 *                                          revision (history is append-only)
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

export async function GET(request: Request) {
  const revisionParam = new URL(request.url).searchParams.get('revision')

  if (revisionParam !== null) {
    const revision = Number(revisionParam)
    const entry = state.history.find((h) => h.revision === revision)
    if (!entry) {
      return NextResponse.json({ error: `Revision ${revisionParam} not in history` }, { status: 404 })
    }
    return NextResponse.json(entry)
  }

  return NextResponse.json({
    current: state.revision,
    entries: state.history.map((h) => ({
      revision: h.revision,
      at: h.at,
      chars: h.code.length,
      firstLine: h.code.split('\n', 1)[0].slice(0, 80),
    })),
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

  const { revision } = (body ?? {}) as { revision?: unknown }
  if (typeof revision !== 'number') {
    return NextResponse.json({ error: '"revision" (number) is required' }, { status: 400 })
  }

  const entry = state.history.find((h) => h.revision === revision)
  if (!entry) {
    return NextResponse.json({ error: `Revision ${revision} not in history` }, { status: 404 })
  }

  // Restoring code identical to the current revision is a no-op (flagged in
  // the response) - history stays append-only for real changes.
  const before = state.revision
  const newRevision = state.setCode(entry.code)
  return NextResponse.json({
    restoredFrom: revision,
    revision: newRevision,
    unchanged: newRevision === before,
    desiredPlaying: state.desiredPlaying,
  })
}
