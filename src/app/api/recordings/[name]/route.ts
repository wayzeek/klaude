/**
 * =============================================================================
 * RECORDING FILE ENDPOINT
 * =============================================================================
 *
 * GET /api/recordings/<name> - Stream a saved WAV so the browser's tape shelf
 * can play recordings in place. Names are strictly validated: only files the
 * recorder itself wrote (flat .wav names inside recordings/) are served.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings')
const SAFE_NAME = /^[A-Za-z0-9._-]+\.wav$/

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'Invalid recording name' }, { status: 400 })
  }

  const filePath = path.join(RECORDINGS_DIR, name)
  // lstat + realpath: refuse symlinks and anything that resolves outside
  // recordings/ - the recorder only ever writes plain files here.
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }
  try {
    const real = fs.realpathSync(filePath)
    const realDir = fs.realpathSync(RECORDINGS_DIR)
    if (real !== path.join(realDir, name)) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream
  return new Response(stream, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    },
  })
}
