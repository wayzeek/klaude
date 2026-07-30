import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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

  describe('against a fake basic-pitch binary', () => {
    const FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "usage: fake basic-pitch"
  exit 0
fi
outDir="$1"
wavPath="$2"
base=$(basename "$wavPath" | sed 's/\\.[^.]*$//')
if [ "$FAKE_BASIC_PITCH_EXIT" != "0" ] && [ -n "$FAKE_BASIC_PITCH_EXIT" ]; then
  echo "boom" >&2
  exit "$FAKE_BASIC_PITCH_EXIT"
fi
mkdir -p "$outDir"
printf 'start_time_s,end_time_s,pitch_midi,velocity,pitch_bend\\n0,1,48,100,1,1,1\\n0.5,1.5,52,80,1\\n' > "$outDir/\${base}_basic_pitch.csv"
exit 0
`

    function installFakeBasicPitch({ exitCode = 0 } = {}) {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-fake-basic-pitch-'))
      const scriptPath = path.join(binDir, 'basic-pitch')
      fs.writeFileSync(scriptPath, FAKE_SCRIPT, { mode: 0o755 })
      fs.chmodSync(scriptPath, 0o755)
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
      process.env.FAKE_BASIC_PITCH_EXIT = String(exitCode)
      return function restore() {
        process.env.PATH = originalPath
        delete process.env.FAKE_BASIC_PITCH_EXIT
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

    it('throws (not returns null) when the tool is present but fails', async () => {
      const restore = installFakeBasicPitch({ exitCode: 1 })
      try {
        const wavPath = path.join(tmp, 'fake-fail-input.wav')
        fs.writeFileSync(wavPath, Buffer.alloc(16, 1))
        const outDir = path.join(tmp, 'fake-fail-out')

        await expect(transcribeWithBasicPitch(wavPath, outDir)).rejects.toThrow(/basic-pitch exited 1/)
      } finally {
        restore()
      }
    })
  })
})
