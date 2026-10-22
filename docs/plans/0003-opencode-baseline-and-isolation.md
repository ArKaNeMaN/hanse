# 0003 - OMO baseline, project/app config, and application isolation

- Status: **discussion draft** - no implementation approved beyond the OMO headless spike.
- Date: 2026-10-19
- Scope: install oh-my-openagent (OMO) as a baseline for managed `opencode` instances; add
  project/app-level MCP and plugin configuration; decide how far an application can be confined to
  its own directory.

> This document records the questions that must be answered before a design is written. It is not a
> plan review artifact and must not be treated as an approved implementation plan.

## Spike result (2026-10-19)

- Installed OMO package: `oh-my-openagent` **5.1.35** (npm `latest`; legacy package
  `oh-my-opencode` also resolves to 5.1.35).
- Local opencode: **1.18.35**. Global config `~/.config/opencode/opencode.json` already lists
  `"oh-my-openagent@latest"`; the resolved cache package is 5.1.35.
- `opencode debug agent sisyphus` returns the OMO `Sisyphus - ultraworker` agent with OMO tools
  (`call_omo_agent`, `background_output`, `look_at`, `skill_mcp`, etc.).
- Headless CLI check:
  `opencode run --agent sisyphus -m deepseek/deepseek-flash --format json "Reply with exactly OMO_HEADLESS_OK..."`.
  Exit code `0`, response text `OMO_HEADLESS_OK`, no plugin errors on stderr.
- Headless server check: `opencode serve --hostname 127.0.0.1 --port 4199` returned `200` for
  `/config`, `/agent`, `/session`, and `/doc`. `/agent` listed the OMO agents
  (`Sisyphus - ultraworker`, `Prometheus - Plan Builder`, `Atlas - Plan Executor`, etc.) and
  `/config` showed `"oh-my-openagent@latest"` in the plugin list. No plugin load errors; the only
  warnings were duplicate skill names (`find-skills`, `laravel-specialist`) from the existing user
  config. The server also warned that `OPENCODE_SERVER_PASSWORD` is not set (see finding 6).
- Open caveat: the hanse Docker image pins `opencode-ai@1.19.3`, while the local spike used
  1.18.35. Re-run both checks inside the built image before declaring OMO supported for managed
  instances.

## First baseline (2026-10-19)

The first baseline is image-level: `oh-my-openagent@5.1.35` is installed once at
`/opt/hanse/omo`, injected into every instance through `HANSE_OMO_PLUGIN` as a `file://` plugin
spec, and configured by `omo/omo.jsonc` with `deepseek/deepseek-flash` pins. The same baseline
injects the codegraph MCP server (`@colbymchenry/codegraph@1.6.2`, `/opt/hanse/codegraph`). This is
intentionally minimal and does **not** answer Q1-Q9; project/app MCP/plugin inheritance and hard
isolation remain open.

## Findings that drive the questions

1. **opencode has no sandbox.** `SECURITY.md` (v1.19.3) says the permission system is a UX feature,
   not security isolation, and recommends a container/VM for true isolation.
2. **`opencode serve` is not bound to its cwd.** The directory is selected per request from
   `?directory=`, `x-opencode-directory`, or `process.cwd()` (`workspace-routing.ts`). Spawning with
   `cwd=appDir` does not confine a client.
3. **Permission coverage is partial and bypassable.** `read`/`edit` patterns are worktree-relative;
   `glob`/`grep` permissions match the pattern/regex, not the search path; `bash` matches parsed
   commands and a best-effort external-directory scan. `external_directory` only fires outside the
   worktree, so sibling directories inside a larger worktree are considered internal.
4. **Application paths are not validated.** `.hanse/project.yaml` accepts any non-empty string for
   `apps[].path`; absolute paths are passed through by `src/http/apps.ts`.
5. **The opencode process inherits the coordinator environment**, including `HANSE_OPERATOR_TOKEN`,
   `HANSE_STATE_HOME`, and `HANSE_AUTH_FILE` (`src/opencode/launcher.ts`). The agent's shell/plugins
   can read them.
