# Design - Managed agent skills (global, project, application)

Status: **approved** - design review rounds 1-7 (`oracle`): CHANGES REQUESTED through round 6,
round 7 PASS (2026-10-22). Implementation permitted.
Scope: a coordinator-owned skill registry with global/project/application scopes, deterministic
materialization into each managed application instance, restart semantics, HTTP API, and Web UI.
Out of scope: implementation in this document; multi-file skill bundles (see section 10).

## 1. Problem

`opencode` discovers Agent Skills (`SKILL.md`) from several roots: the active project's
`.opencode/skills`, the global `~/.config/opencode/skills`, and the external
`~/.claude/skills` / `~/.agents/skills` directories. Hanse already isolates every application's
HOME/XDG and permits these roots through the external-directory policy, but it has no way to
define a skill once and inject it into every agent, or to vary a skill per project or application.

Operators must currently edit files inside each app container or commit skills into every
repository. That breaks the product's hierarchy model (settings already resolve
global -> project -> application), cannot be audited, and is lost when an app moves to a new
image or a fresh agents root.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| S1 | A skill is a named, described Markdown body that opencode loads as an Agent Skill. Skills can be defined at global, project, and application scope. |
| S2 | Effective **Hanse-managed** skills resolve global -> project -> application; a narrower row wins by name, and a narrower disabled row hides an inherited Hanse skill without deleting it. Repository, plugin, and external skill roots are outside this hierarchy and may shadow a same-named managed skill; that is detected and reported, never silent. |
| S3 | Every managed application receives exactly its effective enabled Hanse skills in its own isolated, coordinator-owned `opencode/skills` root before `opencode serve` starts; the legacy `opencode/skill` alias root is emptied, and no unexpected entry (top-level or nested) survives in either. No skill leaks between applications. |
| S4 | Materialization is deterministic and idempotent: the same effective set always produces the same paths and bytes; every entry in the Hanse-owned roots that is not part of the effective set is removed, including nested entries and entries created or tampered with by the agent. |
| S5 | A skill change marks every running affected agent restart-required; no agent is restarted silently. A restart applies the new set. |
| S6 | Humans can create, edit, enable/disable, delete, override, and revert skills from the Web UI at each scope, with progressive enhancement (forms work without JavaScript; saves can update in place). |
| S7 | The JSON API is human-only (agent principals `403`), validates names/descriptions/content, and never exposes anything beyond the skill itself. |
| S8 | App and project deletion remove the corresponding scoped rows; global skills and other scopes are preserved. |
| S9 | Existing agents, chat, settings, git, SSH, terminal, handoffs, deletion, and images are unaffected. In particular, an installation with no skills keeps its current settings hash and does not become restart-required. |
| S10 | The feature requires no new runtime dependency and stays within the existing Node/ESM/Tailwind/vanilla-JS stack. |

## 3. Verified upstream facts

Empirically verified against the locally installed `opencode-ai@1.18.35` (`opencode debug skill`),
whose skill loader matches the documented 1.19.3 behavior; the deployment pins 1.19.3.

- Global skills: `~/.config/opencode/skills/<dir>/SKILL.md` (also `skill/`).
- Project skills: `<cwd>/.opencode/skills/<dir>/SKILL.md` (also `skill/`).
- External auto-loaded roots: `~/.claude/skills/<dir>/SKILL.md`, `~/.agents/skills/<dir>/SKILL.md`.
- Extra roots can be declared with `skills.paths` (scanned recursively for `**/SKILL.md`) and
  `skills.urls`.
- Frontmatter: `name` (required; lowercase hyphen-separated, <= 64 chars), `description`
  (effectively required; a skill without it is never surfaced to the model), optional `license`,
  `compatibility`, `metadata`. The `name` field, not the directory name, is the identity; a mismatch
  still loads, but the documented convention is to match the folder.
- Skill content is the Markdown body below the frontmatter. Additional files are not indexed
  separately; a body may reference relative paths inside its own directory.
- Duplicate names: a project skill overrides a global skill with the same name (verified). The
  narrower scope wins.
- Config, agents, and skills are loaded once at process start and are not hot-reloaded. The
  built-in documentation explicitly requires a restart after changing a skill. Hanse therefore
  applies skills at instance start only.
- The existing permission policy already allows
  `<XDG_CONFIG_HOME>/opencode/skills`, `<XDG_CACHE_HOME>/opencode/skills`,
  `~/.claude/skills`, and `~/.agents/skills` for reads. No policy change is required.

## 4. Decisions

### D1 - Store skills in the coordinator DB, not in manifests or repositories

New table `skills`, mirroring the `settings` hierarchy:

```sql
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 64
    AND name GLOB '[a-z0-9]*'
    AND name NOT GLOB '*[^a-z0-9-]*'
    AND name NOT GLOB '*-'
    AND name NOT GLOB '*--*'
  ),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 48000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  ),
  UNIQUE (scope, project_id, app_key, name)
);
CREATE INDEX skills_scope ON skills(project_id, app_key);
```

