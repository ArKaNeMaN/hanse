# Deploy contract and startup hardening

Follow-up to the `aef3aac` deployment. No deployment action was taken; the changes are in the public
repository.

## Coordinator startup

- The Compose coordinator healthcheck now uses `start_period: 300s`. The one-time runner mount-layout
  migration runs before the HTTP server listens and can take several minutes on a large workspace.
- `runRunnerLayoutMigration` records each app as soon as it verifies instead of waiting for the whole
  loop. A later conflict no longer discards apps that already completed, and a completed app is
  skipped even when its legacy tree still differs.
- Conflicts are reported once per app with `projectId`, `appKey`, and the original message through
  the structured logger. The run still fails closed after visiting every app.
- `docs/deployment.md` documents the worst-case first start, the 300s start period, and the fact that
  the legacy `agents` trees may be retired after the mounts leaves are verified and backed up.

Listening before the migration (option a in the request) was not taken: app containers read the
mounts leaves, so serving app operations before the copy completes would expose a partially migrated
layout. The bounded start period plus incremental completion addresses the unhealthy-container and
repeated-work symptoms without weakening the fail-closed copy.

## Deploy verification contract

`deploy-contract.json` (repository root, copied to `/app/deploy-contract.json`) is a versioned,
machine-readable contract with:

- every shared page route id, path, and public/synthetic flag;
- required assets, the UI manifest selector, and removed legacy assets;
- `/healthz` and `/readyz` status/body fields;
- anonymous/authenticated page statuses, redirects, login semantics, asset statuses, and the
  missing-UI-build fallback.

`test/deploy-contract.test.ts` pins the route list to `src/shared/routes.ts`, so the contract cannot
silently drift from the registry. `docs/deployment.md` and `docs/releases/README.md` define the
release-note policy for contract changes.

## Deploy request spec

`scripts/deploy-request.mjs` (`npm run deploy:request`) generates the complete handoff spec from a
deployed revision and a successful publish run. It refuses a short SHA, a non-numeric publish run id,
an unknown local revision, or a target equal to the deployed revision. Its output always includes:

- the full deployed and target SHAs, the publish run id, the `sha-<full>` image tag, and the rollback
  tag;
- the cumulative commit list, diffstat, and shortstat from the deployed revision;
- explicit migration files and a migration action;
- deploy-visible route, asset/UI, health/Compose, contract, Docker/image, and public-API file flags;
- the no-source-build and no-branch-deploy rules plus the contract verification checklist.

`docs/deploy-request.md` publishes the rules and template; `AGENTS.md` points agents at the generator.

## Verification

- `npx vitest run test/attachments.test.ts test/deploy-contract.test.ts test/deploy-request.test.ts` -
  passed (29 tests).
- `npm run lint` - passed (965 files).
- `npm run typecheck` - passed.
- `npm run typecheck:ui` - passed.
- `npm test` - 4,241 passed, 4 skipped (285 files).
- `npm run build` - passed.
- `npm run check:ui` - passed (92 SFCs, sentinel present).
- `npm run check:sensitive` - passed.
- `npm run deploy:request -- --deployed <sha> --target <sha> --publish-run-id <id>` produced the full
  identity block, cumulative commits/diffstat, migration status, deploy-visible flags, and the
  no-source-build verification checklist.
