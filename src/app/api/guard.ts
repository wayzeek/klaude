/**
 * =============================================================================
 * REQUEST GUARD
 * =============================================================================
 *
 * Local-origin check for mutating routes. A browser tab on a random website
 * can fire POSTs at localhost:3000; curl and local-origin fetches either send
 * no Origin header or a loopback one, so both keep working. Comparing against
 * the Host header would be bypassable via DNS rebinding (attacker hostname
 * resolving to 127.0.0.1 matches itself), so we allowlist loopback hostnames.
 */

import { NextResponse } from 'next/server'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Returns a 403 response for non-local browser requests, or null to proceed. */
export function rejectCrossOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  try {
    if (LOCAL_HOSTNAMES.has(new URL(origin).hostname)) return null
  } catch {
    // fall through to reject
  }
  return NextResponse.json({ error: 'non-local requests are not allowed' }, { status: 403 })
}
