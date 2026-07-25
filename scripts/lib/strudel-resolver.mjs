/**
 * Module resolve hook that makes @strudel/core importable in Node.
 *
 * @strudel/core imports `SalatRepl` from @kabelsalat/web. That package has no
 * "exports" field, so Node falls back to its "main" (dist/index.js), a browser
 * bundle that exports nothing, and the import crashes with:
 *
 *   SyntaxError: The requested module '@kabelsalat/web' does not provide an
 *   export named 'SalatRepl'
 *
 * Its "module" entry (dist/index.mjs) is real ESM and does export SalatRepl,
 * so we point the specifier straight at it. Nothing here touches audio - the
 * synth engine is never started, we only need the module graph to load so
 * patterns can be evaluated and queried.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Absolute file URL of @kabelsalat/web's ESM build, resolved once. */
let kabelsalatEsm = null
function resolveKabelsalat() {
  if (kabelsalatEsm !== null) return kabelsalatEsm
  // Resolve via the package's own manifest rather than a hardcoded path, so
  // this keeps working if the dependency is hoisted somewhere else.
  const manifest = require.resolve('@kabelsalat/web/package.json')
  const dir = manifest.slice(0, manifest.lastIndexOf('/'))
  const pkg = require('@kabelsalat/web/package.json')
  const entry = pkg.module ?? 'dist/index.mjs'
  kabelsalatEsm = pathToFileURL(`${dir}/${entry}`).href
  return kabelsalatEsm
}

/** Repo root's src/, two levels up from scripts/lib/. */
const SRC_ROOT = new URL('../../src/', import.meta.url).href

/**
 * Resolve the app's `@/*` path alias to `src/*`, so files under src/ stay
 * idiomatic while still being importable from these Node test scripts.
 * TypeScript is stripped natively, but only for a specifier that names the
 * file, so a bare alias gets `.ts` appended.
 */
function resolveAlias(specifier) {
  const relative = specifier.slice('@/'.length)
  const suffix = /\.[a-z]+$/.test(relative) ? '' : '.ts'
  return new URL(`${relative}${suffix}`, SRC_ROOT).href
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return { url: resolveAlias(specifier), shortCircuit: true }
  }
  if (specifier === '@kabelsalat/web') {
    return { url: resolveKabelsalat(), shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
