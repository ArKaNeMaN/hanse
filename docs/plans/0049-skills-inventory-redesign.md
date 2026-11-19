# Plan 0049 - Skills inventory redesign (B2)

Status: **approved for implementation** (2026-11-19). Design: [Skills inventory redesign (B2)](../design/skills-inventory-redesign.md). Design review: `oracle` round 3 **PASS WITH FIXES**; all findings folded. Plan review: `momus` **OKAY WITH FIXES**; all findings folded.

Scope: replace the three Skills inventory layouts with the approved B2 card/list design; add the
definition-scope grouping, attention band and `filter=attention`, Cards/List density, a collapsible
summary rail, a read-only preview drawer, and a reusable target selector backed by a new
`GET /api/ui/targets` catalog. The create (`/skills/new`) and detail (`/skills/:id`) workspaces keep
their existing editor and scope nav.

Non-goals: adopting the selector in chat/settings/SSH/handoffs/shell (Stage B); the app-only flat
mode and Master/All roots; terminal/memory pickers; mutations inside the preview drawer; arbitrary
file editing/upload; any skill resolution/materialization/storage change; any schema migration; a
new npm dependency.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 3 PASS WITH FIXES, findings folded).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, copy, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e`,
  `npm test`, `npm run build`, `npm run check:ui`, `npm run check:sensitive`,
  `npm run test:e2e` (the stage changes rendered routes; CI also runs the E2E TypeScript gate).
- Commit policy: the owner authorized the full delivery cycle, so this stage may use one coherent
  commit (code + tests + docs + record) and push per `docs/process.md`. Do not include the
  pre-existing untracked `docs/design/settings-redesign/` or rewrite the one existing ahead
  commit; note both in the record.
- No new npm dependencies.

## Owner decisions (closed)

1. B2 library direction is approved; split workbench A is rejected. B2 is preferred over the triage
   ledger C for discoverability, with C's dense list retained as a density switch.
2. `Show only` filters the same inventory list, not a separate page.
3. List mode is approved and has real column headers.
4. A scoped disabled tombstone that hides a wider source is part of attention; label it
   `Tombstone`, not an error.
5. The same selector will be reused everywhere in Stage B, with an app-only flat mode and a Master
   root for chat. This stage introduces the shared component/catalog but only uses
   `mode="scope"` + `root="global"` on Skills.
6. The owner delegated the remaining choices and authorized the full cycle (design, review, plan,
   plan review, implementation, record, commit).

---

## Phase 0 - Baseline and contract probes

### Boundaries

In scope: read-only code inspection, targeted baseline tests, and disposable local probes. Out of
scope: product code changes, production state, deployment secrets, and real project data.

### Invariants

- No product code changes in this phase.
- The pre-existing untracked `docs/design/settings-redesign/` and the ahead commit are untouched.
- Any probe failure becomes a plan deviation, not a silent workaround.

### Work

1. Record `git status --short --branch`; confirm the branch is ahead by one existing commit. The
   expected untracked paths are `docs/design/settings-redesign/` (unrelated, never stage) plus the
   new stage artifacts `docs/design/skills-inventory-redesign.md` and
   `docs/plans/0049-skills-inventory-redesign.md` (stage them in Phase F). Do not stage
   `docs/design/settings-redesign/` and do not rewrite the ahead commit.
2. Run the baseline `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, and targeted
   `npm test -- test/skills-props.test.ts test/skills-store.test.ts test/ui-props-auth.test.ts`.
   Record pre-existing failures (do not fix unrelated ones).
3. Re-read and record file:line evidence for:
   - `SkillSummary` construction and the `#summaryFiles`/`files` availability
     (`src/skills/types.ts`, `src/skills/service.ts`);
   - the disabled-row `shadows`/`source` computation used by the attention predicate
     (`src/skills/service.ts`, `src/http/props/skills.ts`);
   - `SkillDetailPage.vue` query key `["skills-detail", skillId, fromPath]`, `from` decoding, and
     the detail fetch;
   - `handleUiApi`'s `site` variable and `UI_API_PATHS`;
   - the exact existing test/QA selectors affected (SkillsPage.test.ts,
     `e2e/spa-skills.spec.ts`, `e2e/skills.spec.ts`, `e2e/spa-skill-sources.spec.ts`,
     `docs/design/skills-qa.mjs`, fixtures).
