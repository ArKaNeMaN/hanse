# Plan 0017: Skill bundles and the skill workspace

- Status: implemented and verified (journal 0020); deployment pending
- Design: [`docs/design/skill-bundles.md`](../design/skill-bundles.md)
- Design reviewer: `oracle` - PASS (round 5)
- Plan reviewer: `momus` - PASS
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) stage `0017-skill-bundles`
- Date: 2026-10-23

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0017-skill-bundles` |
| Design artifact | `docs/design/skill-bundles.md` |
| Plan artifact | `docs/plans/0017-skill-bundles.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0020-skill-bundles.md`; index `docs/journal/README.md` |
| Decision record | `docs/decisions/0013-skill-bundles.md` |
| Open questions | none for the core stage; stage 0017 section in `docs/open-questions.md` |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Extra verification | `node docs/design/chat-qa.mjs`; `node docs/design/skills-qa.mjs`; real `opencode debug skill`; 390/768/1024/1440 dark+light |
| Commit policy | one coherent stage commit (code + tests + docs + record); autonomous mode may commit/push |
| Deploy | not part of this plan; record separately if performed |

## Global invariants

- Migration v13 is additive. Existing v12 rows get `license = NULL`, `compatibility = NULL`,
  `metadata_json = '{}'`, and no reference rows. A legacy skill's effective hash and generated
  `SKILL.md` bytes are unchanged. `runMigrations` is a no-op on a second run.
- `skill_references.skill_id` references `skills(id)` with `ON DELETE CASCADE`; the connection
  already sets `foreign_keys = ON`. App/project deletion deletes skill rows and therefore cascades.
- `create`, `update`, and `override` run in one database transaction; update/override replace the
  target reference set in the same transaction. The DB is the source of truth.
- Inventory resolution loads summaries only (no reference contents). `hash`, `probe`, and `apply`
  load `EffectiveBundle` internally. `get` loads the full bundle for the workspace.
- The effective hash is `undefined` exactly when the effective set is empty. A legacy skill hashes as
  `{name, description, content}`; new fields are added only when normalized non-empty. Clearing
  every new field restores the legacy hash.
- `probe` runs after the running-reconnect early return and before any `runtime.delete`; `apply`
  runs after teardown and before `runtime.ensure`. Both write the same bundle; references are
  written first and `SKILL.md` last. `probe().hash === apply().hash === hash()`.
- `<XDG_CONFIG_HOME>/opencode/{skills,skill}` remain Hanse-owned. Remove and rebuild each
  `<name>/` subtree with `lstat`/containment and no symlink following; write files atomically.
  First-deploy `skills-replaced/` preservation and legacy `skill/` emptying are unchanged.
- Validation: description allows newlines; metadata values stay single-line; reference paths are
  canonical `references/<slug>.md`; slug 1-64, path 15-78; max 20 references, 48,000 characters each,
  192,000 aggregate; the 48,000-character body is separate. The `/api/skills*` body bound is 4 MiB;
  the general server bound stays 64 KiB.
- All `/skills*` pages and `/api/skills*` routes remain human-only. Mutations reject cross-site
  Origin and validate `return_to`/`from` as local scope paths.
- The list fragment envelope and `assets/skills.js` are removed. The inventory is server-rendered
  and JS-free. `POST /api/skills/:id` with `action=delete` remains for compatibility.
- The workspace uses one bundle form. Without JS, metadata, license, compatibility, and reference
  controls are disabled and unnamed; one hidden JSON snapshot preserves them; all file editors are
  stacked. With JS, `assets/skill-detail.js` adds side-by-side preview, file tabs, dirty state,
  counters, and inline errors. Preview uses the extracted safe DOM renderer; no `innerHTML` for
  skill text.
- No new runtime dependency. TypeScript ESM/NodeNext; relative imports use `.js`. Styles come from
  `src/http/styles.css` and the existing Chart Room tokens.

## Shared interfaces (implement first)

Implement exactly the types in design section 5. The key additions are:

- `SkillReference { path; content }`, `SkillMetadata`, `SkillStoredIssue` including
  `invalid_skill_bundle`, `SkillBundle`, `SkillRow` with `metadataRaw`, `EffectiveSkill` with summary
  references, `EffectiveBundle` with full references, `SkillInput`/`SkillUpdate` with full
  metadata/reference replacement, `SkillSummary`, `SkillDetail` with `metadataRaw`,
  `SkillWarningCode` limited to collision/resolution warnings (retaining
  `skill_disabled_elsewhere`; only `invalid_skill_name` moves to `storedIssues`),
  `SkillWarning` without `id`/`path`/`detail`, and `ResolvedSkills.rows: SkillSummary[]`.
- `SkillService` keeps `get` and changes `create`, `update`, `override`, `delete`, `resolve`, `hash`,
  `preview`, `probe`, and `apply` to understand bundles.
- `SkillSource` public signatures do not change; `resolve`/`preview` use summaries and
  `hash`/`probe`/`apply` load bundles internally.

## Phase 1 - Data layer, validation, materialization, hash

Boundaries: `src/store/migrations.ts`, `src/skills/types.ts`, `src/skills/validation.ts`,
`src/skills/service.ts`, `src/skills/materialize.ts`, `src/skills/collisions.ts`,
`src/skills/index.ts`, `test/migrations.test.ts`, `test/store.test.ts`,
`test/settings-store.test.ts`, `test/skills-store.test.ts`, `test/http.test.ts` (schema-version
assertion only).

Work:

1. Add migration v13 exactly as design D1: `license`/`compatibility` nullable columns with length
   checks; `metadata_json TEXT NOT NULL DEFAULT '{}'` with `json_valid` and length 16,384;
   `skill_references(skill_id, path, content, PRIMARY KEY(skill_id, path))` with FK cascade and the
   path/content checks. Update every schema-version assertion (`test/migrations.test.ts`,
   `test/store.test.ts`, `test/settings-store.test.ts:45`, and the `schemaVersion` assertion in
   `test/http.test.ts`); change the known-max/future-version tests to 13/14 and the real-v12 fixture
   to v12->v13/v13. Add v12->v13, no-op, constraint, and cascade tests.
2. Update `src/skills/index.ts` exports for the new types and errors. Implement types and validation: name; description newlines and normalization; license/compat;
   metadata key/value bounds and reserved keys; reference path/slug; reference content line endings,
   NUL/control/unpaired-surrogate rejection; count/aggregate; optional-field normalization; stable
   field/code errors.
3. Service:
   - `#readRows` returns all scoped rows, parses metadata, records `metadataRaw`/`storedIssues`, and
     builds reference summaries (path/size) without content; invalid-name rows stay in `rows` for
     repair but never become resolution candidates.
   - `resolve` groups only valid names; invalid-name, invalid metadata, invalid references, and
     invalid bundle bounds make a row ineligible (wider valid row can win); tombstones validate on
     name only; `disabled` semantics unchanged; warnings only collision/resolution conditions
     (`skill_collision`, `skill_disabled_elsewhere`).
   - `get` loads full references; `create`/`update`/`override` transactions and reference-set
     replacement; `delete` cascade; `override` copies the complete bundle.
   - `hash` uses `EffectiveBundle` and the conditional legacy projection; `preview` uses summaries.
   - `probe`/`apply` share the rebuild function; references first, `SKILL.md` last; `written` includes
     reference paths; generated frontmatter exact order/quoting; legacy bytes unchanged.
