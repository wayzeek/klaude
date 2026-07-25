#!/usr/bin/env node
/**
 * Validate every track in tracks/ - structure, semantics, and content.
 *
 * Structural checks: frontmatter fields present, exactly one ```javascript
 * block, balanced delimiters, a setcps/setcpm tempo statement.
 *
 * Semantic checks: the tempo stated in frontmatter matches the code, and the
 * stated duration matches the arrangement (sum of arrange() cycle counts ÷
 * cps). Saved tracks drift; this catches it.
 *
 * Content checks: every track is also evaluated headlessly and its events
 * inspected (see scripts/check.mjs). Text alone cannot tell that a chord voiced
 * to silence or that a sidechain points at the wrong bus - this file once
 * reported 7/7 valid while four tracks had silent harmony.
 *
 * Usage: node scripts/validate-tracks.mjs [--verbose] [--skip-content]
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadStrudel } from './lib/strudel-node.mjs'
import { checkFile } from './check.mjs'

const TRACKS_DIR = path.join(process.cwd(), 'tracks')
const TEMPO_TOLERANCE = 0.03
const DURATION_TOLERANCE = 0.12

const verbose = process.argv.includes('--verbose')

/** Replace string literal contents so brackets inside mini-notation don't confuse scanning. */
function stripStrings(code) {
  return code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0])
}

/** Evaluate a plain arithmetic expression (digits and + - * / . parens only). */
function evalArithmetic(expr) {
  if (!/^[\d\s+\-*/.()]+$/.test(expr)) return null
  try {
    const value = Function(`"use strict"; return (${expr})`)()
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return fields
}

/** Extract cps from setcps(expr) or setcpm(expr) in the code. */
function extractCps(code) {
  const cpsMatch = code.match(/setcps\(([^)]+)\)/)
  if (cpsMatch) return evalArithmetic(cpsMatch[1])
  const cpmMatch = code.match(/setcpm\(([^)]+)\)/)
  if (cpmMatch) {
    const cpm = evalArithmetic(cpmMatch[1])
    return cpm === null ? null : cpm / 60
  }
  return null
}

/**
 * Total cycles of each arrange() call: the sum of the leading number of each
 * top-level [n, pattern] pair. Returns the max across arrange calls (parallel
 * arranges run concurrently; the longest defines track length).
 */
function extractArrangeCycles(strippedCode) {
  let maxCycles = null
  let from = 0
  while (true) {
    const start = strippedCode.indexOf('arrange(', from)
    if (start === -1) break
    let depth = 0
    let i = start + 'arrange('.length - 1
    let end = -1
    for (; i < strippedCode.length; i++) {
      const ch = strippedCode[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break
    const span = strippedCode.slice(start + 'arrange('.length, end)

    let cycles = 0
    let bracketDepth = 0
    let parenDepth = 0
    for (let j = 0; j < span.length; j++) {
      const ch = span[j]
      if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth--
      else if (ch === '[') {
        bracketDepth++
        if (bracketDepth === 1 && parenDepth === 0) {
          const numMatch = span.slice(j + 1).match(/^\s*(\d+(?:\.\d+)?)\s*,/)
          if (numMatch) cycles += Number(numMatch[1])
        }
      } else if (ch === ']') bracketDepth--
    }
    if (maxCycles === null || cycles > maxCycles) maxCycles = cycles
    from = end + 1
  }
  return maxCycles
}

/** Parse a human duration like "~2.7 minutes" or "~40 seconds" into seconds. */
function parseDuration(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(minute|min|second|sec)/i)
  if (!match) return null
  const value = Number(match[1])
  return /^s/i.test(match[2]) ? value : value * 60
}

function checkBalance(strippedCode) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (const ch of strippedCode) {
    if (pairs[ch]) stack.push(pairs[ch])
    else if (Object.values(pairs).includes(ch) && stack.pop() !== ch) return false
  }
  return stack.length === 0
}