4. Confirm no schema migration is needed: `skills.created_at`, `skills.updated_by`, and
   `skill_files` already exist; the additions are response-only.

### Acceptance criteria

- Baseline failures are recorded and attributed to pre-existing code.
- Every probe names file:line; the plan's assumptions about `files`, `shadows`, `from`, and
  `UI_API_PATHS` are confirmed or the plan is revised before Phase A.
- No product code or production state is touched.

### Verification

Manual/read-only probes plus the targeted baseline test commands above.

---

## Phase A - Server props, target catalog, and test fixtures

### Boundaries

In scope: `SkillSummary.fileCount`, attention props/filter, workspace `files`/`createdAt`/
`updatedBy`, the catalog builder and endpoint, client type mirrors, and server unit tests. Out of
scope: Vue components, CSS, E2E, page layout.

### Invariants

- No schema migration; DB columns/tables are unchanged.
- `GET /api/ui/skills` and boot props remain backward-compatible; all new fields are additive.
- `filter=attention` is server-filtered; the six filter chips stay unchanged.
- Attention is derived from the unscoped-filter `allRows`, not the active `rows`.
- `/api/ui/targets` is cookie-only, UI-version gated, and returns identities only (no secrets, no
  filesystem paths, no handoff/SSH data).
- The catalog excludes the master project from `projects` and returns it separately as `master`;
  deleting projects/apps are excluded; projects with zero apps are included.
- No `UI_VERSION` bump.

### Work

1. `src/skills/types.ts`: add `fileCount: number` to `SkillSummary` (row bundle count, excluding the
   synthesized SKILL.md, matching `EffectiveSkill.fileCount` semantics).
2. `src/skills/service.ts`: populate `SkillSummary.fileCount` from the same summary files used by
   `EffectiveSkill.fileCount`; keep the existing legacy reference projection. Add/extend
   `test/skills-store.test.ts` for a scoped row that is not the effective winner (shadowed or
   invalid) and has arbitrary files.
3. `src/http/props/skills.ts`:
   - add `"attention"` to `InventoryFilter`/`parseInventoryFilter`/`inventoryMatchesFilter`;
   - add `SkillsAttentionItemProps`/`SkillsAttentionProps` and build them from `allRows`:
     predicate `invalid || (disabled && shadows.length > 0) || collisions.length > 0`, sort
     invalid→collision→disabled→name, first 3 items, `omitted`, `truncated` from the preview,
     `href`/`clearHref` via `filterHref(pagePath, value, search)`, `active`;
   - use the row's own `fileCount` for scoped rows, the effective count only for effective-only
     rows, and the current external count for external rows;
   - add `files` (path/size/executable, content-free), `createdAt`, `updatedBy` to the workspace
     props; create mode returns `[]`/`null`/`null`;
   - keep the six chip options unchanged; do not add an attention chip.
4. `src/http/props/targets.ts` (new): `TargetAppProps`, `TargetProjectProps`, `TargetsProps`,
   `buildTargets(site)`. Use `operatorProjects(site)` filtered by `!deleting`, apps filtered by
   `!deleting`, stable sort, and a separately resolved master app from `site.projects`.
5. `src/http/spa.ts`: add `/api/ui/targets` to `UI_API_PATHS`; handle it in `handleUiApi` using the
   existing `site` and the existing auth/version gate; return the catalog JSON with
   `cache-control: no-store`.
6. `ui/skills-types.ts`: mirror `attention`, the workspace `files`/`createdAt`/`updatedBy`, and add
   `"attention"` to the client `InventoryFilter` union.
7. `ui/target-types.ts` (new): mirror `TargetAppProps`, `TargetProjectProps`, `TargetsProps` and
   define `Target` / `TargetSelectorConfig` from design §8.
