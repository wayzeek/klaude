/**
 * =============================================================================
 * REACTION BAR
 * =============================================================================
 *
 * The listener's line back to the DJ: one tap sends a reaction the agent
 * reads between phases (/api/reactions). No typing, just vibes.
 */

'use client'

import { useRef, useState } from 'react'

const REACTIONS = [
  { kind: 'fire', emoji: '🔥', label: 'This hits' },
  { kind: 'love', emoji: '❤️', label: 'Love it' },
  { kind: 'sleep', emoji: '💤', label: 'Losing me' },
] as const

type Burst = { id: number; emoji: string; offset: number }

export function ReactionBar() {
  const [bursts, setBursts] = useState<Burst[]>([])
  const idRef = useRef(0)

  const react = (kind: string, emoji: string, index: number) => {
    fetch('/api/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    }).catch(() => {})

    const id = ++idRef.current
    setBursts((b) => [...b, { id, emoji, offset: index * 44 + 22 }])
    setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 1200)
  }

  return (
    <div className="fixed bottom-6 right-6 flex items-center gap-1 bg-card/90 backdrop-blur-lg rounded-full px-2 py-2 shadow-2xl border border-border/50">
      {REACTIONS.map((r, i) => (
        <button
          key={r.kind}
          onClick={() => react(r.kind, r.emoji, i)}
          title={r.label}
          className="w-10 h-10 rounded-full flex items-center justify-center text-lg hover:bg-muted/60 active:scale-125 transition-all"
        >
          {r.emoji}
        </button>
      ))}
      {bursts.map((b) => (
        <span key={b.id} className="reaction-burst" style={{ left: b.offset + 8 }}>
          {b.emoji}
        </span>
      ))}
    </div>
  )
}
