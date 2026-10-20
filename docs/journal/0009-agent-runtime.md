# 0009 - Agent runtime (B0)

Date: 2026-10-20. Stage: B0 of the agent-runtime plan.

## What shipped

- Coordinator and agents now use an HTTP runtime contract. `serve` requires `HANSE_RUNTIME_TOKEN`
  and calls `http://agents:8789`; `InstanceManager` no longer spawns `opencode` itself.
- New `hanse agent-supervisor` and `hanse agent-host` commands. The supervisor starts one host per
  app on `0.0.0.0:4100+`, proxies status/logs, and reconciles; the host runs `opencode serve` with
  the validated per-app spec.
- Per-app runtime state moved to `/data/agents/<projectId>/<appKey>/{home,data,state,config,cache,
  tmp,mise}`. The coordinator DB/`secret.key` stay in `/data/state`.
- Per-app MCP HTTP with a canonical `mcp-token` file/hash and a stdio remote bridge; agents get no
  `HANSE_DB`. Per-app opencode Basic auth and a password file.
- Git runs with a minimal child environment and fixed command-line config: no inherited
  `GIT_*`/`SSH_*`, no repository hooks/fsmonitor/credential helpers/ext protocols/submodule
  recursion/repository SSH commands, validated remotes, and controlled identity/askpass/SSH.
- `agent-base`, `agent-default`, and `agent-ide` image targets; publish/CI build all of them. The
  default image has Python 3.12, Node 22, PHP 8.3 with fixed extensions, uv, build tools, and mise.
  Go/Rust/Java are installed per app with mise.
- IDE uses `agent-ide`; `hanse-shell` clears the environment, pins HOME/mise/PATH, starts in the
  workspace, and uses `bash --norc --noprofile`. Code-server trust/auto-run/auto-update settings are
  pinned.
- Compose adds a hardened `agents` service: uid 1000, read-only root, `cap_drop: ALL`,
  `no-new-privileges`, no state/socket, separate `agents` network, workspace/agents volumes. The IDE
  is on the `front` network only.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` (50 files / 886 tests), `npm run build`.
- Local three-service Compose smoke: coordinator, IDE, and agents healthy; `/ide/` proxy works; probe
  passes.
- `scripts/agent-runtime-probe.sh b0`: no `/data/state`, no operator token or `HANSE_DB` in the
  agents PID 1 environment, no Docker socket, agents cannot resolve the IDE, root is read-only,
  `/tmp` is executable, and toolchains are present.
- Agent toolchain smoke as uid 1000: Python 3.12, Node 22, PHP 8.3 (`mbstring`, `intl`, `zip`,
  `pdo_mysql`, `pdo_pgsql`), uv, Go 1.23 build, Rust compile/link, Java 21 compile/run.

## Deploy

Deployed to `deployment-host` after the stage commit; owner manual verification is the B0 gate. No B1 work
before that gate.

## Known B0 limits

- One shared `agents` container/network for all apps; no per-app process/network isolation yet (B1).
- The supervisor's runtime token is visible inside the B0 agents container; app containers in B1 will
  not receive it.
- App images and runtime image builds are B2.
