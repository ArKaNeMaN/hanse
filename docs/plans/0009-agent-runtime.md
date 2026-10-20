# Plan 0009 - Agent runtime isolation and per-app toolchains

Status: **draft, awaiting plan re-review** (2026-10-20, revised after Momus review).

Design: [`docs/design/agent-runtime.md`](../design/agent-runtime.md). Design review: `oracle`,
2026-10-20, PASS WITH REQUIRED CHANGES (findings folded; gate cleared). Owner decisions:
[`docs/open-questions.md`](../open-questions.md), stage `0009-agent-runtime`.

Plan reviewer: `momus`. Implementation is blocked until the plan review passes.

Project profile bindings:

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` |
| Plan reviewer | `momus` |
| Design docs | `docs/design/`, index `docs/design/README.md` |
| Plans | `docs/plans/`, index `docs/plans/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Stage journal | `docs/journal/`, index `docs/journal/README.md` |
| Open questions | `docs/open-questions.md` (closed) |
| Language | English |
| Verification | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` |
| Commit policy | one stage code commit + a docs-only deploy-record commit; `docs/process.md` updated for this exception; owner authorizes; Conventional Commits |

Owner decisions carried into this plan:

- v1 uses whole-stack rootful Docker with a narrow runner broker; rootless is a later hardening
  stage.
- B0 cross-app limitations are accepted; B1 adds per-app isolation.
- Sessions are reset for pre-alpha; state is backed up first.
- App Dockerfiles are full Dockerfiles; an incompatible image fails agent deployment with an error.
- App images are built at runtime on a human action (add app or rebuild), with Web UI status/logs; no
  deploy-time build and no auto-build on agent file edits.
- IDE keeps the operator token (coordinator + IDE only), safe shell, controlled HOME, restricted
  workspace.
- Git is hardened in B0 and moved to a no-secret context in B1.
- Default image is minimal: Python/Node/PHP + build deps; Go/Rust/Java come from mise or an app
  Dockerfile.
- Egress is open in B0-B2; proxy/allowlist is a post-B2 hardening stage.
- Two app-image versions per app, GC at 85%, caches excluded from backup.
- `hanse down`/wrapper cleans dynamic app containers.
- Per-app containers mount only the app directory; image layers are shared.
- Operator terminal exec ships in B1.
- Stage code commit + push/publish, deploy, owner verification, then a docs-only deploy-record commit per stage.

---

## 1. Global invariants

1. The coordinator never mounts or talks to the container-runtime socket. Only the B1/B2 runner does.
2. Agent containers never mount `/data/state`, the operator token, the coordinator source, or the host
   root. They mount only their app directory and their per-app `/data/agents` directory.
3. In B1/B2 the runtime backend forces: user `1000:1000`, fixed entrypoint, `cap_drop: ALL`,
   `no-new-privileges`, read-only root with writable per-app volumes and tmpfs, no privileged, no host
   network, no devices, no socket. In B0 the single `agents` container is hardened at the Compose level
   (same user/caps/no-new-privileges, read-only root + tmpfs, no socket, no state); per-app envelopes
   begin in B1.
4. App image content cannot change the runtime envelope (`USER`/`ENTRYPOINT`/`CMD`/`VOLUME` are
   overridden or rejected).
5. MCP uses a per-app token and HTTP; `HANSE_DB` never reaches an agent.
6. The coordinator owns auth/OMO/MCP-token/opencode-password files; the runtime backend only passes
   paths.
7. A stage ends with gates, a stage code commit, push/publish, deploy, health/agent checks, owner
   manual verification, then a docs-only deploy record. The next stage starts only on owner approval.
8. No new agent runtime state under `/data/state`. The only new volume is the host bind
   `HANSE_AGENTS` -> `/data/agents`.
9. Existing chat/SSE, questions/permissions, handoffs, git workbench, settings/restart, IDE proxy, and
   `opencode` 1.19.3 behavior are preserved unless a phase explicitly changes the execution context.
10. Every new path is validated with `realpath` and a workspace-root prefix check at both registration
    and launch. Build contexts additionally reject symlinks, `..`, and special files.
11. The coordinator `serveCommand` shutdown must not stop healthy agents. Only an explicit stop or the
    runner/supervisor `stop-all`/`reconcile` owns process termination.

## 2. Non-goals for this plan

- Multi-user/RBAC, Kubernetes, microVMs, GPU.
- Egress proxy/allowlist or metadata blocking (post-B2 hardening).
- Per-app code-server or per-app IDE images.
- Automatic builds on file edit.
- Shared mutable toolchain cache.
- Per-app `opencode` versions.
- Worktrees, multi-instance-per-app.
- A scoped IDE principal (later).
- Arbitrary app bases without the agent runtime (build validation rejects them).

## 3. Stage gate protocol

The order is load-bearing: the deployed image must match the commit that is pushed.

1. Run `npm run lint && npm run typecheck && npm test && npm run build`.
2. Run the stage's container/smoke/probe checks.
3. Make the **stage code commit** (code + tests + docs; no journal verification result yet).
4. Push to `origin/main`; wait for the Publish workflow; pin the `sha-<short>` tag.
5. Back up `state`, `workspace`, and `agents`; record the rollback image tag.
6. Deploy the pinned image:
   `git archive --format=tar HEAD | ssh deployment-host 'tar xf - -C <INSTALL_DIR>'`;
   `ssh deployment-host 'cd <INSTALL_DIR> && docker compose pull && docker compose up -d --remove-orphans'`.
7. Run health checks and stage probes.
8. Owner manually verifies the stage checklist.
9. Only after pass: write the journal and deploy log, then make a **docs-only record commit**. If the
   owner insists on a single commit, use the candidate-deploy alternative: deploy a working-tree
   archive + local image, verify, then commit/publish/deploy the exact commit.

If owner verification fails, fix with a new commit on top (never amend a pushed commit), redeploy, and
repeat. If a deploy is broken, roll back to the previous image and restore data only if required.

The stage code commit and the docs-only record commit are the only split; the code commit remains one
coherent stage change. This exception exists because the deploy record must contain the verified
result.

---

## 4. B0 - Split the coordinator from agents

**Goal:** coordinator secrets are no longer reachable from agent code; toolchains live in agent
images; the runtime client and single-app agent host are in place for B1.

**Boundaries:** one shared `agents` container; no per-app container/network isolation; B0 cross-app
access is accepted. No runner and no Docker socket.

### B0.0 Path confinement

Scope:

- Add a shared `resolveAppPath` used by registration, `appDir`, and launch.
- Reject `..`, symlink escapes, and absolute paths outside the workspace; allow an absolute path only
  if `realpath` is under the workspace root.
- Keep project-relative behavior for normal manifests.
- Update `docs/process.md` to allow the docs-only deploy-record commit for a stage (the code commit
  remains one coherent change).

Files: `src/http/apps.ts`, `src/http/handler.ts`, `src/registry/index.ts`, `src/config/load.ts`,
`src/opencode/manager.ts`, tests.

Acceptance: malicious `path: ../../..`, `/data/state`, and symlink escape are rejected at registration
and launch; existing relative apps register and launch.

Verification: `npx vitest run test/path-containment.test.ts test/registry.test.ts`.

### B0.1 Images, CI, publish

Scope:

- Dockerfile targets: `agent-base`, `agent-default`, `agent-ide`; keep `runtime` for the coordinator.
  `agent-base`: Node 22, `opencode`, `hanse-agent-host`, `hanse-agent-supervisor`, `hanse mcp` client,
  git, CA, curl, mise, OMO, codegraph. `agent-default`: Python 3.12, Node 22, PHP 8.3 (prebuilt, fixed
  extensions), `build-essential`, `pkg-config`, `uv`, common dev libraries/CLI clients.
  `agent-ide`: default + code-server, extension, `hanse-shell`.
- Update `.github/workflows/publish.yml` and `ci.yml` to build/publish all targets with the existing
  SHA/version tags; update `compose.build.yaml` targets.
- Keep the coordinator image unchanged in B0 (slim it later).

Acceptance: all targets build; agent-default has `opencode`, `mise`, `uv`, Python, Node, PHP, `cc`;
Go/Rust/Java install with mise as uid 1000 under a per-app/cache `MISE_DATA_DIR`; agent-ide starts
code-server.

Container smoke:

```bash
docker buildx build --target agent-default -t hanse-agent-default:test .
docker buildx build --target agent-ide -t hanse-agent-ide:test .
docker run --rm --user 1000:1000 -e MISE_DATA_DIR=/tmp/mise hanse-agent-default:test sh -lc \
  'set -e; opencode --version; python3 --version; node --version; php -m; cc --version | head -1; uv --version; \
   mkdir -p /tmp/proj; cd /tmp/proj; \
   printf "[tools]\ngo = \"1.23\"\nrust = \"stable\"\njava = \"21\"\n" > .mise.toml; \
   mise install; mise exec -- go version; mise exec -- rustc --version; mise exec -- java -version'
