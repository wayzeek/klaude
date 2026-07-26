'use client'

/**
 * =============================================================================
 * THEME PICKER
 * =============================================================================
 *
 * Eight one-line rows and a footer. Each row is painted in its own theme's
 * background with that theme's swatches, so the list previews itself.
 *
 * The first attempt gave every row a tall two-column card with the description
 * wrapped inside it, which came to a 930px panel that overflowed the viewport
 * and was mostly dead space. The description lives in a single footer line now,
 * following whatever row is under the pointer, so eight themes fit in the height
 * one card used to take. No `title` attributes either: a native tooltip on each
 * row just covered the panel with text the panel was already showing.
 */

import { useEffect, useRef, useState } from 'react'
import themes from '@/lib/themes.json'
import { DEFAULT_THEME, THEMES, applyTheme, readTheme } from '@/lib/theme'

/** Raw palettes by name, so a row can paint itself in its own colours. */
const PALETTE: Record<string, Record<string, string>> = Object.fromEntries(
  themes.themes.map((t) => [t.name, t as unknown as Record<string, string>]),
)

/** The sprite at the smallest size that still reads: shell, eyes, band. */
function Glyph({ p }: { p: Record<string, string> }) {
  return (
    <svg width="20" height="16" viewBox="-2 -11 111 99" shapeRendering="crispEdges" aria-hidden>
      <g fill={p.body}>
        <rect x="11" y="0" width="85" height="65" />
        <rect x="0" y="21" width="22" height="23" />
        <rect x="85" y="21" width="22" height="23" />
        <rect x="14" y="60" width="14" height="26" />
        <rect x="44" y="60" width="14" height="26" />
        <rect x="79" y="60" width="14" height="26" />
      </g>
      <rect x="21" y="13" width="13" height="13" fill={p.eye} />
      <rect x="73" y="13" width="13" height="13" fill={p.eye} />
      <g fill={p.gear}>
        <rect x="20" y="-9" width="67" height="7" />
        <rect x="4" y="1" width="13" height="22" />
        <rect x="90" y="1" width="13" height="22" />
      </g>
    </svg>
  )
}

export function ThemePicker() {
  // Starts on the default rather than reading storage: the server render has no
  // localStorage and a mismatch would hydrate-warn. The boot script in <head>
  // already applied the real theme, so nothing flashes; this catches the label up.
  const [theme, setTheme] = useState(DEFAULT_THEME)
  const [open, setOpen] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => setTheme(readTheme()), [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = THEMES.find((t) => t.name === theme) ?? THEMES[0]
  const shown = THEMES.find((t) => t.name === peek) ?? current

  const pick = (name: string) => {
    applyTheme(name)
    setTheme(name)
    setOpen(false)
  }

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`h-8 px-2 flex items-center gap-2 border text-[11px] tracking-[0.12em] uppercase ${
          open
            ? 'border-foreground/40 text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
        }`}
      >
        {/* One block, the accent. Two read as a swatch strip and competed with
            the label; the trigger only needs to say which theme is on. */}
        <span aria-hidden className="w-2.5 h-2.5" style={{ background: 'var(--mk-accent)' }} />
        {current.label}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="theme"
          onPointerLeave={() => setPeek(null)}
          className="absolute bottom-[calc(100%+1px)] right-0 z-50 w-[248px] border border-border bg-card"
        >
          {THEMES.map((t) => {
            const p = PALETTE[t.name]
            const active = t.name === theme
            const hot = peek === t.name
            return (
              <button
                key={t.name}
                role="option"
                aria-selected={active}
                onPointerEnter={() => setPeek(t.name)}
                onFocus={() => setPeek(t.name)}
                onClick={() => pick(t.name)}
                className="w-full h-[30px] flex items-center gap-2 pl-0 pr-2 text-left"
                // Hover lifts the row toward its own foreground rather than using
                // one fixed highlight: a single overlay colour that reads on slate
                // disappears on the light theme. Driven from state because the
                // value is per-row, which a CSS :hover cannot reach.
                style={{
                  background: hot ? `color-mix(in oklab, ${p.fg} 12%, ${p.bg})` : p.bg,
                  boxShadow: hot ? `inset 0 0 0 1px ${p.mutedFg}` : undefined,
                }}
              >
                {/* Left marker: the accent when live, the foreground when hovered,
                    so it always says which row the pointer is on. */}
                <span
                  aria-hidden
                  className="w-[3px] h-[30px] shrink-0"
                  style={{ background: active ? p.accent : hot ? p.fg : 'transparent' }}
                />
                <Glyph p={p} />
                <span
                  className="flex-1 min-w-0 truncate text-[11px] tracking-[0.12em] uppercase"
                  style={{ color: active || hot ? p.fg : p.mutedFg }}
                >
                  {t.label}
                </span>
                {active && (
                  <span className="text-[9px] tracking-[0.1em] uppercase shrink-0" style={{ color: p.accent }}>
                    on
                  </span>
                )}
                <span aria-hidden className="flex shrink-0">
                  {[p.accent, p.destructive, p.body, p.gear].map((c, i) => (
                    <span key={i} className="w-2.5 h-[14px]" style={{ background: c }} />
                  ))}
                </span>
              </button>
            )
          })}

          {/* One footer line, following the pointer, instead of a tooltip per row. */}
          <div className="h-8 px-2 flex items-center border-t border-border bg-background">
            <span className="text-[10px] leading-tight text-muted-foreground line-clamp-2">
              {shown.note}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
