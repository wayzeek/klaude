/**
 * =============================================================================
 * CODEMIRROR SYNTAX THEME
 * =============================================================================
 *
 * CodeMirror 6 does not put semantic class names on tokens. It generates scoped
 * ones (`ͼ13`, `ͼm`) and emits matching rules into its own <style> element, which
 * is why every `.cm-keyword` / `.cm-string` rule in a stylesheet is dead code:
 * those selectors match nothing, and the colours you see are whatever theme the
 * host bundle installed.
 *
 * The supported way in is a HighlightStyle extension. Because CM6 accepts
 * arbitrary CSS in a style spec, the colours can be `var(--mk-cm-*)`, which means
 * syntax follows a theme switch live with no re-render and no editor rebuild.
 *
 * Installed at highest precedence so it wins over Strudel's own highlighter
 * rather than racing it.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Prec, StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const V = (name: string) => `var(--mk-cm-${name})`

export const moltekHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: V('comment'), fontStyle: 'italic' },

  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: V('keyword') },
  { tag: [t.meta, t.annotation], color: V('meta') },

  { tag: [t.string, t.special(t.string), t.regexp], color: V('string') },
  { tag: [t.number, t.integer, t.float], color: V('number') },
  { tag: [t.bool, t.null, t.atom, t.unit], color: V('atom') },

  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: V('fn') },
  { tag: [t.propertyName, t.attributeName], color: V('prop') },
  { tag: [t.variableName, t.special(t.variableName)], color: V('var') },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: V('def') },

  { tag: [t.typeName, t.className, t.namespace], color: V('type') },
  { tag: [t.tagName, t.labelName], color: V('tag') },

  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator], color: V('op') },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket], color: V('punct') },

  { tag: t.invalid, color: 'var(--mk-destructive)' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.link], textDecoration: 'underline' },
])

/** Marks a view as themed so a re-run cannot stack duplicate extensions. */
const INSTALLED = new WeakSet<object>()

/**
 * Attach the syntax theme to a live editor.
 *
 * Returns whether it did anything, so a caller polling for the editor to appear
 * knows when to stop. Safe to call repeatedly.
 */
export function installSyntaxTheme(view: EditorView | null | undefined): boolean {
  if (!view || typeof view.dispatch !== 'function') return false
  if (INSTALLED.has(view)) return true
  try {
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        Prec.highest(syntaxHighlighting(moltekHighlightStyle, { fallback: true })),
      ),
    })
    INSTALLED.add(view)
    return true
  } catch {
    // A dead or mid-teardown view is not worth breaking the studio over.
    return false
  }
}
