# Plan 0015: Managed agent skills (global, project, application)

- Status: implemented, verified, and deployed as `sha-33523f1` (journal 0018)
- Design: [`docs/design/agent-skills.md`](../design/agent-skills.md) (oracle round 7 PASS)
- Design reviewer: `oracle` - PASS
- Plan reviewer: `momus`
- Owner decisions: resolved autonomously; design section 8
- Date: 2026-10-22

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0015-agent-skills` |
| Design artifact | `docs/design/agent-skills.md` |
| Plan artifact | `docs/plans/0015-agent-skills.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0018-agent-skills.md`; index `docs/journal/README.md` |
| Decision record | `docs/decisions/0011-managed-agent-skills.md`; index if present |
| Open questions | none; design section 8 records the resolved decisions |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Extra verification | empirical `opencode debug skill` load against a materialized root; manual UI capture at 1440/390 |
| Commit policy | one coherent stage commit (code + tests + docs + record); autonomous mode may commit and push |
| Deploy | not part of this plan; record deployment separately if performed |

## Global invariants

- Migration v12 is additive. Existing schema versions become `[1..12]`; a second `runMigrations`
  is a no-op; a v11 database migrates in place with `foreign_keys = ON`.
- No new runtime dependency. TypeScript ESM/NodeNext, `.js` relative imports; assets are plain
  classic scripts, no bundler. The `/api/skills*` routes accept up to 512 KiB (the general
  server bound stays 64 KiB) so a 48,000-character non-ASCII skill fits a URL-encoded form;
  per-field validation still caps content.
- The effective skills hash is `undefined` exactly when the effective enabled set is empty.
  `settingsHashFor` omits the `skills` key when the hash is undefined, so a zero-skill install keeps
  its previous launch hash byte-for-byte.
- `apply().hash === hash()` for every target; both hash only `{name, description, content}` of
  effective enabled skills, sorted by name.
- `<XDG_CONFIG_HOME>/opencode/{skills,skill}` are Hanse-owned: `apply` empties `skill/`, rebuilds
  every effective `<name>/` subtree, and removes every other entry with `lstat`/`realpath`
  containment and no symlink following. `<XDG_CACHE_HOME>/opencode/skills` is never touched.
- On start, `probe` (staging root) runs after the running-reconnect early return and before any
  `runtime.delete`; the live roots are rebuilt by `apply` only after the old container is gone and
  before `runtime.ensure`. Reconnect never rewrites a running agent's files.
- Skill text is always escaped in HTML/textareas; no skill field is assigned through `innerHTML`.
- All `/skills*` pages and `/api/skills*` routes are human-only; agent principals get `403`, and
  every mutation rejects a cross-site `Origin`.
- Existing settings, chat, git, SSH, terminal, handoffs, images, and deletion behavior is unchanged
  when no skills exist.

## Shared interfaces (implement first)

```ts
// src/skills/types.ts
export type SkillScope = "global" | "project" | "app";
export interface SkillTarget { projectId?: string; appKey?: string }
export interface SkillRow {
  id: number; scope: SkillScope; projectId: string; appKey: string;
  name: string; description: string; content: string; enabled: boolean;
  createdAt: string; updatedAt: string; updatedBy: string | null;
}
export interface EffectiveSkill {
  id: number; name: string; description: string; content: string;
  source: SkillScope; shadows: SkillScope[];
}
export type SkillWarningCode =
  | "skill_collision" | "skill_disabled_elsewhere" | "invalid_skill_name";
