/**
 * =============================================================================
 * MIX API ENDPOINT
 * =============================================================================
 *
 * Per-layer solo, mute and trims for tracks written with the layers({...})
 * convention. The browser's console posts here on toggle and on every fader
 * move; the agent posts here to hear a layer in isolation (solo, then
 * scripts/listen.mjs) and reads back the balance the listener has set.
 *
 * Two counters come back with every response. `seq` moves on any change.
 * `structuralSeq` moves only when the pattern has to be rebuilt, which is
 * mute, solo, feel and swing. Volume, tone and space are read per event by
 * the layers() runtime, so they move `seq` alone and browsers apply them
 * without re-evaluating: a fader can be ridden without touching the audio.
 *
 * ENDPOINTS:
 *   GET  /api/mix - Current mix state plus the layer names of the last
 *        successfully evaluated revision.
 *   POST /api/mix { "muted"?: string[], "soloed"?: string[],
 *                   "toggleMuted"?: string, "toggleSoloed"?: string,
 *                   "trim"?: { "layer": string, "volume"?: 0..2,
 *                              "tone"?: -1..1, "space"?: -1..1,
 *                              "feel"?: -1..1, "swing"?: 0..1 },
 *                   "resetTrim"?: string }
 *        Arrays replace wholesale (agent use); toggles flip one name against
 *        the current server state (console clicks - immune to stale
 *        snapshots). Solo wins over mute; a new code push clears solo and
 *        keeps mutes. A trim patches only the controls it names, on top of
 *        what the track's code already says; neutral values carry no record.
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'
import { TRIM_RANGES, type LayerTrim } from '@/lib/trim'

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

/**
 * Validate a trim patch. Out-of-range numbers are the caller's normal case
 * (a slider mid-drag) and get clamped downstream; a non-numeric value is a
 * client bug and is refused so it cannot be silently ignored.
 */
function parseTrim(value: unknown): { trim?: { layer: string } & Partial<LayerTrim>; error?: string } {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'trim must be an object like { "layer": "bass", "volume": 0.5 }' }
  }
  const { layer, ...rest } = value as Record<string, unknown>
  if (typeof layer !== 'string' || layer.length === 0 || layer.length > MAX_NAME_LENGTH) {
    return { error: `trim.layer must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` }
  }
  const patch: Record<string, number> = {}
  for (const [key, raw] of Object.entries(rest)) {
    // Own-property check: `'toString' in TRIM_RANGES` is true, so `in` would
    // wave an inherited name through as if it were a control.
    if (!Object.hasOwn(TRIM_RANGES, key)) return { error: `trim.${key} is not a mix control` }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { error: `trim.${key} must be a finite number` }
    }
    patch[key] = raw
  }
  if (Object.keys(patch).length === 0) return { error: 'trim needs at least one control value' }
  return { trim: { layer, ...patch } as { layer: string } & Partial<LayerTrim> }
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

  const { muted, soloed, toggleMuted, toggleSoloed, soloOnly, trim, resetTrim, resetAllTrims } = (body ??
    {}) as {
    muted?: unknown
    soloed?: unknown
    toggleMuted?: unknown
    toggleSoloed?: unknown
    soloOnly?: unknown
    trim?: unknown
    resetTrim?: unknown
    resetAllTrims?: unknown
  }
  const mutedParsed = parseNames(muted, 'muted')
  if (mutedParsed.error) return NextResponse.json({ error: mutedParsed.error }, { status: 400 })
  const soloedParsed = parseNames(soloed, 'soloed')
  if (soloedParsed.error) return NextResponse.json({ error: soloedParsed.error }, { status: 400 })
  for (const [field, value] of [
    ['toggleMuted', toggleMuted],
    ['toggleSoloed', toggleSoloed],
    ['soloOnly', soloOnly],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH)) {
      return NextResponse.json(
        { error: `${field} must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` },
        { status: 400 },
      )
    }
  }
  const trimParsed = parseTrim(trim)
  if (trimParsed.error) return NextResponse.json({ error: trimParsed.error }, { status: 400 })
  if (
    resetTrim !== undefined &&
    (typeof resetTrim !== 'string' || resetTrim.length === 0 || resetTrim.length > MAX_NAME_LENGTH)
  ) {
    return NextResponse.json(
      { error: `resetTrim must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` },
      { status: 400 },
    )
  }
  if (resetAllTrims !== undefined && typeof resetAllTrims !== 'boolean') {
    return NextResponse.json({ error: 'resetAllTrims must be a boolean' }, { status: 400 })
  }
  if (
    !mutedParsed.names &&
    !soloedParsed.names &&
    toggleMuted === undefined &&
    toggleSoloed === undefined &&
    soloOnly === undefined &&
    !trimParsed.trim &&
    resetTrim === undefined &&
    resetAllTrims === undefined
  ) {
    return NextResponse.json(
      {
        error:
          'Provide muted/soloed arrays, toggleMuted/toggleSoloed/soloOnly names, or trim/resetTrim/resetAllTrims',
      },
      { status: 400 },
    )
  }

  return NextResponse.json({
    mix: state.setMix({
      muted: mutedParsed.names,
      soloed: soloedParsed.names,
      toggleMuted: toggleMuted as string | undefined,
      toggleSoloed: toggleSoloed as string | undefined,
      soloOnly: soloOnly as string | undefined,
      trim: trimParsed.trim,
      resetTrim: resetTrim as string | undefined,
      resetAllTrims: resetAllTrims as boolean | undefined,
    }),
    layers: state.layerNames,
  })
}
