import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentHash, ensureRunDir, REPO_ROOT, runDir, stagingDir } from './paths.mjs'

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

  it('is unaffected by the current working directory', () => {
    const before = runDir('abc')
    const originalCwd = process.cwd()
    try {
      process.chdir(path.join(REPO_ROOT, 'scripts', 'lib', 'rebuild'))
      expect(runDir('abc')).toBe(before)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('actually sits inside the gitignored .moltek/ tree', () => {
    const dir = runDir('abc')
    expect(dir.startsWith(REPO_ROOT)).toBe(true)
    expect(path.relative(REPO_ROOT, dir).startsWith('.moltek/')).toBe(true)
  })
})

describe('stagingDir', () => {
  it('sits under REPO_ROOT, inside .moltek/staging', () => {
    const dir = stagingDir()
    expect(dir.startsWith(REPO_ROOT)).toBe(true)
    const relative = path.relative(REPO_ROOT, dir)
    expect(relative.startsWith(path.join('.moltek', 'staging') + path.sep)).toBe(true)
  })

  it('returns a fresh, unique directory on every call, so concurrent runs cannot collide', () => {
    const a = stagingDir()
    const b = stagingDir()
    expect(a).not.toBe(b)
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
