/**
 * =============================================================================
 * UNLOCK SCREEN
 * =============================================================================
 *
 * Browsers refuse to start audio before a gesture, so this is the first thing
 * anyone sees. It is the same panel he lives in during the session, centred
 * and held still: the studio's first screen and its mascot window are one
 * object, so arriving at the studio is him already being there rather than a
 * splash that gets replaced by something else.
 *
 * The rig needs no waiting state to sell it. With no audio there are no
 * pulses and the analyser reads silence, so every spring is at rest and he
 * just stands at the decks, blinking, until the music starts.
 *
 * The whole surface is the button. There is nothing to aim at.
 */

'use client'

import { MoltekWindow } from '@/components/moltek-window'
import { PlayIcon } from '@/components/icons'

const WIDTH = 420

export function UnlockScreen({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button
      onClick={onUnlock}
      className="fixed inset-0 z-50 bg-background flex items-center justify-center cursor-pointer"
    >
      <MoltekWindow
        width={WIDTH}
        headerRight={<span className="tabular-nums normal-case tracking-normal">standby</span>}
        footer={
          <div className="flex items-center justify-center gap-2 h-9 shrink-0 border-t border-border bg-card text-[11px] uppercase tracking-widest text-primary">
            <PlayIcon size={11} />
            tap anywhere to start the music
          </div>
        }
      />
    </button>
  )
}
