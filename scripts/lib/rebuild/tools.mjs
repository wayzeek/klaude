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
  basicPitch: {
    bin: 'basic-pitch',
    probeArgs: ['--help'],
    // Genuinely fiddly to install - expect to hit all four of these, not just
    // one. Recorded here because getting past them once did not make them
    // any less surprising the second time.
    install: [
      'pipx install --backend pip --python python3.12 basic-pitch',
      'pipx inject basic-pitch onnxruntime "setuptools<81" "scipy<1.13"',
      '',
      '  Python 3.12, specifically: 3.13+ cannot build the pinned numpy<1.24.',
      '  setuptools<81: newer setuptools dropped pkg_resources, which resampy still imports.',
      '  scipy<1.13: scipy.signal.gaussian was removed and Basic Pitch 0.3.0 still calls it.',
      '  onnxruntime: no inference backend ships by default, so prediction has nothing to run on.',
    ].join('\n  '),
  },
})

/**
 * Whether output looks like the tool crashed rather than printed a banner.
 *
 * Exit code alone cannot be the signal here: some tools legitimately exit
 * non-zero on --help, and their real, working output would then read as
 * absent. What a genuinely broken install produces instead is a stack trace.
 * Demonstrated live: Demucs installed into a venv missing numpy printed a
 * Python traceback and exited non-zero - the traceback header and its
 * `File "...", line N` frames are the shape this pipeline has actually seen.
 */
function looksLikeCrash(text) {
  return /Traceback \(most recent call last\):/.test(text) || /^\s*File "[^"]*", line \d+/m.test(text)
}

/** Never throws. A missing binary is a result, not an exception. */
export function probe(name, spec = TOOLS[name]) {
  return new Promise((resolve) => {
    execFile(spec.bin, spec.probeArgs, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return resolve({ present: false, version: null })
      const text = `${stdout}${stderr}`.trim()
      // A non-zero exit paired with crash-shaped output means the install is
      // broken, not merely a tool that objects to --help. "Instructions, not
      // a stack trace" only holds if that case is reported as absent.
      if (error && looksLikeCrash(text)) return resolve({ present: false, version: null })
      // Some tools exit non-zero on --help. Output is the real signal.
      if (!text) return resolve({ present: !error, version: null })
      resolve({ present: true, version: text.split('\n')[0].trim() })
    })
  })
}

export async function requireTool(name, spec = TOOLS[name]) {
  const { present } = await probe(name, spec)
  if (!present) throw new MissingToolError(name, spec)
}
