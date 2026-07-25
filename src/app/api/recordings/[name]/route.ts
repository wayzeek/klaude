/**
 * =============================================================================
 * RECORDING FILE ENDPOINT
 * =============================================================================
 *
 * GET /api/recordings/<name> - Stream a saved WAV so the browser's tape shelf
 * can play recordings in place. Honors Range requests - without 206 partial
 * responses the browser can't seek inside a tape, only play it start to end.
 * HEAD is answered without opening the file, and aborted downloads destroy
 * their read stream - either would otherwise leak a file descriptor.
 * Names are strictly validated: only files the recorder itself wrote (flat
 * .wav names inside recordings/) are served.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings')
const SAFE_NAME = /^[A-Za-z0-9._-]+\.wav$/

/**
 * Validate a tape name and locate its file. lstat + realpath: refuse
 * symlinks and anything that resolves outside recordings/ - the recorder
 * only ever writes plain files here.
 */
function resolveTape(name: string): { filePath: string; size: number } | null {
  const filePath = path.join(RECORDINGS_DIR, name)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  try {
    const real = fs.realpathSync(filePath)
    const realDir = fs.realpathSync(RECORDINGS_DIR)
    if (real !== path.join(realDir, name)) return null
  } catch {
    return null
  }
  return { filePath, size: stat.size }
}

/**
 * Parse a "bytes=start-end" header into a clamped byte window.
 * 'ignore' = malformed (serve the full file, per spec); 'unsatisfiable' = 416.
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'ignore' | 'unsatisfiable' {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!m || (!m[1] && !m[2])) return 'ignore'
  if (size === 0) return 'unsatisfiable'
  if (!m[1]) {
    // suffix form: the last N bytes
    const suffix = Number(m[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** Open a read stream that dies with the request instead of leaking. */
function streamTape(
  request: Request,
  filePath: string,
  window?: { start: number; end: number },
): ReadableStream {
  const nodeStream = fs.createReadStream(filePath, window)
  const onAbort = () => nodeStream.destroy()
  if (request.signal.aborted) onAbort()
  else request.signal.addEventListener('abort', onAbort, { once: true })
  return Readable.toWeb(nodeStream) as ReadableStream
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'Invalid recording name' }, { status: 400 })
  }
  const tape = resolveTape(name)
  if (!tape) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const rangeHeader = request.headers.get('range')
  const range = rangeHeader ? parseRange(rangeHeader, tape.size) : 'ignore'
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${tape.size}` },
    })
  }
  if (range !== 'ignore') {
    return new Response(streamTape(request, tape.filePath, range), {
      status: 206,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${tape.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  }

  return new Response(streamTape(request, tape.filePath), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(tape.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}

/** Headers only - never opens the file. */
export async function HEAD(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    return new Response(null, { status: 400 })
  }
  const tape = resolveTape(name)
  if (!tape) return new Response(null, { status: 404 })
  return new Response(null, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(tape.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}