docker run --rm hanse-agent-ide:test code-server --version
```

### B0.2 State, HOME, migrations

Scope:

- New agents root `/data/agents/<projectId>/<appKey>/{home,data,state,config,cache,tmp,mise}`.
- Per-app HOME/XDG/TMPDIR; per-app OMO profile; per-app `MISE_DATA_DIR`; recompute permission roots.
- Coordinator writes auth and OMO before `ensure`; the MCP token file is added in B0.3 and the
  opencode password in B0.4/B0.5.
- Migration v4: `agent_tokens` table; `instances.spec_hash`, `instances.runtime_state`.
- Compose bind `${HANSE_AGENTS:-./agents}:/data/agents`; absolute `HANSE_HOST_AGENTS` reserved for B1.
- Reset old per-app sessions after backup.

Acceptance: no agent runtime state under `/data/state`; OMO/auth/codegraph per app; sessions survive
host/coordinator restart; old projects dir backed up and unused by agents.

Verification: `npx vitest run test/agents-env.test.ts test/omo-profile.test.ts test/migrations.test.ts`.

### B0.3 MCP over HTTP

Scope:

- `POST /internal/mcp` authenticated by a per-app token; `handleRpc` against a `CoordinatorService`
  bound to the token's project/app.
- Canonical token file `/data/agents/<projectId>/<appKey>/mcp-token` (0600); hash in `agent_tokens`;
  reuse on coordinator restart; hash mismatch/missing -> recreate; delete/revoke on stop.
- `hanse mcp` remote mode: stdio bridge to the coordinator; no `HANSE_DB`.
- Keep the four tool semantics and project scoping.

Acceptance: agent can call the four tools; no `HANSE_DB`; agent token gets `403` on operator routes and
other apps' MCP; coordinator restart keeps a healthy token; mismatch/missing recreates.

Verification: `npx vitest run test/mcp-http.test.ts test/agent-token.test.ts`.

### B0.4 Agent host and supervisor

Scope:

- `src/agent/protocol.ts`, `spec.ts`, `host.ts`, `supervisor.ts`.
- CLI `hanse agent-host`, `hanse agent-supervisor`.
- API paths: `POST /v1/apps/:appId/ensure`, `DELETE /v1/apps/:appId`, `GET /v1/apps/:appId`,
  `GET /v1/apps/:appId/logs`, `POST /v1/reconcile`.
- `AppRuntimeSpec`: `appId`, `image`, `pathMode`, `appDir`, `stateDir`, `networkName`, optional
  `port`, `env` (no provider keys), `resources`, `labels`, `specHash`.
- `specHash` = hash of stable config: image, paths, `OPENCODE_CONFIG_CONTENT`, model, OMO profile name,
  MCP URL, resources, labels. Ephemeral passwords/tokens are not in the hash.
- Runtime token `HANSE_RUNTIME_TOKEN` in `.env`; coordinator + supervisor. B0 accepts that agents in
  the same container can read the supervisor's `/proc/1/environ` and therefore the token; this is part
  of the accepted B0 supervisor-control surface (5.11). B1 moves the runner to the control network and
  the token never enters app containers.
- Supervisor binds the agents network only; health `/healthz`; version handshake; per-app port when
  omitted; captures logs.
- Agent host: per-app env, auth/OMO/password paths, `opencode serve`, `OPENCODE_SERVER_PASSWORD`,
  health/version, SIGTERM.
- Supervisor is reachable by agents in the same container; B0 accepts that (5.11).

Acceptance: start/stop one host without touching another; idempotent `ensure`; `delete` removes only
that host; `reconcile` stops unknown hosts; returned `{appId,endpoint,state,specHash,version}`;
unauthenticated runtime calls `401`; auth failures tested.

Verification: `npx vitest run test/agent-protocol.test.ts test/agent-supervisor.test.ts`.

### B0.5 Coordinator runtime client and manager switch

Scope:

- New shared `src/agent/client.ts` implementing the runtime API; `InstanceManager` accepts a
  `RuntimeClient`.
- B0 uses the supervisor client; B1 swaps the transport to the runner without changing the manager.
- Remove production `spawn("opencode")` from `manager.ts`/`launcher.ts`; keep a test injector only.
- `serveCommand` shutdown calls `manager.detach()` (do not stop healthy agents); explicit stop only
  through the API/supervisor.
- `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` are built by the coordinator and passed in
  the spec/paths; `src/opencode/client.ts` and chat SSE use Basic auth.
- `no-local-spawn` architectural test.

Acceptance: chat/restart/settings work through the supervisor client; coordinator shutdown leaves
agents running; coordinator restart reconnects; wrong opencode password gets `401`; no production
`spawn("opencode")`.

Verification: `npx vitest run test/runtime-client.test.ts test/manager.test.ts test/no-local-spawn.test.ts`.

### B0.6 Git workbench hardening

Scope:

- `GitService` runs with a controlled environment: `GIT_CONFIG_NOSYSTEM=1`, controlled
  HOME/`.gitconfig`, `GIT_TERMINAL_PROMPT=0`, scrubbed coordinator secrets.
- Force `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `credential.helper=`,
  `protocol.ext.allow=never`, `submodule.recurse=false`; controlled `core.sshCommand`/askpass.