Empty strings, not NULL, identify the wider scopes. This mirrors the existing `settings` and
`provider_keys` tables (migration v3), so the plain
`ON CONFLICT(scope, project_id, app_key, name)` upsert works, the scope invariant is enforced by
the database, and no `COALESCE` expression index is needed. There is deliberately no foreign key:
the settings precedent uses explicit deletes so global rows can use `''`; `#deleteAppRows` and
`#deleteProjectRows` delete `skills` in the same transaction (D6). `app_key` is the portable
application key, matching `apps.app_key`.

Why the DB: skills are operator configuration, not repository content. The precedent is
`settings` (ADR 0006); manifests stay portable and `.hanse/` remains coordinator metadata that
`opencode` never reads. This also gives atomic CRUD, audit timestamps, and deletion integration.

### D2 - Effective resolution is name-keyed and tombstone-aware

Resolution order: global, then project, then application. Rows are grouped by `name`; the narrowest
row wins. If the winning row has `enabled = 1`, the skill is effective at that scope. If it has
`enabled = 0`, the name is hidden at that scope unless a narrower enabled row overrides it (a
tombstone); wider rows are not deleted. A narrower enabled row can therefore re-enable a skill
disabled at a wider scope.

The response distinguishes:

- **effective** - enabled skills materialized into the instance, each with its winning scope and the
  wider scopes it shadows;
- **disabled here** - names hidden by a tombstone at this scope, with the winning wider source;
- **scoped rows** - exactly the rows owned by the page's scope, including disabled rows, used by the
  editor.

A skill name is immutable for a row. Renaming uses delete + create, which keeps override semantics
simple and avoids cascading identity changes.

#### D2.1 - Collisions with non-managed skill roots are explicit

opencode also loads `<appDir>/.opencode/{skill,skills}/**/SKILL.md`, the per-instance
`<HOME>/.claude/skills`, `<HOME>/.agents/skills`, `<XDG_CACHE_HOME>/opencode/skills`, and each
`file://` baseline plugin's `<root>/skills`. These roots are outside the Hanse hierarchy: a
same-named repository or plugin skill can shadow a managed skill, and no Hanse tombstone can hide
it. The design does not pretend otherwise.

`apply` and `preview` scan exactly these non-managed roots: `<appDir>/.opencode/skill` and
`.opencode/skills`, `<home>/.claude/skills`, `<home>/.agents/skills`,
`<xdgCacheHome>/opencode/skills`, and each `file://` baseline plugin's `<root>/skills` (plugin roots
derived the same way as `policy.ts`). The Hanse-owned
`<xdgConfigHome>/opencode/skill{,s}` roots are excluded: `apply` empties/rebuilds them, so they are
not a collision source and scanning them would make `preview` disagree with `apply`. Every Hanse
name is checked, **including disabled tombstones**: a scanned name that matches an effective skill
yields `skill_collision: "<name>" also exists at <root>`, and a scanned name that matches a disabled
tombstone yields `skill_disabled_elsewhere: "<name>" is disabled here but also exists at <root>`.
Warnings are bounded to 20; when more exist, the result carries `truncated: <omitted count>`.
Managed skills are still written and remain available under their own name where opencode does not
prefer another copy. A full precedence guarantee
across repository/plugin roots is **not** promised; opencode loads duplicate roots concurrently, so
duplicate-name winner selection is not a stable contract.

Delivery:

- the application-scope page (and `GET /api/skills?project=&app=`) calls `preview` with the app's
  resolved directory and isolated roots and renders the warnings on the affected skill and in the
  rail;
- global/project pages do not scan every app (bounded cost); they state that repository/plugin
  skills are outside the hierarchy and link to an application page for collision details;
- `apply` writes the same collision/invalid-name warnings to its result; the manager logs them
  (bounded) and the start/restart path can surface them without blocking.

### D3 - Materialize into Hanse-owned per-instance roots, probe before teardown

`InstanceManager.ensure` calls, in this order:

1. `SkillService.probe(target, xdgConfigHome, options)` after the running-reconnect early return and
   **before** any container teardown. `probe` resolves and validates the set, then performs the
   complete materialization into a coordinator-private temporary directory outside the
   agent-writable application tree (for example `mkdtemp(os.tmpdir()/hanse-skills-probe-)`; the
   running agent must not be able to race the staging write with a symlink swap), verifies every
   write, and removes the directory in a `finally`. It returns the hash and warnings. A probe failure aborts the start while the old
   container is untouched (A7).
2. after `runtime.delete` (the old agent process is gone) and before `runtime.ensure`,
   `SkillService.apply(target, xdgConfigHome, options)` rebuilds the live roots from the DB. It
   returns the same hash and warnings. `apply` is idempotent and never trusts the probe's files.

Output:

```text
<XDG_CONFIG_HOME>/opencode/skills/<name>/SKILL.md
<XDG_CONFIG_HOME>/opencode/skill/            # legacy alias: emptied
<XDG_CONFIG_HOME>/opencode/skills-replaced/  # one-time preservation, see below
```