4. Tests: legacy hash and bytes; clear fields restores hash; metadata/ref round-trip; normalization;
   invalid-name rows visible in `rows` but not effective; invalid metadata JSON, invalid reference
   path, count/aggregate, and license/compatibility each produce the appropriate `storedIssues`
   (`metadataRaw` for invalid metadata), are excluded from effective/hash, allow a wider valid row
   to win, and keep `hash() === probe().hash === apply().hash` on the corrupted set; invalid-name tombstones do not hide; forged stored paths
   cannot escape; override copies the complete bundle (including a disabled tombstone that stays
   disabled); transactional failure leaves no partial refs; delete cascade; deterministic/materialized
   refs and ordering (references before `SKILL.md`); stale removal; symlink/path traversal;
   first-deploy preservation; frontmatter YAML load; migration v13.

Exit check: data/service/materialization tests green; `probe().hash === apply().hash === hash()`;
legacy hash/bytes test passes.

## Phase 2 - Manager and deletion integration

Boundaries: `src/opencode/manager.ts`, `src/coordinator/deletion.ts`, `test/manager.test.ts`,
`test/deletion.test.ts`.

Work:

1. Keep probe/apply ordering and state collision guard; pass bundle-aware hashes to
   `settingsHashFor`; `pendingRestart` uses the same hash; existing zero-skill behavior unchanged.
2. Ensure effective-bundle loading is internal to the service; manager call sites do not change
   public signatures.
3. Verify deletion cascades references for skill delete, app delete, and project delete; global rows
   survive; re-adding an app starts clean.
