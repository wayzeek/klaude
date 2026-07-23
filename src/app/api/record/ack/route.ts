/**
 * =============================================================================
 * RECORD ACK API ENDPOINT
 * =============================================================================
 *
 * POST /api/record/ack - The browser acknowledges a record command.
 *
 * Body: {
 *   clientId: string,
 *   commandId: number,
 *   event: 'started' | 'stopped' | 'error',
 *   error?: string
 * }
 *
 * 'started' → phase becomes "recording"; 'stopped' → stays "stopping" until
 * the WAV upload lands at /api/recordings; 'error' → phase "error".
 * The acked command is cleared so an SSE reconnect can't replay it.
 */

import { NextResponse } from 'next/server'
import { state } from '../../state'
import { rejectCrossOrigin } from '../../guard'

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { clientId, commandId, event, error } = (body ?? {}) as {
    clientId?: unknown
    commandId?: unknown
    event?: unknown
    error?: unknown
  }

  if (
    typeof clientId !== 'string' ||
    typeof commandId !== 'number' ||
    (event !== 'started' && event !== 'stopped' && event !== 'error')
  ) {
    return NextResponse.json(
      { error: 'Body must include clientId (string), commandId (number), event (started|stopped|error)' },
      { status: 400 },
    )
  }

  // Validate against the active recording so a stale or misdelivered ack
  // can't rewind the state machine (e.g. an old 'started' reviving a
  // finished recording).
  const rec = state.recording
  const active = rec.phase === 'starting' || rec.phase === 'recording' || rec.phase === 'stopping'
  if (!active || !('clientId' in rec) || rec.clientId !== clientId) {
    state.clearCommand(commandId)
    return NextResponse.json({ error: `No active recording for this client (phase: ${rec.phase})` }, { status: 409 })
  }

  if (event === 'started') {
    if (rec.phase !== 'starting' || rec.commandId !== commandId) {
      state.clearCommand(commandId)
      return NextResponse.json({ error: `Unexpected 'started' ack (phase: ${rec.phase})` }, { status: 409 })
    }
    state.setRecording({ phase: 'recording', commandId, clientId, startedAt: Date.now() })
  } else if (event === 'error') {
    state.setRecording({
      phase: 'error',
      error: typeof error === 'string' ? error : 'Recording failed in the browser',
      at: Date.now(),
    })
  } else {
    // 'stopped': mark stopping (covers auto-stop, where no stop command was
    // issued); the upload to /api/recordings finishes it.
    state.setRecording({ ...rec, phase: 'stopping' })
  }

  state.clearCommand(commandId)

  return NextResponse.json({ recording: state.recording })
}