The `SKILL.md` is generated with deterministic YAML frontmatter plus the body. The description is
emitted as a JSON string literal, which is a valid YAML double-quoted scalar and cannot break the
document:

```markdown
---
name: <name>
description: "<JSON-escaped description>"
---

<body>
```

`apply`:

1. resolves the effective set and common warnings (D2.1). Resolution is the **single** place that
   validates stored names; an invalid row (possible only through a restored/hand-edited or
   check-disabled DB) is excluded from the effective set and reported as
   `invalid_skill_name: #<id>`; `resolve`, `hash`, `preview`, and `apply` therefore agree exactly;
2. ensures `<XDG_CONFIG_HOME>/opencode` and both `skills/` and `skill/` exist as real directories
   inside the application's isolated root; a symlink or non-directory at either path is unlinked and
   recreated;
3. one-time preservation: if `<XDG_CONFIG_HOME>/opencode/.hanse-skills-initialized` is absent, moves
   every unexpected top-level entry (in both roots) to
   `<XDG_CONFIG_HOME>/opencode/skills-replaced/<name>` instead of deleting it, appends the name to
   the result's `preserved` list, then writes the marker. This protects operator-installed skills that
   existed before this feature. After the marker exists, unexpected entries are removed;
4. removes every top-level entry in `skill/` (legacy alias) and every top-level entry in `skills/`
   whose name is not effective: `lstat` first (a symlink is unlinked as a link; a directory's
   `realpath` must stay under the root), never follow a planted link;
5. for each effective name, removes the **entire** `<name>/` subtree (without following symlinks;
   `lstat` first, so a symlink or file at the effective path is unlinked, not followed) and recreates
   it, then writes `SKILL.md` atomically (`O_CREAT|O_EXCL|O_NOFOLLOW` temp file + `rename`, file
   `0644`, directory `0755`). Removing the whole subtree is required because opencode scans
   `{skill,skills}/**/SKILL.md` recursively: a planted `<name>/nested/SKILL.md` must not survive;
6. returns a stable SHA-256 hash of the effective set (`name`, `description`, `content`, sorted by
   name) or `undefined` when the set is empty, plus the warnings;
7. throws `skills_materialize_failed` on I/O failure so the instance is not started with a silent
   partial set. A failure after teardown also persists the instance as `error` (never a stale
   `running` row) before the error is rethrown. Cleanup tolerates a missing entry (crash retry) and
   is idempotent.

`probe` uses exactly the same step 1/4/5 code path against a coordinator-private temporary root,
removed in a `finally`, so `probe().hash === apply().hash` and the collision/invalid-name warnings
are identical for the same target and DB. First-deploy preservation is apply-only and is reported through the separate
`preserved` list, not through warnings; live-root removals likewise appear only in `apply().removed`.

The `<XDG_CONFIG_HOME>/opencode/{skills,skill}` roots are **owned by Hanse**: they are per-instance
state directories, not user or agent workspaces. Provenance comes from the DB, not from the
filesystem: every start rebuilds the complete set after teardown, so an agent cannot persist a
planted skill (top-level or nested) across a restart and a deleted skill cannot survive. No
opencode-core write into either root was found in the pinned source (auth lives under XDG data,
downloaded skills under XDG cache, config-loader writes are top-level files such as
`.gitignore`/plugin dependencies).

The manager additionally refuses to start an application whose sanitized state segment
(`sanitizeAppKey(projectId)/sanitizeAppKey(appKey)`) collides with a sibling, because such apps would
share one skills root; the deletion flow already rejects this collision class. The coordinator runs
as uid 1000 and the app container also runs as uid 1000; the agents root is owned by 1000, so
`0755`/`0644` is readable and the file modes do not pretend to be a security boundary. If a deployment runs the coordinator as a different uid, it must be able to own/write the
agents volume; the existing agents-root ownership requirement is unchanged. See D2.1 for roots that
Hanse does not own.

Why the config root: opencode loads it natively, it is already inside the trusted permission roots,
and it is per-instance, so project/app isolation is preserved without changing the overlay or the
container spec.

### D4 - Restart semantics: skills participate in the launch hash, but empty skills do not

`SkillSource.hash(target)` returns `string | undefined`; `apply` returns the same value. The hash is
over the effective **enabled** set only: `{name, description, content}` sorted by name. It is
`undefined` exactly when the effective set is empty. `settingsHashFor(snapshot, profile,
skillsHash?)` includes a `skills` key only when `skillsHash` is defined, and both call sites
(`ensure` and `#pendingRestartFor`) pass the same value. Therefore:

- an installation with no skills keeps the exact previous hash and no agent becomes restart-required
  merely because this feature was deployed;
- adding, editing, enabling, disabling, or deleting a skill that changes the **effective** set
  changes the hash for every affected running app and surfaces the existing `Restart required`
  state;
- editing a shadowed row or editing the body of a disabled tombstone does **not** change the
  effective set and therefore does not mark any agent restart-required; enabling that row does;