- Credential contract: `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS`,
  `HANSE_GIT_ASKPASS`, `HANSE_GIT_TOKEN`; mount only `/run/hanse/git/*` read-only. If absent,
  fetch/push fails with a clear error; status/commit still work.
- Validate remotes: allow `https://`, `ssh://`, `git@host:path`; reject `ext::`, `file://` outside the
  app, and option-looking URLs.
- Keep human-only API and agent `403`.
- If a repo-controlled vector remains after tests, stop and escalate; do not silently expand B0 into
  B1.5.

Acceptance: malicious hooks/fsmonitor/sshCommand/credential helper/`ext::` cannot execute in the
coordinator's secret context; fetch/push work with configured credentials; commit/update work; agent
gets `403`.

Verification: `npx vitest run test/git-hardening.test.ts test/git-service.test.ts`; manual fetch/push
smoke against a fixture remote.

### B0.7 IDE on agent-ide

Scope:

- `ide` service uses `hanse-agent-ide`; workspace only; no state.
- Operator token remains in the coordinator and IDE only; agents never receive it.
- `hanse-shell`: controlled HOME, `bash --norc --noprofile`, `cd` to the opened folder, stable
  `MISE_DATA_DIR`/PATH.
- Code-server settings: workspace trust enabled + folder untrusted; `task.autoDetect` off;
  `extensions.autoCheckUpdates`/`autoUpdate` off; no workspace auto-run.
