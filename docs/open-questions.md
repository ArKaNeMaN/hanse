# Open questions

> Stage: `0014-context-compaction`. Owner decisions were delegated and resolved autonomously on
> 2026-10-21, before the plan review. There are no open items for this stage.

## Stage `0014-context-compaction` - resolved owner decisions

1. **Defaults** - auto-compaction off; threshold 80%.
2. **Usage formula** - latest non-summary assistant step prompt tokens
   (`input + cache.read + cache.write`); `step-finish` is authoritative, finished `message.updated`
   is the fallback.
3. **Limit source** - `GET /config/providers` -> `limit.context`; a missing limit shows tokens only
   and disables auto-compaction.
4. **Auto scope** - top-level sessions of the app; child/subagent sessions are excluded.
5. **Manual compaction while busy** - `409 session_busy`; unknown status is allowed.
6. **Compaction model** - last-used session model, effective `llm.model` only when hydration finds no
   assistant usage; no per-action override.
7. **Settings application** - live, excluded from the launch settings hash; no restart prompt.
8. **API** - `GET /api/apps/:app/sessions/:sid/context`, `POST .../compact` returning `202`;
   human-only.
9. **Persistence** - in-memory tracker, lazy hydration, best-effort resume of running instances.
10. **UI** - chip in the thread meta, full meter/action in the context rail, new `Context` settings
    section.
11. **No DB migration** and no new dependency.
12. **Loop prevention** - hysteresis floor, armed/ineffective latch, failure cooldown from the
    failure instant with one retry after cooldown.

> Stage: `0013-project-and-application-deletion`. Owner decisions were collected on 2026-10-21,
> before the plan was reviewed. There are no open items for this stage.

## Stage `0013-project-and-application-deletion` - resolved owner decisions

1. **Workspace files** - keep source by default; the delete dialog offers an explicit
   `Delete files too` checkbox. The checkbox path is guarded by root, symlink, shared-directory, and
   coordinator-state containment checks.
2. **Handoff history** - delete handoffs that reference the deleted app/project and write a durable
   `events` audit row. No nullable-FK migration.
3. **Images** - purge the app's managed images immediately with a targeted, label-scoped runner
   operation. In-use/shared images are warnings; the existing global GC remains.
4. **Runtime failure** - strictly require the runner; a runner failure aborts with `502` before a
   durable marker, and deletion is retried later. No force-delete path.
5. **Confirmation** - require the exact project name or app key, validated server-side.

> Stage: `0011-ssh-host-access`. Owner decisions were collected on 2026-10-21, before the plan was
> written. There are no open items for this stage.

## Resolved owner decisions

1. **Runner/daemon model** - whole-stack rootful Docker with a narrow runner broker for v1. Rootless
   would change the daemon, uid mapping, bind-mount ownership, and Compose host; it is a later
   hardening stage, not a flag flip. Mixed rootless/rootful is unsupported.
2. **B0 limitations** - accepted. B0 isolates coordinator secrets only; B1 adds per-app isolation.
   Cross-app auth/token/state access and supervisor reachability are documented B0 limitations.
3. **State migration** - reset per-app sessions for pre-alpha, with a documented backup. No copy
   migration code in B0.
4. **App Dockerfile** - full Dockerfile, so standard linting works. `ARG HANSE_BASE`/`FROM
   ${HANSE_BASE}` is the preferred pattern; an image that lacks the agent runtime is marked
   incompatible and agent deployment fails with a clear error.
5. **Build trigger** - runtime build on a human action (add app or explicit rebuild), with status and
   logs in the Web UI. No deploy-time build; no automatic build on agent file edit.
6. **IDE token** - the operator token remains only in the operator-trusted IDE, with safe shell,
   controlled HOME, restricted workspace, and no auto-run. A scoped IDE principal is a later option.
7. **Git workbench** - harden in B0 with coordinator-controlled fetch/push credentials and tests; move
   app-repo git to a no-secret context in B1.
8. **Default package set** - minimal image: Python 3.12, Node 22, PHP 8.3 (prebuilt, fixed extensions),
   build-essential/pkg-config/dev libraries/CLI clients. Go, Rust, and Java are installed per project
   with mise or an app Dockerfile. No DB servers or browsers.
9. **Egress** - open in B0-B2 for model API and package installs. A forward proxy/allowlist and
   metadata/link-local blocking are a separate hardening stage after B2.
10. **Disk/retention** - two app-image versions per app, GC at 85%, caches excluded from backup.
11. **Cleanup** - `hanse down`/wrapper stops dynamic app containers before `compose down`.
12. **Workspace** - the per-app container mounts only the app directory. Image layers are shared;
    per-app containers add a thin writable layer, not a copy of the image. Project-root read-only is a
    small later addition if a workflow needs it.
13. **Terminal exec** - the operator terminal in the app container ships in B1.
14. **Commit/deploy** - one coherent commit + push to `origin/main` + deploy to `deployment-host` per stage,
    after agent checks and owner manual verification.

## Deliberate non-goals

- No multi-user, RBAC, or multi-tenant isolation.
- No egress proxy/allowlist or metadata blocking in B0-B2; separate hardening stage after B2.
- No per-app code-server, per-app IDE image, or per-app VS Code extensions.
- No automatic build on an agent file edit; builds are human-triggered.
- No shared mutable toolchain cache; per-app `MISE_DATA_DIR`.
- No Kubernetes, microVMs, or distributed coordination.
- No arbitrary app base without the agent runtime; build validation rejects it.

Previous stage decisions are recorded in
[`docs/journal/0010-chat-diff-highlighting.md`](./journal/0010-chat-diff-highlighting.md).

## Previous stage: `0010-git-credentials`

> No open items for `0010-git-credentials`; the nine owner decisions are recorded in [`docs/design/git-credentials.md`](design/git-credentials.md) section 4.

## Resolved owner decisions

1. **Variant A: native git inside the app container with per-app materialized credentials.** The agent
   can read its own credentials; this is accepted. Mitigate with repository-scoped deploy keys or
   fine-grained tokens and operator documentation.
2. **SSH first, HTTPS also required.** GPG signing is out of scope. Passphrase-protected SSH keys are
   rejected on save in v1; the derived public key and fingerprint are shown for the deploy-key
   workflow.
3. **`known_hosts` is optional.** When provided, SSH uses `StrictHostKeyChecking=yes` with the managed
   file; when absent, `accept-new` plus a TOFU warning.
4. **The application directory is the repository root for v1.** Monorepo/project-root repositories are
   out of scope; `GIT_CEILING_DIRECTORIES` stays.
5. **The web IDE is out of scope** and its terminal does not receive these credentials.
6. **Git settings apply on an explicit agent restart.** The web workbench reads the same materialized
   files; Test connection tests draft values without saving.
7. **One SSH credential and one HTTPS credential per scope.** The schema and wrappers leave a seam for
   host-keyed credentials later.
8. **Remove the entire credential/config `HANSE_GIT_*` mechanism, `HANSE_HOST_GIT_DIR`, and
   `HANSE_GIT_SSL_CAINFO` with no fallback**, plus the unused legacy `secrets` table/helper. `deployment-host`
   had no rows, so no data migration is required.
9. **Test connection** runs draft values through the runner's network-enabled one-shot sandbox and is
   app-page-only.
