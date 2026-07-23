/**
 * =============================================================================
 * TAPE SHELF
 * =============================================================================
 *
 * Saved recordings, playable right in the app - a cassette drawer instead of
 * a folder on disk. Files stream from /api/recordings/<name>.
 */

'use client'

import { useEffect, useState } from 'react'
import { ListMusic, X, Download } from 'lucide-react'

type Tape = { name: string; bytes: number; modified: number }

/** "2026-07-23T18-35-40-145-blackout-bomt.wav" → { title: "blackout", date } */
function describeTape(tape: Tape): { title: string; detail: string } {
  // stamp = date T hh-mm-ss-mmm, then an optional slug, then a 4-char suffix
  const m = tape.name.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:-(.+?))?-[a-z0-9]{4}\.wav$/)
  const title = m ? (m[1] ? m[1].replace(/-/g, ' ') : 'untitled') : tape.name.replace(/\.wav$/, '')
  const date = new Date(tape.modified)
  const mb = (tape.bytes / (1024 * 1024)).toFixed(1)
  return {
    title,
    detail: `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mb} MB`,
  }
}

export function TapeShelf() {
  const [open, setOpen] = useState(false)
  const [tapes, setTapes] = useState<Tape[] | null>(null)

  useEffect(() => {
    if (!open) return
    setTapes(null)
    fetch('/api/recordings')
      .then((res) => res.json())
      .then((data) => setTapes(Array.isArray(data.recordings) ? data.recordings : []))
      .catch(() => setTapes([]))
  }, [open])

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Recordings"
        className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
          open ? 'text-primary bg-muted/50' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        }`}
      >
        <ListMusic className="size-4" />
      </button>

      {open && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 w-[26rem] max-w-[calc(100vw-2rem)] max-h-[50vh] overflow-y-auto bg-card/95 backdrop-blur-lg rounded-xl shadow-2xl border border-border/50 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 sticky top-0 bg-card/95 backdrop-blur-lg">
            <div className="text-sm font-semibold">Tapes</div>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <X className="size-4" />
            </button>
          </div>

          {tapes === null && <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>}
          {tapes !== null && tapes.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No tapes yet - record a set and it lands here.
            </div>
          )}
          {tapes?.map((tape) => {
            const { title, detail } = describeTape(tape)
            const url = `/api/recordings/${encodeURIComponent(tape.name)}`
            return (
              <div key={tape.name} className="px-4 py-3 border-b border-border/30 last:border-b-0">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium capitalize truncate">{title}</div>
                    <div className="text-[11px] text-muted-foreground">{detail}</div>
                  </div>
                  <a
                    href={url}
                    download={tape.name}
                    title="Download"
                    className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  >
                    <Download className="size-4" />
                  </a>
                </div>
                <audio controls preload="none" src={url} className="w-full h-9" />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