- Agents are not on the front network.

Acceptance: IDE terminal sees Python/Node/PHP; a malicious `.bashrc`/`.vscode/tasks.json` does not
execute; `/ide/` proxy and extension work; agents cannot reach the IDE container.

Verification: `npx vitest run test/hanse-shell.test.ts`; manual IDE smoke.

### B0.8 Compose, deployment, backup, health

Scope:

- `compose.yaml` B0: `hanse`, `ide` (agent-ide), `agents` (agent-default); bind
  `${HANSE_AGENTS:-./agents}:/data/agents`; agent network; no socket.
- `agents` service hardening: `user 1000:1000`, `security_opt no-new-privileges`, `cap_drop: ALL`,
  `read_only: true`, tmpfs `/tmp`,`/run`, volumes workspace + agents, no state/socket/host network.
- `.env.example`: `HANSE_AGENT_TAG` (defaults to `HANSE_TAG`), `HANSE_AGENTS`, `HANSE_HOST_AGENTS`
  (absolute, B1), `HANSE_HOST_WORKSPACE` (absolute, B1), `HANSE_RUNTIME_TOKEN`.
- `compose.host-auth.yaml` shape unchanged; do not mount host auth into agents.
- Agents health endpoint (`/healthz`), logs; backup includes `agents`; `hanse down` skeleton.
- Docs: deployment, current-state, conventions, deploy runbook.

Acceptance: `docker compose config` valid; `pull && up -d` starts three healthy services; chat and
IDE proxy work; backup/restore includes agents; agents container has no socket/state and is hardened.

Verification: `docker compose config`; `scripts/agent-runtime-probe.sh b0`; deploy smoke on `deployment-host`.

### B0.9 B0 tests and security probes

Scope: the new probe script `scripts/agent-runtime-probe.sh` (tracked; not `docs/deploy`, which is
local-only) plus unit/integration tests.

Acceptance:

- From an agent shell/probe: `/data/state` absent, `secret.key`/`coordinator.db` unreadable, no
  `HANSE_OPERATOR_TOKEN`/`HANSE_DB` in `/proc/1/environ` visible to agents. B0 accepts
  runtime-token/supervisor exposure (5.11); B1.7 verifies the runtime token is absent from app
  containers.
- MCP token scope; runtime-token `401`; opencode password `401`; operator-route `403` matrix.
- Malicious git and IDE `.bashrc` tests pass.
- Toolchain smoke: Node, Python (`uv`), PHP (`php -m` + framework boot), Go build, Rust compile/link,
  Java; all as uid 1000.
- Existing test suite and chat/SSE/handoff/settings/git/IDE smoke pass.

Verification: global gates + `npx vitest run test/path-containment.test.ts test/agent-protocol.test.ts
test/runtime-client.test.ts test/mcp-http.test.ts test/agent-token.test.ts test/agents-env.test.ts
test/omo-profile.test.ts test/migrations.test.ts test/git-hardening.test.ts test/hanse-shell.test.ts`
+ `scripts/agent-runtime-probe.sh b0`.

### B0.10 Deploy and owner gate

Deploy per §3. Owner checklist:

- Sign in; projects/apps load; chat streams.
- Ask the agent to run `ls /data/state` and confirm absence.
- Run `python3 --version`, `node --version`, `php -m`, `uv --version`, `mise install go@1.23 &&
  go version`.
- IDE terminal: same toolchains; malicious `.bashrc` not sourced.
- Git status/commit/fetch/push with configured credentials.
- Handoff approve/reject; agent `403` on a human-only route.
- Restart coordinator; sessions and MCP still work.

Gate: owner approval. No B1 work before it.

---

## 5. B1 - One container per application

**Goal:** each app has its own container, network, app-dir mount, state, limits, and status; the
runner replaces the B0 supervisor behind the same runtime client.

**Boundaries:** images are still `agent-default`; no per-app Dockerfile yet; git moves to a no-secret
context.

### B1.1 Runner service and APIs

Scope:

- `src/runner/{server,validate,docker,paths,git}.ts`; image target `runner`; compose service.
- Docker Engine client over the rootful socket using a small `node:http` SocketPath client (no new
  runtime dependency); no `/data/state`; runtime token; internal control network.
- Validate `AppRuntimeSpec`: image allowlist, `realpath` under `HANSE_HOST_WORKSPACE`/
  `HANSE_HOST_AGENTS`, fixed user/entrypoint/caps/network/limits; fail closed if env missing.
- APIs: `ensure`, `delete`, `status`, `logs`, `reconcile`, `stop-all`, `exec` (B1.4),
  `git` (`POST /v1/apps/:appId/git` with a fixed operation enum and validated args for B1.5),
  `images/build` (B2 only).
- Git execution: one-shot git container from the app image, only the app dir and
  `/run/hanse/git` read-only mounted; no network for local operations, app network only for
  fetch/push; credentials come from the runner's `HANSE_GIT_*` env, never the app container. The app
  image must contain git; B2.4 validates it.
- Labels `hanse.managed=true`, project/app/image/spec-hash; idempotent ensure; restart reconcile.
- Update `compose.build.yaml`/publish for the runner image.

Acceptance: runner rejects traversal, arbitrary images, privileged/host-network/socket mounts, and
`/data/state`; unauthenticated runtime calls `401`; `ensure` returns endpoint; `delete` keeps
`/data/agents`; `stop-all`/`reconcile([])` stops managed containers; the git endpoint rejects unknown
operations/args and fails clearly without credentials; runner restart reconciles; coordinator restart
reattaches networks.

Verification: `npx vitest run test/runner-validate.test.ts test/runner-client.test.ts
test/runner-git.test.ts`.

### B1.2 Per-app containers, networks, mounts, limits

Scope:

- One bridge network per app; coordinator alias `hanse`; app alias `app-<id>`.
- Host source mapped to the container path `/data/workspace/<project>/<app>`; only the app dir + its
  `/data/agents/<project>/<app>` are mounted. No project root/workspace root/state/socket.
- `opencode serve --hostname 0.0.0.0 --port 4100`; `OPENCODE_SERVER_PASSWORD`.
- Read-only root + tmpfs `/tmp`,`/run`; resource defaults `HANSE_APP_MEMORY_MB=2048`,
  `HANSE_APP_CPUS=2`, `HANSE_APP_PIDS=512`; restart `unless-stopped`; log rotation; health
  `/global/health` with a timeout.
- Isolation probe: A cannot read B's files/state/auth/token or reach B's opencode/MCP.

Acceptance: two apps isolated; limits enforced; logs/health/status available; restart policy works;
no `/data/state`/socket.

Verification: `npx vitest run test/runner-containers.test.ts`; `scripts/agent-runtime-probe.sh b1`.

### B1.3 Client transport swap, migration v5, status UI/API

Scope:

- Manager already uses `RuntimeClient`; swap B0 supervisor transport to the runner; no new spawn path.
- Migration v5: `instances.container_id`, `instances.container_name`; do not duplicate
  `runtime_state`.
- Human-only `GET /api/apps/:app/runtime` and app-page status for
  `stopped/starting/running/error`; logs link/terminal.
- Coordinator restart/detach behavior from B0 preserved.

Acceptance: chat/restart/settings/app deletion work through the runner; status visible; no production
spawn; migration fresh/upgrade tests.

Verification: `npx vitest run test/runtime-manager.test.ts test/manager.test.ts
test/migrations.test.ts`.

### B1.4 Operator terminal exec

Scope: runner `POST /v1/apps/:appId/exec` with PTY/WebSocket; only managed app containers;
operator-only; coordinator route/UI; closing the terminal does not kill the app.

Acceptance: operator terminal in a special app container; agent cannot call the runner/terminal;
terminal resizing/close works.

Verification: `npx vitest run test/runner-exec.test.ts`; manual terminal smoke.

### B1.5 Git in a no-secret context

Scope:

- Use the runner `POST /v1/apps/:appId/git` from B1.1; fixed operations `status/fetch/update/switch/
  commit/push`, validated args, one-shot git container, app dir + `/run/hanse/git` only.
- Credentials `HANSE_GIT_*` live in the runner and `/run/hanse/git`; they are never in the app
  container. Local operations use `--network none`; fetch/push uses the app network. No repo-controlled
  hooks/fsmonitor/sshCommand/credential helpers.
- Coordinator keeps the UI/API; GitService becomes a runtime client.

Acceptance: status/commit/update/fetch/push work; the app container has no `HANSE_GIT_*`; malicious
hooks in app A cannot reach coordinator secrets; agent principals still `403`; fetch/push without
credentials fails clearly.

Verification: `npx vitest run test/git-sandbox.test.ts`; manual fixture fetch/push.

### B1.6 Cleanup, reconcile, backup

Scope:

- `hanse down`/wrapper calls `stop-all`, then `compose down`.
- Runner startup reconcile removes unknown managed containers/networks; coordinator restart reattaches.
- Backup stops apps first, includes `agents`; app images not backed up; log/network cleanup.
- Disk/GC labels and retention groundwork.