export interface SkillWarning {
  code: SkillWarningCode; name?: string; root?: string; id?: number;
}
export interface ResolvedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  rows: SkillRow[];
  disabled: Array<{ id: number; name: string; source: SkillScope | null; disabledBy: SkillScope }>;
  warnings: SkillWarning[];
}
export interface SkillInput { name?: string; description: string; content: string; enabled?: boolean }
export interface SkillUpdate { description?: string; content?: string; enabled?: boolean }
export interface SkillApplyOptions {
  appRoot: string; home: string; xdgCacheHome: string; appDir: string;
  baselinePlugins?: string[];
}
export interface SkillPreview {
  resolved: ResolvedSkills; warnings: SkillWarning[]; truncated?: number;
}
export interface SkillMaterializeResult {
  hash: string | undefined; written: string[]; removed: string[]; preserved: string[];
  warnings: SkillWarning[]; truncated?: number;
}
export interface SkillSource {
  resolve(target: SkillTarget): ResolvedSkills;
  preview(target: SkillTarget, options: SkillApplyOptions): SkillPreview;
  hash(target: SkillTarget): string | undefined;
  probe(target: SkillTarget, xdgConfigHome: string, options: SkillApplyOptions): SkillMaterializeResult;
  apply(target: SkillTarget, xdgConfigHome: string, options: SkillApplyOptions): SkillMaterializeResult;
}
// src/skills/index.ts re-exports types + SkillService + SkillValidationError + SkillConflictError
```

`SkillService` (constructor `{db, now?}`) additionally exposes `get(id)`, `create(scope, target,
input, actor)`, `update(id, patch, actor)`, `override(fromId, scope, target, enabled, actor)`, and
`delete(id, actor)`. `update` validates only the supplied patch fields, so `{enabled:true}` and
`{enabled:false}` are valid partial updates. `SkillValidationError` carries `code = "VALIDATION"` for HTTP 400;
`SkillConflictError` carries `code = "skill_exists"` for HTTP 409.

`InstanceManagerOptions` gains `skills?: SkillSource`. `HttpDeps` gains `skills?: SkillService`,
`agentsHome?: string`, and `baselinePlugins?: string[]` (serve passes the resolved agents root and
`resolveBaselinePlugins()`; tests may omit `agentsHome`, in which case app-scope preview scans only
the repository roots).

## Phase 1 - Data layer, resolution, materialization, collisions

Boundaries: `src/store/migrations.ts`, `src/skills/**`, `test/skills-store.test.ts`,
`test/migrations.test.ts`, `test/store.test.ts`. No manager, HTTP, or UI work.

Work:

1. Migration v12: `skills` table exactly as design D1 (empty-string scope key, `UNIQUE(scope,
   project_id, app_key, name)`, scope/`length` **and name-regex** `CHECK`s, `id INTEGER PRIMARY KEY
   AUTOINCREMENT`, `skills_scope(project_id, app_key)` index, no FK). `SkillRow.projectId`/`appKey`
   are strings (`''` for wider scopes). Update migration-count tests.
2. `src/skills/types.ts`, `src/skills/validation.ts`: validate name/description/content/enabled;
   trim; reject control characters in description; stable error messages.
3. `src/skills/service.ts`:
   - one shared `normalizeTarget`/`normalizeScope` used by every method; global = `''` keys;
   - versioned name validation in the **shared resolve step**: a stored invalid name is excluded
     from `effective` and reported as `{code:"invalid_skill_name", id}` (so resolve/hash/preview/
     apply agree);
   - `create` inserts only and throws `SkillConflictError` on conflict; `override(fromId, ...,
     enabled)` copies the resolved enabled content into the target scope and is the only
     insert-or-replace-by-name path (`enabled=false` creates a tombstone); `update` changes only supplied description/content/enabled fields by id (including
     a tombstone `{enabled:false}` / `{enabled:true}` toggle); `delete` by id; actor + timestamps;
   - `resolve`: rows for global -> project -> app, narrowest row per name, tombstones, `shadows`,
     `disabled`, warnings;
   - `hash`: `undefined` for empty, otherwise `hashValue` over the sorted effective
     `{name, description, content}` list;
   - `probe`: full materialization into a coordinator-private `mkdtemp` directory outside the
     agent-writable application tree (removed in a `finally`), sharing only the
     resolution/rebuild/write steps with `apply` (never first-deploy preservation or the marker),
     and returning hash + collision/invalid-name warnings with `preserved` empty;
   - `apply`: D3 algorithm (ensure/contain both `skills/` and legacy `skill/` roots, one-time
     `skills-replaced/` preservation (reported in `preserved`, not warnings) +
     `.hanse-skills-initialized` marker, empty `skill/`, remove
     unexpected top-level entries, rebuild every effective `<name>/` subtree after `lstat`, write
     `SKILL.md` with an `O_CREAT|O_EXCL|O_NOFOLLOW` temp + `rename`,
     `JSON.stringify(description)` in frontmatter, return written/removed/preserved/warnings);
   - `preview(target, options)`: read-only resolution plus the collision scan, no writes.
4. `src/skills/collisions.ts`: bounded scan (max depth 4, max 2,000 entries, no symlinks) of the
   exact roots: `<appDir>/.opencode/skill(s)`, `<home>/.claude/skills`,
   `<home>/.agents/skills`, `<xdgCacheHome>/opencode/skills`, and each `file://` plugin
   `<root>/skills`; **exclude the Hanse-owned `<xdgConfigHome>/opencode/skill(s)`**;
   parse frontmatter `name` (fallback directory name); check **all** Hanse names including disabled
   tombstones; emit structured `skill_collision`/`skill_disabled_elsewhere`; bound to 20.
5. Tests: hierarchy/tombstones/re-enable; validation edges (`a: b`, `#`, quotes, backslash, Unicode,
   control chars, caps); hash empty/equality with probe/apply; idempotent apply (same paths/bytes);
   first-apply preservation then removal; removal of unexpected top-level entries, `skill/` alias
   entries, nested `SKILL.md`, effective-path symlink and file; stale skill removal; collision +
   tombstone-collision warnings; preview writes nothing; forged `../x` row injected with
   `PRAGMA ignore_check_constraints=ON` is excluded from all four paths; crash-retry tolerance
   (missing entry); v12 migration on v11 data.

Exit check: service tests green; `apply().hash === hash()` proven; migration v12 verified.

## Phase 2 - Runtime integration and deletion

Boundaries: `src/opencode/manager.ts`, `src/coordinator/deletion.ts`, `src/cli/commands.ts`,
`test/manager.test.ts`, `test/deletion.test.ts`, `test/no-local-spawn.test.ts`. No HTTP/UI work.

Work:

1. `InstanceManagerOptions.skills`; in `ensure`, resolve `baselinePlugins` once and build
   `{appRoot: path.dirname(isolated.HOME), home: isolated.HOME, xdgCacheHome:
   isolated.XDG_CACHE_HOME, appDir: app.appDir, baselinePlugins}`. Call `probe` after the
   running-reconnect early return and before `resolveAgentImage`/`runtime.delete`; call `apply`
   after `runtime.delete` and before `runtime.ensure`. Wrap failures as
   `skills_materialize_failed: <bounded detail>`; log returned warnings (bounded, no secrets). On a
   post-teardown `apply` failure, persist the instance as `error` before rethrowing so the UI never
   shows a stale running row. Reuse the same `baselinePlugins` later.
2. `settingsHashFor(snapshot, profile, skillsHash?)` (export it for the hash-compatibility test):
   include `{skills: skillsHash}` only when defined. Pass `apply`'s hash from `ensure`; compute `this.#options.skills?.hash(...)` in
   `#pendingRestartFor` and pass it too. Store the combined hash as today.
3. Add an `ensure` guard that refuses an application whose sanitized state segment
   (`sanitizeAppKey(projectId)/sanitizeAppKey(appKey)`) collides with a sibling, mirroring the
   deletion guard; this prevents two apps from sharing a skills root. Test `web-api` vs `web:api`.
4. Deletion: add `DELETE FROM skills WHERE scope = 'app' AND project_id = ? AND app_key = ?` in
   `#deleteAppRows`, and `DELETE FROM skills WHERE project_id = ?` (all scopes for that project,
   including app rows) in `#deleteProjectRows`, in the same transaction as settings/provider keys.
   Global rows (`project_id = ''`) survive.
5. `serveCommand`: construct `SkillService`, pass it to `InstanceManagerOptions` and `HttpDeps`;
   pass `agentsHome: path.resolve(agentsHome())` and `baselinePlugins: resolveBaselinePlugins()`
   (export the helper or move it to `policy.ts`).
6. Tests: probe runs before any runtime.delete and apply after it (record calls on a fake
   SkillSource and the fake runtime); reconnect calls neither; probe failure leaves a running
   container untouched; apply failure after teardown aborts the start and persists `error`;
   pendingRestart flips only for effective-set changes, not shadowed/disabled edits; zero skills
   produce the old hash; app deletion removes its app rows; project deletion removes both project
   and app rows for that project; re-adding the same app key starts clean.

Exit check: manager/deletion tests green; existing manager tests unchanged apart from injected
skills; no local spawn checks still pass.

## Phase 3 - HTTP API, server-rendered pages, shell nav, asset

Boundaries: `src/http/skills.ts`, `src/http/server.ts`, `src/http/handler.ts` (asset allowlist only),
`src/http/ui.ts`, all `appShell` call sites for `skillsHref`, `assets/skills.js`,
`docs/design/skills-qa.mjs`, `test/skills-http.test.ts`, `test/skills-asset.test.ts`,
`test/http.test.ts`.

Work:

1. Routes (human-only, `cache-control: no-store`):
   - `GET /skills`, `/projects/:id/skills`, `/projects/:id/apps/:appKey/skills`;
   - `GET /api/skills?project=&app=`, `GET /api/skills/:id`;
   - `POST /api/skills` (`action=create|override&from_id=<id>&enabled=1|0`, explicit
     `scope` + `project`/`app`,
     hidden `return_to`); `create` returns `409 skill_exists` on a name conflict, never overwrites;
     `override` copies an enabled source row and may create or replace the target-scope row;
   - `POST /api/skills/:id` (`action=update`, partial patch incl. `enabled` only),
     `POST /api/skills/:id/delete`, `DELETE /api/skills/:id`.
   - Register `isSkillsRoute`/`handleSkills` in `server.ts` **before** the `isChat` catch-all.
   - Add `/assets/skills.js` to the `ASSETS` allowlist.
2. Auth/origin/validation: anonymous HTML redirects to `/login?next=...`; anonymous JSON `401`;
   agent principals `403`; cross-site `Origin` rejected on every mutation; `return_to` via
   `safeLocalPath`; `400 invalid_scope_target`, `400 invalid_override_source`,
   `401`/`403`/`404`/`409 skill_exists` mapping; `x-hanse-fragment: skills` returns
   `application/json` `{ ok: true, surface: "<div id=\"skills-surface\">…</div>",
   counts: { effective: N, defined: M } }`, else `303` + notice.
3. Page: `pageHeader`, scope switcher using the existing `settings-nav` classes, `#skills-surface`
   with effective/defined/disabled sections. At application scope call `preview` with
   `SkillApplyOptions` built from the resolved app dir, `deps.agentsHome`-derived
   `resolveInstanceEnv` roots, and `deps.baselinePlugins`, then render its warnings; global/project
   pages render the static "repository/plugin skills are outside this hierarchy" note instead of
   scanning every app. Add the stale-app rail (from `site.pendingRestart`), empty state,
   create/delete dialogs, per-row `<details>` editor. Reuse
   `card`, `setting-row`, `badge`, `status`, `btn`, `field`, `input`, `textarea`, `mono` classes.
   HTML-escape every dynamic value; skill text only in escaped `<textarea>`.
4. Shell: `active` union gains `"skills"`, `ShellOptions.skillsHref`; add the `Skills` nav item
   (icon `code`) after Handoffs. Pass scope-aware `skillsHref` from dashboard project/overview,
   application, chat, terminal, settings, and ssh pages (`/skills` globally, project/app paths
   otherwise). Do not change the existing `settingsHref` behavior.
5. `assets/skills.js` (classic IIFE, no framework): submit interception for `form[data-skill-form]`
   with `x-hanse-fragment: skills`; replace `#skills-surface`; close dialogs; restore open row,
   scroll, focus; toast; 401 redirect; inline field errors; description/content counters; example
   prefill; override prefill; delete confirmation dialog; no-JS falls back to normal form posts.
6. CSS: reuse `card`, `setting-row`, `badge`, `status`, `btn`, `field`, `input`, `textarea`,
   `dialog`, `settings-nav`, `empty-state`, `mono`; prefer zero changes to `src/http/styles.css`
   (it has unrelated uncommitted SSH work). If a class is unavoidable, append only a minimal
   skills-scoped block using Chart Room tokens, no raw colors; verify 390/1440 dark and light.
7. Tests: page HTML for all three scopes; nav active/href; exact fragment JSON shape; create/update/
   toggle/delete/override; 409 create conflict; `invalid_scope_target` and `invalid_override_source`;
   401/403; origin rejection; return_to rejection; 404; escaping of `<script>`/quotes in
   name/description/content; asset allowlist and JS content assertions; repository and plugin
   preview warnings rendered on the app page.
8. Add `docs/design/skills-qa.mjs`: seed a temp DB + HTTP server, log in with a human token, open
   the global/project/app skills pages at 1440 and 390 (dark), assert no console/page errors and the
   `#skills-surface`/scope controls, and write screenshots plus `report.json` to
   `docs/design/artifacts/skills/`. Resolve Playwright the same way as `docs/design/capture.mjs`.

Exit check: scoped pages work without JS and with fragments; asset is allowlisted; no horizontal
overflow at 390; no console errors in the browser smoke.

## Phase 4 - Docs, record, verification

Work:

1. `docs/current-state.md`: new "Agent skills" section, migration `[1..12]`, `skills.js` asset,
   restart semantics, collision limitation, deletion behavior.
2. `docs/conventions.md`: skills are coordinator settings, not manifests; runtime layout
   `<project>/<app>/config/opencode/skills/<name>/SKILL.md` is Hanse-owned.
3. `docs/design/README.md` status; `docs/plans/README.md`; `docs/journal/0018-agent-skills.md` and
   index; `docs/decisions/0011-managed-agent-skills.md`.
4. `README.md` feature bullet.
5. Run all gates. Run the exact empirical smoke:
   `T=$(mktemp -d); mkdir -p "$T/home/.config/opencode" "$T/data" "$T/state" "$T/cache";
   HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/data"
   XDG_STATE_HOME="$T/state" XDG_CACHE_HOME="$T/cache" opencode debug skill` after materializing a
   fixture set into `$T/home/.config/opencode/skills`; assert the managed names/descriptions.
   Run `node docs/design/skills-qa.mjs` for the 1440/390 dark screenshots and report.
6. Record deviations, residual risks (no precedence guarantee vs repository/plugin roots; no
   multi-file bundles), and the verification evidence.

Exit check: all gates green; docs indexes updated; journal names the exact tests/evidence.

## Verification matrix

| Area | Command / test |
| --- | --- |
| Migrations | `test/migrations.test.ts`, `test/store.test.ts` |
| Resolution/validation/hash/materialization/collisions | `test/skills-store.test.ts` |
| Manager/restart/deletion | `test/manager.test.ts`, `test/deletion.test.ts` |
| HTTP/pages/assets | `test/skills-http.test.ts`, `test/skills-asset.test.ts`, `test/http.test.ts` |
| Existing behavior | full `npm test` |
| Types/lint/build | `npm run typecheck`, `npm run lint`, `npm run build` |
| Real opencode load | temporary HOME/XDG + `opencode debug skill` |
| Visual | `node docs/design/skills-qa.mjs` (1440/390 dark, report + screenshots) |

## Risks and rollback

- If the schema or manager integration is wrong, revert the stage commit; migration v12 is additive
  and older code ignores the table, so a rollback does not require a down-migration.
- If repository/plugin collisions surprise operators, the warnings are the mitigation; true
  override is a follow-up design change, not a patch to this plan.
- If the page is too large with many skills, content is capped per row; pagination is a follow-up.

## Plan review record

Round 1 (`momus`, 2026-10-22): **CHANGES REQUESTED**. Findings folded into this revision:

- project deletion now states the exact `WHERE project_id = ?` predicate covering app-scoped rows,
  with a re-add test (Phase 2.3/2.5);
- HTTP preview now receives `baselinePlugins`, so plugin-root collision warnings match D2.1
  (interfaces, Phase 2.4, Phase 3.3);
- the fragment response is an exact JSON envelope (Phase 3.2);
- `invalid_scope_target` and `invalid_override_source` plus tests were added (Phase 3.2/3.7);
- probe is explicitly resolve/rebuild/write only, without preservation or the marker (Phase 1.3);
- verification now gives an exact `opencode debug skill` environment and a committed
  `docs/design/skills-qa.mjs` harness (Phase 3.8, Phase 4.5).

Round 2 (`momus`, 2026-10-22): **PASS**; no blocker. Advisory notes recorded: app-scope preview fallback when `agentsHome` is absent, the probe/apply warning-equality assertion, and the `HttpDeps` shared-interface ordering.

Post-approval security hardening (2026-10-22): probe staging is a coordinator-private temporary
directory outside the agent-writable tree, `ensure` refuses sanitized state-segment collisions
with a sibling, and only `/api/skills*` accepts 512 KiB request bodies. The four gates remain green
at 1480 tests in 94 files; `docs/design/skills-qa.mjs` remains PASS.
