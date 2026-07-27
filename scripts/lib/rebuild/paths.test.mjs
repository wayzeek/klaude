import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentHash, ensureRunDir, runDir } from './paths.mjs'

const made = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('contentHash', () => {
  it('is stable for the same bytes', () => {
    expect(contentHash(Buffer.from('hello'))).toBe(contentHash(Buffer.from('hello')))
  })

  it('differs for different bytes', () => {
    expect(contentHash(Buffer.from('hello'))).not.toBe(contentHash(Buffer.from('world')))
  })

  it('is 16 hex characters', () => {
    expect(contentHash(Buffer.from('hello'))).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('runDir', () => {
  it('lands under .moltek/rebuilds, which is gitignored', () => {
    expect(runDir('abc123')).toContain(path.join('.moltek', 'rebuilds', 'abc123'))
  })
})

describe('ensureRunDir', () => {
  it('creates the tree and is safe to call twice', async () => {
    const hash = 'testhash00000001'
    const first = await ensureRunDir(hash)
    made.push(first.root)
    expect(fs.existsSync(first.stems)).toBe(true)
    expect(fs.existsSync(first.attempts)).toBe(true)

    const second = await ensureRunDir(hash)
    expect(second.root).toBe(first.root)
  })
})
