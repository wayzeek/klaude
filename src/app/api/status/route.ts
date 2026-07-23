/**
 * =============================================================================
 * STATUS API ENDPOINT
 * =============================================================================
 *
 * GET /api/status - The agent's window into what is actually happening.
 *
 * Key fields:
 * - desiredPlaying vs actualPlaying: what was requested vs what a browser
 *   reports is really making sound.
 * - lastEval: result of the browser evaluating a pushed revision. `fresh` is
 *   true when it refers to the CURRENT revision + play epoch - if fresh and
 *   ok:false, the push failed; fix the code and push again.
 * - clients: connected browser tabs and their readiness. No clients means
 *   nobody can hear anything - open http://localhost:3000.
 * - recording: idle | starting | recording | stopping | done (with file) | error.
 */

import { NextResponse } from 'next/server'
import { state } from '../state'

export async function GET() {
  state.reconcileRecording()
  const lastEval = state.lastEval
  const clients = state.clients.map((c) => ({
    id: c.id,
    connected: c.connections > 0,
    editorReady: c.editorReady,
    audioReady: c.audioReady,
    isPlaying: c.isPlaying,
    appliedRevision: c.appliedRevision,
  }))
  const live = state.liveClients

  return NextResponse.json({
    code: state.code,
    revision: state.revision,
    desiredPlaying: state.desiredPlaying,
    actualPlaying: state.actualPlaying,
    playEpoch: state.playEpoch,
    lastEval: lastEval
      ? {
          revision: lastEval.revision,
          playEpoch: lastEval.playEpoch,
          ok: lastEval.ok,
          error: lastEval.error,
          at: lastEval.at,
          fresh: lastEval.revision === state.revision && lastEval.playEpoch === state.playEpoch,
        }
      : null,
    clients,
    browserConnected: live.length > 0,
    audioReady: live.some((c) => c.audioReady),
    gain: state.gain,
    nowPlaying: state.nowPlaying,
    recording: state.recording,
    serverTime: Date.now(),
  })
}
