/**
 * =============================================================================
 * MIXER PANEL
 * =============================================================================
 *
 * The rack's top section: one channel row per named layer, and the open
 * layer's knobs unfolded directly underneath its own row.
 *
 * The knobs live inside the row's block rather than in one shared strip at the
 * foot of the panel. A shared strip re-points as the selection moves, so a knob
 * never reads as belonging to a layer even though its value always did.
 *
 * Everything folds. One layer's knobs fold from the marker on its row, and the
 * whole panel folds from the marker in the header, leaving the rack to the tape
 * deck when you just want to code. The first layer opens itself once when a
 * track arrives, so the panel is never a wall of closed rows on load - after
 * that a fold the listener chose sticks, including across a new revision.
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { ChannelRow } from '@/components/channel-row'
import { ChannelStrip } from '@/components/channel-strip'
import { ResetIcon } from '@/components/icons'
import { hasTrim } from '@/lib/trim'
import { postQuiet } from '@/lib/api-client'
import type { Mix } from '@/hooks/use-strudel'

export function MixerPanel({
  layers,
  mix,
  folded,
  onToggleFolded,
}: {
  layers: string[]
  mix: Mix
  /** Whether the whole rows list is folded away behind the header. */
  folded: boolean
  onToggleFolded: () => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  // Whether the one automatic open has happened for the current track. Without
  // it, a listener who folds every row would have the first one spring back
  // open on the next push.
  const autoOpened = useRef(false)

  useEffect(() => {
    if (layers.length === 0) {
      autoOpened.current = false
      if (open !== null) setOpen(null)
      return
    }
    if (!autoOpened.current) {
      autoOpened.current = true
      setOpen(layers[0])
      return
    }
    // The open row followed a layer that has left with the track: follow the
    // track to the first one rather than showing knobs for a name nobody can
    // see. A rack the listener folded stays folded - `open` is already null
    // there, so this never springs it back open.
    if (open !== null && !layers.includes(open)) setOpen(layers[0])
  }, [layers, open])

  // Layers currently showing a star. Trims are only stored when non-neutral,
  // so presence is enough - no need to re-check isNeutral here.
  const trimmedCount = layers.filter((name) => hasTrim(mix.trims, name)).length
  const soloCount = layers.filter((name) => mix.soloed.includes(name)).length

  return (
    // Folded, the section is its header and nothing more, so the rack below it
    // can take the space rather than leaving a hole where the rows were.
    <section className={folded ? 'shrink-0 flex flex-col' : 'flex-1 min-h-0 flex flex-col'}>
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-border bg-card text-[11px] uppercase tracking-widest text-muted-foreground">
        {/* The whole label folds the panel, not just the marker: a 12px glyph is
            a mean target for something you reach for between takes. */}
        <button
          onClick={onToggleFolded}
          title={folded ? 'open the mixer' : 'fold the mixer away'}
          className="flex-1 min-w-0 flex items-center gap-2 text-left hover:text-foreground"
        >
          <span className="w-3 shrink-0">{folded ? '+' : '-'}</span>
          <span className="flex-1 min-w-0 truncate">
            mixer{layers.length > 0 ? ` · ${layers.length}` : ''}
            {trimmedCount > 0 ? ` · ${trimmedCount} trimmed` : ''}
          </span>
        </button>
        {/* Solo is additive, so it can end up spread across several rows - and
            when the panel is folded those rows aren't even visible. One click
            here drops the whole solo and returns the full mix. */}
        {soloCount > 0 && (
          <button
            onClick={() => postQuiet('/api/mix', { soloed: [] })}
            title={`clear solo on ${soloCount === 1 ? 'the soloed layer' : `all ${soloCount} soloed layers`}`}
            className="shrink-0 h-5 px-1 border border-primary text-primary leading-none hover:bg-primary hover:text-primary-foreground"
          >
            {soloCount} solo
          </button>
        )}
        {/* Panel-level reset: clears every layer's trim in one mutation, so the
            whole rack returns to as-written together. Counts starred layers
            rather than reading Object.keys blindly, since a layer whose trim was
            pruned with the track is not on any row. */}
        <button
          onClick={() => postQuiet('/api/mix', { resetAllTrims: true })}
          disabled={trimmedCount === 0}
          title={
            trimmedCount === 0
              ? 'every layer is already as written'
              : `reset all ${trimmedCount} trimmed layers to as written`
          }
          className={`w-6 h-6 shrink-0 flex items-center justify-center ${
            trimmedCount === 0 ? 'text-muted-foreground/30 cursor-default' : 'hover:text-foreground'
          }`}
        >
          <ResetIcon size={12} />
        </button>
      </div>
      {!folded && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {layers.map((name, i) => (
            <div key={name} className={name === open ? 'border-b border-border' : ''}>
              <ChannelRow
                name={name}
                index={i}
                mix={mix}
                open={name === open}
                onToggle={() => setOpen((current) => (current === name ? null : name))}
              />
              {/* Keyed by layer as well as scoped to it: without the key React
                  could reuse the strip and its knobs across a selection change,
                  so a pending drag or a half-typed note could be posted under
                  the newly selected layer's name. */}
              {name === open && <ChannelStrip key={name} name={name} mix={mix} />}
            </div>
          ))}
          {layers.length === 0 && (
            <div className="px-2.5 h-11 flex items-center text-muted-foreground/60">
              no layers yet: push a track built with layers(...)
            </div>
          )}
        </div>
      )}
    </section>
  )
}
