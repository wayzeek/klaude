import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BasicPitchHeaderError,
  basicPitchArgs,
  basicPitchCsvPath,
  cacheComplete,
  parseNoteEvents,
  transcribeWithBasicPitch,
} from './basic-pitch.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-basic-pitch-'))

describe('basicPitchArgs', () => {
  it('is output_dir then audio path, positionally, with note-events and onnx requested', () => {
    const args = basicPitchArgs('/out', '/in/bass.wav')
    expect(args[0]).toBe('/out')
    expect(args[1]).toBe('/in/bass.wav')
    expect(args).toContain('--save-note-events')
    expect(args[args.indexOf('--model-serialization') + 1]).toBe('onnx')
  })
})

describe('basicPitchCsvPath', () => {
  it('matches the tool own <basename>_basic_pitch.csv naming convention', () => {
    expect(basicPitchCsvPath('/out', '/in/bass.wav')).toBe(path.join('/out', 'bass_basic_pitch.csv'))
  })

  it('strips the extension regardless of what it is', () => {
    expect(basicPitchCsvPath('/out', '/in/other.flac')).toBe(path.join('/out', 'other_basic_pitch.csv'))
  })
})

describe('parseNoteEvents', () => {
  it('reads the first four columns of a real-shaped row', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n0.5,0.9,60,90,1,1,1\n'
    const notes = parseNoteEvents(csv)
    expect(notes).toEqual([{ startSec: 0.5, endSec: 0.9, midi: 60, velocity: 90 / 127 }])
  })

  it('does not truncate or throw on a long variable-length pitch_bend tail', () => {
    const tail = Array(40).fill('1').join(',')
    const csv = `start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n1.0,3.5,45,73,${tail}\n`
    const notes = parseNoteEvents(csv)
    expect(notes).toEqual([{ startSec: 1.0, endSec: 3.5, midi: 45, velocity: 73 / 127 }])
  })

  it('handles a row with no pitch_bend samples at all', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n1.0,1.2,50,64,\n'
    const notes = parseNoteEvents(csv)
    expect(notes).toEqual([{ startSec: 1.0, endSec: 1.2, midi: 50, velocity: 64 / 127 }])
  })

  it('rounds a fractional pitch_midi to the nearest integer', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n0,1,60.6,64,1\n'
    expect(parseNoteEvents(csv)[0].midi).toBe(61)
  })

  it('parses several rows and skips blank lines', () => {
    const csv = [
      'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend',
      '0,0.5,60,100,1,1',
      '',
      '0.5,1.0,64,80,1',
      '',
    ].join('\n')
    const notes = parseNoteEvents(csv)
    expect(notes.map((n) => n.midi)).toEqual([60, 64])
  })

  it('drops a row whose end is not after its start', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n1.0,1.0,60,64,1\n'
    expect(parseNoteEvents(csv)).toEqual([])
  })

  it('returns an empty array for a header-only file', () => {
    expect(parseNoteEvents('start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n')).toEqual([])
  })

  it('throws a named error when the header columns are reordered', () => {
    // The exact "CLI-format drift" this validation exists for: a future
    // Basic Pitch version that reorders its columns. Without the header
    // check, this row would still pass every Number.isFinite/endSec>startSec
    // sanity check and silently read velocity as pitch and pitch as
    // velocity.
    const csv = 'pitch_midi,velocity,start_time_s,end_time_s\n60,90,0.5,0.9\n'
    expect(() => parseNoteEvents(csv)).toThrow(BasicPitchHeaderError)
  })

  it('throws a named error when a column is missing entirely', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi\n0.5,0.9,60\n'
    expect(() => parseNoteEvents(csv)).toThrow(BasicPitchHeaderError)
  })

  it('does not throw on the real header even with the variable-length pitch_bend tail', () => {
    const csv = 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n0,1,60,90,1,1,1\n'
    expect(() => parseNoteEvents(csv)).not.toThrow()
  })
})

