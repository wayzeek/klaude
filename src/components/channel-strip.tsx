/**
 * =============================================================================
 * CHANNEL STRIP
 * =============================================================================
 *
 * One layer's feel knobs, a reset, and a note box. Rendered by the mixer panel
 * directly beneath that layer's own row, so the controls are visibly contained
 * in the layer they belong to.
 *
 * Knobs are named for what they sound like, not for what they are: the listener
 * does not need to know that "muffled" is a lowpass.
 *
 * Two of the four knobs rebuild the pattern, so they commit on release rather
 * than continuously. The note is last on purpose: it is the escape hatch for
 * when no knob gets you where you wanted.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { NoteInput } from '@/components/note-input'
import { ResetIcon } from '@/components/icons'
import { postNote, postQuiet } from '@/lib/api-client'
import { createThrottle } from '@/lib/throttle'
import { isNeutral, trimFor, type LayerTrim } from '@/lib/trim'
import type { Mix } from '@/hooks/use-strudel'

/** How often a dragged live knob may post. */
const KNOB_POST_MS = 80
/**
 * Backstop for a release we never saw. Long on purpose: release is detected on
 * the window, so this should almost never fire, and a short timer here would
 * re-evaluate the track whenever someone paused mid-drag.
 */
const KNOB_SETTLE_MS = 2000

type KnobSpec = {
  key: keyof LayerTrim
  left: string
  right: string
  min: number
  /**
   * Live controls are read per event at query time and land under the finger.
   * Structural ones rebuild the pattern, so they are only sent on release.
   */
  live: boolean
}

const KNOBS: KnobSpec[] = [
  { key: 'tone', left: 'muffled', right: 'thin', min: -1, live: true },
  { key: 'space', left: 'dry', right: 'roomy', min: -1, live: true },
  { key: 'feel', left: 'early', right: 'late', min: -1, live: false },
  { key: 'swing', left: 'straight', right: 'swung', min: 0, live: false },
]

function Knob({ spec, layer, value }: { spec: KnobSpec; layer: string; value: number }) {
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  const releaseRef = useRef<(() => void) | null>(null)

  const send = (next: number) => postQuiet('/api/mix', { trim: { layer, [spec.key]: next } })

  const throttle = useMemo(
    () => createThrottle<number>(send, KNOB_POST_MS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, spec.key],
  )
  useEffect(
    () => () => {
      throttle.cancel()
      if (settleRef.current) clearTimeout(settleRef.current)
      if (releaseRef.current) {
        window.removeEventListener('pointerup', releaseRef.current)
        window.removeEventListener('pointercancel', releaseRef.current)
      }
    },
    [throttle],
  )

  const shown = drag ?? value

  const commit = () => {
    if (settleRef.current) clearTimeout(settleRef.current)
    // Remove the registered identity, not this render's. See channel-row.tsx.
    if (releaseRef.current) {
      window.removeEventListener('pointerup', releaseRef.current)
      window.removeEventListener('pointercancel', releaseRef.current)
      releaseRef.current = null
    }
    draggingRef.current = false
    const pending = dragRef.current
    if (pending !== null) {
      if (spec.live) throttle.flush()
      else send(pending)
      dragRef.current = null
    }
    setDrag(null)
  }

  const handleChange = (next: number) => {
    setDrag(next)
    dragRef.current = next
    if (spec.live) throttle.push(next)
    // Catch the release wherever it happens. A pointer let go outside the input
    // fires no mouseup on it, and a structural knob sends nothing during the
    // drag, so without this its value would simply be lost. Listening on the
    // window means a real release commits, instead of an inactivity timer
    // firing mid-drag and re-evaluating the track while the knob is held.
    // Armed once per drag: once per change event would stack up dozens.
    if (!draggingRef.current) {
      draggingRef.current = true
      releaseRef.current = commit
      window.addEventListener('pointerup', commit)
      window.addEventListener('pointercancel', commit)
    }
    // Long backstop for the keyboard path and any release we still miss.
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(commit, KNOB_SETTLE_MS)
  }

  return (
    <div className="flex items-center gap-2 px-2.5 h-8">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground/70 text-right lowercase">
        {spec.left}
      </span>
      <input
        type="range"
        min={spec.min}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => handleChange(Number(e.target.value))}
        onMouseUp={commit}
        onBlur={commit}
        onKeyUp={commit}
        title={`${spec.left} to ${spec.right}: ${shown.toFixed(2)}`}
        className="flat-fader flex-1 min-w-0 cursor-pointer"
      />
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground/70 lowercase">{spec.right}</span>
    </div>
  )
}

export function ChannelStrip({ name, mix }: { name: string; mix: Mix }) {
  const [sent, setSent] = useState(false)
  const trim = trimFor(mix.trims, name)

  const sendNote = (text: string) =>
    postNote({ text, layer: name }).then((ok) => {
      if (ok) {
        setSent(true)
        setTimeout(() => setSent(false), 1200)
      }
      return ok
    })

  return (
    // No header naming the layer: this block sits directly under that layer's
    // own row, which already names it. It shares the selected row's background
    // so the row and its knobs read as one block belonging to one layer.
    <div className="bg-card pb-2">
      <div className="py-1">
        {KNOBS.map((spec) => (
          <Knob key={spec.key} spec={spec} layer={name} value={trim[spec.key]} />
        ))}
      </div>
      {/* The escape hatch, always open rather than hidden behind a button: if
          no knob gets you there, the box to say so is already in front of you.
          No onClose, so it renders no cancel button and Escape is inert - it
          clears itself when the server confirms the send, and keeps the text
          with a red hairline if that fails.
          Reset sits at the end of this row, contained in the same block as the
          knobs it undoes, and inert while the layer is already as written. */}
      <div className="flex items-center gap-2 px-2.5 pt-1">
        <NoteInput placeholder={sent ? 'sent' : 'tell me what you want'} onSend={sendNote} />
        <button
          onClick={() => postQuiet('/api/mix', { resetTrim: name })}
          disabled={isNeutral(trim)}
          title={isNeutral(trim) ? `${name} is already as written` : `reset ${name} to as written`}
          className={`w-8 h-8 shrink-0 border flex items-center justify-center ${
            isNeutral(trim)
              ? 'border-border/40 text-muted-foreground/30 cursor-default'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
          }`}
        >
          <ResetIcon />
        </button>
      </div>
    </div>
  )
}
