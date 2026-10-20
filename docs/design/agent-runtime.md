# Design - Agent runtime isolation and per-app toolchains

Status: **proposed, revised after design review** (2026-10-20). This document is the design contract
a plan can be written from. It does not authorize implementation until the design review, owner
questions, and plan review gates are closed (see [`docs/process.md`](../process.md)).

Scope: the runtime topology that hosts managed `opencode` agents, the image layers that provide
toolchains, the per-app container runtime, the app image build path, and the deployment/operations
changes those require.

Out of scope: application feature code, chat UI changes unrelated to runtime status, multi-user
support, Kubernetes, microVMs, and implementation detail that belongs in the plan.

Project profile bindings (phase 0 of `feature-delivery`):

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` |
| Plan reviewer | `momus` |
| Design docs | `docs/design/`, index `docs/design/README.md` |
| Plans | `docs/plans/`, index `docs/plans/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Stage journal | `docs/journal/`, index `docs/journal/README.md` |
| Open questions | this document, then the plan and `docs/open-questions.md` while open |
| Language | English |
| Verification | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` |
| Commit policy | one stage, one coherent commit; owner authorizes; Conventional Commits |

---

## 1. Summary

Hanse currently runs the coordinator and every managed `opencode` agent in one container, under one
uid, with one `PATH`, one `HOME`, and one filesystem view. The agents can read `/data/state`
(`coordinator.db`, `secret.key`, per-instance auth), the coordinator's `/proc/<pid>/environ`, and the
unauthenticated loopback `opencode serve` API. The image contains no Python, PHP, Go, Rust, Java, or
build toolchain beyond Node and git, so adding a language means rebuilding the shared image for every
application.

This design separates three concerns that are currently coupled:

1. **Secrets and agent work.** The coordinator keeps `/data/state`; agents live in their own
   container(s) without it.
2. **Environment and application code.** Toolchains live in layered agent images; application code
   stays in the mounted workspace and is never baked into an image.
3. **Runtime shape and image shape.** Per-app containers are introduced before per-app images, so the
   hard supervisor/MCP/state migration is validated before a build system is added.

The target is **B2**: one container per application, from a default toolchain image, optionally
extended by a `.hanse/Dockerfile` fragment. Delivery is staged as **B0 -> B1 -> B2**. Each stage is
independently deployable, is deployed to `deployment-host`, and ends with an owner manual-verification gate
before the next stage starts.

**B0 is not "B1 with one container instead of N" in the cheap sense.** B0 must implement the same
agent-runtime API and the same single-app agent host as B1; only the implementation behind that API
changes from an in-container supervisor to the runner. That contract is R18 and is the main defense
against B1 rework.

---

## 2. Current behavior and root causes

### 2.1 Runtime topology

- `compose.yaml` defines two services from one published image: `hanse` (coordinator) and `ide`
  (code-server). Both run as uid/gid `1000` (`coder`) with `no-new-privileges`.
- `hanse` mounts `./workspace:/data/workspace`, `./state:/data/state`, and optionally the host
  `auth.json`. `ide` mounts only the workspace.
- The coordinator spawns one `opencode serve` child per `(project, app)` in
  `src/opencode/launcher.ts:146-195`, with `cwd=appDir`, a per-instance XDG/DB/TMPDIR environment,
  `OPENCODE_CONFIG_CONTENT`, and a loopback port allocated from `4100+`
  (`src/opencode/manager.ts:72-73, 204-305`).
- Per-app runtime state lives **inside the coordinator state directory**:
  `coordinatorStateDir(stateHome)/projects/<projectId>/apps/<appKey>` (`src/runtime/paths.ts:19-22`,
  `src/opencode/instance.ts:76-96`). That is `/data/state/hanse/projects/...` in production, next to
  `coordinator.db` and `secret.key`.
- The coordinator MCP server is a child of `opencode` and opens the coordinator database directly
  from `HANSE_DB` (`src/cli/commands.ts:327-340`, `src/mcp/server.ts:6`). It trusts
  `HANSE_PROJECT_ID`/`HANSE_APP_KEY` from its environment.
- The OMO profile store rewrites one shared file, `~/.omo/omo.jsonc`
  (`src/opencode/omo-profile.ts:171-239`, `src/cli/commands.ts:215-217`).

### 2.2 Known limitations this design addresses

`docs/current-state.md:354-386` already records the security boundary:

- agents run as the same uid as the coordinator and can read `/data/state`, `secret.key`, the DB, and
  `/proc/<pid>/environ`;
- the permission overlay is a guardrail, not a sandbox;
- the OMO config/state and `~/.codegraph` are shared by all instances;
- provider keys are encrypted at rest, but agents can read the per-instance `auth.json` and the DB.

The design treats these as the primary problem. Toolchains are the second problem; adding them to the
current container would widen the first.

### 2.3 Toolchain facts

Verified in `node:22-bookworm-slim` as uid 1000 without sudo:

- `mise` installs Python/Node/Go/Java/uv without root; PHP default (`vfox:jdx/vfox-php`) fails without
  `autoconf`/build deps; the prebuilt `github:adwinying/php@8.3` works with a fixed extension set;
  Rust installs but cannot link without `cc`.
- `bash -lc` does not read `.bashrc`; shims must be on `PATH` at process start or the process must use
  `mise exec --`.
- Nix single-user works only with a pre-created writable `/nix`; `nix-portable` fails in default Docker
  (`private mount namespace: Operation not permitted`).
- Devbox's installer requires sudo; asdf Python/PHP fail on build deps.

These facts inform the image layer and `agent-host` design; they do not require reproducing the full
experiment in this document.

### 2.4 Current schema facts

- `.hanse/app.yaml` (`src/schema/app.ts:4-15`) has `name`, `kind`, `contract`, `ports`, `setup`. It is
  **not read in production**: `loadAppConfig()` (`src/config/load.ts:106-123`) has no `src/` callers;
  `registerProject()` derives `appKey` from `path.basename(entry.path)` and hardcodes
  `contract: "AGENTS.md"` (`src/registry/index.ts:67-80`).
- `project.shared` (`src/schema/project.ts:24`) is inert; `appDir()` accepts absolute paths and joins
  relative paths without a traversal check (`src/http/apps.ts:31-35`).
- The `apps` table has only `id, project_id, app_key, path, kind, contract, created_at`
  (`src/store/migrations.ts:21-30`).

The design must therefore add a real app-environment declaration and close the path-confinement hole
before per-app containers can be safe.

---

## 3. Requirements

Every requirement has an ID; the plan and acceptance criteria trace back to these.

| ID | Requirement |
| --- | --- |
| R1 | Agents can use per-project toolchains for Python, Node.js, PHP, Go, Rust, and Java; a project can pin a version without rebuilding the coordinator image. |
| R2 | Images are layered: coordinator, agent base, agent default, agent IDE, and optional per-app image. Application images inherit the agent runtime and cannot silently lose `opencode`, the agent host, or MCP. |
| R3 | In every stage, agents cannot read the coordinator's `/data/state` (`coordinator.db`, `secret.key`, operator token) or the coordinator's `/proc/<pid>/environ`. In B1/B2 they also cannot read another app's auth, MCP token, or state. B0's cross-app exposure is explicit in 5.11. |
| R4 | In B1/B2, each application has its own container, network namespace, workspace mount, state volume, and resource limits; application A cannot read application B's files or reach its `opencode`/MCP endpoint. |
| R5 | The coordinator MCP server is reachable over an authenticated HTTP endpoint with a per-app token; it does not require `HANSE_DB` or direct SQLite access from the agent container. The token survives a coordinator restart without recreating a healthy agent. |
| R6 | Per-app runtime state and `HOME` live under `/data/agents/<projectId>/<appKey>`; OMO profiles, provider auth, caches, and `~/.codegraph` are per app. Sessions survive container and coordinator restarts. |
| R7 | Deployment remains pull-only for the control plane and static images: the user still runs `git archive`, `docker compose pull`, and `docker compose up -d`. In B2, per-app images are built at runtime by the coordinator on a human action (add app or explicit rebuild), with status and logs in the Web UI; deploy does not build app layers. |
| R8 | `.hanse/Dockerfile` (app directory) is a complete Dockerfile for the app environment, so normal Dockerfile linting works. It should use the pinned `ARG HANSE_BASE`/`FROM ${HANSE_BASE}` pattern; if the built image lacks the agent runtime, the build is marked incompatible and agent deployment fails with a clear error. |
| R9 | App-image builds run only on explicit operator action (add app or rebuild), never automatically when an agent edits a file. The coordinator triggers the runner; the runner is the only socket holder and build executor. Builds receive no secrets, no host socket inside the build, and no privileged mode; status/logs are visible in the Web UI. |
| R10 | The IDE terminal sees the default toolchains (`agent-ide` image). An application with a special image can be reached through an operator-only terminal exec into its container; per-app code-server is not the default. |
| R11 | In B1/B2, a narrow runner owns the container-runtime socket (or the same rootless daemon used by the control plane). It validates every container and build spec: image allowlist, mount roots, user, capabilities, network, and limits. The coordinator never holds the socket. |
| R12 | Instances start lazily on first chat, stop on app deletion or explicit action, recreate on image/spec/settings change, and report status (`stopped`, `starting`, `running`, `error`, `image_missing`, `image_building`, `image_stale`). An in-flight turn is interrupted by a restart and the UI says so. |
| R13 | Operations cover backup (`workspace`, `state`, `agents`), `down` cleanup of dynamic containers, health checks, logs, disk/GC, and per-app image rollback. |
| R14 | Runtime invariants are enforced regardless of what the app image declares: fixed user, fixed entrypoint, `cap_drop: ALL`, `no-new-privileges`, read-only root with writable per-app volumes/tmpfs, no privileged, no host network, no Docker socket, no `/data/state`. |
| R15 | Existing behavior is preserved: chat/SSE, questions/permissions, handoffs, git workbench, settings/restart, IDE proxy, and `opencode` 1.19.3 compatibility. Agent host and coordinator versions handshake. |
| R16 | B0, B1, and B2 are independently deployable. After each stage: gates pass, deploy to `deployment-host`, agent-run checks, then owner manual verification. The next stage starts only on owner approval. |
| R17 | Repository-controlled git execution never runs with coordinator secrets. B0 hardens in place and proves it; B1 moves app-repo git to a no-secret context. |
| R18 | B0 exposes the same agent-runtime API as B1 (`ensure/delete/status/logs/reconcile`); the coordinator client is identical. Only the implementation changes from an in-container supervisor to the runner. |
| R19 | Built app images are validated: the entrypoint, `opencode`, `agent-host`, and MCP bridge exist and their versions match the labels. A Dockerfile that produces an incompatible image is marked `error` and agent deployment is refused; image `USER`, `ENTRYPOINT`, `CMD`, and `VOLUME` declarations are overridden or rejected. |
| R20 | The IDE does not expose the operator token to agent-controlled startup or auto-run paths: controlled `HOME`, `bash --norc --noprofile`, a restricted/untrusted workspace, no task auto-detection or automatic extension activation, and no agents on the front network. The IDE remains operator-trusted; the operator can still run repository code. A scoped IDE principal is a later alternative. |

---

## 4. Decision

Adopt the following target and delivery shape.

**Target (B2):**

- One coordinator container (`hanse`) with `/data/state` and the HTTP API.
- One IDE container (`ide`) from an `agent-ide` image: code-server plus default toolchains, workspace
  only.
- One narrow runner container (`runner`) with the container-runtime socket (or the same rootless
  daemon), no state, internal control network. It also executes app-image builds.
- One dynamic container per application, from `hanse-agent-default` or a per-app image, with its own
  network, app-directory mount, `/data/agents/<app>` mount, and resource limits.
- Static images published to GHCR; per-app layers built on `deployment-host` at deploy time or on explicit
  operator action.

**Delivery:**

| Stage | Runtime shape | Images | New infrastructure | Exit gate |
| --- | --- | --- | --- | --- |
| **B0** | Coordinator + **one shared agents container** (N single-app agent hosts) + IDE | `coordinator`, `agent-base`, `agent-default`, `agent-ide` | `agents` service, `hanse-agent-supervisor`, agent host, MCP HTTP, `/data/agents`, git hardening, safe IDE shell | Agent cannot read coordinator state; toolchain smoke; git-hook test; IDE shell test; deploy on `deployment-host`; owner check |
| **B1** | Coordinator + **one container per app** + IDE | same as B0 | `runner` implementing the same runtime API, per-app networks/mounts/limits, terminal exec, git no-secret context | Two apps isolated (fs/network); resources; restart/logs/terminal; git hook cannot reach coordinator; deploy; owner check |
| **B2** | B1 + **per-app images** | + per-app `hanse-app-*` | runtime build + status UI, full Dockerfile schema/DB, GC/rollback | App with extra OS package; incompatible image rejected; failed build keeps old; stale/rebuild; rollback; deploy; owner check |

B0 is not a throwaway. It is B1 with one container instead of N: the agent host is single-app from day
one, the runtime API is the same (R18), and the images, MCP, state, and IDE work carry forward. Its
limitations are explicit in 5.11.

---

## 5. Target architecture

### 5.1 Containers and networks

```
deployment-host Docker daemon
├── compose project "hanse"
│   ├── hanse          coordinator, /data/state, :8787 published
│   ├── ide            agent-ide, workspace only, internal :8080
│   └── runner         narrow container + build API, internal only (B1/B2)
├── dynamic containers (B1/B2)
│   ├── hanse-app-<project>-<app>   :4100 internal
│   └── ...
└── networks
    ├── front     hanse, ide
    ├── control   hanse, runner
    └── app-<id>  hanse, app container
