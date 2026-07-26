/**
 * =============================================================================
 * THEMES
 * =============================================================================
 *
 * The list comes from src/lib/themes.json, which is also what generates
 * themes.generated.css and what the contrast gate measures. One source, so a
 * theme cannot exist in the picker without existing in the CSS, or vice versa.
 *
 * Switching is a single attribute on <html>. Both the UI and the mascot read the
 * same custom properties, so one attribute change recolours everything in one
 * repaint with nothing coordinating them.
 */

import themes from '@/lib/themes.json'

export type Theme = {
  name: string
  kind: 'dark' | 'light'
  label: string
  note: string
}

export const THEMES: Theme[] = themes.themes.map((t) => ({
  name: t.name,
  kind: t.kind as 'dark' | 'light',
  label: t.label,
  note: t.note,
}))

export const DEFAULT_THEME = THEMES[0].name
export const THEME_KEY = 'moltek.theme'

export const isTheme = (name: string | null): name is string =>
  !!name && THEMES.some((t) => t.name === name)

/**
 * Read the stored choice. localStorage can throw (privacy modes, denied
 * storage) and a theme is a nicety, never worth crashing the studio over.
 */
export function readTheme(): string {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function applyTheme(name: string): void {
  const theme = isTheme(name) ? name : DEFAULT_THEME
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

/**
 * Inlined into <head> so the first paint is already the stored theme. Without
 * it every reload flashes the default before hydration catches up.
 *
 * Deliberately dependency-free and duplicated from the logic above: it has to
 * run before any module loads, so it cannot import anything. The theme list is
 * interpolated at build time from the same JSON, so it cannot drift.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(${JSON.stringify(
  THEMES.map((t) => t.name),
)}.indexOf(t)<0)t='${DEFAULT_THEME}';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='${DEFAULT_THEME}'}})()`
