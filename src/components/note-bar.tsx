/**
 * =============================================================================
 * NOTE BAR
 * =============================================================================
 *
 * The command line: talk to the agent about the whole track. It lives in the
 * foot of the mascot's window, because telling moltek something and watching
 * moltek are the same act, and a full-width bar pinned to the bottom of the
 * page read as unrelated chrome.
 *
 * When a note lands the whole row becomes his reply for a moment, then goes
 * back to being an input. A tick in the corner is form-validation language;
 * this is a booth, so he answers you.
 */

'use client'

import { useRef, useState } from 'react'
import { NoteInput } from '@/components/note-input'
import { postNote } from '@/lib/api-client'
import { emitAck } from '@/lib/ack-bus'

/** Rotated so he does not answer identically every time. */
const REPLIES = [
  'moltek heard you',
  'cued up',
  'working it into the mix',
  'locked in',
  'next in the crate',
  'on the next drop',
]

/** How long his reply holds before the input comes back. */
const REPLY_MS = 1700

export function NoteBar() {
  const [reply, setReply] = useState<string | null>(null)
  const nextReply = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendTrackNote = (text: string) =>
    postNote({ text }).then((ok) => {
      if (ok) {
        // He nods in the window at the same moment the row answers.
        emitAck()
        setReply(REPLIES[nextReply.current % REPLIES.length])
        nextReply.current++
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setReply(null), REPLY_MS)
      }
      return ok
    })

  return (
    <div className="flex items-center gap-1.5 px-2.5 h-9 shrink-0 border-t border-border bg-card">
      {reply ? (
        <span className="text-[11px] uppercase tracking-widest text-primary">{reply}</span>
      ) : (
        <>
          <span className="shrink-0 w-3 text-muted-foreground">&gt;</span>
          <NoteInput bare placeholder="tell moltek" onSend={sendTrackNote} />
        </>
      )}
    </div>
  )
}
