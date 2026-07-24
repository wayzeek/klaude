/**
 * =============================================================================
 * LAYER PULSE BUS
 * =============================================================================
 *
 * Tiny pub/sub between the layers() runtime (which learns when a layer's
 * pattern fires an event) and the console rows that blink on activity.
 * Module-level so the audio path never touches React state directly.
 */

type PulseListener = (layer: string) => void

const listeners = new Set<PulseListener>()

export function onLayerPulse(listener: PulseListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitLayerPulse(layer: string): void {
  listeners.forEach((listener) => listener(layer))
}