```

- Per-app containers are **siblings** on the host daemon, created by the runner through the Docker
  Engine API (Docker-out-of-Docker), not nested inside the runner.
- Each app container gets its own network namespace. `opencode serve` listens on `0.0.0.0:4100`
  inside it; the coordinator reaches `http://app-<id>:4100`. No app port is published.
- The runner connects the coordinator to each app network with a stable alias (`hanse`); the app's MCP
  URL is `http://hanse:<internal-port>/internal/mcp`. On coordinator restart the runner reattaches it.
- The app container may reach the model provider (egress is required). Sibling app networks are not
  reachable. Operator routes require the operator token; MCP uses a separate internal route and a
  per-app token.
- **Daemon constraint:** B1 assumes the coordinator and app containers share one Docker daemon. A
  rootless runner cannot attach a rootful Compose coordinator to its networks. Choose one of:
  (a) whole stack rootful Docker with a narrow broker; (b) whole stack rootless Docker/Podman;
  (c) whole-stack rootful Docker with Sysbox for app containers. Mixed
  rootless-runner/rootful-coordinator is not supported.
- B0's `agents` service is on one agents network with the coordinator; it has no runner and no socket.
- Image layers are shared by all containers. A per-app container does not copy the image; it adds a
  thin writable layer, logs, and per-app volumes (MBs, not GBs). Container creation is sub-second to a
  few seconds; opencode boot dominates. Pre-pulling the default image and lazy start keep first-chat
  latency low. If overhead ever matters more than isolation, B0 remains the shared-container option.
