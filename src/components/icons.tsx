/**
 * =============================================================================
 * ICONS
 * =============================================================================
 *
 * One flat SVG set, all drawn on the same 14x14 grid so every glyph carries
 * the same optical weight - the fix for unicode symbols that each render at
 * their own size. Solid fills for transport states, hairline strokes for
 * utility actions.
 */

import { BODY, EYES, HANDS, LEGS } from '@/lib/moltek-sprite'

type IconProps = { size?: number; className?: string }

function Svg({ size = 14, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 2L12 7L3.5 12V2Z" fill="currentColor" />
    </Svg>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="8" height="8" fill="currentColor" />
    </Svg>
  )
}

export function RecordIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4" fill="currentColor" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M11.5 7A4.5 4.5 0 1 1 7 2.5c1.76 0 3.3 1 4.05 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M11.5 1.5V5H8" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  )
}

/** Counter-clockwise: put it back. The mirror of RefreshIcon, so the pair
 *  reads as opposites and both carry the same weight on the grid. */
export function ResetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M2.5 7A4.5 4.5 0 1 0 7 2.5c-1.76 0-3.3 1-4.05 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M2.5 1.5V5H6" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 1.5V9M7 9L3.75 5.75M7 9l3.25-3.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 12.25h10" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  )
}

/**
 * Mini moltek.
 *
 * Drawn from the sprite's real coordinates rather than redrawn by eye. His
 * proportions are the whole likeness and they are easy to get wrong: the body
 * is 79 percent of the width and sits flush with the top, the eyes are high
 * and set wide near the outer edges, the claws are a fifth of the width each,
 * and the legs are nearly a third of his height. An approximation that misses
 * those reads as a generic blocky creature and not as him.
 *
 * So this imports the same constants the mascot renders from, which also
 * means the icon cannot drift if the sprite is ever corrected.
 *
 * He is 107x86, not square, so this does not use the shared 14x14 grid: a
 * square viewBox would either squash him or shrink him to fit.
 */
export function MoltekIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={Math.round((size * 86) / 107)}
      viewBox="0 0 107 86"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={className}
    >
      <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} fill="currentColor" />
      {HANDS.map((h, i) => (
        <rect key={i} x={h.x} y={h.y} width={h.w} height={h.h} fill="currentColor" />
      ))}
      {LEGS.map((l, i) => (
        <rect key={i} x={l.x} y={l.y} width={l.w} height={l.h} fill="currentColor" />
      ))}
      {/* Eyes punched through in the surface behind him, which is --card
          everywhere this is used. */}
      {EYES.map((e, i) => (
        <rect key={i} x={e.x} y={e.y} width={e.w} height={e.h} fill="var(--mk-surface)" />
      ))}
    </svg>
  )
}
