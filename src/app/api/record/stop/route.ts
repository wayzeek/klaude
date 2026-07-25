/**
 * =============================================================================
 * RECORD STOP API ENDPOINT
 * =============================================================================
 *
 * POST /api/record/stop - Ask the recording browser tab to finish capturing.
 * The tab encodes the WAV and uploads it to /api/recordings; poll
 * /api/status → recording until phase is "done" (with the file path) or "error".
 */

import { NextResponse } from 'next/server'
import { state } from '../../state'
import { rejectCrossOrigin } from '../../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.reconcileRecording()
  const phase = state.recording.phase
  if (phase !== 'starting' && phase !== 'recording') {
    return NextResponse.json({ error: `No active recording (phase: ${phase})` }, { status: 409 })
  }

  // issueRecordCommand targets the tab that is actually recording
  const command = state.issueRecordCommand('record-stop')
  if (!command) {
    state.setRecording({ phase: 'error', error: 'Recording tab disconnected', at: Date.now() })
    return NextResponse.json({ error: 'Recording tab disconnected' }, { status: 503 })
  }

  return NextResponse.json({ recording: state.recording, commandId: command.id })
}
