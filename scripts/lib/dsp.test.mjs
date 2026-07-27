import { describe, expect, it } from 'vitest'

describe('scripts test harness', () => {
  it('runs .mjs tests under scripts/', () => {
    expect(1 + 1).toBe(2)
  })
})
