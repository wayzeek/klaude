/**
 * =============================================================================
 * CHANNEL ROW
 * =============================================================================
 *
 * One mixer row: a fold marker, channel number, live activity light, layer
 * name, volume fader, solo and mute. Clicking the row unfolds its knobs and
 * clicking it again folds them; the marker at the left is a target for the
 * same thing, not the only way to reach it.
 *
 * Solo is additive - soloing bass and then kick leaves both audible, which is
 * how you check a pair against each other.
 *
 * The fader holds its own value while being dragged so the SSE echo cannot
 * fight the thumb, and posts on a throttle so riding it never outruns the
 * audio. A trimmed layer marks its name with a star, so a departure from
 * as-written is visible without selecting the row.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { onLayerPulse } from '@/lib/layer-pulse'
import { postQuiet } from '@/lib/api-client'
import { createThrottle } from '@/lib/throttle'
import { faderPosition, faderVolume, isNeutral, trimFor } from '@/lib/trim'
import type { Mix } from '@/hooks/use-strudel'

/** How often a dragged fader may post. */
const FADER_POST_MS = 80
/** How long after the last move the local override is released. */
const FADER_SETTLE_MS = 800

/** Square, flat toggle - inverse video when active, inert when disabled. */
function Toggle({
  label,
  active,
  activeClass,
  title,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  activeClass: string
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      className={`w-8 h-8 shrink-0 border text-xs leading-none ${
        disabled
          ? 'border-border/40 text-muted-foreground/30 cursor-default'
          : active
            ? activeClass
            : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
      }`}
    >
      {label}
    </button>
  )
}