8. Tests:
   - `test/skills-props.test.ts`: attention ordering/omitted/truncated/active; `filter=attention`;
     fileCount for scoped vs effective-only; workspace files/createdAt/updatedBy; create nulls.
   - `test/skills-store.test.ts`: `SkillSummary.fileCount` for legacy references and arbitrary
     files; shadowed row.
   - `test/targets-props.test.ts` (new): project/app shape, deleting filters, zero-app project,
     master separation, stable sort, no hrefs/paths/secrets.
   - `test/ui-props-auth.test.ts`: add `/api/ui/targets` to the cookie/bearer/agent and UI-version
     matrix.
   - Update any fixture helpers that construct `SkillSummary`/workspace props.

### Acceptance criteria

- `SkillSummary.fileCount` reflects the row's own bundle, not a shadowing/effective row's count.
- Attention items are truthful for invalid/collision/hiding-tombstone rows, capped at 3 with
  omitted/truncated counters; a disabled row with no wider source is not attention.
- `filter=attention` parses on both server and client and returns only the attention rows, without
  adding a seventh chip.
- Workspace props include content-free files and createdAt/updatedBy; create returns empty/null.
- `GET /api/ui/targets` returns the catalog to a cookie session, rejects bearer/agent tokens, and
  requires the UI version; it contains no paths or secrets.
- Targeted server tests and `npm run typecheck` pass.

### Verification

`npm test -- test/skills-props.test.ts test/skills-store.test.ts test/targets-props.test.ts test/ui-props-auth.test.ts`, `npm run typecheck`.

---

## Phase B - Shared TargetSelector and route mapping

### Boundaries

In scope: `TargetSelector.vue`, client target types, the Skills target-to-route helper, its CSS,
and unit tests. Out of scope: the inventory page layout, the drawer, E2E.

### Invariants

- Stage A only exposes/uses `mode="scope"` + `root="global"`; the other discriminated-union modes
  are typed but not used by a page.
- The trigger renders the current target from page props; the catalog is only needed to open the
  menu. Loading/error/retry and "current target not in catalog" are handled.
- Selecting a target emits `change(target)`; the component does not navigate.
- The dialog/combobox/listbox ARIA and focus model from design §7.5 is implemented exactly.
- No new tokens or dependencies; classes live in `src/http/styles.css`; no SFC `<style>`.

### Work

1. `ui/components/TargetSelector.vue`:
   - 32px trigger: glyph (globe/folder/app), current label, chevron; `aria-haspopup="dialog"`,
     `aria-expanded`, `aria-controls`;
   - popover dialog with search combobox and listbox options; project rows select the project,
     app rows select the app; current check; global root;
   - loading/error/retry and current-not-in-catalog states; Escape/click-outside/focus return;
   - `change` emit only.
2. `ui/skills-target.ts` (or a small shared helper): `targetToSkillsHref(target)` for
   global/project/app; unit tests for all three and encoding.
3. `src/http/styles.css`: `.target-*` classes (trigger, dialog, search, sections, rows, current
   check, mobile width); reuse existing tokens; no new colors.
4. `ui/components/TargetSelector.test.ts`: scope mode, project/app selection, current check,
   search filtering, keyboard/active-descendant, Escape, loading/error/retry, fallback label,
   no navigation. `ui/skills-target.test.ts` (or inline tests) for href mapping.

### Acceptance criteria

- The trigger shows the current target before the catalog resolves and after a catalog error.
- The menu is searchable and keyboard-operable; selecting emits the right `Target`; the current
  option is checked; the menu never navigates itself.
- Href mapping matches `/skills`, `/projects/:id/skills`, `/projects/:id/apps/:app/skills`.
- `npm run typecheck:ui` and the new unit tests pass.

### Verification

`npm test -- ui/components/TargetSelector.test.ts ui/skills-target.test.ts`, `npm run typecheck:ui`, `npm run check:ui`.

---

## Phase C - Skills inventory B2 page

### Boundaries

In scope: the inventory branch of `ui/pages/SkillsPage.vue` for the three inventory routes, the
header/toolbar, attention band, cards/list, rail, density, target navigation, empty/error states,
responsive CSS, fixtures, and unit tests. Out of scope: the create/detail branches, the preview
drawer (Phase D), E2E/QA (Phase E).

### Invariants

- The create and detail branches are unchanged; `SkillsScopeNav` stays for them.
- `inventoryQuery` keys/paths, boot hydration, `hasSkillsMutated`, `usePageChrome`, and mutation
  flows are preserved.
