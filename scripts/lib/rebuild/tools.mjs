/**
 * External binaries the rebuild pipeline shells out to.
 *
 * None of these are vendored or installed by the project. A missing one is an
 * ordinary situation, not an error condition, so probing never throws and the
 * failure a caller sees carries the instructions to fix it.
 */

import { execFile } from 'node:child_process'

export class MissingToolError extends Error {
  constructor(name, spec) {
    super(`${name} is not installed.\n\n  ${spec.install}\n`)
    this.name = 'MissingToolError'
    this.tool = name
  }
}

export const TOOLS = Object.freeze({
  ffmpeg: {
    bin: 'ffmpeg',
    probeArgs: ['-version'],
    install: 'brew install ffmpeg   (or see https://ffmpeg.org/download.html)',
  },
  ytdlp: {
    bin: 'yt-dlp',
    probeArgs: ['--version'],
    install: 'brew install yt-dlp   (or see https://github.com/yt-dlp/yt-dlp#installation)',
  },
  demucs: {
    bin: 'demucs',
    probeArgs: ['--help'],
    install: 'pipx install demucs   (needs Python 3.9+; first run downloads a ~2 GB model)',
  },
})

/** Never throws. A missing binary is a result, not an exception. */
export function probe(name, spec = TOOLS[name]) {
  return new Promise((resolve) => {
    execFile(spec.bin, spec.probeArgs, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return resolve({ present: false, version: null })
      // Some tools exit non-zero on --help. Output is the real signal.
      const text = `${stdout}${stderr}`.trim()
      if (!text) return resolve({ present: !error, version: null })
      resolve({ present: true, version: text.split('\n')[0].trim() })
    })
  })
}

export async function requireTool(name, spec = TOOLS[name]) {
  const { present } = await probe(name, spec)
  if (!present) throw new MissingToolError(name, spec)
}