4. Tests: probe before teardown/apply after; probe failure leaves running container; apply failure
   persists `error`; pending restart for metadata/reference changes; shadowed/tombstone edits do not
   restart; state collision guard unchanged; deletion cascades.

Exit check: manager/deletion tests green; zero-skill hash unchanged.

## Phase 3 - Shared renderer extraction

Boundaries: `assets/chat.js`, new `assets/markdown.js`, `src/http/handler.ts`, `src/http/ui.ts`,
`docs/design/chat-qa.mjs`, `docs/design/skills-qa.mjs`, `test/http.test.ts`.

Work:

1. Extract `renderMarkdown`, `renderInline`, `renderTable`, `startsBlock`, and the `element` helper
   from `assets/chat.js` into `assets/markdown.js` (ES module importing `parseMarkdownTable` from
   `assets/chat-core.js`). Export both `renderMarkdown` and `element`; `chat.js` imports both and
   removes its local copies (or keeps a local `element` copy only if the import would create a
   cycle, documented in the journal).
2. Add `markdown.js` and `skill-detail.js` to the asset allowlist; load the detail script via
   `moduleScripts`.
3. Run the existing `docs/design/chat-qa.mjs` to prove chat rendering is unchanged. Add a focused
   renderer scenario to `docs/design/skills-qa.mjs` using a synthetic preview container (a temporary
   page/evaluate that imports `/assets/markdown.js`), independent of the Phase 4 workspace, covering
   raw HTML as text, `javascript:` links not becoming links, quotes, tables, code fences, and
   reference links; no DOM test dependency is added.
4. No server renderer and no new dependency.

Exit check: chat QA passes with no console/page errors; the synthetic skills renderer fixture passes;
asset allowlist tests green.

## Phase 4 - HTTP API, inventory, workspace, create page

Boundaries: `src/http/skills.ts`, `src/http/server.ts`, `src/http/handler.ts`,
`src/http/ui.ts`, `assets/skill-detail.js`, `src/http/styles.css`, `assets/app.css`,
`docs/design/skills-qa.mjs`, `test/skills-http.test.ts`, `test/skills-asset.test.ts`,
`test/http.test.ts`, `DESIGN.md`.

Work:

1. Routes: add `GET /skills/new` and `GET /skills/:id`; keep scope inventories and JSON APIs.
   `isSkillsRoute` matches `/skills/new` before the numeric id. Detail page resolves the viewing
   context from `from`; D5 selects editable/inherited/shadowed/hidden/invalid/not-effective.
2. Inventory: one server-rendered table with scope nav, search, filters, row model, empty states,
   collision/issue warnings, restart rail; no fragment, no inline editor, no mutations.
3. Workspace: header, scope strip, details card, source/preview split (>=1024), file rail/tabs,
   sticky edit bar, dirty/discard, reference add/remove, delete danger zone, override/disable/revert,
   restart banner, collision/issues strips, create page, 422/409 pages, `confirm_name`.
4. One bundle form: JS sends metadata/references full replacements; no-JS disabled/unnamed controls +
   hidden JSON snapshot; all file editors stacked; `license`/`compatibility` preserved. Remove
   `assets/skills.js` and the fragment contract; keep `action=delete`.
5. `skill-detail.js`: live preview via extracted renderer, 120ms debounce, file tabs, dirty tracking,
   `beforeunload`, counters, error focus; no autosave. Add `.skill-prose`, `.skill-source`,
   `.skill-state`, `.skill-editbar` styles using existing tokens; update DESIGN.md §5.
6. API: list projections, detail `SkillDetail`, create/update/override, references replacement,
   error shape `{error, code, field?}`, 4 MiB bound, Origin/auth/return_to/from validation.
7. Tests: route matching; auth anon/agent; Origin; return_to/from; inventory row model
   (`Invalid local override`); detail states (editable/inherited/shadowed/hidden/invalid/not-effective);
   create page; form/JSON; 422/409; invalid repair and `metadataRaw`; no-JS markup
   (disabled/unnamed/stacked) and no-JS actions (save, discard, create, enable/disable, override,
   revert, delete, hidden-snapshot round-trip after body/description save, `confirm_name` mismatch,
   422 re-render value preservation); escaping; asset allowlist; 4 MiB; old fragment removal;
   action=delete.

Exit check: HTTP/UI tests green; no-JS markup assertions; no horizontal overflow at 390.

## Phase 5 - Browser QA, docs, record

