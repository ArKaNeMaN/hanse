/**
 * The server writes a pre-JS topbar fallback into `.topbar__actions`; the App-level
 * `TopbarActions` component owns the same container after mount. Clear it exactly once before
 * `app.mount()` so the two action sets never coexist.
 */
export function clearTopbarActions(doc: Document = document): void {
  doc.querySelector<HTMLElement>(".topbar__actions")?.replaceChildren();
}
