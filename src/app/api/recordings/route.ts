/**
 * =============================================================================
 * RECORDINGS API ENDPOINT
 * =============================================================================
 *
 * ENDPOINTS:
 *   POST /api/recordings - Browser uploads the finished WAV (raw audio/wav body,
 *                          optional X-Recording-Name header for the filename slug).
 *                          Files land in recordings/ at the project root.
 *   GET  /api/recordings - List saved recordings (name, bytes, modified time).
 */

import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { state } from '../state'
import { rejectCrossOrigin } from '../guard'

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings')

/** ~60 min of 16-bit stereo 48kHz - far above any real bounce, catches runaway uploads */
const MAX_UPLOAD_BYTES = 700 * 1024 * 1024

export async function GET() {
  let files: { name: string; bytes: number; modified: number }[] = []
  try {
    files = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const stat = fs.statSync(path.join(RECORDINGS_DIR, f))
        return { name: f, bytes: stat.size, modified: stat.mtimeMs }
      })
      .sort((a, b) => b.modified - a.modified)
  } catch {
    // No recordings directory yet - empty list is the right answer
  }
  return NextResponse.json({ recordings: files })
}

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request)
  if (rejected) return rejected

  // Only an in-flight recording may upload - a delayed retry from an old
  // session must not overwrite a newer recording's outcome.
  const phase = state.recording.phase
  if (phase !== 'recording' && phase !== 'stopping') {
    return NextResponse.json({ error: `No recording awaiting upload (phase: ${phase})` }, { status: 409 })
  }

  // Reject oversized uploads before buffering the body
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Upload too large' }, { status: 413 })
  }

  const data = await request.arrayBuffer()
  if (data.byteLength === 0) {
    return NextResponse.json({ error: 'Empty upload' }, { status: 400 })
  }
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Upload too large' }, { status: 413 })
  }

  const rawName = request.headers.get('x-recording-name') ?? ''
  const slug = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  const suffix = Math.random().toString(36).slice(2, 6)
  const filename = slug ? `${stamp}-${slug}-${suffix}.wav` : `${stamp}-${suffix}.wav`

  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(RECORDINGS_DIR, filename), Buffer.from(data))
  } catch (err) {
    console.error('[klaude] failed to save recording:', err)
    state.setRecording({ phase: 'error', error: 'Failed to write WAV to disk', at: Date.now() })
    return NextResponse.json({ error: 'Failed to write recording' }, { status: 500 })
  }

  state.setRecording({
    phase: 'done',
    file: `recordings/${filename}`,
    bytes: data.byteLength,
    at: Date.now(),
  })

  return NextResponse.json({ file: `recordings/${filename}`, bytes: data.byteLength })
}
