/**
 * =============================================================================
 * GAIN API ENDPOINT
 * =============================================================================
 *
 * POST /api/gain - Master volume with a smooth ramp. Enables fade-ins,
 * fade-outs, and duck-under-voice moves in DJ sets.
 *
 * Body: { "level": 0..1, "rampMs": number? (default 200) }
 *
 * Example fade-out then stop:
 *   POST /api/gain {"level": 0, "rampMs": 4000}   → wait ~4s → POST /api/stop
 *   POST /api/gain {"level": 1}                    → restore before next play
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const MAX_RAMP_MS = 60_000

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { level, rampMs } = (body ?? {}) as { level?: unknown; rampMs?: unknown }

  if (typeof level !== 'number' || Number.isNaN(level)) {
    return NextResponse.json({ error: '"level" (number 0..1) is required' }, { status: 400 })
  }

  const clampedLevel = Math.min(1, Math.max(0, level))
  const clampedRamp =
    typeof rampMs === 'number' && !Number.isNaN(rampMs)
      ? Math.min(MAX_RAMP_MS, Math.max(0, rampMs))
      : 200

  state.setGain(clampedLevel, clampedRamp)

  return NextResponse.json({ gain: state.gain })
}
