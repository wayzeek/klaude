/**
 * =============================================================================
 * ACK BUS
 * =============================================================================
 *
 * One event: a note reached the agent. The mascot listens and nods.
 *
 * Separate from the layer pulse bus because this is not a musical event and
 * has no timing, sound or intensity. Module-level pub/sub for the same reason
 * layer-pulse is: the note bar and the mascot are in different corners of the
 * tree and neither should own the other.
 */

type AckListener = () => void

const listeners = new Set<AckListener>()

export function onAck(listener: AckListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitAck(): void {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch (err) {
      console.error('[moltek] ack listener failed:', err)
    }
  })
}
