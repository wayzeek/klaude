/**
 * =============================================================================
 * PLAY API ENDPOINT
 * =============================================================================
 *
 * POST /api/play - Request playback of the current code.
 *
 * Always bumps the play epoch, so posting while already playing forces the
 * browser to re-evaluate the current code (useful after a flaky eval).
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.play()
  return NextResponse.json({
    desiredPlaying: state.desiredPlaying,
    playEpoch: state.playEpoch,
    revision: state.revision,
  })
}