- `FILTERS`/`parseFilter`, `inventoryApiPath`, the query key, and boot hydration all include
  `attention`; no attention chip is rendered.
- Grouping uses `row.scope` (managed) / `mode === "external"`; origin text is a note only.
- The card/row is one native `<button>` activation target; no nested interactive controls.
- Data attributes `data-skill-inventory`, `data-skill-row`, `data-skill-name`,
  `data-skill-state`, `data-skill-state-label`, `data-skill-mode` are present for tests/QA.
- Density persists at `hanse.skills.density` (`cards|list`, default cards).
- The rail is collapsible on desktop and moves below the content on mobile.
- No SFC `<style>`; all new classes in `src/http/styles.css`; dark/light use existing tokens.

### Work

1. `ui/pages/SkillsPage.vue` (inventory branch):
   - add `targetsQuery(["targets"] -> /api/ui/targets)` with `staleTime: 60_000`, loading/error
     handling; trigger label from `view.scope`;
   - replace the inventory `SkillsScopeNav` with `TargetSelector`; target change uses
     `targetToSkillsHref` + `router.push` (reset filter/search);
   - header: `Skills · scope`, title, description, meta counts, New skill;
   - toolbar: live search (250 ms debounce, `router.replace`, Enter immediate, `/` focus,
     Escape clear, clear button), six filter chips, target selector, density toggle, result count;
   - attention band (up to 3 items, omitted, Show only/Showing only/Clear; active-zero band);
   - cards grouped by definition scope with header counts; list mode with one column header;
     mobile stacked rows and hidden column header;
   - right rail: summary counts, warnings/truncated, restart entries, resolution explainer,
     Hide/Show; mobile below content;
   - empty/loading/error states reuse existing classes/data;
   - preserve all data attributes; managed/external activation opens the corresponding drawer
     (Phase D wires the managed drawer).
2. `src/http/styles.css`: `.skills-*` card/list/attention/rail/density classes and responsive rules
   at 1280/900/640; no SFC styles.
3. `ui/skills-fixtures.ts`: add `attention`, files/createdAt/updatedBy, target catalog fixtures;
   update inventory fixtures.
4. `ui/pages/SkillsPage.test.ts`: migrate all inventory selectors and flows: table `tr` →
   `[data-skill-row]`; `a.mono` detail links → row → drawer `Open full skill`;
   `.settings-nav__link` current-scope assertion → the target-selector trigger/current check;
   the nested external "View" button → the `[data-skill-mode="external"]` activation; add a
   "no nested interactive controls" assertion. Test cards/list, target selector
   navigation/fallback, attention band/filter (active-zero, search preservation), density
   persistence, rail collapse, empty/error; keep create tests.
5. `ui/components/StatusPill`/`AppIcon` reuse where appropriate; add no new icon sprite unless an
   existing icon is missing.

### Acceptance criteria

- All three inventory routes render the B2 layout; the create/detail routes still render the
  existing editor.
- All inventory fixture rows appear in cards and list; groups/counts are correct; external rows
  are read-only. The fixture set is defined in `ui/skills-fixtures.ts`; do not hard-code a count.
- Attention shows invalid, collision, and hiding-tombstone items; `Show only` filters the same
  list; active-zero and search-preserving clear work.
- Density persists across reloads; rail collapses; mobile is usable without horizontal overflow.
- Target selection navigates to the correct route and resets filter/search.
- `npm test -- ui/pages/SkillsPage.test.ts` and `npm run typecheck:ui` pass.

### Verification

`npm test -- ui/pages/SkillsPage.test.ts`, `npm run typecheck:ui`, `npm run check:ui`.

---

## Phase D - Read-only skill preview drawer

### Boundaries

In scope: `SkillPreviewDrawer.vue` for managed rows, its styles, opening/closing from the inventory,
and unit tests. External rows keep `ExternalSkillDrawer`. Out of scope: mutations in the drawer,
create/detail editor changes.

### Invariants

- The drawer fetches `GET /api/ui/skills/${String(row.primaryId)}?from=${encodeURIComponent(from)}`
  with `from = inventoryHref` (decoded); it shares `["skills-detail", id, from]` and refetches on
  open.
