import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { STEMS, cacheComplete, demucsArgs, separate, stemPaths } from './separate.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-sep-'))

describe('STEMS', () => {
  it('does not include vocals, which are dropped on arrival', () => {
    expect(STEMS).toEqual(['drums', 'bass', 'other'])
    expect(STEMS).not.toContain('vocals')
  })
})

describe('demucsArgs', () => {
  it('writes WAV into the requested directory', () => {
    const args = demucsArgs('/in.wav', '/out')
    expect(args).toContain('-o')
    expect(args[args.indexOf('-o') + 1]).toBe('/out')
    // -o and --out are aliases; passing both is an error.
    expect(args).not.toContain('--out')
    // demucs has no explicit "wav" token: WAV is the default output unless
    // --mp3 or --flac is passed, so keeping WAV means omitting both.
    expect(args).not.toContain('--mp3')
    expect(args).not.toContain('--flac')
    expect(args[args.length - 1]).toBe('/in.wav')
  })
})

describe('stemPaths', () => {
  it('names one file per kept stem', () => {
    const paths = stemPaths('/stems')
    expect(paths.drums).toBe(path.join('/stems', 'drums.wav'))
    expect(paths.bass).toBe(path.join('/stems', 'bass.wav'))
    expect(paths.other).toBe(path.join('/stems', 'other.wav'))
    expect(paths.vocals).toBeUndefined()
  })
})

describe('separate', () => {
  it('returns the cached stems without running demucs when they already exist', async () => {
    const stemsDir = path.join(tmp, 'cached')
    fs.mkdirSync(stemsDir, { recursive: true })
    for (const stem of STEMS) {
      // Non-trivial size, so the cache check does not treat them as empty.
      fs.writeFileSync(path.join(stemsDir, `${stem}.wav`), Buffer.alloc(2048, 1))
    }

    const result = await separate(path.join(tmp, 'does-not-exist.wav'), stemsDir)
    expect(result.cached).toBe(true)
    expect(result.drums).toBe(path.join(stemsDir, 'drums.wav'))
  })

  it('does not treat a partial cache as complete', async () => {
    const stemsDir = path.join(tmp, 'partial')
    fs.mkdirSync(stemsDir, { recursive: true })
    fs.writeFileSync(path.join(stemsDir, 'drums.wav'), Buffer.alloc(2048, 1))

    // The operative assertion is that this does NOT resolve as a cache hit.
    // What it rejects *with* depends on the environment - a missing demucs
    // here, a missing input file on a machine that has demucs - so the reason
    // is deliberately not asserted. `cacheComplete` is tested directly below,
    // which is where the cache logic itself is actually pinned down.
    await expect(separate(path.join(tmp, 'does-not-exist.wav'), stemsDir)).rejects.toThrow()
  })
})

describe('cacheComplete', () => {
  function writeStems(dir, entries) {
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, size] of Object.entries(entries)) {
      fs.writeFileSync(path.join(dir, `${name}.wav`), Buffer.alloc(size, 1))
    }
  }

  it('is true when all kept stems are present with non-trivial size', () => {
    const dir = path.join(tmp, 'cc-complete')
    writeStems(dir, { drums: 2048, bass: 2048, other: 2048 })
    expect(cacheComplete(dir)).toBe(true)
  })

  it('is false when a stem is missing', () => {
    const dir = path.join(tmp, 'cc-missing-stem')
    writeStems(dir, { drums: 2048, bass: 2048 })
    expect(cacheComplete(dir)).toBe(false)
  })

  it('is false for an empty directory', () => {
    const dir = path.join(tmp, 'cc-empty')
    fs.mkdirSync(dir, { recursive: true })
    expect(cacheComplete(dir)).toBe(false)
  })

  it('is false for a directory that does not exist', () => {
    expect(cacheComplete(path.join(tmp, 'cc-does-not-exist'))).toBe(false)
  })

  it('is false when stub files are under the size threshold', () => {
    const dir = path.join(tmp, 'cc-too-small')
    writeStems(dir, { drums: 10, bass: 10, other: 10 })
    expect(cacheComplete(dir)).toBe(false)
  })

  it('is unaffected by a stray vocals.wav alongside the three kept stems', () => {
    const dir = path.join(tmp, 'cc-stray-vocals')
    writeStems(dir, { drums: 2048, bass: 2048, other: 2048, vocals: 2048 })
    expect(cacheComplete(dir)).toBe(true)
  })
})