Boundaries: `docs/design/skills-qa.mjs`, `docs/design/artifacts/skills/`, `docs/current-state.md`,
`docs/conventions.md`, `docs/design/README.md`, `docs/plans/README.md`,
`docs/journal/0020-skill-bundles.md`, `docs/journal/README.md`,
`docs/decisions/0013-skill-bundles.md`, `docs/open-questions.md`, `README.md`, `AGENTS.md` if needed.

Work:

1. Rewrite `skills-qa.mjs`: seed a bundle with metadata/license/references; capture inventory,
   workspace, create, invalid repair, shadowed/hidden, delete; 1440/1024/768/390 dark+light; save,
   add/remove reference, override/disable/revert/delete; no-JS scenario (`javaScriptEnabled: false`)
   covering stacked editors, body/description save with hidden
   metadata/license/compatibility/reference snapshot preservation, discard, create, enable/disable,
   override, revert, delete, and `confirm_name` mismatch; 422 value preservation; report JSON and
   screenshots; fail on console/page errors.
   Add a short `docs/design/artifacts/skills/README.md` describing the seeded fixture and scenarios.
2. Run chat QA and skills QA; record reports and screenshot inventory. Declare them manual stage
   gates (not CI) or wire the selected checks into CI only if the repo already has a browser job.
3. Update docs and indexes; write journal 0020 and ADR 0013; mark design/plan status; update
   `docs/current-state.md`, `docs/conventions.md`, and the root `README.md` feature bullet; add
   `skills-qa.mjs` and the skills artifacts to `docs/design/README.md`'s QA/evidence sections; keep
   sensitive data out.
4. Run all gates, `npm run check:sensitive`, and the real `opencode debug skill` smoke on a
   materialized bundle.
5. Record deviations, accepted debt (no optimistic locking, no-JS metadata/reference editing,
   renderer extraction regression risk), and exact evidence.

Exit check: all gates green; manual browser QA reports recorded; docs indexes updated; journal names
tests/evidence.

## Verification matrix

| Area | Command / test |
| --- | --- |
| Schema/migrations | `test/migrations.test.ts`, `test/store.test.ts` |
| Bundle validation/service/materialization/hash | `test/skills-store.test.ts` |
| Manager/restart | `test/manager.test.ts` |
| Deletion cascade | `test/deletion.test.ts` |
| HTTP/pages/forms/assets | `test/skills-http.test.ts`, `test/http.test.ts`, `test/skills-asset.test.ts` |
| Full suite | `npm test` |
| Types/lint/build | `npm run typecheck`, `npm run lint`, `npm run build` |
| Chat rendering | `node docs/design/chat-qa.mjs` |
| Skills browser QA | `node docs/design/skills-qa.mjs` |
| Real opencode load | `T=$(mktemp -d); mkdir -p "$T/home/.config/opencode" "$T/data" "$T/state" "$T/cache"; HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" XDG_CACHE_HOME="$T/cache" opencode debug skill` after materializing a bundle |
| Sensitive data | `npm run check:sensitive` |

## Risks and rollback

- Migration v13 is additive. Older code ignores the new columns/table, but its apply would remove
  reference files from disk because it rebuilds only `SKILL.md`; rollback after bundle rows exist
  requires a forward fix or restoring a pre-upgrade DB/state backup. Document this in the journal.
- Removing the fragment contract and `assets/skills.js` is intentional; tests and docs must be
  rewritten in the same stage.
- Renderer extraction touches chat; the chat QA harness is the regression gate.
- Large bundles are bounded by 20 files, 48k each, 192k aggregate, and a 4 MiB request.
- Hash cost on page render is memoized per build context; a durable cache is a follow-up.
- No optimistic locking; last write wins. Visible updated time and no autosave are the mitigation.
- No-JS cannot preview or edit metadata/references; it preserves them and edits body/description/
  enabled. This is documented, not silent.

## Plan review record

Round 1 (`momus`, 2026-10-23): **CHANGES REQUESTED**. Findings folded:

- Phase 4/5 now cover the full no-JS action matrix, hidden-snapshot preservation, `confirm_name`
  mismatch, and 422 value preservation;
- Phase 1 now covers corrupted-row categories, repair visibility, forged-path containment, tombstone
  copy/stays-disabled, and hash/probe/apply agreement;
- migration v13 version-assertion fallout is scoped across migrations/store/settings-store/http,
  known-max/future, and the real-v12 fixture;
- renderer fixture harness/export and `SkillWarningCode` wording clarified.

Round 2 (`momus`, 2026-10-23): **PASS**. Non-gating notes folded: the Phase 3 renderer fixture now
uses a synthetic preview container independent of the Phase 4 workspace; the Phase 5 no-JS snapshot
assertion names compatibility explicitly.
