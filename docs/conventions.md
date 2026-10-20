# Conventions

## `.hanse/` marker directory

A `.hanse/` directory marks both projects and applications. The file inside distinguishes them:

- **Project root**: `.hanse/project.yaml`
- **Application root**: `.hanse/app.yaml`

`opencode` uses `.opencode/`; `.hanse/` is coordinator metadata and is never read by `opencode`.

## `.hanse/project.yaml`

```yaml
id: 3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b   # stable uuid, keys runtime state
name: demo-project
base_branch: main                            # default: main
shared:                                      # optional shared docs
  - shared/AGENTS.md
apps:
  - path: apps/web                           # relative to the project root
    remote: git@github.com:example/web.git   # optional
    kind: web                                # optional
```

## `.hanse/app.yaml`

```yaml
name: web            # application key (portable string name)
kind: web            # optional
contract: AGENTS.md  # path to the interface/contract doc (default: AGENTS.md)
ports:               # optional named ports
  http: 3000
setup: npm install   # optional setup command
build:               # optional per-app image environment
  dockerfile: Dockerfile   # path relative to the app directory (default: Dockerfile)
  args:                     # optional build arguments, hashed into the build spec
    NODE_VERSION: "22"
```

The Dockerfile is a complete Dockerfile. It is resolved under the app directory with `realpath`
containment (no `..`, absolute paths, or escaping symlinks); an invalid manifest or Dockerfile marks
the app image `error` without failing project registration. The build spec hash covers the Dockerfile
bytes, the default/base image reference, and sorted build args, so app source edits do not change it.

## Naming and portability

- Use **relative paths** everywhere (manifests, shared docs) so the tree can be moved.
- The application key (`name`) is a **string name**, not a unique id. The coordinator assigns a
  per-clone instance identity in its own state, so the same application can be cloned into more than
  one project with separate clones.
- Keep coordinator-specific files inside `.hanse/` so repository roots stay clean.

## Settings

Settings are **not** stored in `.hanse/` manifests. Global, project, and application settings and
encrypted model-provider keys live in the coordinator SQLite database (`settings` and
`provider_keys` migrations). Missing rows inherit; `null`/`cleared` is an explicit empty override.
Provider keys are never written to YAML, the project repository, or the opencode config overlay.

## Runtime layout (outside repositories)

Coordinator state lives under `$XDG_STATE_HOME/hanse/` (`coordinator.db`, `secret.key`, and the
coordinator's own records). It is never mounted into agents.

Per-app agent state lives outside the coordinator state, under `HANSE_AGENTS_HOME` (default
`~/.local/state/hanse-agents`; Compose uses `/data/agents`):

```text
<projectId>/<appKey>/
├── home/                  HOME, .omo profile, tool config
├── data/ state/ config/ cache/   XDG dirs and opencode DB
├── tmp/                   per-app TMPDIR
├── mise/                  per-app toolchain cache
└── mcp-token              per-app MCP token (0600)
```

The app directory remains under the workspace; only its runtime state lives under the agents root.
In B1, the runner mounts the app directory at `/data/workspace/<project>/<app>` and only that app's
agents root at `/data/agents/<project>/<app>` into its container. The runner reads the host agents
volume read-only for per-app passwords; the app container never sees coordinator state or the IDE
volume. The IDE sees the workspace only.

`.hanse-runtime/` (gitignored) may be used as a local override during development.