- the existing explicit restart action applies the new set (skills are re-materialized by `ensure`).

`apply().hash` must equal `hash()` for the same target; a test asserts this equality. Hashing reads
the effective rows in one query and is O(number of effective skills × body size); the projected
practical bound is tens of skills per app, and no content is hashed when the set is empty. If the
dashboard later proves this hot, a revision-keyed memo can be added without changing the contract.

`pendingRestart` continues to report `settings_changed`; the UI copy is broadened to
"Settings or skills changed". No new durable column is needed. Materialization and hashing are
pure functions of the DB, so a coordinator reconnect/reconcile reaches the same answer. Reconnect
(`ensure`'s running early-return) intentionally does not re-materialize: a running agent is already
using the loaded set, and the restart-required marker is the only way it changes.

### D5 - Human-only API and scope-aware server-rendered pages

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/skills`, `/projects/:id/skills`, `/projects/:id/apps/:appKey/skills` | server-rendered scope pages |
| `GET` | `/api/skills?project=&app=` | JSON resolution for the scope |
| `GET` | `/api/skills/:id` | one row (editor hydration) |
| `POST` | `/api/skills` | `action=create` (409 `skill_exists` on a name conflict) or `action=override&from_id=<id>&enabled=1\|0` |
| `POST` | `/api/skills/:id` | update `description`, `content`, `enabled` |
| `POST` | `/api/skills/:id/delete` | delete (form), `DELETE /api/skills/:id` for JSON |

Scope/target for `POST /api/skills` is explicit: `scope=global|project|app` plus `project` and `app`
fields (query or body). A missing/widened combination is `400 invalid_scope_target`; an app target
requires both. `create` never overwrites an existing `(scope, target, name)` row; `override` is the
explicit copy/enable action and may replace a row at the target scope.

All are human-only: browser requests without a human session redirect to `/login`; agent principals
receive `403` on every route, including fragment responses. Mutations accept form encoding and JSON,
validate the same payload, and reject a cross-site `Origin` (same Host origin or no Origin; reject
`Origin: null`) for **all** form and JSON mutations. `return_to` is validated as a same-origin
absolute path (no scheme, no `//host`, no backslashes) exactly like `safeLocalPath`; resubmitting
`/login` is not allowed. The skills routes accept a 512 KiB request body (the general
server bound stays 64 KiB) so a 48,000-character non-ASCII skill still fits a URL-encoded form;
per-field validation still caps `content` at 48,000 characters. A browser mutation with `x-hanse-fragment: skills` returns
`application/json` `{ok:true, surface:"<div id=\"skills-surface\">…</div>", counts:{effective,defined}}`;
otherwise it returns `303` to the validated `return_to` with a `notice` toast. JSON callers receive `{ skill }` / `{ deleted: true }` with `400`
validation, `401`/`403` auth, and `404` unknown. All responses are `cache-control: no-store`.

Validation (server-side, before hashing or writing; stable `400` codes):

- `create` requires `name`, `description`, `content`; `update` validates only the supplied patch
  fields (`description`, `content`, `enabled`); `override` derives the name and body from `from_id`
  and takes only an optional `enabled` flag (default `true`);
- `name`: trim, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1..64 characters;
- `description`: trim, 1..1024 characters, no control characters, single line. "Covers what the skill
  does and when to use it" is authoring guidance shown in the UI, **not** machine validation;
- `content`: trim, 1..48,000 characters, no NUL; Markdown text. The UI renders it only inside a
  `<textarea>` and never assigns skill text through `innerHTML`;
- `enabled`: boolean.

The page is a first-class scope surface, not a settings section: skills are content, not scalar
configuration, and editing benefits from a larger editor. The shell gains a `Skills` nav item whose
href is scope-aware exactly like `Settings` (`/skills` from global pages, the project page from a
project, the app page from an app). The scope switcher shows Global, the current project, and the
current application (when the URL supplies them); `/skills` alone shows Global only.

"Effective here" is explicitly **Hanse-effective at this scope**: global page = global rows;
project page = global + project rows (per-app overrides are not considered); application page =
global + project + application rows. The page labels the project case as such.

### D6 - Delete integration and lifecycle

- Application deletion runs `DELETE FROM skills WHERE scope = 'app' AND project_id = ? AND
  app_key = ?` inside `#deleteAppRows` (the same transaction that removes settings/provider keys).
  Re-adding an application with the same key must start with no app-scoped skills.
- Project deletion runs `DELETE FROM skills WHERE project_id = ?` inside `#deleteProjectRows`, and the
  app cascade covers rows for every app. Global rows (`project_id = ''`) survive.
- The per-app materialized directory is under the app agents root, which the existing deletion flow
  already removes (the app state root is the whole `<agents>/<project>/<app>` tree, including
  `config/`). A skill deletion or disable is reconciled by the next start (D3).
- Migration v12 is additive. Verified against a database at v11 with `foreign_keys = ON`; the
  migration runner's checksum/version behavior is unchanged. Downgrades are not a supported
  operation; older code ignores the table.
- B1 host-path mode: `apply` writes the coordinator-visible path returned by `resolveInstanceEnv`
  (`this.#runtimeRoot`), which is the same agents volume the runner mounts at `hostAgents`; no
  host-path translation is introduced for skills. The plan includes a host-path-mode check.
- A coordinator DB restore older than the agents volume can leave materialized files loaded in a
  running container; the next start reconciles them. This is the same restart boundary as any skill
  change and is documented, not silently repaired while running.

## 5. Shared interfaces

```ts
// src/skills/types.ts
export type SkillScope = "global" | "project" | "app";

export interface SkillRow {
  id: number;
  scope: SkillScope;
  /** `''` for wider scopes, matching the DB scope key. */
  projectId: string;
  /** `''` unless scope = "app". */
  appKey: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface EffectiveSkill {
  /** id of the winning enabled row (used by override/disable actions). */
  id: number;
  name: string;
  description: string;
  content: string;
  /** Scope of the winning row. */
  source: SkillScope;
  /** Wider scopes shadowed by this skill, wide to narrow. */
  shadows: SkillScope[];
}

export type SkillWarningCode =
  | "skill_collision"
  | "skill_disabled_elsewhere"
  | "invalid_skill_name";

export interface SkillWarning {
  code: SkillWarningCode;
  name?: string;
  root?: string;
  id?: number;
}

export interface ResolvedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  /** Rows owned by the page's scope, including disabled tombstones. */
  rows: SkillRow[];
  /** Names hidden by a tombstone at this scope; `id` is the tombstone row. */
  disabled: Array<{ id: number; name: string; source: SkillScope | null; disabledBy: SkillScope }>;
  warnings: SkillWarning[];
}

export interface SkillInput {
  name?: string;
  description: string;
  content: string;
  enabled?: boolean;
}

/** Partial patch for `POST /api/skills/:id`; only supplied fields are validated and written. */
export interface SkillUpdate {
  description?: string;
  content?: string;
  enabled?: boolean;
}

export interface SkillTarget { projectId?: string; appKey?: string }

export interface SkillApplyOptions {
  /** Isolated application root; the skills root must stay inside it. */
  appRoot: string;
  /** Isolated HOME, for `.claude`/`.agents` collision detection. */
  home: string;
  /** Isolated cache root, for downloaded-skill collision detection. */
  xdgCacheHome: string;
  /** Resolved application directory for repository-skill collision detection. */
  appDir: string;
  /** Baseline plugin specs, used exactly as the permission policy resolves `file://` skill roots. */
  baselinePlugins?: string[];
}