- v1 uses whole-stack rootful Docker with the narrow runner broker (owner decision). Rootless is a
  later hardening option: it changes the daemon, uid mapping, bind-mount ownership, and Compose host,
  so it is not a flag flip.

### 5.2 Image layers

| Image | Contents | Explicitly absent |
| --- | --- | --- |
| `ghcr.io/arkaneman/hanse` | Node 22, `dist`, production deps, git, CA, SQLite, dumb-init | code-server, opencode, OMO, codegraph, toolchains |
| `ghcr.io/arkaneman/hanse-agent-base` | Node 22, `opencode`, `hanse-agent-host`, `hanse-agent-supervisor` (B0), `hanse mcp` HTTP client, git, CA, curl, mise, OMO, codegraph, user `agent` | application code, toolchains beyond the runtime |
| `ghcr.io/arkaneman/hanse-agent-default` | base + Python 3.12, Node 22, PHP 8.3 (prebuilt, fixed extensions), `build-essential`, `pkg-config`, common dev libraries and CLI clients | Go, Rust, Java (installed per project with mise or an app Dockerfile), database servers, browsers, CUDA |
| `ghcr.io/arkaneman/hanse-agent-ide` | default + code-server, Hanse extension, `hanse-shell` | `/data/state`; the operator token is present in the coordinator and IDE, never in agents (see 5.8) |
| `ghcr.io/arkaneman/hanse-runner` | Node 22, runtime/build control API, Docker Engine client, path validation; workspace mounted read-only for build contexts | `/data/state`, operator token |
| `hanse-app-<project>-<app>:<hash>` | default + `.hanse/Dockerfile` fragment | application source (mounted, not baked) |

The default image is deliberately minimal: Python, Node, and PHP are preinstalled; Go, Rust, and Java
are installed per project with mise or an app Dockerfile. This keeps the shared image smaller and
avoids a multi-language monolith. The coordinator image may remain based on the current code-server
image during B0 to reduce risk; the target is a slim coordinator with the IDE on `agent-ide`. The plan
must state which image form B0 ships.

### 5.3 Application environment manifest

