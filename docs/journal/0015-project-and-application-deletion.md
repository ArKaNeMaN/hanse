# 0015 - Project and application deletion

Status: implemented and verified; deployment pending.

Design: [`docs/design/project-and-application-deletion.md`](../design/project-and-application-deletion.md).
Plan: [`docs/plans/0013-project-and-application-deletion.md`](../plans/0013-project-and-application-deletion.md).

## Context

The coordinator could create projects and add applications, but it could not remove either. Removing
a manifest or a DB row by hand left containers, networks, images, sessions, credentials, settings,
handoffs, and per-app state behind; deleting only the DB row was undone by the next workspace scan.
The stage adds a complete, human-only deletion flow for both entities.

## Delivered

- Migration v11 adds durable `apps.deleting` / `projects.deleting` markers and exposes them through the
  registry, project context, and site model. Registration never clears a marker.
- `DeletionService` orchestrates the runtime stop, managed container/network removal, targeted image
  purge, per-app/project agents-state removal, atomic manifest update, scoped settings/provider-key/
  git-credential cleanup, handoff cleanup, `events` audit rows, and the final DB transaction.
- `InstanceManager.stopForDeletion` performs the runtime delete and marker update in one per-app lock;
  `ensure` refuses a deleting app/project inside the same lock and the chat/prompts/runtime paths map it
  to `409 deletion_pending`.
- The runner gained ownership-checked orphan-network cleanup, the `DELETE /v1/images/:appId` targeted
  purge, a per-app image build/purge gate, and label-scoped image deletion. The coordinator image
  service gained `assertRunnerIdle`/`reserveDelete`/`endDelete`, `purgeApp`/`forgetApp`, and a status
  row re-check before writes.
- New async HTTP handler with exact-name confirmation, MCP/agent rejection, `Origin`/`Host` checks,
  browser `303`/notice and JSON `200`/error responses. Add-app and create-project refuse active
  deletion reservations.
- Project and application pages gained `Danger zone` cards, exact-name dialogs, optional
  `Delete files too`, `Deletion incomplete` states, retry actions, and disabled start/chat/terminal
  actions. Existing design-system primitives were sufficient; no new client script or CSS was needed.
- `events` now records `app.deleted` / `project.deleted`; SSH audit, global settings/secrets, SSH
  hosts, and other projects are preserved.

## Owner decisions

- Q1: keep source by default; `Delete files too` is an explicit checkbox. Source deletion is guarded
  and warning-only when unsafe.
- Q2: delete handoffs that reference the deleted entity and write an `events` audit row; no nullable-FK
  migration.
- Q3: purge managed images immediately with a targeted, label-scoped runner operation; in-use/shared/
  skipped/truncated results are warnings and the global image GC remains.
- Q4: strictly require the runner; a runtime failure aborts with `502` before a durable marker.
- Q5: require the server-validated exact project name or app key.

## Review history

- Design reviewed by `oracle` through six rounds; findings included the state-path `.`/`..` escape,
  async-handler dispatch, startable ghosts, concurrent deletes, source containment, image-build races,
  and shared-root/retry edge cases. All were addressed before implementation.
- Implementation reviewed by `oracle` after all gates passed. It found one major (shared-root project
  deletion could unlink another project's manifest) and five minor issues (image-purge warnings,
  symlinked-parent rejection, add-app/state-dir race, project manifest pre-validation, agents-root
  containment). All were fixed and covered by tests before this record.

## Verification

- `npm run lint` - clean (Biome).
- `npm run typecheck` - clean.
- `npm test` - **86 files / 1295 tests passed**.
- `npm run build` - passed (`tsc` + Tailwind CSS).
- New coverage: migrations v10->v11 and marker preservation; deletion service app/project artifacts;
  shared-root manifest refusal/preservation; settings/secrets/handoffs/events; path, symlink,
  sanitize-collision and source guards; retry/marker/ensure races; image purge/filter/warnings/build
  gate; HTTP auth/confirm/Origin/503/409/502 and add-app/create-project guards; page danger zones,
  retries, badges and disabled actions.
- Real Chromium visual QA at 1440px and 390px for normal/deleting project and app states and open
  dialogs; screenshots under `/tmp/deletion-qa.6R0lLs/out/` (local evidence, not committed).
- No live deployment or `deployment-host` smoke was performed from this checkout.

## Residual risks

- Deletion is irreversible and a failed deletion cannot be cancelled; the entity stays
  `Deletion incomplete` and start/chat/terminal are blocked until a retry completes.
- The runner is required; if it is unreachable deletion returns `502` and no durable marker is set.
- Source-file deletion is opt-in, post-commit, and best-effort; unsafe or re-added paths are skipped
  with warnings.
- A shared project root is refused when its manifest belongs to the target; a manifest that belongs to
  another project at the same root is preserved, so the target row/state can be removed without
  destroying the surviving project's registration.
- Handoff history for deleted entities is deleted (the `events` row is the durable audit); SSH audit
  is preserved.
- The deletion mutex and reservations are in-process and single-node; there is no CLI delete command
  or distributed coordination.
- Image purge skips in-use/shared/limited images with warnings; the global GC remains the fallback.

## Next steps

1. Deploy to `deployment-host` and run the throwaway-app live smoke: create/start/delete an app, verify no
   container/network/state/image/settings/handoff row remains, the `events` row and SSH audit survive,
   and re-adding the same key starts clean.
2. Consider a CLI delete command and bulk deletion only if a workflow needs them.
3. Record the deploy in the stage journal/current-state when the owner authorizes it.
