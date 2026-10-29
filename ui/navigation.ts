/**
 * Full document navigation to a still-legacy route (for example a created project's detail page)
 * so the server-rendered notice and chrome render exactly as they do for a legacy form post.
 */
export function fullDocumentNavigate(url: string): void {
  window.location.assign(url);
}
