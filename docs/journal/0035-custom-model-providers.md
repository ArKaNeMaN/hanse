# 0035 - Global custom model providers

Status: implemented and verified; committed and pushed.
Date: 2026-10-27.
Design: [Global custom model providers](../design/custom-model-providers.md).
Plan: [0029](../plans/0029-custom-model-providers.md).
Owner decisions: [open questions](../open-questions.md), stage 0029.

## What shipped

- Migration v19 adds the global `model_providers` table (`id`, `name`, `npm`, `base_url`,
  `models_json`, timestamps, JSON/npm/length checks). Provider keys stay in `provider_keys`.
- `src/model-providers/` provides strict validation, the 32-provider and 48 KiB projection caps, the
  validated `snapshot()` used by every consumer, the overlay/hash projection, the delete guard, and
  collision/base-URL warnings.
- The manager and the legacy launcher project every validated provider into
  `OPENCODE_CONFIG_CONTENT.provider` and enforce the hard 64 KiB overlay limit. `settingsHashFor`
  receives the provider hash at both the launch and pending-restart call sites; an empty registry
  leaves the overlay and hash unchanged.
- The Global settings page has a **Custom model providers** block with add/edit/delete, a models
  textarea (`id | context | output | name?`), key status/link, warnings, and a delete confirmation.
  Project/app pages show a hint and the model datalist. `llm.model` accepts custom
  `provider/model` suggestions without becoming a closed enum.
- `SettingsService` adds registry ids to the key status map (`providerIdSource`), so a new provider
  appears in the Providers block as `Missing`; `allProviderIds()` supplies all key scopes plus host
  auth for collision warnings.
- HTTP: `GET/POST /api/settings/model-providers` (human-only, `crossSiteMutation` on POST), the
  existing settings fragment contract, `400/404/409`, and `503 model_providers_not_configured`.
  Deleting a provider referenced by any `llm.model` row returns `409 provider_in_use` with the
  referencing scopes.
- Docs updated: current state, deployment, README, design/plan indexes, open questions, journal.

## Review notes

- Design review: `oracle` round 1 CHANGES REQUESTED (3 blockers, 6 majors, 6 minors), round 2 PASS
  (8 minors folded). One earlier Oracle attempt was discarded because the reviewer tried a live
  process-control command (`pkill -f "opencode serve"`) that killed its own agent server; the final
  reviews were static, read-only passes.
- Plan review: `momus` round 1 CHANGES REQUESTED (3 majors, 5 minors), round 2 PASS (5 minors
  folded).
- Owner accepted: global-only definitions, manual model list, only
  `@ai-sdk/openai-compatible`, delete blocked while referenced, and the settings block surface.

## Verification

- `npm run lint` - pass.
- `npm run typecheck` - pass.
- Full suite - 2518 tests in 130 files pass with the managed `HANSE_CREDENTIALS_DIR`/`GIT_*`
  environment unset and `--testTimeout=20000`. The default 5 s timeout is flaky under the app
  container's concurrent load; the managed credential environment also changes the
  `git-service` expected `core.sshCommand`, so the suite is run with that environment removed.
- `npm run build` - pass (tsc + Tailwind).
- `npm run check:sensitive` - pass.
- New coverage: provider CRUD/validation/caps/delete guard/snapshot/hash; overlay projection,
  empty-registry byte identity, and the 64 KiB guard; manager spec/hash/pending-restart; settings
  page/API/fragments/warnings/503/agent-403/cross-site; migration v19 and version bumps; launcher
  projection; `data-confirm`.
- Live smoke against the real `llm-lan` gateway is pending; no real model call was made in this
  stage.

## Residual risks

- Provider definitions are global-only; per-project/app definitions, model auto-discovery, arbitrary
  npm adapters, custom headers, OAuth providers, and enable/disable are not implemented.
- The collision warning uses a curated bundled-id set; an uncommon bundled id can be overridden
  without a warning. A same-id project `opencode.json` provider is deep-merged, with the overlay
  winning the keys it supplies.
- Provider definitions are non-secret and visible to every app in `OPENCODE_CONFIG_CONTENT`; keys
  stay in `auth.json`/`provider_keys`. Deleting and recreating an id reuses its retained key against
  the new base URL.
- The 48 KiB provider projection and 64 KiB final overlay are hard limits; a very large existing
  overlay plus the registry fails the start with a clear `provider_overlay_too_large` error.
- A downgrade to a coordinator without v19 needs a restart because the applied hash includes the
  provider hash.

## Commit

- `feat(settings): add global custom model providers`
- Pushed to `origin main`.