describe('cacheComplete', () => {
  it('is false for a file that does not exist', () => {
    expect(cacheComplete(path.join(tmp, 'does-not-exist.csv'))).toBe(false)
  })

  it('is false for a header-only file (nothing to cache)', () => {
    const file = path.join(tmp, 'header-only.csv')
    fs.writeFileSync(file, 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n')
    expect(cacheComplete(file)).toBe(false)
  })

  it('is true once real rows are present', () => {
    const file = path.join(tmp, 'real.csv')
    fs.writeFileSync(
      file,
      'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n' + '0,1,60,90,1,1,1,1,1,1,1,1,1,1\n'.repeat(3),
    )
    expect(cacheComplete(file)).toBe(true)
  })
})

describe('transcribeWithBasicPitch', () => {
  it('returns null without throwing when the tool is not installed', async () => {
    const originalPath = process.env.PATH
    // A directory that certainly does not contain `basic-pitch`.
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-empty-path-'))
    try {
      const outDir = path.join(tmp, 'absent-tool')
      const result = await transcribeWithBasicPitch(path.join(tmp, 'input.wav'), outDir)
      expect(result).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reads a pre-existing cache without requiring the tool to be present', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-empty-path-'))
    try {
      const outDir = path.join(tmp, 'cache-hit')
      fs.mkdirSync(outDir, { recursive: true })
      const wavPath = path.join(tmp, 'cache-hit-input.wav')
      fs.writeFileSync(
        basicPitchCsvPath(outDir, wavPath),
        'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n0,1,60,90,1,1,1,1,1,1,1,1,1,1\n',
      )
      const result = await transcribeWithBasicPitch(wavPath, outDir)
      expect(result).toEqual([{ startSec: 0, endSec: 1, midi: 60, velocity: 90 / 127 }])
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('returns null (not []) for a cached CSV whose rows all fail parseNoteEvents own sanity check', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-empty-path-'))
    try {
      const outDir = path.join(tmp, 'cache-zero-notes')
      fs.mkdirSync(outDir, { recursive: true })
      const wavPath = path.join(tmp, 'cache-zero-notes-input.wav')
      // cacheComplete only checks for more than one non-blank line - it
      // cannot tell this apart from a real cache. The row itself fails
      // parseNoteEvents' endSec > startSec check, so it parses to [].
      fs.writeFileSync(basicPitchCsvPath(outDir, wavPath), 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\n0,0,60,90,1\n')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await transcribeWithBasicPitch(wavPath, outDir)
      expect(result).toBeNull()
      errorSpy.mockRestore()
    } finally {
      process.env.PATH = originalPath
    }
  })

  describe('against a fake basic-pitch binary', () => {
    const FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "usage: fake basic-pitch"
  exit 0
fi
outDir="$1"
wavPath="$2"
base=$(basename "$wavPath" | sed 's/\\.[^.]*$//')
if [ -n "$FAKE_BASIC_PITCH_HANG" ]; then
  # exec, not a plain "sleep 30 &" or "sleep 30": a forked subprocess would
  # inherit this script's stdout/stderr pipes and keep them open even after
  # this process is SIGKILLed, which stalls Node's 'close' event on the
  # orphan rather than on the process actually being tested. exec replaces
  # this process's own image, so killing it closes its own pipe ends
  # immediately - matching how a real hung basic-pitch (one process, no
  # forked children holding the pipes) behaves.
  exec sleep 30
fi
if [ "$FAKE_BASIC_PITCH_EXIT" != "0" ] && [ -n "$FAKE_BASIC_PITCH_EXIT" ]; then
  echo "boom" >&2
  exit "$FAKE_BASIC_PITCH_EXIT"
fi
mkdir -p "$outDir"
if [ -n "$FAKE_BASIC_PITCH_BAD_HEADER" ]; then
  printf 'pitch_midi,velocity,start_time_s,end_time_s\\n48,100,0,1\\n' > "$outDir/\${base}_basic_pitch.csv"
elif [ -n "$FAKE_BASIC_PITCH_ZERO_NOTES" ]; then
  # A header, plus a data row that fails parseNoteEvents' own sanity check
  # (endSec <= startSec) - exactly the shape that passes cacheComplete's
  # "more than one non-blank line" test but parses to zero usable notes.
  printf 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\\n0,0,48,100,1\\n' > "$outDir/\${base}_basic_pitch.csv"
else
  printf 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\\n0,1,48,100,1,1,1\\n0.5,1.5,52,80,1\\n' > "$outDir/\${base}_basic_pitch.csv"
fi
exit 0
`

    function installFakeBasicPitch({ exitCode = 0, hang = false, badHeader = false, zeroNotes = false } = {}) {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-fake-basic-pitch-'))
      const scriptPath = path.join(binDir, 'basic-pitch')
      fs.writeFileSync(scriptPath, FAKE_SCRIPT, { mode: 0o755 })
      fs.chmodSync(scriptPath, 0o755)
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
      process.env.FAKE_BASIC_PITCH_EXIT = String(exitCode)
      if (hang) process.env.FAKE_BASIC_PITCH_HANG = '1'
      if (badHeader) process.env.FAKE_BASIC_PITCH_BAD_HEADER = '1'
      if (zeroNotes) process.env.FAKE_BASIC_PITCH_ZERO_NOTES = '1'
      return function restore() {
        process.env.PATH = originalPath
        delete process.env.FAKE_BASIC_PITCH_EXIT
        delete process.env.FAKE_BASIC_PITCH_HANG
        delete process.env.FAKE_BASIC_PITCH_BAD_HEADER
        delete process.env.FAKE_BASIC_PITCH_ZERO_NOTES
      }
    }

    it('runs the tool, parses its output, and returns the notes', async () => {
      const restore = installFakeBasicPitch()
      try {
        const wavPath = path.join(tmp, 'fake-run-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-run-out')

        const result = await transcribeWithBasicPitch(wavPath, outDir)

        expect(result).toEqual([
          { startSec: 0, endSec: 1, midi: 48, velocity: 100 / 127 },
          { startSec: 0.5, endSec: 1.5, midi: 52, velocity: 80 / 127 },
        ])
      } finally {
        restore()
      }
    })

    it('caches: a second call does not re-invoke the tool', async () => {
      const restore = installFakeBasicPitch()
      try {
        const wavPath = path.join(tmp, 'fake-cache-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-cache-out')

        const first = await transcribeWithBasicPitch(wavPath, outDir)
        // Now make the binary fail loudly if invoked again - the second call
        // must not touch it at all.
        process.env.FAKE_BASIC_PITCH_EXIT = '1'
        const second = await transcribeWithBasicPitch(wavPath, outDir)

        expect(second).toEqual(first)
      } finally {
        restore()
      }
    })

    it('returns null (not throws) when a present install exits non-zero - degrades like a missing binary', async () => {
      // A present-but-broken install (the module's own doc comment names the
      // real ones: a stale checkpoint, an incompatible onnxruntime) must not
      // take the whole rebuild down - every caller falls back to the DSP path
      // exactly as if the tool were never installed.
      const restore = installFakeBasicPitch({ exitCode: 1 })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const wavPath = path.join(tmp, 'fake-fail-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-fail-out')

        const result = await transcribeWithBasicPitch(wavPath, outDir)
        expect(result).toBeNull()
        // The failure is downgraded, not swallowed - a diagnostic still
        // reaches stderr so a fixable install problem stays visible.
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        restore()
        errorSpy.mockRestore()
      }
    })

    it('returns null (not throws) when the tool produces a CSV with an unrecognised header', async () => {
      // The other half of "present but broken": the exit code is 0, but a
      // future basic-pitch version reordered its columns. This must degrade
      // exactly like a non-zero exit, not propagate BasicPitchHeaderError and
      // kill the rebuild.
      const restore = installFakeBasicPitch({ badHeader: true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const wavPath = path.join(tmp, 'fake-badheader-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-badheader-out')

        const result = await transcribeWithBasicPitch(wavPath, outDir)
        expect(result).toBeNull()
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        restore()
        errorSpy.mockRestore()
      }
    })

    it('returns null (not throws, not []) when a present install produces a CSV with zero usable note rows', async () => {
      // The bug this guards against: `[]` is truthy, so `otherNotes ? notesPath
      // : dspPath`-shaped selection code in rebuild.mjs would pick the notes
      // path on a technically-successful-but-empty run and silently emit no
      // chords instead of falling back to the DSP path.
      const restore = installFakeBasicPitch({ zeroNotes: true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const wavPath = path.join(tmp, 'fake-zero-notes-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-zero-notes-out')

        const result = await transcribeWithBasicPitch(wavPath, outDir)
        expect(result).toBeNull()
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        restore()
        errorSpy.mockRestore()
      }
    })

    it('kills a hung invocation after timeoutMs and returns null instead of hanging forever', async () => {
      const restore = installFakeBasicPitch({ hang: true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const wavPath = path.join(tmp, 'fake-hang-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-hang-out')

        // A tiny timeoutMs, not the real ~5 minute default - this only
        // proves the timeout mechanism kills the child and resolves the
        // promise, not that the production ceiling itself is well chosen.
        const result = await transcribeWithBasicPitch(wavPath, outDir, { timeoutMs: 200 })
        expect(result).toBeNull()
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        restore()
        errorSpy.mockRestore()
      }
    }, 10000)
  })
})