export interface SkillPreview {
  resolved: ResolvedSkills;
  /** Repository/plugin/external collisions, including disabled-tombstone collisions. */
  warnings: SkillWarning[];
  /** Number of warnings omitted by the 20-entry bound, when truncated. */
  truncated?: number;
}

export interface SkillMaterializeResult {
  hash: string | undefined;
  written: string[];
  removed: string[];
  preserved: string[];
  warnings: SkillWarning[];
  truncated?: number;
}

export interface SkillSource {
  resolve(target: SkillTarget): ResolvedSkills;
  /** Read-only collision preview; never writes. */
  preview(target: SkillTarget, options: SkillApplyOptions): SkillPreview;
  /** Effective enabled-set hash; `undefined` exactly when the effective set is empty. */
  hash(target: SkillTarget): string | undefined;
  /** Validate and materialize into a private staging root; removes it before returning. */
  probe(target: SkillTarget, xdgConfigHome: string, options: SkillApplyOptions): SkillMaterializeResult;
  /** Rebuild the live roots from the DB; call only after the old container is gone. */
  apply(target: SkillTarget, xdgConfigHome: string, options: SkillApplyOptions): SkillMaterializeResult;
}
```

`SkillService` implements `SkillSource` plus `get(id)`, `create(scope, target, input, actor)`,
`update(id, patch, actor)`, `override(fromId, scope, target, enabled, actor)`, and
`delete(id, actor)`. `create` inserts and throws `SkillConflictError` (HTTP `409 skill_exists`)
when `(scope, projectId, appKey, name)` exists. `override(fromId, scope, target, enabled, actor)`
copies the enabled source row visible at the target scope into a new row at the target scope, with
`enabled` defaulting to `true` and `false` producing a tombstone; a disabled source row or a source
not visible at the target is `400 invalid_override_source`. It is the only operation that may
insert-or-replace by name. `update(id, patch)` changes only the supplied fields by id, so
`{enabled:true}` and `{enabled:false}` toggles are valid without resending the body; `delete` is by
id. `InstanceManagerOptions` gains `skills?: SkillSource`; the manager calls `probe` before
teardown and `apply` after `runtime.delete`, passes `apply`'s hash to `settingsHashFor`, and logs the
warnings. `#pendingRestartFor` calls `hash()` and passes the same-shaped value; tests assert
`probe().hash === apply().hash === hash()` and that `preview` returns the same collision warnings as
`apply` without writing.

## 6. UI design

Scope pages share one surface component:

