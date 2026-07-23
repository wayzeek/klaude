/**
 * =============================================================================
 * STOP API ENDPOINT
 * =============================================================================
 *
 * POST /api/stop - Stop playback. Also clears the now-playing metadata.
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.stop()
  return NextResponse.json({
    desiredPlaying: state.desiredPlaying,
    revision: state.revision,
  })
}