Add an optional `build` object to `.hanse/app.yaml` (the app manifest in the application directory):

```yaml
build:
  dockerfile: .hanse/Dockerfile   # optional; presence enables a build
```

- `.hanse/Dockerfile` is a **complete Dockerfile**, so standard Dockerfile linting works.
- Preferred pattern: `ARG HANSE_BASE` + `FROM ${HANSE_BASE}` for the runtime stage. Hanse passes the
  pinned agent-default image as the build arg, so base updates are centralized.
- Multi-stage builds are allowed (for example a `node` builder stage followed by
  `FROM ${HANSE_BASE}`). The final stage must contain the agent runtime.
- Any base is allowed, but the built image must pass the runtime contract: entrypoint, `opencode`,
  `agent-host`, MCP bridge, and version labels. If not, the build is marked incompatible and agent
  deployment fails with a clear error.
- Image `USER`, `ENTRYPOINT`, `CMD`, and `VOLUME` declarations are overridden or rejected by the
  runner; the image cannot change the runtime envelope.
- **No build declaration:** the app uses `hanse-agent-default`.
- `setup` remains inert in B2; runtime dependency setup belongs to project scripts or `mise`.

The application image is an **environment**, not a copy of the application. `COPY` is for build-time
artifacts only; application code stays in the mounted workspace.

### 5.4 Runtime contract

The runtime accepts a validated spec, not a raw Docker request:

```ts
interface AppRuntimeSpec {
  appId: string;
  image: string;              // default image in B1; per-app image in B2
  pathMode: "host" | "container"; // host for B1/B2; container for B0
  appDir: string;
  stateDir: string;
  networkName: string;        // hanse-app-<id> (B1/B2); agents network for B0
  port?: number;              // B1/B2 fixed 4100; B0 supervisor assigns when omitted
  env: Record<string, string>; // config, model, OMO profile name, MCP URL; no provider keys
  resources: { memoryBytes: number; nanoCpus: number; pidsLimit: number };
  labels: Record<string, string>;
  specHash: string;
}
```

Runner invariants (forced, not read from the image):

- `User: "1000:1000"`; `Entrypoint: ["/usr/local/bin/hanse-agent-entrypoint"]`; image `USER`,
  `ENTRYPOINT`, `CMD`, and `VOLUME` are ignored.
- `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges:true"]`, `Privileged: false`.
- `ReadonlyRootfs: true` with writable `/tmp`, `/run`, and the per-app state/home volumes.
- Mounts only: the app directory and `/data/agents/<app>`; no `/data/state`, no host root, no Docker
  socket, no devices, no host network.
- Per-app bridge network; no published ports.
- Memory, CPU, and PID limits; log rotation.

The runtime API (same shape in B0 and B1/B2):

- `POST /v1/apps/:appId/ensure` (idempotent by `specHash`);
- `DELETE /v1/apps/:appId`;
- `GET /v1/apps/:appId`;
- `GET /v1/apps/:appId/logs`;
- `POST /v1/apps/:appId/exec` (operator-only terminal; B1/B2);
- `POST /v1/reconcile` with the desired app ids;
- `POST /v1/images/build` (B2 only; runner builds through the Docker Engine API).

Every mutating endpoint returns the effective `{ appId, endpoint, state, specHash, version }`. The
coordinator consumes the returned endpoint and never assumes port 4100 outside B1/B2.

In B0 the supervisor implements the `apps` endpoints for processes and ignores `image` and
`networkName`. It assigns a port when the spec omits one. In B1 the runner implements the same
endpoints for containers. The coordinator uses one client for both.

It is bound to the internal control or agents network, authenticated with a runtime token held only by
the coordinator, and rejects arbitrary images/mounts.

### 5.5 Agent host and B0 supervisor

`hanse-agent-host` is a single-app process. In B0, one container runs N of them (one per app); in B1,
each container runs one. It:

- reads its per-app spec/config (model, overlay, OMO profile name, MCP endpoint/token);
- prepares its per-app `HOME`, XDG dirs, `TMPDIR`, auth file, and OMO profile;
- execs `opencode serve --hostname 0.0.0.0 --port 4100` (B1/B2) or a per-app port (B0);
- reports a health/version handshake (`hanseVersion`, `opencodeVersion`, `specHash`);
- handles SIGTERM and exits cleanly.

In B0, `hanse-agent-supervisor` runs in the `agents` container and exposes the same `apps` runtime API
on the agents network. It starts/stops one agent host per app, assigns a per-app port when the spec
omits one, and captures host stdout/stderr for the logs endpoint. The coordinator owns the per-app
auth, OMO, and MCP-token files and writes them before calling `ensure`; the supervisor only passes
their paths to the host. The coordinator client is identical to B1. In B1 the runner replaces the
supervisor; the agent host is unchanged.

The supervisor is reachable by agents in the same container (same uid, same network namespace). B0
therefore accepts that an agent can attempt to control sibling hosts or the supervisor. B1 moves the
runtime into a separate runner container on the control network, not reachable from app networks.
This is a B0 limitation in 5.11, not a hidden property.

### 5.6 MCP over HTTP

The coordinator exposes an internal MCP JSON-RPC endpoint (`POST /internal/mcp`) authenticated with a
per-app token. It runs the existing `handleRpc` against a `CoordinatorService` bound to the token's
project/app. The agent image ships a thin `hanse mcp` stdio bridge that forwards JSON-RPC to that
endpoint. `HANSE_DB` is never passed to an agent container.

Token lifecycle:

- The coordinator mints a token per running instance, writes the plaintext to
  `/data/agents/<app>/mcp-token` (mode 0600), and stores only its hash with the app id.
- On coordinator restart it reuses the file and hash instead of minting a new token, so a healthy
  agent keeps working.
- On stop it deletes the file and revokes the row.
- On restart the coordinator compares the file hash with the stored hash; if the file or row is
  missing, or the hashes differ, it revokes and recreates the instance. A token file is never trusted
  by existence alone.
