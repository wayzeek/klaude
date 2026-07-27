import { describe, expect, it } from 'vitest'
import { MissingToolError, TOOLS, probe, requireTool } from './tools.mjs'

describe('TOOLS', () => {
  it('describes every binary the pipeline shells out to', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(['demucs', 'ffmpeg', 'ytdlp'])
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
})
