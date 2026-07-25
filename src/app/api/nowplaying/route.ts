/**
 * =============================================================================
 * NOW PLAYING API ENDPOINT
 * =============================================================================
 *
 * Track metadata shown as a HUD overlay in the browser. The agent updates it
 * when a set moves between tracks or sections; stopping playback clears it.
 *
 * ENDPOINTS:
 *   POST   /api/nowplaying { "title": "...", "artist": "...", "section": "..." }
 *          (all fields optional - omitted fields are kept from the current value)
 *   DELETE /api/nowplaying - Clear the HUD
 */

import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const MAX_FIELD_LENGTH = 200

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { title, artist, section } = (body ?? {}) as {
    title?: unknown
    artist?: unknown
    section?: unknown
  }

  const clean = (value: unknown, fallback: string | null): string | null => {
    if (typeof value === 'string') return value.slice(0, MAX_FIELD_LENGTH)
    if (value === null) return null
    return fallback
  }

  const current = state.nowPlaying
  state.setNowPlaying({
    title: clean(title, current?.title ?? null),
    artist: clean(artist, current?.artist ?? null),
    section: clean(section, current?.section ?? null),
  })

  return NextResponse.json({ nowPlaying: state.nowPlaying })
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  state.setNowPlaying(null)
  return NextResponse.json({ nowPlaying: null })
}
