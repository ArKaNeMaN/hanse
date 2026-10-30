/**
 * Every route that is a default SPA route at Stage 0, in registry order.
 *
 * `HANSE_UI_SPA_ROUTES` is a replacement set, so a test that needs one extra route must include this
 * full list plus the route under test. Chat stays absent from the default registry set until its
 * cutover; terminal is added by Stage 2, chat by Stage 3B, never as a bare id.
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

/** Stage 2/3A SPA project: the full default set plus the terminal record, never a bare id. */
export const SPA_E2E_ROUTE_IDS_WITH_TERMINAL = `${SPA_E2E_ROUTE_IDS},terminal`;

/** Stage 3B SPA project: the full default set plus both test-only workspace records. */
export const SPA_E2E_ROUTE_IDS_WITH_TERMINAL_AND_CHAT = `${SPA_E2E_ROUTE_IDS},chat,terminal`;