export function ChannelRow({
  name,
  index,
  mix,
  open,
  onToggle,
}: {
  name: string
  index: number
  mix: Mix
  /** Whether this row's knobs are unfolded beneath it. */
  open: boolean
  /** Open when folded, fold when open. Both the row and its marker call it. */
  onToggle: () => void
}) {
  const dotRef = useRef<HTMLSpanElement>(null)
  // Local value while dragging, so the server echo cannot fight the thumb.
  const [dragPosition, setDragPosition] = useState<number | null>(null)

  // Activity pulse: flash the dot when this layer fires. Direct style
  // mutation - a re-render per audio event would be wasteful.
  useEffect(
    () =>
      onLayerPulse(({ layer }) => {
        if (layer !== name || !dotRef.current) return
        const dot = dotRef.current
        dot.style.background = 'var(--primary)'
        setTimeout(() => {
          if (dotRef.current) dotRef.current.style.background = 'var(--muted)'
        }, 90)
      }),
    [name],
  )

  const throttle = useMemo(
    () =>
      createThrottle<number>((volume) => {
        postQuiet('/api/mix', { trim: { layer: name, volume } })
      }, FADER_POST_MS),
    [name],
  )
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  // The registered release listener, so unmount can remove the exact one that
  // was added. `commitFader` is a new function every render, so the cleanup
  // cannot simply name it.
  const releaseRef = useRef<(() => void) | null>(null)
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

  const trim = trimFor(mix.trims, name)
  const muted = mix.muted.includes(name)
  const soloed = mix.soloed.includes(name)
  // Another layer's solo silences this one too - show it, don't make the
  // listener guess why a row went quiet.
  const silenced = muted || (mix.soloed.length > 0 && !soloed)
  const position = dragPosition ?? faderPosition(trim.volume)

  // Declared before the change handler that arms it, so the listener registered
  // below always refers to an initialised function.
  const commitFader = () => {
    throttle.flush()
    if (settleRef.current) clearTimeout(settleRef.current)
    // Remove the function that was actually registered, not this one. Every
    // render makes a new commitFader identity, so a commit arriving from the
    // keyboard or a blur (which call whichever identity the current render
    // produced) would otherwise remove nothing and leave the original listener
    // on the window forever, one per keyboard adjustment.
    if (releaseRef.current) {
      window.removeEventListener('pointerup', releaseRef.current)
      window.removeEventListener('pointercancel', releaseRef.current)
      releaseRef.current = null
    }
    draggingRef.current = false
    setDragPosition(null)
  }

  const handleFader = (next: number) => {
    setDragPosition(next)
    throttle.push(faderVolume(next))
    // Release the local override once the drag really ends. A pointer let go
    // outside the input fires no mouseup on it, and without this the row would
    // stay pinned to its own value and ignore a change from another tab. The
    // value itself is never at risk: the throttle always delivers a trailing
    // send. Arm the listeners once per drag rather than once per change event,
    // or a single drag would register dozens of them.
    if (!draggingRef.current) {
      draggingRef.current = true
      releaseRef.current = commitFader
      window.addEventListener('pointerup', commitFader)
      window.addEventListener('pointercancel', commitFader)
    }
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(commitFader, FADER_SETTLE_MS)
  }

  // Toggle by intent, not by computed array - the server flips against its
  // own current state, so rapid clicks from a stale snapshot cannot collide.
  const toggleMute = () => postQuiet('/api/mix', { toggleMuted: name })
  // Additive: a listener auditioning a groove wants the kick and the bass
  // together, not one at a time. Soloing everything is a no-op on the sound,
  // and the header's solo count is there to clear the lot in one click.
  const toggleSolo = () => postQuiet('/api/mix', { toggleSoloed: name })

  return (
    <div
      // The whole row folds and unfolds, so the marker is a signpost rather
      // than the only target.
      //
      // Controls are excluded, and not for tidiness: unfolding a row inserts
      // its knobs and shifts every row below it, so a press aimed at a solo,
      // mute or fader would slide out from under the pointer before the
      // mouseup and the click would never complete. Clicking solo down the
      // rack has to work on the first press.
      onMouseDown={(e) => {
        // Primary button only: a right-click is asking for the context menu,
        // not for the rack to move under it.
        if (e.button !== 0) return
        if ((e.target as HTMLElement).closest('button,input')) return
        onToggle()
      }}
      className={`flex items-center gap-2 px-2.5 h-11 border-b border-border/40 cursor-pointer ${
        open ? 'bg-card' : ''
      }`}
    >
      {/* Fold marker: ASCII on purpose. A triangle or a chevron would sit at
          its own weight next to the tabular digits beside it, where +/- is the
          same monospace cell as everything else on the row. */}
      <button
        onClick={onToggle}
        title={open ? `fold ${name} away` : `open ${name}'s knobs`}
        className={`w-3 shrink-0 text-left leading-none ${
          open ? 'text-foreground' : 'text-muted-foreground/50 hover:text-foreground'
        }`}
      >
        {open ? '-' : '+'}
      </button>
      {/* The channel number always stays: it is the layer's stack order in the
          code, so the fold marker sits beside it rather than replacing it. */}
      <span
        className={`w-5 shrink-0 text-[11px] tabular-nums ${
          open ? 'text-foreground' : 'text-muted-foreground/60'
        }`}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <span ref={dotRef} className="w-2 h-2 shrink-0" style={{ background: 'var(--muted)' }} />
      <span
        className={`flex-1 min-w-0 truncate lowercase ${silenced ? 'text-muted-foreground/50' : ''} ${
          muted ? 'line-through' : ''
        }`}
        title={name}
      >
        {name}
        {!isNeutral(trim) && <span className="text-primary"> *</span>}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        // Continuous, not a 200-notch grid. Unity sits at sqrt(0.5) = 0.7071 of
        // the travel, which is not a multiple of any round step, so a stepped
        // input snaps an untouched fader off unity and records a trim nobody
        // asked for the first time the track is clicked.
        step="any"
        value={position}
        onChange={(e) => handleFader(Number(e.target.value))}
        onMouseUp={commitFader}
        onBlur={commitFader}
        onKeyUp={commitFader}
        title={`${name} volume: ${Math.round(faderVolume(position) * 100)}%`}
        className="flat-fader w-20 shrink-0 cursor-pointer"
      />
      <Toggle
        label="s"
        active={soloed}
        activeClass="bg-primary text-primary-foreground border-primary"
        title={
          soloed
            ? `stop soloing ${name}`
            : mix.soloed.length > 0
              ? `hear ${name} as well`
              : `hear only ${name}`
        }
        onClick={toggleSolo}
      />
      <Toggle
        label="m"
        active={muted}
        activeClass="bg-destructive text-background border-destructive"
        title={
          muted
            ? `unmute ${name}`
            : mix.soloed.length > 0 && !soloed
              ? `${name} is already silent while solo is active`
              : `mute ${name}`
        }
        onClick={toggleMute}
        // Muting what a solo already silenced does nothing, so the button says
        // so by going inert - but never for a row that IS muted, or the mute
        // would be a one-way door: muting a soloed layer un-solos it, and with
        // another layer still soloed this row would go inert holding a mute the
        // listener could not take back.
        disabled={!muted && mix.soloed.length > 0 && !soloed}
      />
    </div>
  )
}
