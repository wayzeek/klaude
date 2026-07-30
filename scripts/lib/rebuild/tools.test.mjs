import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MissingToolError, TOOLS, probe, requireTool } from './tools.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moltek-tools-'))

/**
 * A fake binary that crashes like a broken Python install: non-zero exit,
 * traceback-shaped output. Modelled on Demucs installed into a venv missing
 * numpy, which is what exposed the bug this file guards against.
 */
const crashyScript = path.join(tmp, 'crashy.mjs')
fs.writeFileSync(
  crashyScript,
  [
    `console.error('Traceback (most recent call last):')`,
    `console.error('  File "demucs/__main__.py", line 12, in <module>')`,
    `console.error('    import numpy')`,
    `console.error("ModuleNotFoundError: No module named 'numpy'")`,
    `process.exit(1)`,
  ].join('\n'),
)
const crashySpec = { bin: 'node', probeArgs: [crashyScript], install: 'pipx inject demucs numpy' }

/**
 * A fake binary that exits non-zero on "--help" the way some real tools do,
 * but prints an ordinary banner rather than a crash. This is the case the
 * fix must not break: output, not exit code, is still the signal for a tool
 * that works but is merely fussy about --help.
 */
const grumpyHelpScript = path.join(tmp, 'grumpy-help.mjs')
fs.writeFileSync(
  grumpyHelpScript,
  [`console.log('grumpy-tool 1.0.0')`, `console.log('Usage: grumpy-tool [options]')`, `process.exit(1)`].join('\n'),
)
const grumpyHelpSpec = { bin: 'node', probeArgs: [grumpyHelpScript] }

describe('TOOLS', () => {
  it('describes every binary the pipeline shells out to', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(['basicPitch', 'demucs', 'ffmpeg', 'ytdlp'])
    for (const [name, spec] of Object.entries(TOOLS)) {
      expect(spec.bin, `${name}.bin`).toBeTruthy()
      expect(spec.install, `${name}.install`).toMatch(/\S/)
    }
  })
})

describe('probe', () => {
  it('reports a binary that is certainly present', async () => {
    // `node` is running this test, so it exists.
    const result = await probe('node', { bin: 'node', probeArgs: ['--version'] })
    expect(result.present).toBe(true)
    expect(result.version).toMatch(/v\d+/)
  })

  it('reports a binary that is certainly absent, without throwing', async () => {
    const result = await probe('nope', { bin: 'definitely-not-a-real-binary-xyz', probeArgs: ['--version'] })
    expect(result.present).toBe(false)
    expect(result.version).toBeNull()
  })

  it('reports a broken install (non-zero exit, traceback output) as not present', async () => {
    const result = await probe('crashy', crashySpec)
    expect(result.present).toBe(false)
    expect(result.version).toBeNull()
  })

  it('still reports present when a tool exits non-zero but prints an ordinary banner', async () => {
    const result = await probe('grumpy', grumpyHelpSpec)
    expect(result.present).toBe(true)
    expect(result.version).toBe('grumpy-tool 1.0.0')
  })
})

describe('requireTool', () => {
  it('rejects with install instructions when the tool is missing', async () => {
    const spec = { bin: 'definitely-not-a-real-binary-xyz', probeArgs: ['--version'], install: 'brew install nope' }
    await expect(requireTool('nope', spec)).rejects.toThrow(MissingToolError)
    await expect(requireTool('nope', spec)).rejects.toThrow(/brew install nope/)
  })

  it('resolves when the tool is present', async () => {
    await expect(requireTool('node', { bin: 'node', probeArgs: ['--version'], install: 'n/a' })).resolves.toBeUndefined()
  })

  it('rejects rather than passing when the tool crashed instead of running', async () => {
    // This is the exact failure this fix closes: a broken Demucs venv used
    // to make probe() report present:true, so requireTool passed and the
    // pipeline advanced toward a tool that could not run.
    await expect(requireTool('crashy', crashySpec)).rejects.toThrow(MissingToolError)
    await expect(requireTool('crashy', crashySpec)).rejects.toThrow(/pipx inject demucs numpy/)
  })
})
