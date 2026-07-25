/**
 * =============================================================================
 * API CLIENT HELPERS
 * =============================================================================
 *
 * Tiny fetch wrappers shared by the studio UI components.
 */

export const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Fire-and-forget - UI actions whose failure the server state will reveal. */
export const postQuiet = (url: string, body: unknown) => post(url, body).catch(() => {})

/** POST a note; resolves true only when the server actually stored it. */
export const postNote = (body: { text: string; layer?: string }) =>
  post('/api/notes', body).then(
    (res) => res.ok,
    () => false,
  )