- **Header**: page title `Skills`, a scope line (`Global` / `Project: <name>` /
  `Application: <project> / <app>`), and a short explanation of inheritance and restart behavior.
- **Scope switcher**: Global / Project / Application, with only the scopes that exist for the
  current target; the current scope is marked. This mirrors the settings scope nav.
- **Primary card "Effective here"**: one row per effective Hanse skill with name (mono), description,
  source badge (`Global`, `Project`, `Application`), an `Overrides global/project` note when
  applicable, a `Shadowed by <root>` warning when `apply`/preview detected a repository, plugin, or
  external collision, and actions: `Edit here` (if owned by this scope), `Override here` (copy
  inherited content into this scope), `Disable here` (tombstone), `Open at source` (link to the
  source page). `Override here` is offered only for an enabled inherited skill.
- **Card "Defined at this scope"**: enabled and disabled rows owned here, with edit, enable/disable,
  and delete. A disabled row is labelled `Disabled here` and explains that it hides an inherited
  skill. Its `Enable here` action re-enables that row by id (`POST /api/skills/:id` with
  `enabled=true`); it never calls `create`, so it cannot hit the `409 skill_exists` conflict. A
  narrower `Disable here` on an inherited skill creates a tombstone row at this scope (via
  `override(fromId, ..., enabled=false)`). Delete opens a native confirmation dialog
  (`Delete "<name>"? This cannot be undone.`); it is never a one-click action.
- **Disabled inherited list**: names hidden by this scope's tombstones (each entry carries the
  tombstone `id`), with `Enable here` (re-enable the row, keeping its body) and `Revert to
  inherited` (delete the tombstone and inherit the wider row).
- **New skill**: a brass `New skill` action opens a native `<dialog>` with name, description
  (with a live counter), a monospace Markdown body textarea, an `Enabled` switch, and inline field
  errors. `Insert example` prefills a valid skeleton. The dialog degrades to a normal form.
- **Empty state**: explains that skills are reusable procedures and offers `Create the first skill`.
- **Rail**: a compact `How it works` card (resolution order, restart, repository/plugin shadowing),
  a count summary (`N effective · M defined here`), and, when the scope's running apps are stale, a
  `Restart required` note linking to the existing app restart action. Staleness is computed with
  `manager.pendingRestart` over all apps for global scope, the current project's apps for project
  scope, and the current app for application scope.
- **Editing**: one expanded editor per row (`<details>`), with `Save`, `Cancel`, and `Delete`.
  Saves send `x-hanse-fragment: skills`; the client swaps `#skills-surface`, restores focus, the
  open row, scroll position, and the URL hash, then shows the existing toast. Without JavaScript the
  same form posts and redirects.
- Skills are displayed as text; nothing is rendered as HTML. Skill text is only ever written into a
  `<textarea>` via `textContent`/escaped server HTML, never `innerHTML`. Long bodies stay in a
  fixed-height textarea, never in the page flow.

Responsive rules follow the established shell: the rail stacks below the main column under 1024,
the scope switcher scrolls horizontally under 640, and dialogs are full-width sheets under 640.

## 7. Alternatives considered

- **Files in `.hanse/skills/` manifests or repositories.** Rejected: violates portability, would make
  skills part of the app contract, and gives no project/app override UI or audit.
- **A single `skills.paths` entry pointing at a coordinator-authored directory.** Rejected: requires
  an overlay change, exposes a coordinator path to every container, and complicates isolation. The
  native per-instance config root already works.
- **Store the complete `SKILL.md` text and edit frontmatter by hand.** Rejected: invalid frontmatter
  would silently hide a skill. Separate fields let the coordinator generate valid frontmatter.
- **Restart agents automatically on skill change.** Rejected: contradicts the explicit-restart model
  used by settings and would interrupt active chat turns.
- **A per-agent skill allowlist.** Rejected for this stage: opencode exposes all discovered skills to
  every agent; scope is the selection mechanism. Per-agent selection would be a separate feature.
- **Multi-file skill bundles in v1.** Deferred: a single body covers instruction/procedure skills;
  bundles need a file editor, path validation, and a materialization model. The schema and
  materializer are written so files can be added later without changing scope semantics.

## 8. Owner decisions (resolved autonomously)

The owner delegated all decisions for this stage. Recorded here instead of blocking:

- **D8.1** - Store skills in coordinator SQLite, not manifests. Rationale: matches settings; keeps
  repositories portable; enables hierarchy and deletion.
- **D8.2** - Materialize into the Hanse-owned `<XDG_CONFIG_HOME>/opencode/skills`; keep the
  repository `.opencode/skills` untouched. Managed scope resolution is authoritative only among
  Hanse rows; repository/plugin/external duplicates are detected and warned, not overridden (D2.1).
- **D8.3** - Restart required, never automatic restart.
- **D8.4** - Empty skill sets do not alter the existing launch hash (safe rollout).
- **D8.5** - Single-file skills in this stage; multi-file bundles are a follow-up.
- **D8.6** - Disabled rows are tombstones, not deletions, so inheritance can be reverted without
  retyping content.