- It renders the row's state/origin, content, metadata, references/files, and both
  `Open full skill` (`row.href`) and `Open effective source` (`row.effectiveHref`) when present.
- `files` is authoritative; legacy references are a fallback only; no duplicate paths.
- Read-only: no forms, no mutation actions. `data-skill-effective-link` lives on the effective
  anchor.
- Native `<dialog>` right sheet, full-screen on mobile; Escape/scrim/close, focus return,
  loading/error/retry.
- No SFC `<style>`; no new tokens.

### Work

1. `ui/components/SkillPreviewDrawer.vue`: dialog, useQuery (shared key, enabled when open,
   refetch on open), header/state/origin, body `<pre>`, metadata grid, references/files, links,
   loading/error/retry, focus handling.
2. `src/http/styles.css`: `.skill-preview-drawer` / right-sheet and mobile full-screen styles.
3. `ui/pages/SkillsPage.vue`: open the drawer for managed rows; keep the existing external drawer.
4. `ui/components/SkillPreviewDrawer.test.ts`: id/from/key; content; files authoritative and the
   pre-v24 `files`-empty → references fallback; invalid/shadowed/disabled identity and the
   effective link; `Open full skill` navigation; loading, error/retry, scrim close, Escape, and
   focus return; no mutation controls.
5. `ui/skills-fixtures.ts`: detail fixture with files/createdAt/updatedBy.

### Acceptance criteria

- Clicking a managed card/row opens the drawer with the correct skill and context; Escape/scrim/
  close work; focus returns.
- The body, metadata, references/files, and effective link render from the detail response.
- No mutation controls are present; `Open full skill` navigates to the existing detail route.
- Loading/error/retry states work.
- `npm test -- ui/components/SkillPreviewDrawer.test.ts` and `npm run typecheck:ui` pass.

### Verification

`npm test -- ui/components/SkillPreviewDrawer.test.ts`, `npm run typecheck:ui`, `npm run check:ui`.

---

## Phase E - E2E, browser QA, visual QA, and full gates

### Boundaries

In scope: E2E/QA updates, visual QA, and the full verification matrix. Out of scope: unrelated
test failures and pre-existing debt.

### Invariants

- Every affected selector and flow is migrated; no table-row assumptions remain.
- Existing data attributes (`data-skill-inventory`, `data-skill-name`, `data-skill-state`,
  `data-skill-state-label`, `data-skill-mode`) remain stable.
- The QA script opens the row and drawer where the old row action link was used; it keeps the
  detail-page state assertions after `Open full skill`.
- Visual QA covers dark/light and 1600/1280/900/390; no horizontal overflow; no console errors.
- All mandatory gates from `docs/process.md` pass.

### Work

1. Extend `e2e/support/seed.ts` / `SeedFixture` with deterministic invalid, disabled-tombstone,
   shadowed/invalid-local, and collision rows for the attention and drawer E2E; do not invent a
   fixture path elsewhere. Use those rows in the new specs.
2. `e2e/spa-skills.spec.ts`: target-selector trigger/menu instead of `.settings-nav`; row →
   drawer → `Open full skill` instead of `tr a.mono`; keep the inventory-visible intercept after a
   target change.
3. `e2e/skills.spec.ts`: `[data-skill-row]` selectors; `getByRole("link")`/`a.mono` navigation
   becomes row → drawer → `Open full skill`; keep state attributes.
4. `e2e/spa-skill-sources.spec.ts`: external `Open <name>`/name-exact button clicks become the
   `[data-skill-mode="external"]` activation; keep mode counts; replace the inventory `a[href]`
   `/skills/null` scan with a no-managed-`/skills/null` check.
5. Add targeted E2E: target selector (switch project/app, current check, Escape, mobile), attention
   (Show only/active-zero/clear/search), cards/list density persistence, drawer/effective link.
6. `docs/design/skills-qa.mjs`: update row/state/effective/scope selectors and row→detail flows;
   keep the deterministic fixture assertions; capture cards, list, attention, drawer, target menu,
   mobile.
7. Visual QA: run the project browser/visual harness; capture dark/light at 1600, 1280, 900, 390;
   check no horizontal overflow, no console/page errors, and light/dark contrast.