Acceptance: `hanse down` leaves no app containers/networks; `up --remove-orphans` does not kill apps;
host reboot reconciles; backup/restore smoke.

Verification: `npx vitest run test/runner-cleanup.test.ts`; manual on `deployment-host`.

### B1.7 B1 probes

Acceptance: no cross-app fs/network/auth/token; no coordinator state/socket in apps; runtime token
absent from app containers; terminal scoped; chat/SSE, questions/permissions, handoffs, settings, git,
IDE pass; limits/logs verified.

Verification: `scripts/agent-runtime-probe.sh b1`; global gates; regression suite.

### B1.8 Deploy and owner gate

Deploy per §3; remove the B0 `agents` service via Compose update. Owner checklist:

- Two apps; A cannot read B's files/state; A cannot reach B's chat/terminal.
- App terminal works; agent cannot open one.
- Restart app/runner/coordinator; sessions survive; reconcile.
- `hanse down` removes apps; `up` restores.
- Git fetch/push works; malicious hook test passes.

Gate: owner approval. No B2 before it.

---

## 6. B2 - Per-app images

**Goal:** apps can declare a full `.hanse/Dockerfile`; the coordinator builds at runtime on a human
action, validates the image, and runs it with the same envelope. Status/logs are in the Web UI.

**Boundaries:** human-triggered builds; no deploy-time build; no auto-build on file edit; app code
mounted, not baked.

### B2.1 Build schema, registry, migration v6

Scope:

- `.hanse/app.yaml` `build.dockerfile` (full Dockerfile); registry reads `app.yaml` in production.
- `appKey` remains `path.basename(entry.path)`; invalid app.yaml marks the app `error` and does not
  build.
- Dockerfile path under the app dir, `realpath`; no symlink escape.
- Build `specHash` = Dockerfile content + default digest + build args.
- Migration v6: app `image_ref`, `image_status`, `image_hash`, `image_base_digest`, `image_built_at`,
  `image_error`.
- Labels: `hanse.app.id`, `hanse.image.version`, `hanse.base.digest`, `hanse.default.digest`.

Acceptance: full Dockerfile with `ARG HANSE_BASE`/`FROM ${HANSE_BASE}` builds; no build uses default;
path escape rejected; `specHash` stable across app-code-only changes; fresh/upgrade migrations.

Verification: `npx vitest run test/app-build-schema.test.ts test/build-spec.test.ts
test/migrations.test.ts`.

### B2.2 Runner build endpoint and tar containment

Scope:

- `POST /v1/images/build` returns `{buildId,status}`; `GET /v1/images/:appId` returns the current
  image/status; `GET /v1/images/builds/:buildId` returns status + log tail. Runtime-token auth;
  workspace read-only; tar app dir; BuildKit via Engine API; pass `HANSE_BASE`.
- Tar containment: no-follow/realpath, reject symlinks/`..`/special files; exclude `.git`, state,
  agents, caches; never include `/data/state`.
- Build status `building/ready/error`; log tail; serialized/bounded concurrency; resource limits.
- No secrets, no host socket in build, no privileged.

Acceptance: extra OS package builds; symlink/escape rejected; build failure keeps old image/container;
runner never reads `/data/state`; malicious-symlink test.

Verification: `npx vitest run test/runner-build.test.ts test/build-context.test.ts`; container smoke.

### B2.3 Coordinator build route, UI statuses, stale detection

Scope:

- Human-only `POST /api/apps/:app/build`, `GET /api/apps/:app/image`, `GET /api/apps/:app/image/logs`;
  CLI `hanse images build`. The coordinator stores `buildId`, status and log tail (bounded) and proxies
  the runner's image/build endpoints.
- App page: image status (`missing/building/ready/stale/error`), runtime status, logs, retry, rebuild.
- On add app with Dockerfile: mark `missing`; human action builds.
- Agent edits Dockerfile: mark `stale`; never auto-build; old container stays on the last `ready`
  image.
- Base/default digest change: mark `stale`.

Acceptance: add -> build -> start -> chat; rebuild keeps old until ready; agent edit -> `stale`; build
failure -> `error`, logs, app start refused; no auto-build.

Verification: `npx vitest run test/app-image-api.test.ts`; manual UI smoke.

### B2.4 Image compatibility validation (sandboxed)

Scope:

- After build, inspect the image and run a one-shot validation:
  `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--user 1000:1000`, memory/PID limits, tmpfs only, no mounts, timeout, fixed entrypoint.
- Check `/usr/local/bin/hanse-agent-entrypoint`, `opencode`, `hanse-agent-host`, MCP bridge, and
  `git --version`; reject `USER`/`ENTRYPOINT`/`CMD`/`VOLUME` that cannot be overridden.
- Incompatible image -> `error`; agent deployment refused; no untrusted network.

