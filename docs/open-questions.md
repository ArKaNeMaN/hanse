# Open questions

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
