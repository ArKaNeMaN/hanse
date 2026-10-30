/**
 * The Stage 0 default SPA route set, in registry order.
 *
 * `HANSE_UI_SPA_ROUTES` is a replacement set, so a test that needs a workspace route must include
 * this full list plus the route under test, never a bare id. `/terminal` and `/chat` are appended
 * explicitly so the SPA project stays stable before and after their registry cutovers.
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

/** Stage 2 SPA project: the full default set plus the terminal record, never a bare id. */
export const SPA_E2E_ROUTE_IDS_WITH_TERMINAL = `${SPA_E2E_ROUTE_IDS},terminal`;

/** Stage 3B onward SPA project: the full default set plus both workspace records. */
export const SPA_E2E_ROUTE_IDS_WITH_TERMINAL_AND_CHAT = `${SPA_E2E_ROUTE_IDS},chat,terminal`;