## 9. Risks and mitigations

- **Duplicate name with a repository, plugin, or external skill.** opencode's duplicate winner across
  roots is not a stable contract (loads run concurrently); a repository/plugin skill can shadow a
  managed one. Mitigation: `apply` and the page scan the reachable roots and report
  `skill_collision` warnings; the UI labels "Hanse-effective", and docs state the boundary. This is
  an explicit limitation, not a silent failure.
- **Agent tampering with its own skill root.** Mitigated by probing before teardown and rebuilding
  both roots only after the old container is gone (D3), with `lstat`/`realpath`/symlink handling and
  full subtree replacement; the agent has no live process during the rebuild. The agent can change
  files in its running container, but opencode loads them only at start and the next start rebuilds
  from the DB.
- **First-deploy data loss.** The first `apply` for an instance preserves pre-existing entries under
  `opencode/skills-replaced/` and reports them in `preserved` instead of deleting them (D3); later
  applies remove unexpected entries. The deployment notes mention the one-time move.
- **Partial materialization.** Mitigated by writing before container start and failing closed;
  cleanup tolerates missing entries and the next apply repairs a crash mid-run.
- **Large pages.** Content is included once per scoped row; validation caps each body at 48,000
  characters. The list itself is not paginated in v1; realistic skill counts are small.
- **Concurrent edits.** Last write wins; the row's `updatedAt` is shown in the editor. No optimistic
  locking in v1 (single operator).
- **Secret material.** Skills are operator-authored instructions, not secrets; they are stored in
  plaintext in the coordinator DB, like project/app names. Docs must not encourage secrets in skills.
- **DB/agents-volume drift.** A restored DB or agents volume can disagree until the next start;
  `apply` reconciles from the DB, and a running agent is never mutated behind its back.

## 10. Non-goals

- Per-agent assignment, skill marketplaces, URL imports, or `skills.urls`.
- Multi-file bundles, scripts, or binary assets.
- Version history, diffs, or rollback of skill content (beyond the existing agent image rollback).
- Hot reload into a running agent.
- Changing opencode's built-in skill discovery or the external `~/.claude`/`~/.agents` roots.
- Guaranteeing that a managed skill wins over a same-named repository/plugin/external skill.

## 11. Acceptance criteria (verifiable)

Each item is a test or an inspected artifact; the plan maps them to test files.

| ID | Acceptance check |
| --- | --- |
| A1 | With zero skills, `settingsHashFor(snapshot, profile, undefined)` equals the pre-feature hash shape and the persisted applied hash for a running instance is unchanged, so no agent becomes restart-required after the upgrade. |
| A2 | Global/project/app rows with the same name resolve to the narrowest enabled row; a narrower tombstone hides the wider skill; a narrower enabled row re-enables it. |
| A3 | Two consecutive `apply` calls for the same target produce the same relative paths, the same bytes, and the same hash; `probe().hash === apply().hash === hash()`; collision/invalid-name warnings from probe and apply are equal; a second apply adds no entries. |
| A4 | Removing/disabling a skill deletes its directory on the next `apply`; entries planted in `skills/`, in the legacy `skill/` alias, and nested at `skills/<effective-name>/nested/SKILL.md` are removed without following symlinks; a non-`SKILL.md` top-level file is removed. On the first apply of a fresh instance, pre-existing entries are moved to `skills-replaced/` and reported, not deleted. |
| A5 | The description edge cases (`a: b`, `#`, quotes, backslash, Unicode) produce parseable frontmatter and the expected description after a real `opencode debug skill` load. |
| A6 | A changed effective set marks only affected running apps restart-required; editing a shadowed/disabled row does not; the restart action applies the new set. |
| A7 | A `probe` failure aborts the start before any teardown, leaving a previously running container running; a post-teardown `apply` failure aborts the start with `skills_materialize_failed` and leaves the app stopped with the failure visible. |
| A8 | App deletion removes its app-scoped rows; project deletion removes its rows; re-adding the same app key shows no old app-scoped skills; global rows survive. |
| A9 | Every page and API route is human-only: anonymous browser requests redirect, anonymous JSON gets 401, agent principals get 403 (including fragments), and a cross-site Origin is rejected on every mutation. |
| A10 | `return_to` rejects schemes, `//host`, and backslashes; skill text is HTML-escaped in the textarea and in fragment responses. |
| A11 | A repository `.opencode/skills` skill with an effective managed name yields `skill_collision`; a repository skill matching a tombstoned managed name yields `skill_disabled_elsewhere`; preview returns them without writing; the managed skill is still written. |
| A12 | Migration v12 applies on a real v11 database with `foreign_keys = ON`; `runMigrations` is a no-op on a second run; existing settings/provider/git/SSH/deletion tests stay green. |
| A13 | The DB check rejects an invalid name at insert; a forged row injected with check constraints disabled is excluded from `resolve`/`hash`/`preview`/`apply` with `invalid_skill_name` and never used as a path; `preview` never writes. |
| A14 | The four repository gates pass: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; a real `opencode debug skill` run against a materialized root lists the managed skills with the expected names/descriptions. |