Acceptance: incompatible base rejected; valid image with extra packages passes; malicious image
cannot use network/mounts; old container stays.

Verification: `npx vitest run test/image-validation.test.ts`; manual incompatible fixture.

### B2.5 Lifecycle, rollback, GC

Scope:

- Keep two versions per app; rollback switches `image_ref` and restarts; current/rollback/running
  images are never pruned.
- GC at 85% disk; build cache prune; labels; deploy health warns/fails above threshold.
- Failed build keeps old image/container.

Acceptance: stale/rebuild; rollback; GC safety; disk report; layer sharing evidence
(`docker system df`).

Verification: `npx vitest run test/image-lifecycle.test.ts`; `docker system df`; manual rollback.

### B2.6 B2 probes

Acceptance: extra OS package; incompatible image; broken Dockerfile; stale after base update; rebuild;
rollback; layer sharing; build logs/status in UI.

Verification: `scripts/agent-runtime-probe.sh b2`; global gates; manual UI.

### B2.7 Deploy and owner gate

Deploy per §3; no app build in deploy. Owner checklist:

- Add app with `.hanse/Dockerfile`; `missing -> building -> ready`; start chat.
- Rebuild; old container stays until ready.
- Agent edits Dockerfile -> `stale`; no build; rebuild.
- Incompatible base -> `error`, refused start.
- Roll back image; check disk/layer sharing.

Gate: owner approval. B2 ends this plan; egress proxy is post-B2.

---

## 7. Verification matrix

| Phase | Command |
| --- | --- |
| B0.0 | `npx vitest run test/path-containment.test.ts test/registry.test.ts` |
| B0.1 | the Docker build/run smoke in B0.1 |
| B0.2 | `npx vitest run test/agents-env.test.ts test/omo-profile.test.ts test/migrations.test.ts` |
| B0.3 | `npx vitest run test/mcp-http.test.ts test/agent-token.test.ts` |
| B0.4 | `npx vitest run test/agent-protocol.test.ts test/agent-supervisor.test.ts` |
| B0.5 | `npx vitest run test/runtime-client.test.ts test/manager.test.ts test/no-local-spawn.test.ts` |
| B0.6 | `npx vitest run test/git-hardening.test.ts test/git-service.test.ts` |
| B0.7 | `npx vitest run test/hanse-shell.test.ts`; manual IDE smoke |
| B0.8 | `docker compose config`; `scripts/agent-runtime-probe.sh b0` |
| B0.9 | all B0 unit tests + `scripts/agent-runtime-probe.sh b0` |
| B1.1 | `npx vitest run test/runner-validate.test.ts test/runner-client.test.ts test/runner-git.test.ts` |
| B1.2 | `npx vitest run test/runner-containers.test.ts`; `scripts/agent-runtime-probe.sh b1` |
| B1.3 | `npx vitest run test/runtime-manager.test.ts test/manager.test.ts test/migrations.test.ts` |
| B1.4 | `npx vitest run test/runner-exec.test.ts`; manual terminal smoke |
| B1.5 | `npx vitest run test/git-sandbox.test.ts`; fixture fetch/push |
| B1.6 | `npx vitest run test/runner-cleanup.test.ts`; manual cleanup/backup |
| B1.7 | `scripts/agent-runtime-probe.sh b1`; global gates |
| B2.1 | `npx vitest run test/app-build-schema.test.ts test/build-spec.test.ts test/migrations.test.ts` |
| B2.2 | `npx vitest run test/runner-build.test.ts test/build-context.test.ts` |
| B2.3 | `npx vitest run test/app-image-api.test.ts`; manual UI |
| B2.4 | `npx vitest run test/image-validation.test.ts`; incompatible fixture |
| B2.5 | `npx vitest run test/image-lifecycle.test.ts`; `docker system df` |
| B2.6 | `scripts/agent-runtime-probe.sh b2`; global gates |