function validateTrack(filePath) {
  const issues = []
  const notes = []
  const content = fs.readFileSync(filePath, 'utf8')

  const fm = parseFrontmatter(content)
  if (!fm) {
    return { issues: ['no frontmatter block'], notes }
  }
  for (const field of ['name', 'description', 'tempo', 'key', 'duration']) {
    if (!fm[field]) issues.push(`frontmatter missing "${field}"`)
  }

  const codeBlocks = [...content.matchAll(/```javascript\n([\s\S]*?)```/g)]
  if (codeBlocks.length !== 1) {
    issues.push(`expected exactly one \`\`\`javascript block, found ${codeBlocks.length}`)
    return { issues, notes }
  }
  const code = codeBlocks[0][1]
  const stripped = stripStrings(code)

  if (!checkBalance(stripped)) issues.push('unbalanced brackets/parens in code')

  const cps = extractCps(code)
  if (cps === null) {
    issues.push('no parseable setcps()/setcpm() in code')
    return { issues, notes }
  }

  if (fm.tempo) {
    const statedCps = fm.tempo.match(/(\d+(?:\.\d+)?)\s*cps/)
    if (!statedCps) {
      issues.push(`tempo "${fm.tempo}" does not state cps`)
    } else if (Math.abs(Number(statedCps[1]) - cps) / cps > TEMPO_TOLERANCE) {
      issues.push(`tempo mismatch: frontmatter says ${statedCps[1]} cps, code sets ${cps.toFixed(4)} cps`)
    }
  }

  const cycles = extractArrangeCycles(stripped)
  if (cycles === null) {
    notes.push('no arrange() - loop track, duration not checked')
    return { issues, notes }
  }

  const computedSeconds = cycles / cps
  notes.push(`${cycles} cycles @ ${cps.toFixed(4)} cps = ${(computedSeconds / 60).toFixed(2)} min`)

  const statedSeconds = fm.duration ? parseDuration(fm.duration) : null
  if (statedSeconds === null) {
    issues.push(`duration "${fm.duration}" not parseable`)
  } else if (Math.abs(statedSeconds - computedSeconds) / computedSeconds > DURATION_TOLERANCE) {
    issues.push(
      `duration mismatch: frontmatter says ${(statedSeconds / 60).toFixed(2)} min, arrangement is ${(computedSeconds / 60).toFixed(2)} min (${cycles} cycles)`,
    )
  }

  return { issues, notes }
}

async function main() {
  let files = []
  try {
    for (const artist of fs.readdirSync(TRACKS_DIR)) {
      const dir = path.join(TRACKS_DIR, artist)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) files.push(path.join(dir, f))
      }
    }
  } catch {
    console.log('no tracks/ directory - nothing to validate')
    return
  }

  const skipContent = process.argv.includes('--skip-content')
  const strudel = skipContent ? null : await loadStrudel()

  let failed = 0
  for (const file of files.sort()) {
    const rel = path.relative(process.cwd(), file)
    const { issues, notes } = validateTrack(file)

    // Content check: evaluate the track and inspect what it would actually
    // play. Only errors fail the run; warnings are advice, not defects.
    if (strudel && issues.length === 0) {
      try {
        const code = extractCodeBlock(fs.readFileSync(file, 'utf8'))
        const result = await checkFile(strudel, rel, code)
        for (const item of result.findings.items) {
          if (item.severity === 'error') issues.push(`${item.rule}: ${item.message}`)
          else if (verbose && item.severity === 'warn') notes.push(`${item.rule}: ${item.message}`)
        }
      } catch (err) {
        issues.push(`content check failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    if (issues.length === 0) {
      console.log(`OK    ${rel}${verbose && notes.length ? `  (${notes.join('; ')})` : ''}`)
    } else {
      failed++
      console.log(`FAIL  ${rel}`)
      for (const issue of issues) console.log(`      - ${issue}`)
      for (const note of notes) console.log(`      note: ${note}`)
    }
  }

  console.log(`\n${files.length - failed}/${files.length} tracks valid`)
  if (failed > 0) process.exit(1)
}

/** The single ```javascript block a track file is required to have. */
function extractCodeBlock(content) {
  const blocks = [...content.matchAll(/```javascript\n([\s\S]*?)```/g)]
  if (blocks.length !== 1) throw new Error(`expected one javascript block, found ${blocks.length}`)
  return blocks[0][1]
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
