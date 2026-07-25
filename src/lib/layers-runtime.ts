/**
 * =============================================================================
 * LAYERS RUNTIME
 * =============================================================================
 *
 * `layers({ kick, bass, ... })` is moltek's track contract: the agent names
 * every layer, and the console gets a row per name that can solo, mute and
 * trim it live.
 *
 * This is the function evaluated code calls. It registers the names, drops the
 * layers the mix silences, taps each survivor for activity pulses, and returns
 * the stacked pattern. It is deliberately free of React and of the server
 * protocol: everything it needs arrives as a dependency, which is also what
 * makes it testable in Node.
 */

import {
  applyStructuralTrim,
  applyValueTrim,
  type LayerTrim,
  type StructuralPattern,
} from '@/lib/trim'
import type { Pulse } from '@/lib/layer-pulse'

/**
 * The pattern surface this runtime uses. Declared structurally so Strudel
 * stays out of this file, and as an `interface` rather than a `type` because
 * it is extended by a generic parameterised by itself, which a type alias
 * cannot express (TS2456, circular reference).
 */
export interface LayerPattern extends StructuralPattern<LayerPattern> {
  stack: (other: LayerPattern) => LayerPattern
  mask: (keep: boolean) => LayerPattern
  fmap: (fn: (value: Record<string, unknown>) => Record<string, unknown>) => LayerPattern
  onTrigger: (
    fn: (hap: unknown, currentTime: number, cps: number, targetTime: number) => void,
    dominant: boolean,
  ) => LayerPattern
}

export type LayersRuntimeDeps = {
  /** Current solo/mute state, read at evaluation time. */
  getMix: () => { muted: string[]; soloed: string[] }
  /**
   * The current trim for a layer. This must be a lookup, never a captured
   * object: the value wrapper below calls it at query time, which is exactly
   * what lets a fader move be heard without re-evaluating the track. Hand it
   * a snapshot and every fader goes dead until the next evaluation.
   */
  getTrim: (layer: string) => LayerTrim
  /** Called once per name seen, in declaration order. */
  collect: (name: string) => void
  /**
   * Hand off a pulse and how long until its sound is audible. The receiver owns
   * the timer, so a stop can drop pulses that have not fired yet rather than
   * letting the console blink and the mascot twitch at silence.
   */
  onPulse: (pulse: Pulse, delayMs: number) => void
}

/**
 * Pull the musical detail out of a Strudel event.
 *
 * `hap.value` is the controls object: `s` holds the sound name, and `s("bd:3")`
 * yields `{ s: 'bd', n: 3 }` rather than a gain of 3. Gain and velocity
 * multiply, and neither is validated on creation, so a track can legitimately
 * ask for 8 and the clamp is not optional.
 *
 * `whole` is optional on a Hap in general, but schedulers only fire triggers
 * after `hasOnset()`, which tests for it. Guarded anyway: this runs on the
 * audio path and must never throw.
 *
 * Note this reads the value AFTER the trims are applied, so a layer the
 * listener has faded down pulses more gently, which is what the mascot should
 * be dancing to.
 */
function describeHap(hap: unknown, cps: number): Omit<Pulse, 'layer'> {
  const h = hap as { value?: Record<string, unknown>; whole?: { begin?: unknown } } | undefined
  const value = h?.value ?? {}
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const begin = Number(h?.whole?.begin)
  return {
    sound: typeof value.s === 'string' ? value.s : undefined,
    intensity: Math.max(0, Math.min(2, num(value.gain, 1) * num(value.velocity, 1))),
    cyclePos: Number.isFinite(begin) ? ((begin % 1) + 1) % 1 : 0,
    cps: Number.isFinite(cps) && cps > 0 ? cps : 0.5,
  }
}

export function createLayersRuntime(deps: LayersRuntimeDeps) {
  return function layers(map: Record<string, LayerPattern>): LayerPattern {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('layers() expects an object of named patterns, e.g. layers({ kick, bass })')
    }
    const names = Object.keys(map)
    if (names.length === 0) throw new Error('layers() needs at least one named pattern')
    for (const name of names) deps.collect(name)

    const { muted, soloed } = deps.getMix()
    const entries = Object.entries(map).filter(([name]) =>
      soloed.length > 0 ? soloed.includes(name) : !muted.includes(name),
    )
    if (entries.length === 0) {
      // Everything silenced: an event-free pattern keeps the eval valid.
      //
      // The mask argument is a boolean rather than the mini-notation "0" this
      // used to pass. Mini-notation parses "0" into a value the mask treats as
      // truthy, so `mask("0")` let every event through: muting the last
      // unmuted layer left the track playing. Measured, not assumed - see the
      // all-muted check in scripts/selftest.mjs.
      return map[names[0]].mask(false)
    }

    const tapped = entries.map(([name, pattern]) => {
      // Structural trims are read now, at evaluation time, because they
      // rebuild the pattern. The server only bumps structuralSeq for these,
      // so a change here always arrives with a fresh evaluation.
      const structural = applyStructuralTrim(pattern, deps.getTrim(name))

      // The value wrapper goes on unconditionally, even at neutral, and asks
      // for the trim on every query. Installing it only for already-trimmed
      // layers would make the first touch of every fader require a rebuild.
      const trimmed = structural.fmap((value) => applyValueTrim(value, deps.getTrim(name)))

      return trimmed.onTrigger((hap, currentTime, cps, targetTime) => {
        const delayMs = Math.max(0, (targetTime - currentTime) * 1000)
        deps.onPulse({ ...describeHap(hap, cps), layer: name }, delayMs)
      }, false)
    })
    return tapped.reduce((acc, pattern) => acc.stack(pattern))
  }
}