describe('separate against a fake demucs', () => {
  // A shell script standing in for the real `demucs` binary. Controlled by
  // env vars so one script covers every scenario: `--help` (the probe in
  // requireTool) always succeeds without touching the filesystem; otherwise
  // it writes stub stem files under `<outDir>/htdemucs/`, either flat or
  // nested under a fake track directory, and exits with the requested code.
  const FAKE_DEMUCS_SCRIPT = `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "usage: fake demucs"
  exit 0
fi

outDir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) outDir="$2"; shift 2 ;;
    *) shift ;;
  esac
done

model_dir="$outDir/htdemucs"

if [ "$FAKE_DEMUCS_PARTIAL" = "1" ]; then
  mkdir -p "$model_dir/sometrack"
  head -c 2048 /dev/zero > "$model_dir/sometrack/vocals.wav"
  exit "\${FAKE_DEMUCS_EXIT:-1}"
fi

if [ "$FAKE_DEMUCS_LAYOUT" = "nested" ]; then
  target_dir="$model_dir/sometrack"
else
  target_dir="$model_dir"
fi
mkdir -p "$target_dir"
for stem in drums bass other vocals; do
  head -c 2048 /dev/zero > "$target_dir/$stem.wav"
done
exit "\${FAKE_DEMUCS_EXIT:-0}"
`

  // Installs the fake `demucs` at the front of PATH and sets the env vars the
  // script reads. Returns a restore function that MUST be called in a
  // `finally` - vitest can share a process across tests in this file, and a
  // leaked PATH or env var would corrupt whatever runs next.
  function installFakeDemucs({ layout = 'flat', exitCode = 0, partial = false } = {}) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-fake-demucs-'))
    const scriptPath = path.join(binDir, 'demucs')
    fs.writeFileSync(scriptPath, FAKE_DEMUCS_SCRIPT, { mode: 0o755 })
    fs.chmodSync(scriptPath, 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
    process.env.FAKE_DEMUCS_LAYOUT = layout
    process.env.FAKE_DEMUCS_EXIT = String(exitCode)
    process.env.FAKE_DEMUCS_PARTIAL = partial ? '1' : '0'

    return function restore() {
      process.env.PATH = originalPath
      delete process.env.FAKE_DEMUCS_LAYOUT
      delete process.env.FAKE_DEMUCS_EXIT
      delete process.env.FAKE_DEMUCS_PARTIAL
    }
  }

  function fakeInput(name) {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, Buffer.alloc(2048, 1))
    return file
  }

  it('flattens a flat demucs layout: kept stems land, vocals and htdemucs/ do not survive', async () => {
    const restore = installFakeDemucs({ layout: 'flat', exitCode: 0 })
    try {
      const stemsDir = path.join(tmp, 'fake-flat')
      const input = fakeInput('fake-flat-input.wav')

      const result = await separate(input, stemsDir)

      expect(result.cached).toBe(false)
      for (const stem of STEMS) {
        expect(fs.existsSync(path.join(stemsDir, `${stem}.wav`))).toBe(true)
      }
      expect(fs.existsSync(path.join(stemsDir, 'vocals.wav'))).toBe(false)
      expect(fs.existsSync(path.join(stemsDir, 'htdemucs'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('flattens a nested demucs layout: kept stems land, vocals and htdemucs/ do not survive', async () => {
    const restore = installFakeDemucs({ layout: 'nested', exitCode: 0 })
    try {
      const stemsDir = path.join(tmp, 'fake-nested')
      const input = fakeInput('fake-nested-input.wav')

      const result = await separate(input, stemsDir)

      expect(result.cached).toBe(false)
      for (const stem of STEMS) {
        expect(fs.existsSync(path.join(stemsDir, `${stem}.wav`))).toBe(true)
      }
      expect(fs.existsSync(path.join(stemsDir, 'vocals.wav'))).toBe(false)
      expect(fs.existsSync(path.join(stemsDir, 'htdemucs'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('reports the demucs error, not a flatten error, when the run fails partway through', async () => {
    const restore = installFakeDemucs({ partial: true, exitCode: 1 })
    try {
      const stemsDir = path.join(tmp, 'fake-partial-failure')
      const input = fakeInput('fake-partial-input.wav')

      await expect(separate(input, stemsDir)).rejects.toThrow(/demucs exited 1/)
      expect(fs.existsSync(path.join(stemsDir, 'htdemucs'))).toBe(false)
    } finally {
      restore()
    }
  })
})