8. Run the full matrix: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`,
   `npm run typecheck:e2e`, `npm test`, `npm run build`, `npm run check:ui`,
   `npm run check:sensitive`, `npm run test:e2e`. Fix only regressions introduced by this stage.

### Acceptance criteria

- All E2E/QA flows pass; no console/page errors; no secret text.
- Visual QA passes in both themes and all four widths.
- All nine verification commands pass (or a pre-existing unrelated failure is recorded and
  attributed).
- No table-row/user-visible regression in create/detail.

### Verification

The nine commands above plus the browser/visual QA report in the journal draft.

---

## Phase F - Docs, record, and commit

### Boundaries

In scope: current-state/DESIGN updates, design/plan/journal indexes, open-questions record, journal
entry, stage commit/push. Out of scope: Stage B code and deployment.

### Invariants

- Docs are English; no host-specific or secret data.
- The journal links artifacts by path and records decisions/evidence, not restated design.
- The commit contains only this stage's files; the untracked `docs/design/settings-redesign/` and
  the pre-existing ahead commit are not included/rewritten.
- `npm run check:sensitive` passes before commit.

### Work

1. `docs/current-state.md`: update the Skills inventory description (cards/list, attention,
  target selector, preview drawer, target endpoint, density).
2. `DESIGN.md`: update §5.22 (skills inventory) and add the target selector + preview drawer
   component notes; no new tokens.
3. `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`: add the entries.
4. `docs/open-questions.md`: add the stage resolved-decisions section (no open items).
5. `docs/journal/0063-skills-inventory-redesign.md`: stage record with context, decisions, files,
   verification evidence, visual QA, risks, and next Stage B handoff.
6. Commit one coherent stage (code + tests + docs + record) with a Conventional Commit message;
   push per the process. Do not stage the unrelated untracked settings-redesign directory; note the
   pre-existing ahead commit in the record.

### Acceptance criteria

- All indexes updated; the journal record and open-questions section exist.
- The commit contains exactly the stage files and passes the sensitive scan.
- The final report names the commit SHA and any deployment follow-up (none in this stage).

### Verification

`npm run check:sensitive`, `git status`, `git show --stat HEAD`, and the nine gates above.

---

## Rollback and risk

- The stage is additive at the API level; rollback is a code revert (no schema migration). The
  create/detail routes and existing API contracts remain usable.
- The target endpoint is additive; an older client simply does not call it.
- The main risk is test/QA selector drift. The plan enumerates the known files; the executor must
  search for any remaining `data-skill-inventory`/`tr`/`a.mono`/`.settings-nav` assumptions before
  the gates.
- No deployment is part of this stage; the owner can deploy after the record using the standard
  deploy request.

## Plan review (momus, 2026-11-19) — OKAY WITH FIXES

Verdict: the plan is well-scoped and consistent with the design and code; the phase split is
implementable. Findings folded:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | major | E2E seed has no invalid/tombstone/shadowed/collision rows, so the new attention/drawer tests would be vacuous. | Phase E Work 1 extends `e2e/support/seed.ts` and uses those rows. |
| 2 | major | `SkillsPage.test.ts` migration was under-specified (`a.mono`, `.settings-nav__link`, nested external "View"). | Phase C Work 4 enumerates all migrations and a no-nested-controls assertion. |
| 3 | major | `npm run typecheck:e2e` was missing from the verification gates (CI runs it). | Bindings/Phase E/Phase F now include nine commands. |
| 4 | minor | Phase 0 claimed only `settings-redesign/` was untracked; the design/plan docs are also untracked. | Phase 0 now names all three paths and stages the design/plan docs in Phase F. |
| 5 | minor | "12 fixture rows" was undefined. | Phase C acceptance now uses the fixture-defined row set, no hard-coded count. |
| 6 | minor | Drawer tests omitted pre-v24 fallback, invalid/shadowed/disabled identity, `Open full skill`, scrim/focus. | Phase D Work 4 enumerates them. |
| 7 | minor | Phase 0 named only two E2E specs. | It now names all three, including `spa-skill-sources.spec.ts`. |

Gate: implementation is unblocked; all findings are folded before Phase A.