Every stage also runs `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Docker smokes
are not part of `npm test`.

## 8. Files and modules

| Area | Files |
| --- | --- |
| Path containment | `src/http/apps.ts`, `src/http/handler.ts`, `src/registry/index.ts`, `src/config/load.ts`, `src/opencode/manager.ts` |
| Agent runtime | `src/agent/{protocol,spec,host,supervisor,client}.ts`; CLI commands |
| Runner | `src/runner/{server,validate,docker,paths,git}.ts`; runner image target |
| MCP | `src/mcp/http.ts` (or `src/http/internal-mcp.ts`), `src/mcp/client.ts`, `src/mcp/server.ts` |
| State/settings | `src/opencode/{instance,launcher,manager,omo-profile,policy}.ts`, `src/runtime/paths.ts` |
| Git | `src/git/service.ts`, `src/http/git.ts` (if needed), credential env contract |
| IDE | `shell/hanse-shell`, code-server settings, `extensions/hanse-agent` if needed |
| Images/CI | `Dockerfile`, `.github/workflows/{ci,publish}.yml`, `compose.yaml`, `compose.build.yaml`, `compose.host-auth.yaml` |
| Store | `src/store/migrations.ts` v4/v5/v6 |
| HTTP/UI | app image/runtime status, build/rebuild/logs, terminal route, human-only guards |
| Tests/probes | `test/*.test.ts`, `scripts/agent-runtime-probe.sh` |
| Docs | `docs/deployment.md`, `docs/current-state.md`, `docs/conventions.md`, `docs/deploy/host.md`, journal |

## 9. Deployment and runbook changes

- `docs/deployment.md`: B0/B1/B2 topology, `agents` bind, runner, image tags, runtime build status,
  `hanse down`, backup, disk/GC, rollback, rootful broker.
- `docs/current-state.md`: replace the same-uid limitation with the staged boundary and B0/B1/B2
  status; keep residual risks.
- `docs/conventions.md`: `.hanse/Dockerfile` full Dockerfile, `ARG HANSE_BASE`,
  `build.dockerfile`.
- `docs/deploy/host.md`: new images, pull, `agents` bind, runner, `hanse down`, health, build status,
  rollback.
- `docs/journal/0011-agent-runtime.md`: record after B2; update index.
- `docs/plans/README.md`, `docs/design/README.md`, `docs/journal/README.md`: index updates.

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| B0 cross-app access | Explicit limitation; B1 next; owner accepted. |
| Runner root-equivalent (rootful broker) | Narrow API, control network only, no state, no app network; rootless later. |
| Git hardening incomplete | Malicious repo tests; B1 no-secret context; B0 gate fails/escalates if a vector remains. |
| Agent-writable Dockerfile | Human-triggered build only; build validation; runtime envelope; no secrets/socket in build. |
| Incompatible image | Sandboxed validation; status `error`; old container stays. |
| Disk growth | 2 versions, GC 85%, cache exclusion, `docker system df` check. |
| Per-app overhead | Shared image layers; thin writable layer; lazy start/pre-pull; B0 fallback if needed. |
| Egress open | Post-B2 hardening; residual exfiltration risk documented. |
| State reset | Backup before B0; rollback requires restoring the pre-B0 state. |
| MCP/opencode token loss | Token/password files + hash verification; recreate on mismatch; restart test. |
| Deploy order | Stage commit -> push/publish -> deploy -> verify -> docs-only record; candidate-deploy alternative if one commit is required. |

## 11. Out of scope

- Post-B2 egress proxy/allowlist and metadata/link-local blocking.
- Multi-user/RBAC, Kubernetes, microVMs, GPU.
- Per-app code-server, scoped IDE principal.
- Automatic builds on file edit.
- Shared mutable toolchain cache.
- Per-app opencode versions.
- Worktrees, multi-instance-per-app.

## 12. Review

Plan review: `momus`, 2026-10-20, **PASS WITH REQUIRED CHANGES**. Findings folded:

- B0 runtime client/manager switch added as B0.5; B1.3 only swaps transport; no-spawn acceptance moved
  to B0; shutdown detach semantics added.
- Gate order fixed (stage commit -> push/publish -> deploy -> verify -> docs-only record); candidate
  deploy alternative documented.
- B1.5 git execution now uses the runner `POST /v1/apps/:appId/git` endpoint from B1.1; B2.2 tar
  containment and B2.4 sandboxed validation added.
- Agents bind `${HANSE_AGENTS:-./agents}` + absolute host paths; B0 Compose hardening added.
- Runtime env/auth contract (`OPENCODE_CONFIG_CONTENT`, `OPENCODE_SERVER_PASSWORD`, Basic auth) and
  `HANSE_RUNTIME_TOKEN` added with tests.
- Migrations v4/v5/v6 split; specHash/API paths/token path canonicalized.
- Per-phase verification commands added; CI/publish/compose.build targets added; B1 status/restart/
  stop-all and B2 build status/stale/GC added.
- Git credential contract, IDE operator-token wording, mise smoke, operator-only route matrix fixed.

Re-review 1 (momus, 2026-10-20): **PASS WITH REQUIRED CHANGES.** Remaining changes folded:
`docs/process.md` now allows the docs-only deploy-record commit; B0 runtime-token/supervisor exposure
is explicit and removed from the B0 probe; B1 uses a one-shot git container with runner-held
credentials; B0.1 builds `agent-ide` before the smoke; B2.2/B2.3 define runner image status/log
endpoints. Final review (momus, 2026-10-20): **PASS.** Plan gate cleared; decision-complete. Implementation
starts with B0.0 (path confinement) and proceeds phase by phase; each stage deploys to `deployment-host` and
waits for owner manual verification before the next stage.

## 13. References

- [`docs/design/agent-runtime.md`](../design/agent-runtime.md)
- [`docs/open-questions.md`](../open-questions.md)
- [`docs/current-state.md`](../current-state.md)
- [`docs/deployment.md`](../deployment.md)
- [`docs/conventions.md`](../conventions.md)
- [`docs/process.md`](../process.md)
