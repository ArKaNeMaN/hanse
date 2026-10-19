# Stage 0006 - Web tools and hierarchical settings

- Date: 2026-10-19
- Status: implemented, verified, and deployed to `deployment-host` on 2026-10-19
- Design: [`docs/design/web-tools-and-settings.md`](../design/web-tools-and-settings.md)
- Plan: [`docs/plans/0006-web-tools-and-settings.md`](../plans/0006-web-tools-and-settings.md)
- Decisions: [ADR-0006](../decisions/0006-hierarchical-settings.md),
  [ADR-0007](../decisions/0007-web-tool-drivers.md)
- Owner decisions: [`docs/open-questions.md`](../open-questions.md)

## Context

The coordinator had no operator-editable settings: model selection was fixed by the image-baked OMO
config, provider credentials were only the host `auth.json`, and there was no way to enable or
configure web search/fetch. This stage adds a global -> project -> application settings hierarchy,
encrypted model-provider keys, optional web drivers (built-in or DeepSeek), a model that also reaches
OMO agents/categories, and an explicit restart workflow.

## Delivered

- SQLite migration v3: `settings` (scoped, three-state, `json_valid`) and `provider_keys`
  (AES-256-GCM ciphertext, logical tombstone).
- `src/settings/`: typed key registry, resolver (replace/append, `null` clears, `sources`, warnings),
  provider-key storage/status, host-auth snapshot, and deterministic effective/auth/combined hashes.
- `src/web/`: driver registry, DeepSeek standalone Search/Fetch client, managed `hanse_web` MCP
  server, and `HANSE_WEB_CONFIG` validation. A managed driver disables the corresponding built-in.
- `src/opencode/`: reconciled per-instance `auth.json` (0600, atomic), model overlay, per-app OMO
  profile + `OMO_PROFILE`, `hanse_web` MCP injection, permission options, single-flight `ensure`,
  bounded per-app stop/restart, pending hash, and a warning-only `/agent` model check.
- `src/http/`: human-only settings pages/API, provider-key forms (never echoed), three-state
  controls, driver fields, pending/restart surfaces, and `/assets/settings.js`.
- CLI: `hanse web-mcp`; serve wiring for `SettingsService`/`OmoProfileStore` and fail-closed secret-key
  loading.

## Verification

- `npm run lint && npm run typecheck && npm test && npm run build` — all green; **522 tests**.
- Temporary Playwright smoke of global/project/app settings at 1440 and 390 (dark): 6 pages, zero
  console/page errors, zero duplicate DOM ids; screenshots inspected and the duplicated pills/copy,
  provider status duplication, scoped-row alignment, and duplicate nav links were fixed.
- Built image `hanse:qa`, uid 1000, writable `/home/node/.omo`, real `opencode-ai@1.19.3` +
  `oh-my-openagent@5.1.35`:
  - per-app OMO profile written; `/agent` reported `deepseek/deepseek-flash` for the pinned agents;
  - a second run selected `deepseek/deepseek-v4-pro`: `/config` and `/agent` both reported it and
    the generated profile contained 20 model pins (11 agents + 9 categories);
  - managed search registered `hanse_web` with `search`, OMO `websearch` disappeared from `/config`,
    permissions were `websearch: deny` and `hanse_web_search: allow`;
  - the real `hanse web-mcp` listed `search` with the instance auth file;
  - restart returned `{restarted:true}`, a second call returned
    `{restarted:false,reason:"not_running"}`.
  - A project `.omo/omo.jsonc` layer was exercised; the per-app profile still won in this image, so
    no mismatch warning appeared. The `/agent` model-mismatch verifier itself is unit-tested.
  - No paid DeepSeek Search/Fetch call was made; driver tests use a local fake HTTP server.
- Security review (`security-engineer`, focused diff review): **PASS WITH CHANGES**. Fixed:
  - `safeLocalPath` now rejects all C0 controls (HTAB open-redirect bypass), with a regression test;
  - `loadOrCreateKey` enforces `0600` and a regular file on an existing key, with tests;
  - provider-key mutations enable `secure_delete` and checkpoint the WAL, with a WAL-scan test;
  - the tombstone claim was softened to logical clearing in the design/ADR.

## Deployment

- Deployed from the working tree via the `deployment-host` tar procedure (not from git HEAD).
- Image: `hanse:0.1.0`, `sha256:34d3dcaafff8bf868424fd4568e26d765bbb47774c9b345307a0f60bd7301db5`.
- Previous image: `sha256:384546b4e280a8653472c62a105c726489feb7d2e90989e53d4880cb042c8c03`.
- Rollback tag: `hanse:rollback-20261019-173815-pre-settings`.
- Backup: `<BACKUP_DIR>/20261019-173815-pre-settings/{state.tgz,workspace.tgz,env}`.
- Health: `/`, `/projects`, `/handoffs`, `/api/projects`, `/settings`, assets — 200; `/chat` — 303;
  anonymous `/` — 303; `/ide/` — 200 after redirect; both containers `Up`; logs clean.
- Probe: `GET /api/settings?scope=global` 200 with defaults; `secret.key` mode 0600; a temporary
  `demo-app` session created/deleted (200); instance `/config` kept the expected MCPs and
  `deepseek/deepseek-flash`; `/agent` reported the same model; the per-app OMO profile was written.
- The local-only deploy log has the same record.

## Accepted residual risks

- Agents run as the coordinator uid and can read `/data/state`, `auth.json`, the DB, and
  `secret.key`; provider keys are encrypted at rest but this is not a boundary against same-uid
  agents.
- Provider ciphertext is not AAD-bound and key rotation is not implemented. Clearing is logical;
  physical media/backups may retain old pages.
- `~/.omo` state remains shared; project `.omo` layers can override profile pins and the `/agent`
  model check is warning-only.
- Existing sessions may keep their session model after a restart.
- Built-in search requires the OMO baseline; managed web tools depend on DeepSeek availability and
  have no per-instance cost budget.
- Settings do not travel with a cloned project; no multi-user/RBAC.
- No commit was made; deployment to `deployment-host` and a real paid DeepSeek search/fetch smoke remain.

## Next steps

1. Commit/push the stage (owner requested after the deployment).
2. Run a real DeepSeek Search/Fetch call on `deployment-host` when a paid smoke is acceptable; the managed
   tool was listed and the driver is covered by deterministic tests, but no paid API call was made.
3. Consider AAD binding/key rotation, OMO config isolation, and a per-instance web cost budget in a
   later stage.
