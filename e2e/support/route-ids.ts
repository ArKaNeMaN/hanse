/**
 * The Stage 0 default SPA route set, in registry order.
 *
 * `HANSE_UI_SPA_ROUTES` is a replacement set. Retired chat/terminal are always included by the
 * registry, so test servers only need the non-workspace defaults.
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
