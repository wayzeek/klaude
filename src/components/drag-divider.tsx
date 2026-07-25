/**
 * =============================================================================
 * DRAG DIVIDER
 * =============================================================================
 *
 * A flat resize handle: a hairline that widens into a green grip on hover
 * and while dragging. Pointer capture keeps the drag alive when the cursor
 * outruns the 5px strip; arrow keys nudge for keyboard users.
 */

'use client'

import { useState } from 'react'

export function DragDivider({
  direction,
  label,
  onDrag,
  onNudge,
}: {
  direction: 'col' | 'row'
  label: string
  /** Called with the pointer position while dragging. */
  onDrag: (clientX: number, clientY: number) => void
  /** Called with +/- pixels on arrow keys. Positive grows the panel. */
  onNudge: (delta: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const grow = direction === 'col' ? 'ArrowLeft' : 'ArrowUp'
  const shrink = direction === 'col' ? 'ArrowRight' : 'ArrowDown'
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'col' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title={label}
      data-dragging={dragging || undefined}
      className={direction === 'col' ? 'divider divider-col' : 'divider divider-row'}
      onPointerDown={(e) => {
        e.preventDefault()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {}
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (dragging) onDrag(e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {}
        setDragging(false)
      }}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(e) => {
        if (e.key === grow) {
          e.preventDefault()
          onNudge(16)
        } else if (e.key === shrink) {
          e.preventDefault()
          onNudge(-16)
        }
      }}
    />
  )
}
