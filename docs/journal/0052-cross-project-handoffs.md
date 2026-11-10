# 0052 - Cross-project handoffs

Status: **implemented**; full verification matrix green.
Design: [Cross-project handoffs](../design/cross-project-handoffs.md) (`oracle` PASS WITH FIXES;
findings folded).
Plan: [0044 - Cross-project handoffs](../plans/0044-cross-project-handoffs.md) (`momus` OKAY WITH
FIXES; findings folded).
Baseline: rebased onto `3123a39` (0043 idle maintenance, migration v27); originally designed against `9913271` (migration v26).
Migration: pinned **v28** (`cross-project-handoff-grants`, additive, `backwardCompatible: true`).
Mode: **feature** - source-owned grants, cross-project admission/discovery, listing, HTTP/UI,
deletion/audit, migration, tests.

## Scope

Add an explicit, operator-owned egress permission so an application can hand off to an application in
a different project, for one-shot and threaded handoffs, without changing the same-project path.

## What changed

- **Schema v28.** New `handoff_grants` table (source project, `from_app_key`/`to_app_key` with `*`,
  concrete `target_project_id`, `auto|approve` modes, unique pair, `CHECK (project_id <>
  target_project_id)`, both project FKs cascade, target index). `handoffs` gains nullable
  `target_project_id` and `grant_id` (insert-only snapshot) plus the target index; existing rows are
  backfilled with `target_project_id = project_id`.
- **Resolver/store.** `src/coordinator/grants.ts`: precedence exact pair > exact-from/wildcard-to >
  wildcard-from/exact-to > wildcard pair; builtin/master and deleting projects/apps fail closed;
  content-free grant audit events; reachable-target discovery for `list_apps`.
- **Service/MCP.** `request_sibling_change` accepts optional `to_project`; `undefined` keeps the
  same-project branch byte-for-byte, `""`/`null`/non-string is `invalid_target_project`, and the
  grant is checked before the target app. `list_apps` adds `remoteApps`. One grant covers one-shot
  and threads; replies need no reverse grant.
- **Dispatch/listing.** Cross-project envelopes carry the project pair and the untrusted-content
  warning; `listHandoffs` unions source and target; `allHandoffs` dedupes; `buildSite` counts once.
- **HTTP/UI.** Human-only grant CRUD, public `/api/projects` redaction (cross rows filtered out),
  human-only projection with both project ids/names, the project-page **Cross-project grants** card
  with a read-only inbound list, the `/handoffs` `Cross-project` filter/count/badge, and the
  project-qualified route in the detail dialog.
- **Deletion/audit.** Project deletion cascades grants from either side; app deletion removes
  exact-app grants on both sides; `handoff.cross_project.denied` is deduped per app per rate window
  and counts toward the existing failure limiter.

## Owner decisions (closed)

1. Outbound grants are source-owned; the target does not consent in this stage.
2. A separate `handoff_grants` table, not `handoff_policies`; absence is deny.
3. `handoff_policies` remain the same-project authority; the grant is authoritative cross-project.
4. One grant covers one-shot and threads; replies never require a reverse grant.
5. `list_apps` includes reachable `remoteApps`.
6. Default grant mode is `auto/auto`; the operator can tighten a pair.
7. Target-project inbound visibility is read-only (visibility, not consent).
8. Human-only grant management; builtin/master excluded on both sides.

## Verification

Full matrix, run in the stage worktree:

- `npm run lint` - pass (912 files).
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- `npm run typecheck:e2e` - pass (extra check; not in the required gate list).
- `npm test` - 269 test files passed / 1 skipped; 4,005 tests passed / 1 skipped.
- `npm run build` - pass (Tailwind + Vite).
- `npm run check:ui` - pass (86 SFCs, sentinel present).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 137 passed / 1 skipped. New scenarios:
  - `e2e/spa-project.spec.ts` - "shows outbound grants on the source and read-only inbound grants on
    the target" (grant card outbound row, pinned cross-handoff timestamp, target read-only inbound).
  - `e2e/spa-handoffs.spec.ts` - "filters cross-project handoffs and shows the project-qualified
    route" (`/handoffs?filter=cross` row/badge, pinned timestamp, dialog project pair).

The E2E seed creates one outbound grant (`alpha` -> `gamma`, `auto/auto`) and one cross-project
handoff after it, then pins `created_at`/`updated_at`/`last_message_at` to
`2021-01-01T00:00:00.000Z` so the specs assert a stable time (plan m3). Same-project fixtures are
unchanged.

## Accepted limits

- **No target consent.** The target project cannot accept/revoke a grant; it only sees the inbound
  row read-only.
- **In-flight snapshot.** Revoking/editing a grant affects only new handoffs; an in-flight
  handoff/thread keeps its snapshot and is stopped through the human cancel route.
- **No deny rows.** A wildcard cannot be narrowed by an exception; delete it and add exact grants.
- **Project-id existence.** `to_project` is a project **id**, not a slug/name; names are display-only.
- **One-shot collision residual.** A cross-project one-shot retry can emit a second
  `handoff.cross_project.created` event (count-only, no content); thread retries skip it.

## Next

- Orchestrator review and a single coherent stage commit (`feat(handoffs): add explicit
  cross-project grants`), including only this stage's files plus the 0044 `docs/open-questions.md`
  hunk.
- Deployment follows the normal image rollback rule; after v28 the schema guard blocks an older
  binary, so rollback is image + pre-v28 database backup/PITR.