- The token authorizes only the MCP tools, not the operator API. Existing human-only routes remain
  `403` for agent principals.

### 5.7 State and HOME

```
/data/state/hanse/coordinator.db, secret.key          # coordinator only
/data/agents/<projectId>/<appKey>/home                # HOME, OMO profile, codegraph state
/data/agents/<projectId>/<appKey>/data                # XDG_DATA_HOME, auth.json
/data/agents/<projectId>/<appKey>/state               # opencode.db
/data/agents/<projectId>/<appKey>/config, cache, tmp  # XDG config/cache, TMPDIR
/data/agents/<projectId>/<appKey>/mise                # per-app extra toolchain versions
```

- The coordinator writes the per-app auth file, OMO profile, and MCP token before the runtime starts.
- `HOME` is per app. The default image preinstalls Python 3.12, Node 22, and PHP 8.3. Go, Rust, and
  Java are installed per project with mise (or an app Dockerfile) into the per-app `MISE_DATA_DIR`
  under `/data/agents/<app>/mise`; there is **no shared mutable toolchain cache**, because a
  compromised app could poison a binary another app executes. `build-essential` in the default image
  lets Rust link.
- The permission overlay's trusted roots are recomputed from the per-app paths.
- Moving the existing state from `/data/state/hanse/projects/...` is an explicit migration decision
  (open question): copy sessions, or reset them for pre-alpha.

### 5.8 IDE

- `ide` uses `hanse-agent-ide`; its terminal sees the default toolchains.
- The coordinator and IDE are the only places the operator token is present; agents never receive it.
  The IDE is operator-trusted.
- `hanse-shell` must not source agent-controlled shell startup: use a controlled `HOME`,
  `bash --norc --noprofile`, and `cd` into the opened folder; set a stable `MISE_DATA_DIR` and `PATH`.
  Keep workspace trust enabled and the folder untrusted/restricted; disable task auto-detection and
  automatic extension activation in code-server settings.
- Special app images are reachable through the app page's operator-only terminal, which calls the
  runner `exec` endpoint. Per-app code-server is a non-goal.
- A scoped IDE principal is a later option; until then the IDE token is an accepted operator-trusted
  risk, documented in the security section.

### 5.9 Build and publish

- CI publishes the coordinator, agent-base, agent-default, agent-ide, and runner images with the same
  `sha-<short>`/version tags as today.
- B2 adds `POST /v1/images/build` to the runner. The runner is the only socket holder and the only
  build executor; it mounts the workspace read-only, tars the app directory, and builds the full
  Dockerfile through the Docker Engine build API (BuildKit), passing the pinned `HANSE_BASE` arg. The
  coordinator calls this endpoint with its runtime token; there is no separate builder process or
  builder token. A human-only coordinator route/UI action (`Add application`, `Build image`,
  `Rebuild`) triggers it. There is no deploy-time build step.
- App image status is stored in the coordinator DB and shown in the Web UI: `missing`, `building`,
  `ready`, `stale`, `error`, with the current log tail and retry. A Dockerfile edit by an agent marks
  the image `stale`; it does not start a build. The running container stays on the last `ready` image
  until the operator rebuilds.
- After build, the runner inspects the image and runs a one-shot version check for the entrypoint,
  `opencode`, `hanse-agent-host`, and the MCP bridge; a missing component or version mismatch marks
  the image `error` and agent deployment is refused. Incompatible `USER`/`ENTRYPOINT`/`CMD`/`VOLUME`
  declarations are overridden or rejected.
- App images are local tags on `deployment-host`; the coordinator stores the image ref/report in its DB.
  Base/default upgrades mark app images `stale`; they are rebuilt on operator action, not silently.
- Build security: no secrets, no host socket inside the build, BuildKit, no `--privileged`, bounded
  resources. A build is always a human action; an agent-writable Dockerfile cannot trigger it.

### 5.10 Deployment and operations

| Concern | B0 | B1 | B2 |
| --- | --- | --- | --- |
| Static images | GHCR pull | GHCR pull | GHCR pull |
| App images | none | none | runtime build via runner, UI status, local tags |
| User commands | `git archive` + `compose pull && up -d` | same | same; app image build is a UI action, not deploy |
| App cleanup | n/a | runner `stop-all`/reconcile | same |
| Backup | `workspace`, `state`, `agents` | same | same |
| Rollback | image tag + state restore | + runner/app state | + app image pointer |

- B1's daemon constraint is load-bearing: a rootless runner cannot attach a rootful Compose
  coordinator to its networks. Pick whole-stack rootful + broker, whole-stack rootless, or
  whole-stack rootful + Sysbox (5.1).
- `docker compose down` removes static services only. A wrapper or `hanse down` command calls the
  runner cleanup before `compose down`.
- Backup stops app containers first for consistent SQLite/state; `agents` is added to the backup set
  (caches excluded or documented as rebuildable).
- Deploy checks `docker system df`; retain two app image versions and prune old tags/build cache.
- Health: coordinator, IDE, runner, and per-app `/global/health`; `docker compose ps` plus
  `docker ps --filter label=hanse.managed=true`.
- Logs: static services via Compose; app containers via the UI/runner (`docker logs` is the fallback).
- There is no separate builder process. The coordinator calls the runner build endpoint with its
  runtime token; the runner never sees `/data/state`.
- Egress stays open in B0-B2 (model API and package installs). A forward proxy/allowlist and
  link-local/metadata blocking are a separate hardening stage after B2; the residual exfiltration
  risk is documented in 6.2.
- The default image is minimal; first use of Go/Rust/Java in a project installs them into the per-app
  mise dir and is shown as a startup/build-like status in the UI.

### 5.11 B0 accepted limitations

B0 fixes the coordinator-secret boundary only. It is explicitly **not** per-app isolation:

