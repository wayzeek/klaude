/**
 * =============================================================================
 * RECORD START API ENDPOINT
 * =============================================================================
 *
 * POST /api/record/start - Ask the browser to start capturing audio to WAV.
 *
 * The command targets one specific client (the most recently active tab with
 * audio unlocked) and carries an id, so reconnects can't replay it and
 * multiple tabs never record in parallel. Follow /api/status → recording for
 * progress; the file lands via the browser's upload to /api/recordings.
 */

import { NextResponse } from 'next/server'
import { state } from '../../state'
import { rejectCrossOrigin } from '../../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.reconcileRecording()
  const phase = state.recording.phase
  if (phase === 'starting' || phase === 'recording' || phase === 'stopping') {
    return NextResponse.json({ error: `Recording already ${phase}` }, { status: 409 })
  }

  const command = state.issueRecordCommand('record-start')
  if (!command) {
    return NextResponse.json(
      {
        error:
          'No browser tab with audio ready. Open http://localhost:3000 and start playback once (audio unlocks on first play).',
      },
      { status: 503 },
    )
  }

  return NextResponse.json({ recording: state.recording, commandId: command.id })
}