## 12. Design review record

Round 1 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Blockers and majors were addressed in
revision 2:

- app/project scope vs repository/plugin precedence: now an explicit "Hanse-effective" contract with
  collision detection and warnings (S2/S3, D2.1, D8.2, A11);
- YAML frontmatter injection: description is emitted as a JSON string literal (D3, A5);
- untrusted manifest: removed; the config root is Hanse-owned and fully reconciled each start, with
  symlink/containment handling (S3/S4, D3, A4);
- app-scope orphan rows: explicit deletes in `#deleteAppRows`/`#deleteProjectRows` (D1/D6, A8);
- schema: an empty-string scope key, a real `UNIQUE` constraint, DB `CHECK` invariants, and a plain
  `ON CONFLICT` upsert (D1, A12);
- restart hash: `string | undefined`, one shared hash argument at both call sites, and hash-over-
  effective-set semantics, including "editing a shadowed row does not restart" (D4, A1/A6);
- exact `ensure` insertion point and failure behavior (D4, D3, A7);
- external/plugin root precedence: declared unverified for duplicate resolution, with warnings (D2.1,
  A11);
- acceptance criteria added (section 11).

Round 2 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Revision 3 addresses the remaining items:

- the legacy `opencode/skill` alias root is now emptied, and each effective skill directory is
  rebuilt from scratch so nested `SKILL.md` files cannot survive (S3/S4, D3, A4);
- the atomic temp file uses `O_CREAT|O_EXCL|O_NOFOLLOW`, and the effective path is replaced without
  following a link (D3, A4);
- collision detection has a read-only `preview`, covers tombstoned names, and is delivered on the
  application page/API; global/project pages state the limitation instead of scanning every app
  (D2.1, interfaces, A11, A13);
- the name regex is in the DB `CHECK` and is re-validated before use as a path segment (D1, D3,
  A13);
- `SkillRow` uses the empty-string scope key, matching the schema (interfaces);
- acceptance criteria A1/A3/A4/A11 were tightened and A13/A14 added.

Round 3 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Revision 4 addresses the remaining items:

- apply-before-teardown race: `probe` now materializes into a private staging root before teardown
  and the live roots are rebuilt only after `runtime.delete` (D3, A3/A7);
- `hash`/`apply` divergence on invalid stored rows: stored-name validation lives in one shared
  resolution step used by `resolve`/`hash`/`preview`/`apply` (D3, A13);
- collision preview roots were enumerated and the Hanse-owned roots excluded; warnings are structured
  (`SkillWarning`) and tombstone collisions are covered (D2.1, interfaces, A11);
- the POST contract now has an explicit scope/target and `409 skill_exists`; only `override` updates
  an existing name (D5);
- first-deploy preservation moves pre-existing per-instance entries to `skills-replaced/` with a
  marker and `preserved` results (D3, A4);
- minor wording/type contradictions were corrected (D2, D3 step 5).

Round 4 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Revision 5 addresses the remaining items:

- first-apply preservation is reported only in `preserved`, so `probe`/`apply` collision and
  invalid-name warnings are identical (D3, A3);
- "Enable here" re-enables the existing tombstone by id and never calls `create` (UI, D5);
- collision roots now exactly match the verified facts: the unverified `<home>/.opencode` root was
  removed (D2.1, plan);
- a post-teardown `apply` failure persists the instance as `error` before rethrowing (D3, A7);
- warning truncation is represented by `truncated?: number` on preview/materialize results (D2.1,
  interfaces).

Round 5 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Revision 6 addresses the remaining items:

- the last unverified `<HOME>/.opencode` mention was removed from D2.1's prose (D2.1);
- `POST /api/skills/:id` now takes a partial `SkillUpdate` patch (including `enabled` alone), so
  Enable/Disable toggles do not resend the body; `override` is the only insert-or-replace-by-name
  operation (interfaces, D5);
- disabled-list entries now carry the tombstone `id`; `Enable here` moved to the scoped disabled
  row / disabled list, where that row actually exists (UI, interfaces).

Round 6 (`oracle`, 2026-10-22): **CHANGES REQUESTED**. Revision 7 addresses the remaining items:

- `override` now takes an optional `enabled` flag, so creating a narrower tombstone is a defined
  operation; the route/validation/UI wording match (interfaces, D5, UI);
- the last `.opencode`-under-HOME attribution was removed from the `SkillApplyOptions.home` comment
  (interfaces).

Round 7 (`oracle`, 2026-10-22): **PASS**; no remaining blocker or major.

Post-approval security hardening (2026-10-22): a separate security review moved probe staging into
a coordinator-private temporary directory outside the agent-writable tree, added the sanitized
state-segment collision guard at `ensure`, and limited the enlarged request-body bound to
`/api/skills*`. No architectural change; the review found no XSS, SQL injection, auth bypass, CSRF,
or redirect issue.