6. **All instances share one network namespace and localhost.** Every instance listens on
   `127.0.0.1:4100+`; the launcher does not set `OPENCODE_SERVER_PASSWORD`. One agent can reach
   another instance's API, and the coordinator API on `127.0.0.1:8787`.
7. **The coordinator MCP server writes directly to the shared SQLite DB.** `hanse mcp` receives
   `HANSE_DB` and runs as a child of opencode (`src/opencode/manager.ts`). Strict app-directory
   confinement conflicts with this design.
8. **App-level config currently cannot flow.**
   - `.hanse/app.yaml` is loaded by `loadAppConfig()` but the function is unused in production.
   - `registerProject()` derives `appKey` from `basename(path)` and hardcodes
     `contract: "AGENTS.md"`; it never reads `app.yaml`.
   - `project.shared` exists in the schema but is never passed to the overlay.
   - `buildConfigOverlay()` supports only a local MCP entry and `instructions`; there is no plugin
     field and no remote MCP support.
9. **OMO install details matter for a baseline.**
   - `opencode` 1.19.3 installs npm plugins per instance under
     `$XDG_CACHE_HOME/opencode/packages/<spec>` with `ignoreScripts: true`.
   - hanse already sets a per-app `XDG_CACHE_HOME`, so an image-level OMO cache is not reused
     automatically.
   - OMO's own `postinstall` checks the opencode version and invalidates/deletes plugin cache
     entries; any prebake must use `--ignore-scripts`.
   - OMO stores state/config under `~/.omo`, which is not covered by the per-app XDG variables.
   - OMO requires opencode `>= 1.4.0`; model access comes from opencode provider auth.
   - OMO 5.x is licensed `SUL-1.0` (source-available, not OSI); redistribution needs review.

## Open questions

Each question needs an owner decision before a design document is written.

### Q1. Trust model

Are application repositories **trusted** (the current documented model: single owner, trusted
repos, logical isolation) or **untrusted** (multi-tenant/adversarial)?

- If trusted: app-level plugins and OMO hooks are acceptable, and soft permissions plus a
  best-effort sandbox may be enough for the first iteration.
- If untrusted: app-level plugins are arbitrary code execution and must be disallowed or
  allowlisted; a hard OS/container boundary is mandatory.
- Decision needed: which model applies to the first release, and what changes it later.

### Q2. What does "confined to the application folder" mean?

The answer defines the allowlist:

- May the agent read/write **only** the app repository?
- May it read project-level `shared/` docs and the project manifest?
- May it read/write its own per-instance state (`XDG_*`, `OPENCODE_DB`)?
- May it read/write a per-app OMO home/cache (`~/.omo`, plugin cache)?
- May it read system paths needed by Node/opencode/OMO (`/usr`, `/lib`, `/etc`, `/proc`)?
- May it execute external binaries (git, rg, language servers, ast-grep, browser)?
- May it reach the network (provider APIs, OMO `websearch`/`context7`/`grep_app`)?
- May it reach the coordinator API and the coordinator DB?

Recommendation: define an explicit read-only/write allowlist; do not use the phrase "only the app
folder" until the allowlist is agreed.

### Q3. Sandbox mechanism and deployment constraints

Options:

| Option | Strength | Constraints |
|---|---|---|
| opencode `permission` only | Soft UX guardrail | Not a security boundary; bypassable |
| **Landlock** | Per-process FS allowlist, unprivileged | Kernel >= 5.13, `no_new_privs`, helper binary; network not restricted |
| bwrap / nsjail | Namespace + FS (+ optional net) isolation | Docker default seccomp blocks unprivileged userns; needs custom seccomp or `seccomp=unconfined`; tools not installed; netns breaks coordinator→instance connectivity |
| Per-app container | Strongest | Needs an orchestrator/Docker socket; heavier operations |
| Per-app UID | Strong-ish | Coordinator runs as uid 1000 without `CAP_SETUID`; not viable as-is |

