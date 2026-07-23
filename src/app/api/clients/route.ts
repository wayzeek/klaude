/**
 * =============================================================================
 * CLIENTS API ENDPOINT
 * =============================================================================
 *
 * POST /api/clients - Browser tabs report readiness and playback state.
 *
 * "Connected" alone doesn't mean anyone can hear anything: the editor may
 * still be booting, and audio stays locked until the user's first gesture.
 * Tabs post here whenever readiness changes so /api/status tells the truth.
 *
 * Body: {
 *   clientId: string,
 *   editorReady?: boolean,
 *   audioReady?: boolean,
 *   isPlaying?: boolean,
 *   appliedRevision?: number
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

  const { clientId, editorReady, audioReady, isPlaying, appliedRevision } = (body ?? {}) as {
    clientId?: unknown
    editorReady?: unknown
    audioReady?: unknown
    isPlaying?: unknown
    appliedRevision?: unknown
  }

  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: '"clientId" (string) is required' }, { status: 400 })
  }

  const patch: Record<string, boolean | number> = {}
  if (typeof editorReady === 'boolean') patch.editorReady = editorReady
  if (typeof audioReady === 'boolean') patch.audioReady = audioReady
  if (typeof isPlaying === 'boolean') patch.isPlaying = isPlaying
  if (typeof appliedRevision === 'number') patch.appliedRevision = appliedRevision

  state.updateClient(clientId, patch)

  return NextResponse.json({ recorded: true })
}