- one `agents` container, one uid, one workspace mount, one `/data/agents` mount;
- app A can read app B's auth, MCP token, OMO profile, state, and files;
- app A can reach sibling `opencode` ports and may attempt to control them;
- app A can reach the B0 supervisor and may start/stop sibling hosts;
- the toolchain cache is per app only if the per-app `MISE_DATA_DIR` is used; the default image and
  workspace are shared;
- app A can write files that app B or the operator may execute.

B0 is acceptable for a single operator on a trusted host as a short-lived or coarse boundary. B1 is
the isolation stage. The owner must accept this explicitly (open question 2).

---

## 6. Security model

### 6.1 Boundaries

| Boundary | Mechanism | Residual risk |
| --- | --- | --- |
| Coordinator secrets vs agents | Separate container, no `/data/state`, no operator token, no `/proc` of coordinator | Agent still has its own provider key and app data |
| App A vs app B | B1/B2: per-app container, network, app-dir mount, state, HOME; per-app toolchain cache | Host kernel shared; same host daemon |
| Agent vs container runtime | Runner is the only socket holder; coordinator never has it | Runner socket is root-equivalent if Docker rootful |
| App image vs runtime envelope | Runner overrides user/entrypoint/caps/mounts/network; post-build validation | Image can contain malicious binaries the agent runs |
| Build vs host | Runner builds; no secrets; no host socket inside the build; explicit/opt-in trigger | Build consumes CPU/disk/network |
| Git workbench | B0 hardening; B1 no-secret git context | B0 hardening must be proven; B1 credential injection is a new surface |
| IDE | Operator-trusted container, safe shell, no front-network agents | Agent-writable workspace can still trick the operator |
| Egress | Model API allowed; per-app network; metadata/link-local block later | Exfiltration to allowed destinations remains possible |

### 6.2 Explicit non-guarantees

- B0 does not isolate apps from each other (5.11). It isolates coordinator secrets from work.
- B1/B2 isolate app data only if each container mounts only its app directory and its per-app state;
  mounting the whole workspace makes per-app containers "theater".
- The permission overlay remains a guardrail, not a sandbox.
- Prompt injection is in scope: the agent process is assumed compromised. That is why the
  coordinator/agent split precedes toolchains.
- The git workbench is an execution surface. Repository-controlled hooks, `core.fsmonitor`,
  `core.sshCommand`, credential helpers, and protocol extensions must not run with coordinator
  secrets (R17).
- A rootful Docker runner is root-equivalent. If B is adopted for security, use whole-stack rootless
  or a minimal broker.
- The coordinator and IDE hold the operator token; agents never do. The IDE opens an agent-writable
  workspace and is operator-trusted; the safe shell and restricted workspace prevent agent-controlled
  startup/auto-run paths, but the operator can still run repository code. R20 is scoped accordingly.

---

## 7. Alternatives considered

| Option | Why rejected |
| --- | --- |
| **A. Shared container + mise only** | Fastest, but leaves the secret boundary and cross-app exposure; toolchains in the coordinator image widen the blast radius. Kept as the B0 toolchain layer, not the end state. |
| **B0 only** | Valid for a single operator, but no per-app isolation or resource limits. Kept as a deployable intermediate. |
| **B1 directly (skip B0)** | Less total work if confident, but a big-bang change: images, host, MCP, state, runner, networks, IDE. Higher debugging risk; no early deployable product. Allowed if the owner chooses, using the same interfaces. |
| **C. Devcontainers per project** | Not a security boundary; repo-controlled `privileged`/`runArgs`/lifecycle; requires Docker access; does not solve the coordinator/secret boundary. |
| **D. Nix per project** | 0.6-1.6 GB, writable `/nix`, sandbox caveats; too much operational surface for a single host. |
| **Per-app code-server** | Heavy RAM/disk; duplicates the IDE; terminal exec is narrower. |
| **Automatic build on file edit** | App Dockerfiles are agent-writable; automatic builds turn file edits into code execution. Only a human add/rebuild action triggers a build. |
| **DinD / privileged containers** | Root-equivalent; no security gain over a runner; nested storage/network complexity. |
| **App base without the agent runtime** | Loses `opencode`, agent host, and MCP; the coordinator cannot manage the container. Build validation rejects it; `ARG HANSE_BASE` is the supported path. |
| **Fragment-only Dockerfile** | Rejected: forces a non-standard file that linters reject. Full Dockerfile + runtime validation is the chosen path. |
| **Docker socket in the coordinator** | The coordinator holds secrets and the operator token; a socket compromise is host root plus all data. |
| **Rootless runner with rootful coordinator** | Cannot attach the rootful coordinator to the rootless daemon's networks. Use whole-stack rootless or put the control plane in the same rootless daemon. |
| **Separate builder process/token** | Creates a second socket holder or runtime-token holder and contradicts R11. The runner builds; the coordinator calls it with its runtime token. |
| **Git in the coordinator with secrets** | Repository-controlled hooks/fsmonitor/sshCommand become a direct agent-to-coordinator escape. Harden in B0, move in B1. |
| **Shared mutable mise cache** | Cross-app binary poisoning. Per-app `MISE_DATA_DIR` by default. |

---

## 8. Impact

