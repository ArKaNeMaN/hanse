/**
 * Every route that is a default SPA route at Stage 0, in registry order.
 *
 * `HANSE_UI_SPA_ROUTES` is a replacement set, so a test that needs one extra route must include this
 * full list plus the route under test. Chat and terminal are deliberately absent in Stage 0; they
 * are added by their cutover stages, never as a bare `chat`/`terminal` allowlist.
 */
export const SPA_E2E_ROUTE_IDS = [
  "projects",
  "overview",
  "handoffs",
  "ssh",
  "settings-global",
  "skills-global",
  "skills-new",
  "skills-detail",
  "settings-project",
  "settings-app",
  "skills-project",
  "skills-app",
  "app",
  "project",
].join(",");
