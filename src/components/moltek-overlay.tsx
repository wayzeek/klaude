/**
 * =============================================================================
 * MOLTEK WINDOW
 * =============================================================================
 *
 * The mascot as a floating panel: the same flat chrome as the rack sections,
 * lifted off the layout so it can sit anywhere over the studio. Dragged by its
 * title bar like a window, resized from the corner, and both remembered.
 *
 * The header carries a live tempo readout rather than being decoration. It is
 * written straight into the DOM from the pulse bus, never through React state,
 * because it updates on the audio path.
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { MoltekWindow, HEADER_H } from '@/components/moltek-window'
import { CloseIcon } from '@/components/icons'
import { NoteBar } from '@/components/note-bar'
import { onLayerPulse } from '@/lib/layer-pulse'
import { VIEWBOX } from '@/lib/moltek-sprite'

const POSITION_KEY = 'moltek.mascotPos'
const WIDTH_KEY = 'moltek.mascotWidth'

/** Note row at the foot of the window. */
const FOOTER_H = 36
const DEFAULT_WIDTH = 340
const MIN_WIDTH = 170
const MAX_WIDTH = 560

/** Body height for a given window width, from the sprite's own aspect. */
const bodyHeight = (width: number) => Math.round(width * (VIEWBOX.h / VIEWBOX.w))

/* localStorage can throw in privacy modes. A mascot is never worth crashing
   the studio over, which is the same bargain strudel-editor.tsx makes for
   panel sizes. */
function readJson<T>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (valid(parsed)) return parsed
  } catch {}
  return null
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const isPos = (v: unknown): v is { x: number; y: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { x?: unknown }).x === 'number' &&
  typeof (v as { y?: unknown }).y === 'number'

const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_WIDTH), MAX_WIDTH))

/**
 * Keep the whole window on screen, including its title bar.
 *
 * Measured against the document element rather than window.innerHeight, which
 * is the layout viewport: with browser or webview chrome over the page it
 * reports more height than is actually visible, and the panel could then be
 * clamped to a position whose foot is off the bottom of the screen. The body is
 * height:100% with overflow:hidden, so its client box is what can be seen.
 */
function visible(): { w: number; h: number } {
  const el = document.documentElement
  return {
    w: Math.min(el.clientWidth || window.innerWidth, window.innerWidth),
    h: Math.min(el.clientHeight || window.innerHeight, window.innerHeight),
  }
}

function clampPos(pos: { x: number; y: number }, width: number): { x: number; y: number } {
  const h = bodyHeight(width) + HEADER_H + FOOTER_H
  const view = visible()
  return {
    x: Math.min(Math.max(pos.x, 0), Math.max(0, view.w - width)),
    y: Math.min(Math.max(pos.y, 0), Math.max(0, view.h - h - 76)),
  }
}

export function MoltekOverlay({ onDismiss }: { onDismiss: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const gestureRef = useRef<
    { kind: 'move'; dx: number; dy: number; pointerId: number } | { kind: 'resize'; startX: number; startW: number; pointerId: number } | null
  >(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const tempoRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const w = clampWidth(readJson(WIDTH_KEY, isWidth) ?? DEFAULT_WIDTH)
    setWidth(w)
    setPos(clampPos(readJson(POSITION_KEY, isPos) ?? { x: 24, y: visible().h - 360 }, w))
  }, [])

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p, width) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [width])

  /**
   * Live tempo in the title bar. Strudel gives cycles per second; every track
   * in this studio is written as setcpm(bpm/4), so a cycle is a bar of four.
   * Written directly to the node: this fires on every beat and must never
   * re-render.
   */
  useEffect(
    () =>
      onLayerPulse(({ cps }) => {
        if (!tempoRef.current || !cps) return
        const bpm = Math.round(cps * 240)
        // During startup a stray cps arrives before the track has evaluated,
        // and the header used to latch it and sit there reading 500. Anything
        // outside the range this studio actually plays is not a tempo.
        if (bpm < 40 || bpm > 220) return
        tempoRef.current.textContent = `${bpm} bpm`
      }),
    [],
  )

  useEffect(() => {
    // A gesture can end by a clean release, or by the pointer being lost
    // (a touch scroll takes it, the OS interrupts, the button comes up
    // outside the window). Every path must clear it and persist, which is
    // why pointercancel is handled alongside pointerup.
    const end = (pointerId: number) => {
      const g = gestureRef.current
      if (!g) return
      gestureRef.current = null
      try {
        ;(g.kind === 'move' ? headerRef.current : gripRef.current)?.releasePointerCapture(pointerId)
      } catch {}
      if (g.kind === 'move') setPos((p) => (p && write(POSITION_KEY, p), p))
      else setWidth((w) => (write(WIDTH_KEY, w), w))
    }
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current
      if (!g || e.pointerId !== g.pointerId) return
      if (g.kind === 'move') {
        setPos((p) => (p ? clampPos({ x: e.clientX - g.dx, y: e.clientY - g.dy }, width) : p))
      } else {
        const next = clampWidth(g.startW + (e.clientX - g.startX))
        setWidth(next)
        setPos((p) => (p ? clampPos(p, next) : p))
      }
    }
    const onEnd = (e: PointerEvent) => {
      if (!gestureRef.current || e.pointerId !== gestureRef.current.pointerId) return
      end(e.pointerId)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [width])

  if (!pos) return null

  return (
    <MoltekWindow
      width={width}
      className="fixed z-40"
      style={{ left: pos.x, top: pos.y }}
      headerRef={headerRef}
      headerTitle="drag to move"
      headerCursor="grab"
      onHeaderPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        gestureRef.current = {
          kind: 'move',
          dx: e.clientX - pos.x,
          dy: e.clientY - pos.y,
          pointerId: e.pointerId,
        }
        // Keeps events coming here even if the pointer leaves the window,
        // which is what the end handlers rely on to always persist.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {}
      }}
      headerRight={
        <>
          <span ref={tempoRef} className="tabular-nums normal-case tracking-normal" />
          <button
            onClick={onDismiss}
            title="hide moltek"
            className="w-6 h-6 flex items-center justify-center hover:text-foreground"
          >
            <CloseIcon size={14} />
          </button>
        </>
      }
      /* Talking to him lives with him, rather than as a bar across the page. */
      footer={<NoteBar />}
    >
      <div
        ref={gripRef}
        onPointerDown={(e) => {
          gestureRef.current = {
            kind: 'resize',
            startX: e.clientX,
            startW: width,
            pointerId: e.pointerId,
          }
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {}
        }}
        title="drag to resize"
        style={{ cursor: 'nwse-resize', touchAction: 'none' }}
        className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-muted-foreground/50 hover:border-primary"
      />
    </MoltekWindow>
  )
}
