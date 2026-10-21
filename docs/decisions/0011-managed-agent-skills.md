# 11. Managed agent skills in the coordinator database

- Status: Accepted
- Date: 2026-10-22
- Stage: `0015-agent-skills`
- Design: [`docs/design/agent-skills.md`](../design/agent-skills.md)
- Plan: [`docs/plans/0015-agent-skills.md`](../plans/0015-agent-skills.md)

## Context

opencode discovers Agent Skills from the active project's `.opencode/skills`, the per-instance
`~/.config/opencode/skills`, and external roots such as `~/.claude/skills` and `~/.agents/skills`.
Hanse already isolates each application's HOME and XDG roots, but had no way to define a skill once
and inject it into every agent, or to vary it by project or application. Editing each container or
committing skills to every repository would bypass the settings hierarchy, leave no audit, and lose
content when an app moves to a new image or a fresh agents root. opencode loads config, agents, and
skills once at process start, so any change needs an explicit restart.

## Decision

1. **Store skills in the coordinator SQLite database, not in manifests.** A `skills` table
   (migration v12) is keyed by `(scope, project_id, app_key, name)`, using empty strings for wider
   scopes as the existing `settings` and `provider_keys` tables do. DB `CHECK` constraints enforce
   the scope shape, name syntax, description and content lengths, and enabled state; a
   `UNIQUE(scope, project_id, app_key, name)` constraint makes the plain upsert work. There is no
   foreign key: app and project deletion remove the corresponding rows explicitly in the same
   transactions as settings, while global rows (`project_id = ''`) survive. `.hanse/` remains
   coordinator metadata and repository skills remain untouched.
2. **Resolve effective skills by name, global -> project -> application.** The narrowest row wins.
   A disabled row is a tombstone that hides an inherited skill without deleting it; a narrower
   enabled row re-enables it. `EffectiveSkill` carries the winning row id, source scope, and
   shadowed scopes. Name is immutable for a row; rename is delete plus create.
3. **Materialize into the Hanse-owned per-instance config root.** The coordinator writes
   `$XDG_CONFIG_HOME/opencode/skills/<name>/SKILL.md` with deterministic frontmatter, using a JSON
   string literal for the description. It empties the legacy `skill/` alias, rebuilds every
   effective `<name>/` subtree, removes unexpected entries without following symlinks, and never
   touches the cache root. The first apply for an instance moves pre-existing entries outside the
   effective set to `opencode/skills-replaced/` and writes `.hanse-skills-initialized`; later
   applies remove unexpected entries. Every start reconciles from the database, so the agent cannot
   persist a planted skill across a restart.
4. **Probe before teardown, apply after teardown.** `probe` materializes into a coordinator-private
   temporary directory outside the agent-writable tree before any container teardown (a running
   agent must not be able to race the staging write with a symlink swap). After `runtime.delete`, `apply` rebuilds the live roots before
   `runtime.ensure`. A probe failure leaves a running container untouched; a post-teardown failure
   persists the instance as `error`. Materialization failures are `skills_materialize_failed`.
   `ensure` also refuses an application whose sanitized state segment collides with a sibling,
   mirroring the deletion guard, so two apps cannot share one skills root.
5. **Skills participate in the launch hash only when the effective set is non-empty.**
   `settingsHashFor(snapshot, profile, skillsHash?)` adds the `skills` key only when a hash exists.
   A zero-skill install keeps its previous hash. Effective-set changes mark affected running apps
   restart required; shadowed or disabled-body edits do not. Restarts are never automatic.
6. **Detect collisions with non-managed roots; do not promise precedence.** `apply` and `preview`
   scan repository `.opencode/skill(s)`, per-instance `.claude` and `.agents` roots, the cache
   skills root, and `file://` plugin `<root>/skills`, excluding the Hanse-owned config roots. They
   emit structured `skill_collision` and `skill_disabled_elsewhere` warnings, bounded to 20 with a
   `truncated` count. A same-named repository or plugin skill can shadow a managed skill; the
   managed skill is still written.
7. **Expose human-only scope surfaces.** Server-rendered pages at `/skills`,
   `/projects/:id/skills`, and `/projects/:id/apps/:appKey/skills`, with JSON under
   `/api/skills`. All routes are human-only; agent principals get `403`, mutations reject a
   cross-site `Origin`, and `return_to` is validated. Fragment saves use
   `x-hanse-fragment: skills` and return `{ok, surface, counts}`; delete uses a native
   confirmation dialog. Without JavaScript the same forms post and redirect. The `/api/skills*`
   routes accept up to 512 KiB request bodies, while the general HTTP bound stays 64 KiB, so a
   48,000-character non-ASCII skill fits a URL-encoded form.

## Consequences

Positive:

- Skills are operator configuration with one source of truth, audit timestamps, hierarchical
  overrides, and deletion integration. They do not travel with or modify managed repositories.
- Resolution and materialization are pure functions of the database, so a coordinator reconnect or
  a retry reaches the same set. The same effective set produces the same paths and bytes.
- A zero-skill installation keeps its launch hash, so deploying the feature does not mark existing
  agents restart required.
- Restart semantics match settings: changes are visible, explicit, and never interrupt a turn
  silently.
- Startup refuses sanitized state-segment collisions, so the per-instance skills root cannot be
  shared by two applications.
- Collisions with repository, plugin, and external roots are reported rather than silently losing a
  managed skill.

Negative / residual:

- There is no true override against repository, plugin, `~/.claude`, `~/.agents`, or cache roots.
  opencode does not define a stable duplicate winner across those roots.
- Only a single `SKILL.md` is supported. There are no bundles, scripts, binary assets, URL imports,
  per-agent allowlists, pagination, or version history and rollback.
- Skills require an explicit restart and are not hot-reloaded. `pendingRestart` hashes effective
  content per query, and first-deploy `skills-replaced/` directories are not cleaned automatically.
- Skills are plaintext operator instructions in the coordinator database, not a secret store.
- A restored database older than the agents volume can leave materialized files loaded in a running
  container until the next start; the next start reconciles them.
- The feature has been implemented and verified but not deployed from this checkout.