| Area | Change |
| --- | --- |
| `.hanse/app.yaml` | Add optional `build` (`dockerfile`, `mode`). Keep `setup` inert. |
| `.hanse/project.yaml` | No new fields; app paths validated against the workspace root. |
| Store | Staged migrations: v4 (B0) agent tokens, instance runtime state/spec_hash; v5 (B1) container id/name/runtime state; v6 (B2) app image metadata. Forward-only. |
| Registry | Read `.hanse/app.yaml` in production; validate paths; compute app build spec. |
| Launcher/manager | Replace local `spawn` with an agent-runtime client (B0 supervisor, B1 runner); move runtime root to `/data/agents`; per-app HOME; OMO profile per app; handshake. |
| MCP | HTTP bridge + per-app token file; remove `HANSE_DB` from agent env; keep tool semantics and scoping. |
| Git workbench | B0 hardening and security tests; B1 move app-repo git to a no-secret context; keep UI/API. |
| IDE | `agent-ide`; safe shell, controlled HOME, no workspace auto-run; operator token remains IDE-only. |
| HTTP/UI | App runtime status, image status, build/rebuild, logs, operator terminal; a human-only image-build route; no new operator API for container internals. |
| Dockerfile | New targets: agent-base, agent-default, agent-ide, runner; keep the coordinator target. |
| Compose | B0 `agents`; B1 `runner`; B2 no extra builder service; networks/volumes; host-path env. |
| CI | Publish all static images with the existing tag scheme; build matrix and smoke checks. |
| Deployment docs | Pull/build split, `agents` volume, cleanup wrapper, backup, disk/GC, rollback, daemon constraint. |
| Tests | Unit for specs/validation/tokens/hashes; integration with a fake runner; container smoke on a Docker host; security probes (git, IDE shell, cross-app); regression suite. |

---

## 9. Non-goals

- Multi-user, RBAC, multi-tenant isolation.
- Kubernetes, Nomad, Firecracker, gVisor, Kata, or any microVM.
- Windows/macOS hosts, GPU, accelerators.
- Per-app code-server, per-app IDE images, or per-app VS Code extensions.
- Arbitrary app base images, runtime build APIs, or automatic builds on file change.
- Egress domain allowlists/TLS inspection in B0-B2; deferred to a later security stage.
- Whole-machine snapshots, image-builder UI, or a snapshot cache platform.
- Per-app `opencode` versions; the agent image pins one version.
- App-level MCP/plugin manifests beyond the existing `.opencode` behavior.
- Toolchain selection UI; `.mise.toml` is the interface.
- Worktrees, multi-instance-per-app, or distributed coordination.
- Migrating secrets to a vault; provider keys remain in the coordinator DB.
- A scoped IDE principal in B0/B1; it is a later option.

---

## 10. Stage plan and gates

Each stage is a separate commit and deployment. Implementation is blocked until the design review,
owner questions, and plan review pass.

### B0 - Split the coordinator from agents

Deliverables:

1. Path confinement (registration and launch) for app paths.
2. Image targets: `agent-base`, `agent-default`, `agent-ide`; CI publish.
3. `hanse-agent-host` single-app and `hanse-agent-supervisor` with the same runtime API as B1 (R18).
4. `agents` service; per-app HOME/state under `/data/agents`; per-app `MISE_DATA_DIR`.
5. MCP over HTTP with per-app token file and restart persistence; remove `HANSE_DB` from agents.
6. Git workbench hardening (hooks, fsmonitor, sshCommand, credential helpers, protocol.ext, scrubbed
   env, validated remotes) and malicious-repo tests; preserve fetch/push with coordinator-controlled
   credentials (fixed SSH/askpass, no repo-controlled helper); move to a no-secret context if any
   vector remains.
7. IDE service on `agent-ide`; safe `hanse-shell`, controlled HOME, no workspace auto-run.
8. Compose/pull/backup/health docs; migration/reset decision.
9. Tests and security probes.

Exit gate:

- Agent shell cannot read `/data/state`, `secret.key`, `coordinator.db`, or coordinator env.
- Toolchain smoke: Node, Python (`uv`), PHP framework boot + `php -m`, Go build, Rust compile, Java.
- Chat/SSE, questions/permissions, handoff approve/reject, git workbench agent `403`, IDE proxy.
- A malicious git hook/fsmonitor/sshCommand does not execute in the coordinator's secret context.
- Fetch/push still work with coordinator-controlled credentials; a repo-controlled helper or
  `core.sshCommand` is ignored.
- A malicious `.bashrc` is not sourced by the IDE terminal.
- Coordinator restart keeps MCP tokens valid; restart/reconcile; sessions survive; no orphans.
- Deploy to `deployment-host`; agent checks; **owner manual verification**.

### B1 - One container per application

Deliverables:

1. Runner service with the same runtime API; Docker socket/rootless choice; path mapping.
2. Per-app containers from `agent-default`; per-app network, app-dir mount, state, limits.
3. Operator terminal exec; logs; reconciliation; cleanup wrapper.
4. Coordinator runtime client switch from supervisor to runner; per-app `4100`.
5. Git workbench in a no-secret context (per-app container or one-shot git container) with explicit
   credentials for fetch/push.
6. Tests and isolation probes.

Exit gate:

- Two apps: A cannot read B's files/state/auth/token or reach B's `opencode`/MCP; resources are per
  app.
- First-chat lazy start, stop, restart, logs, terminal.
- Git hooks from app A cannot reach coordinator secrets; fetch/push still work with explicit
  credentials.
- `compose down` cleanup; backup stops apps; host restart reconciles.
- Deploy to `deployment-host`; agent checks; **owner manual verification**.

### B2 - Per-app images

Deliverables:

1. `build` schema for a full `.hanse/Dockerfile`; validation; image hash/labels; `ARG HANSE_BASE`
   injection.
2. Runtime image lifecycle: runner `POST /v1/images/build`; human-only coordinator route/UI; statuses
   (`missing/building/ready/stale/error`), logs, retry; no deploy-time build.
3. App image validation (entrypoint/opencode/agent-host/MCP bridge/versions); an incompatible image is
   refused.
4. App image lifecycle: stale on base/default change, rollback, retention/GC.
5. Runtime build on add app/rebuild; failed build keeps the old container; disk checks.
6. Tests: extra OS package, incompatible image, broken build, stale, rollback, base update, layer
   sharing.

Exit gate:

