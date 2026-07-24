/**
 * =============================================================================
 * MIX API ENDPOINT
 * =============================================================================
 *
 * Per-layer solo/mute for tracks written with the layers({...}) convention.
 * The browser's console posts here on toggle; the agent posts here to hear a
 * layer in isolation (solo, then scripts/listen.mjs). Connected browsers
 * re-evaluate on every change - audibly seamless, the scheduler keeps phase.
 *
 * ENDPOINTS:
 *   GET  /api/mix - Current mix state plus the layer names of the last
 *        successfully evaluated revision.
 *   POST /api/mix { "muted"?: string[], "soloed"?: string[],
 *                   "toggleMuted"?: string, "toggleSoloed"?: string }
 *        Arrays replace wholesale (agent use); toggles flip one name against
 *        the current server state (console clicks - immune to stale
 *        snapshots). Solo wins over mute; a new code push clears solo and
 *        keeps mutes.
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const MAX_LAYERS = 64
const MAX_NAME_LENGTH = 40

function parseNames(value: unknown, field: string): { names?: string[]; error?: string } {
  if (value === undefined) return {}
  if (
    !Array.isArray(value) ||
    value.length > MAX_LAYERS ||
    value.some((n) => typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH)
  ) {
    return {
      error: `${field} must be an array of at most ${MAX_LAYERS} non-empty strings (max ${MAX_NAME_LENGTH} chars)`,
    }
  }
  return { names: [...new Set(value as string[])] }
}

export async function GET() {
  return NextResponse.json({ mix: state.mix, layers: state.layerNames })
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

  const { muted, soloed, toggleMuted, toggleSoloed } = (body ?? {}) as {
    muted?: unknown
    soloed?: unknown
    toggleMuted?: unknown
    toggleSoloed?: unknown
  }
  const mutedParsed = parseNames(muted, 'muted')
  if (mutedParsed.error) return NextResponse.json({ error: mutedParsed.error }, { status: 400 })
  const soloedParsed = parseNames(soloed, 'soloed')
  if (soloedParsed.error) return NextResponse.json({ error: soloedParsed.error }, { status: 400 })
  for (const [field, value] of [
    ['toggleMuted', toggleMuted],
    ['toggleSoloed', toggleSoloed],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH)) {
      return NextResponse.json(
        { error: `${field} must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` },
        { status: 400 },
      )
    }
  }
  if (!mutedParsed.names && !soloedParsed.names && toggleMuted === undefined && toggleSoloed === undefined) {
    return NextResponse.json(
      { error: 'Provide muted/soloed arrays or toggleMuted/toggleSoloed names' },
      { status: 400 },
    )
  }

  return NextResponse.json({
    mix: state.setMix({
      muted: mutedParsed.names,
      soloed: soloedParsed.names,
      toggleMuted: toggleMuted as string | undefined,
      toggleSoloed: toggleSoloed as string | undefined,
    }),
    layers: state.layerNames,
  })
}
