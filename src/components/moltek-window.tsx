/**
 * =============================================================================
 * MOLTEK WINDOW
 * =============================================================================
 *
 * The panel the mascot lives in: title bar, him, and a foot. Nothing else.
 *
 * It exists because he appears twice and both should be the same object. In
 * the studio it floats, is dragged by its bar and has the note line in its
 * foot; on the unlock screen it sits centred and its foot invites you to
 * start. Only the header's right-hand slot, the footer and the positioning
 * differ, so those are the props and everything else is shared. Two hand
 * built panels would have drifted apart within a change or two.
 */

'use client'

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { Moltek } from '@/components/moltek'

/** Title bar height, matching the rack sections. */
export const HEADER_H = 32

export type MoltekWindowProps = {
  /** Width of the panel, which is also the width the scene renders at. */
  width: number
  /** Right-hand end of the title bar: a readout, a close button, or nothing. */
  headerRight?: ReactNode
  /** The row under him. */
  footer?: ReactNode
  /** Extras positioned against the panel, such as a resize grip. */
  children?: ReactNode
  headerRef?: Ref<HTMLDivElement>
  onHeaderPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  headerTitle?: string
  headerCursor?: CSSProperties['cursor']
  className?: string
  style?: CSSProperties
}

export function MoltekWindow({
  width,
  headerRight,
  footer,
  children,
  headerRef,
  onHeaderPointerDown,
  headerTitle,
  headerCursor,
  className = '',
  style,
}: MoltekWindowProps) {
  return (
    <section
      className={`flex flex-col border border-border bg-card select-none ${className}`}
      style={{ width, ...style }}
    >
      <div
        ref={headerRef}
        onPointerDown={onHeaderPointerDown}
        title={headerTitle}
        style={{ cursor: headerCursor, touchAction: onHeaderPointerDown ? 'none' : undefined }}
        className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-border bg-card text-[11px] uppercase tracking-widest text-muted-foreground"
      >
        <span>moltek</span>
        <span className="flex items-center gap-2">{headerRight}</span>
      </div>

      <div className="bg-background flex items-center justify-center overflow-hidden">
        <Moltek size={width} />
      </div>

      {footer}
      {children}
    </section>
  )
}
