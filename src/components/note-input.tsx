/**
 * =============================================================================
 * NOTE INPUT
 * =============================================================================
 *
 * Inline feedback field - Enter sends, Escape or the ✕ button closes. The
 * text clears only when the server confirms delivery of the exact draft
 * that was sent - editing while a send is in flight never gets wiped, and
 * Enter is inert until the previous send resolves. On failure the text
 * stays put with a red border so feedback is never silently lost. The bare
 * variant drops the box for the bottom command line; failure still draws
 * the red hairline.
 */

'use client'

import { useRef, useState } from 'react'
import { CloseIcon } from '@/components/icons'

export function NoteInput({
  placeholder,
  onSend,
  onClose,
  autoFocus,
  bare,
}: {
  placeholder: string
  onSend: (text: string) => Promise<boolean>
  onClose?: () => void
  autoFocus?: boolean
  bare?: boolean
}) {
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const [sending, setSending] = useState(false)
  // The live draft, readable when the send promise settles (state would be stale)
  const textRef = useRef('')
  const chrome = bare
    ? failed
      ? 'border-destructive'
      : 'border-transparent'
    : failed
      ? 'border-destructive'
      : 'border-border focus:border-primary'

  const updateText = (value: string) => {
    textRef.current = value
    setText(value)
    setFailed(false)
  }

  const send = () => {
    const draft = text.trim()
    if (!draft || sending) return
    setSending(true)
    onSend(draft).then((ok) => {
      setSending(false)
      if (!ok) {
        setFailed(true)
      } else if (textRef.current.trim() === draft) {
        updateText('')
        onClose?.()
      }
    })
  }

  return (
    <>
      <input
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => updateText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            send()
          } else if (e.key === 'Escape') {
            onClose?.()
          }
        }}
        placeholder={placeholder}
        maxLength={500}
        className={`flex-1 min-w-0 bg-transparent border px-2 h-8 text-[13px] font-mono outline-none placeholder:text-muted-foreground/60 ${chrome}`}
      />
      {onClose && (
        <button
          onClick={onClose}
          title="cancel"
          className="w-8 h-8 shrink-0 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground/40"
        >
          <CloseIcon size={12} />
        </button>
      )}
    </>
  )
}