- An app installs an OS package absent from default and runs.
- An invalid fragment or image is rejected with a clear error.
- A broken Dockerfile leaves the old container running and marks `error`.
- Base/default update marks `stale`; operator rebuild works.
- Rollback to the previous app image works.
- Deploy to `deployment-host`; agent checks; **owner manual verification**.

---

## 11. Resolved owner decisions

Owner decisions were collected interactively on 2026-10-20. There are no open items for this stage;
the same decisions are recorded in `docs/open-questions.md`.

1. **Runner/daemon model:** whole-stack rootful Docker with a narrow runner broker for v1. Rootless
   would change the daemon, uid mapping, bind-mount ownership, and Compose host; it is a later
   hardening stage, not a flag flip. Mixed rootless/rootful is unsupported.
2. **B0 limitations:** accepted. B0 isolates coordinator secrets only; B1 adds per-app isolation.
3. **State migration:** reset per-app sessions for pre-alpha, with a documented backup. No copy
   migration code in B0.
4. **App Dockerfile:** full Dockerfile, so standard linting works. `ARG HANSE_BASE`/`FROM
   ${HANSE_BASE}` is the preferred pattern; an image that lacks the runtime is marked incompatible and
   agent deployment fails with a clear error.
5. **Build trigger:** runtime build on a human action (add app or explicit rebuild), with status and
   logs in the Web UI. No deploy-time build; no automatic build on agent file edit.
6. **IDE token:** the operator token remains only in the coordinator and the operator-trusted IDE,
   with safe shell, controlled HOME, restricted workspace and no auto-run. Agents never receive it. A
   scoped IDE principal is a later option.
7. **Git workbench:** harden in B0 with coordinator-controlled fetch/push credentials and tests; move
   app-repo git to a no-secret context in B1.
8. **Default package set:** minimal image: Python 3.12, Node 22, PHP 8.3 (prebuilt, fixed extensions),
   build-essential/pkg-config/dev libraries/CLI clients. Go, Rust, and Java are installed per project
   with mise or an app Dockerfile. No DB servers or browsers.
9. **Egress:** open in B0-B2 for model API and package installs; a proxy/allowlist and
   metadata/link-local blocking are a separate hardening stage after B2. Deploy stays simple.
10. **Disk/retention:** two app-image versions per app, GC at 85%, caches excluded from backup.
11. **Cleanup:** `hanse down`/wrapper stops dynamic app containers before `compose down`.
12. **Workspace:** per-app container mounts only the app directory. Image layers are shared; per-app
    containers add a thin writable layer, not a copy of the image. If a workflow needs project-level
    files, project-root read-only is a small later addition.
13. **Terminal exec:** operator terminal in the app container ships in B1.
14. **Commit/deploy:** one coherent commit + push to `origin/main` + deploy to `deployment-host` per stage, after
    agent checks and owner manual verification.

---

## 12. Review

Design review: **oracle, 2026-10-20. Verdict: PASS WITH REQUIRED CHANGES.** The review output was
truncated after blocker B6, so the blocker list below is complete for B1-B5 and partial for B6; the
major/minor and owner-question sections were not delivered and are not reconstructed here.

Findings folded into this revision:

- **B1** - B0 had no control plane. Added R18 and 5.5: `hanse-agent-supervisor` implements the same
  runtime API as the runner; the coordinator client is identical.
- **B2** - Git workbench could execute repo-controlled hooks/fsmonitor/sshCommand with coordinator
  secrets. Added R17, B0 hardening and tests, and a B1 no-secret git context.
- **B3** - `image-builder` socket contradicted R11. The runner is now the only socket holder and build
  executor; there is no separate builder process or builder token; the coordinator calls the runner
  build endpoint.
- **B4** - A rootless runner cannot attach a rootful coordinator to its networks. Added the daemon
  constraint (5.1) and the whole-stack rootless/rootful/Sysbox options.
- **B5** - IDE held the operator token; the design claimed it did not. Added R20, safe shell,
  controlled HOME, no workspace auto-run, and an explicit operator-trusted residual risk.
- **B6** - B0 cross-app leakage contradicted R3/R4. Scoped R3/R4 and added 5.11 with explicit B0
  limitations.

Re-review (oracle, 2026-10-20): **PASS WITH REQUIRED CHANGES.** The five remaining changes were
folded: (1) the coordinator, not a separate builder, calls the runner build endpoint with its runtime
token and the runner tars the app directory; no builder token or application data at rest; (2) daemon
options are aligned to rootful broker / whole-stack rootless / Sysbox; (3) the runtime spec now has
`pathMode`, an optional port, an `ensure` response contract, and the coordinator owns auth/OMO/token
files; (4) the coordinator verifies the token file hash and recreates on mismatch; (5) the IDE keeps a
restricted workspace, and B0 fetch/push uses coordinator-controlled credentials. Design review gate:
**cleared**; no further architectural change is pending.

Owner decisions (section 11 and `docs/open-questions.md`, 2026-10-20) close phase 3. There are no open
questions. Next phase: write `docs/plans/0009-agent-runtime.md`, then plan review by `momus`.

## 13. References

- `docs/current-state.md` - current topology and known limits.
- `docs/deployment.md` - current GHCR/Compose deployment.
- `docs/conventions.md` - manifest schemas.
- `docs/decisions/0001-one-opencode-instance-per-app.md`
- `docs/decisions/0002-config-injection-via-OPENCODE_CONFIG_CONTENT.md`
- `docs/decisions/0003-per-instance-state-isolation-xdg.md`
- `docs/decisions/0005-permission-policy-guardrail.md`
- `docs/decisions/0006-hierarchical-settings.md`
- `docs/decisions/0007-web-tool-drivers.md`
- `docs/plans/0003-opencode-baseline-and-isolation.md` - discussion draft; this design supersedes its
  runtime stages.
- `docs/process.md` - delivery gates and verification.