Decision needed:

- Is Landlock acceptable, or is bwrap/per-app container required?
- What is the kernel/LSM situation on the target host? (Landlock ABI, user namespaces, AppArmor)
- May we add a seccomp profile / capabilities / helper binary to the image?
- Is network egress allowed for agents? OMO's built-in MCPs need it.

Recommendation: Landlock as the first hard FS boundary; per-app containers later if the trust model
requires it.

### Q4. Manifest scope

Should `.hanse/project.yaml` / `.hanse/app.yaml` expose:

- only `opencode.mcp`, `opencode.plugins`, `opencode.instructions`; or
- also `opencode.permission`, `opencode.agents`, `opencode.model/provider`?

Recommendation: start with MCP/plugins/instructions only. App-defined `permission` or agents can
override the coordinator baseline; OS-level enforcement is the only reliable boundary.

Decision needed: exact allowed field set and validation/error behavior for unknown keys.

### Q5. Secret handling in MCP/plugin config

MCP servers may need tokens in `environment` or HTTP headers; `.hanse/*.yaml` is committed to git.

Options:

- literal values (rejected for secrets);
- `${ENV_VAR}` interpolation from the coordinator environment at launch;
- a separate secrets file/dir with `0600` and per-app scoping;
- a secrets manager later.

Also required: never expose secret-bearing config through the unauthenticated `GET /api/projects`
or through `list_apps` MCP.

Decision needed: interpolation syntax, storage, and redaction rules.

### Q6. OMO baseline profile

- Which opencode edition/profile: default OMO roster or a trimmed one?
- Which providers/models should the baseline `[opencode]` config pin? (Currently OMO agents are
  pinned to `deepseek/deepseek-flash` in the local `~/.omo/omo.jsonc`.)
- Is telemetry allowed? Should `auto-update-checker` be disabled for a pinned baseline?
- Should OMO's `~/.omo` be per-app (`HOME=<app state>/home`) or shared?
- Are OMO's built-in MCPs (`websearch`, `context7`, `grep_app`, `lsp`) allowed by default?
- Is `SUL-1.0` acceptable for the intended distribution model?

Recommendation: pin a version, disable auto-update, isolate `HOME`/`~/.omo` per app, prebake
platform binaries, and explicitly choose the MCP set.

### Q7. Application-owned opencode config

Managed repositories may already contain `opencode.json`, `.opencode/`, `AGENTS.md`, plugins, and
MCP servers. Do we:

- honor them as-is (current behavior; another arbitrary-code path);
- allow only read-only instructions/AGENTS.md and reject plugins/MCP;
- ignore them entirely and inject only coordinator-approved config?

Decision needed: this determines whether a "controlled baseline" is actually controlled.

### Q8. Configuration reload policy

`InstanceManager` caches a running instance and has no per-app restart. Options:

- restart the instance when a manifest changes;
- require an explicit "restart agent" action;
- apply only on next natural start.

Decision needed: expected operator experience and whether config changes can wait.

### Q9. App identity and manifest source of truth

`registerProject()` uses `basename(apps[].path)` as `appKey` and ignores `.hanse/app.yaml` `name`.
If app-level config is keyed by the app manifest, this mismatch matters.

Decision needed:

- Is `appKey` the path basename, or `app.yaml.name`, or a new explicit `key` field?
- Should the coordinator read `app.yaml` at registration, at launch, or both?
- What happens when a cloned repo already has `app.yaml` with config?

## Future work

### Agent selection from the web UI

Current behavior (2026-10-19): the web UI has no agent selector. Hanse sends only
`{ parts: [{ type: "text", text }] }` to `POST /session/:id/message`
(`src/opencode/client.ts`); opencode resolves the agent from `default_agent` or falls back to the
first visible primary agent. OMO sets `default_agent = "Sisyphus - ultraworker"`, so all web UI
prompts currently use Sisyphus.

To support explicit selection later:

- extend `sendPrompt` with an optional `agent` and send it in the prompt payload;
- parse and validate `body.agent` in `src/http/chat.ts` (primary, visible, known agent only);
- add a primary-agent selector to the chat composer, fed by the instance `/agent` endpoint;
- decide whether the selection is per message, per session, or a per-app default;
- keep the opencode default as the fallback when no selection is made.

### Cold-start reliability

The first `sessions` request after a container restart can return a connection error while the
managed instance installs its per-app opencode dependencies; a retry a few seconds later succeeds.
Consider raising the launcher wait, pre-warming instances after deploy, or seeding the per-app
config dependencies.

## Proposed phase outline (for discussion, not approved)

1. **P0 - security prerequisites (before calling anything "isolated")**
   - Sanitize the environment passed to opencode; remove coordinator tokens/secrets.
   - Validate/normalize `apps[].path`; reject absolute/traversal paths; `realpath` containment.
   - Give each instance a per-app `HOME`/`~/.omo` and a per-app auth/state boundary.
   - Decide and implement per-instance server auth and/or network isolation for `127.0.0.1:4100+`.
2. **P1 - manifest config and overlay**
   - Add `opencode.mcp/plugins/instructions` to project and app schemas.
   - Read `app.yaml` in production; wire `project.shared` to `instructions`.
   - Merge project + app; reserve `hanse` MCP; add remote MCP support; map `plugins` to opencode
     `plugin`.
   - Inject at launch; do not store secret-bearing config in `RegisteredApp`/API/MCP.
3. **P2 - OMO baseline**
   - Pin `oh-my-openagent@5.1.35`; prebake/seeding strategy for per-app cache; `--ignore-scripts`.
   - Baseline `omo.jsonc` with model pins, telemetry/auto-update policy, per-app home.
   - Re-run headless verification inside the `opencode-ai@1.19.3` image.
4. **P3 - hard filesystem isolation**
   - Landlock wrapper with an allowlist (app dir rw, per-app state/home/cache rw, system ro,
     project shared ro).
   - Resolve the `hanse mcp` DB conflict: allow the DB path, or move MCP to a scoped HTTP API.
5. **P4 - stronger isolation if needed**
   - Per-app container with only the app dir and per-app state, seccomp/caps drop, network policy.

## Verification criteria (draft)

- OMO headless: `opencode run --agent sisyphus` exits 0 in the target image; no plugin errors.
- Config inheritance: project MCP + app MCP merge by name; app overrides; `hanse` reserved; plugin
  lists concatenate and dedupe; instructions concatenate.
- Secret isolation: `/api/projects`, `list_apps`, logs, and error pages contain no MCP secrets.
- Confinement probes (once P3 exists): agent cannot read sibling app dirs, other instances' state,
  `secret.key`, the coordinator DB, or the operator token; cannot control a sibling instance's
  `127.0.0.1` port.
- Offline start: a fresh instance starts without network and loads the pinned OMO build.
- Reload: manifest change is either applied on restart or rejected with a clear error.

## References

- `SECURITY.md` in opencode v1.19.3 (`No Sandbox`, server mode).
- `src/server/routes/instance/httpapi/middleware/workspace-routing.ts` (per-request directory).
- `src/project/instance-context.ts` (`containsPath`, worktree boundary).
- `packages/web/src/content/docs/permissions.mdx` (permission schema and defaults).
- `<HOME>/dev/hanse/src/schema/project.ts`, `src/schema/app.ts`.
- `<HOME>/dev/hanse/src/config/load.ts`, `src/registry/index.ts`.
- `<HOME>/dev/hanse/src/opencode/instance.ts`, `manager.ts`, `launcher.ts`.
- `<HOME>/dev/hanse/src/http/apps.ts`, `handler.ts`, `chat.ts`.
- `<HOME>/dev/hanse/docs/decisions/0002-config-injection-via-OPENCODE_CONFIG_CONTENT.md`.
- `<HOME>/dev/hanse/docker-compose.yml`, `Dockerfile`.
