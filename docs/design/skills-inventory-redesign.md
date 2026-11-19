# Skills inventory redesign (B2)

Status: design review round 3 PASS WITH FIXES; all findings folded; plan pending. Stage: Skills
inventory, 2026-11-19.

## 1. Context

The current Skills inventory (`/skills`, `/projects/:id/skills`,
`/projects/:id/apps/:app/skills`) is a table plus a right rail. It is functionally complete but
underuses the data already returned by `GET /api/ui/skills`: state, origin, shadowing,
collisions, issues, external source, file/reference counts, restart state. The operator asked for a
less bulky, more useful inventory. A visual exploration produced three directions (workbench split,
library cards, triage ledger). The owner selected the **library (B2)** direction: cards grouped by
definition scope with a target selector, an attention band, a card/list density switch, and a right
summary rail.

The owner also approved reusing the same target selector everywhere a project/application is
chosen, with an app-only flat mode and a Master root for chat. That rollout is a **separate stage**
(Stage B). This design introduces the shared target catalog and selector contract because the
Skills redesign depends on them, but only Skills consumes them in this stage.

## 2. Decision summary

1. Replace only the **inventory** layout. The create (`/skills/new`) and detail (`/skills/:id`)
   workspaces keep their current editor and `SkillsScopeNav`; Stage B may adopt the selector there.
2. Render the inventory as **cards grouped by definition scope** (`row.scope`: `Application`,
   `Project`, `Global`; `External sources` for `mode === "external"`), with a **Cards/List**
   density switch. List mode adds a column header.
3. Add a **Needs attention** band above the groups. It is derived from the current scope rows
   (invalid, collision, scoped disabled tombstone). `Show only` filters the same inventory via a
   new server filter `filter=attention`; it is not a separate page or a second list.
4. Introduce a shared **`TargetSelector`** component and a new **`GET /api/ui/targets`** catalog.
   In this stage the selector is used with `mode="scope"`, `root="global"`, and navigates to the
   existing Skills routes. Stage B adds `mode="apps"` / `mode="projects"` and the `Master` /
   `All applications` roots for chat, SSH, settings, and handoff dialogs.
5. Clicking a managed card/row opens a **read-only preview drawer** fetched from the existing
   `GET /api/ui/skills/:id`. External rows keep the existing `ExternalSkillDrawer`. Mutations
   (override, disable, revert, delete, restart) remain on the detail workspace in this stage.
6. Add additive server props needed by the layout: `attention`, a per-row file count, a files
   summary in the workspace props, and `createdAt`/`updatedBy` on the workspace row. No schema
   migration.
7. Keep all existing routes, boot hydration, mutation flows, restart reporting, and the
   create/detail contracts.

## 3. Scope and non-goals

### In scope

- The three inventory routes and their responsive layout.
- Definition-scope grouping, cards/list, attention band, density preference, summary/warnings/
  restart rail, preview drawer, empty/error/loading states, mobile layout.
- `GET /api/ui/targets` and the shared selector component, used by the inventory.
- Server additions: `attention` props, `filter=attention`, `SkillSummary.fileCount`, workspace
  `files` summary, workspace `createdAt`/`updatedBy`.
- Unit, E2E, browser-QA, visual QA, docs/current-state, DESIGN.md, journal/plan records.
- Migration of inventory test/QA selectors and flows from table rows to `[data-skill-row]`
  elements, plus the target selector, attention band, density, and drawer tests.

### Out of scope (Stage B)

- Adopting the selector in chat, settings, SSH, handoffs, project policy/grants, or the shell.
- The app-only flat mode and `Master`/`All applications` roots in production.
- Terminal/Memory target pickers.
- Mutating actions inside the preview drawer.
- Arbitrary-file editing/upload UI in the workspace.
- Any change to skill resolution, materialization, storage, or the mutation API contract.

## 4. Owner decisions (recorded)

- The library (B2) direction is approved; the split workbench (A) was rejected. B2 was preferred
  over the triage ledger (C) for discoverability, with C's dense list retained as a switchable
  density.
- `Show only` should not become a separate page: it filters the same inventory list.
- List mode is approved and should have real column headers.
- A scoped disabled tombstone is part of the attention signal (B2 included it): it intentionally
  hides a wider row. This is a recorded owner decision; the band labels it `Tombstone`, not an
  error.
- The same selector should be reused everywhere a project/application is chosen, with an app-only
  flat mode and a `Master` root instead of `Global` for chat. This is Stage B; the shared contract
  is designed now.
- The owner delegated the remaining implementation choices and authorized the full delivery cycle.

No open owner decisions remain for this stage.

## 5. Current behavior to preserve

- Route ids/paths: `skills-global`, `skills-project`, `skills-app`, `skills-new`, `skills-detail`.
- `inventoryQuery` key, boot hydration guard, `hasSkillsMutated()` behavior, `usePageChrome`.
- `GET /api/ui/skills?scope=&project=&app=&filter=&q=` and its filter values.
- `rows` are server-filtered; `allCount`/`matchedCount` semantics; counts; warnings/truncated;
  pending restart entries.
- Create submission, duplicate-name handling, `SkillBundleEditor`, detail actions, external source
  drawer, restart semantics, and `ExternalSkillDrawer`.
- Cookie-only `/api/ui/*`, UI-version header, no secrets in props.
- Existing data attributes used by QA: `data-skill-inventory`, `data-skill-name`,
  `data-skill-state`, `data-skill-state-label`, `data-skill-mode`. Keep them on the new card/row
  elements even if the visual markup changes. `data-skill-effective-link` moves to the drawer's
  effective link; it is no longer on the row.

## 6. Data and API

### 6.1 Target catalog

New endpoint: `GET /api/ui/targets` (cookie-only, UI-version gated, added to `UI_API_PATHS`).

```ts
interface TargetAppProps {
  projectId: string;
  projectName: string;
  appKey: string;
  kind: string | null;
  master: boolean;
}
interface TargetProjectProps {
  id: string;
  name: string;
  apps: TargetAppProps[];
}
interface TargetsProps {
  projects: TargetProjectProps[];
  master: TargetAppProps | null;
}
```

- Projects are operator projects (`operatorProjects(site)`), deleting projects excluded.
- Apps exclude deleting apps; projects with zero apps are included so project-scope navigation
  still works.
- `master` is the reserved `hanse-master` / `master` app from `src/master/constants.ts`, with
  `master: true`, for Stage B. Skills does not show it.
- Stable sort: projects by name then id, apps by app key.
- No hrefs in the payload: each consumer maps a target to its route. This avoids coupling the
  catalog to chat/skills/settings/SSH URL shapes.
- Client mirror: `ui/target-types.ts`. Query key `["targets"]`, stale time 60 s, no boot
  injection. Invalidation on project/app mutations belongs to Stage B; a stale catalog only affects
  navigation, not data.
- Implementation builds the catalog from the `site` already created in `handleUiApi`; no extra
  database work inside the request. The separate request still triggers one `buildSite`; that is
  accepted for this self-hosted tool. No `UI_VERSION` bump: the addition is backward-compatible.
- The selector trigger renders from the **current page props**, not from the catalog, so a
  loading/error/absent catalog never blanks the current target. The menu has loading, error +
  `Retry`, and "current target not in catalog" states.

### 6.2 Attention

Add to `SkillsInventoryProps`:

```ts
type SkillsAttentionTone = "invalid" | "collision" | "disabled";
interface SkillsAttentionItemProps {
  key: string;                 // externalKey ?? String(primaryId ?? name)
  name: string;
  reason: string;
  tone: SkillsAttentionTone;
  scope: SkillScope | null;
  mode: SkillInventoryMode;
  primaryId: number | null;
  externalKey: string | null;
}
interface SkillsAttentionProps {
  count: number;
  items: SkillsAttentionItemProps[]; // up to 3
  omitted: number;                   // count - items.length
  truncated: number | null;          // collision-warning cap, from preview
  href: string;                      // filterHref(pagePath, "attention", search)
  clearHref: string;                 // filterHref(pagePath, "all", search)
  active: boolean;                   // input filter === "attention"
}
```

- Derived server-side from `allRows` (before the active filter/search), so the band is truthful
  even when the visible list is filtered.
- Predicate: `state === "invalid" || (state === "disabled" && shadows.length > 0) ||
  collisions.length > 0`. A disabled row is attention only when it actually hides a wider source;
  a disabled row with nothing to hide is not. The owner decision above records that a hiding
  tombstone is attention.
- Sort: invalid, collision, disabled; then name. `items` is the first 3; `omitted` is the rest.
- Reasons: invalid → first issue message; collision → first collision text; disabled →
  `Hides ${shadows.map(scopeLabel).join(", ")}`. Do not reuse `originText` for the tombstone reason.
- Collision-derived matches are bounded by the existing collision-warning cap. `truncated` carries
  the existing preview truncation; the band must not claim more matches than the available
  warnings. The rail still shows the full `truncated` count.
- Add `"attention"` to the server `InventoryFilter`/`parseInventoryFilter`/
  `inventoryMatchesFilter` **and** to the client parse-only list in
  `ui/pages/SkillsPage.vue` (`FILTERS`/`parseFilter`, `inventoryApiPath`, query key, boot
  hydration). Do **not** add a seventh filter chip; the band is the control.
- Build `href`/`clearHref` with `filterHref(pagePath, value, search)` so search is preserved.
- The band is visible when `count > 0` **or** `filter === "attention"`. If the active filter has
  zero matches, show `Needs attention · 0` with `Clear`; the empty state also explains it. This
  avoids an invisible active filter and a stale bookmark trap.
- The search form passes the hidden `attention` filter; `matchedCount` reflects
  attention ∩ search.

### 6.3 Workspace preview additions

- Add `fileCount` to `SkillSummary` in `src/skills/types.ts`, populated by `src/skills/service.ts`
  from the same `#summaryFiles` used by `EffectiveSkill.fileCount`. Use the scoped row's count for
  scoped rows; use the effective count only for effective-only rows. External rows keep their
  current count. This fixes the current `fileCount: effective?.fileCount ?? scoped.references.length`
  lie for shadowed/invalid scoped rows.
- Add `files: { path: string; size: number; executable?: boolean }[]` to `SkillWorkspaceProps`,
  built from `SkillRow.files ?? []` without content. Create mode returns `[]`.
- Add `createdAt: string | null` and `updatedBy: string | null` to `SkillWorkspaceRowProps`;
  create mode returns `null`/`null` (`emptyRow` uses epoch).
- Add the client mirror in `ui/skills-types.ts`.
- No new endpoint: the preview drawer uses `GET /api/ui/skills/:id?from=...` (existing
  `SkillDetailResponse`).
- The detail payload includes `form`/`danger` and full reference content; the drawer ignores them.
  The response is operator-only and already used by the detail page; no new leak. The drawer uses
  the body (`values.content`) and the paths/sizes, not the reference content.

## 7. UI structure

### 7.1 Header and controls

- Header: overline `Skills · <Global|Project|Application>`, title `Skills`, description from the
  server, meta line `N skills · M matched · W warnings · P apps need restart` (omit zero
  warning/restart segments), primary `New skill`.
- Control bar: live search (250 ms debounce, `router.replace`; Enter immediate), filter chips
  (existing six), `TargetSelector`, `Cards/List` density toggle, and the result count
  `M of N skills at this scope`.
- Search: keep Enter immediate, `/` focuses, `Escape` clears when focused; add a clear button.
- The target selector replaces `SkillsScopeNav` on the inventory only. Create/detail keep the
  existing scope nav.

### 7.2 Attention band

- A ruled band under the control bar: warning glyph, `Needs attention`, count, up to 3
  `name + reason` entries, `+N more`, and `Show only`/`Showing only` + `Clear`.
- No card, no shadow; use existing status tokens for tone and text labels, never color alone.
- The entries are not individually interactive; `Show only` is the single action. This avoids a
  second navigation concept and keeps the action on filtering the list.
- `Tombstone` entries use the disabled tone and wording, not `Invalid`.

### 7.3 Inventory

- Group managed rows by `row.scope`; group external rows by `mode === "external"`. Use
  `originScope`/`originText` only in the card/list origin note, not for the group key.
- Cards: name (mono), state pill, description clamp 2, note row (issue/collision/shadow/tombstone),
  footer with origin, file/ref counts, updated time, chevron. External cards show source/bucket/rev
  and read-only.
- The file count is the row's own count (`scoped.fileCount`); effective-only rows use the effective
  count; external rows use the external bundle count.
- List: 44px rows, a single column header (`STATE`, `SKILL`, `ORIGIN`, `FILES/REFS`, `UPDATED`),
  same data; on mobile the header is hidden and rows become two-line blocks.
- Group headers show visible counts; empty groups are hidden.
- Preserve `data-skill-inventory` on the container and put `data-skill-row`, `data-skill-name`,
  `data-skill-state`, `data-skill-state-label`, and `data-skill-mode` on the activation element.
  `data-skill-effective-link` is on the drawer's effective link, not the row. The QA script is
  updated accordingly.
- Density: localStorage key `hanse.skills.density` (`cards|list`); default cards.

### 7.4 Rail and preview drawer

- Right rail: summary counts, warnings + truncated count, restart-required apps, resolution
  explainer. `Hide/Show` collapse control; rail moves below the content on mobile.
- Managed card/row click opens `SkillPreviewDrawer`:
  - Fetch `GET /api/ui/skills/${id}?from=${encodeURIComponent(from)}` where
    `id = String(row.primaryId)` (guard null for external rows) and `from` = `inventoryHref`
    (the decoded scope page path, e.g. `/projects/p1/skills`). Do not use the already-encoded
    `from` value inside `row.href`; encode only in the request URL.
  - Use the string id and the same query key as the detail page
    (`["skills-detail", id, from]`), with `refetchOnMount: "always"`/`staleTime: 0` when opened,
    so a drawer opened after an edit cannot silently show stale content.
  - Header with state/origin, description, resolution chain, source-style body, metadata,
    references/files, `Open full skill` (`row.href`), and `Open effective source`
    (`row.effectiveHref`) when present; the effective anchor carries
    `data-skill-effective-link`. For invalid/shadowed rows, `row.href`/`primaryId` already point
    at the repair/tombstone target; keep both links so the operator can reach the effective
    source.
  - `files` is the authoritative bundle list, default `[]`; show it once. Show legacy
    `references` only when `files` is empty or when a reference path is not present in `files`.
    Never list the same path twice. Test both pre-v24 (no files) and current rows.
  - Read-only; no mutations. Show a small read-only note.
  - Native `<dialog>` right sheet, full-screen on mobile; scrim/Escape/close, focus return, loading
    and error + retry.
- External card/row click keeps `ExternalSkillDrawer`.
- No `Inspected` strip: it was a mockup device and has no production data model. The drawer is the
  preview surface.

### 7.5 Activation, ARIA, responsive

- A managed card/row is **one activation target**: a native `<button type="button">` (block-level
  layout via spans) or an equivalent single control with `role="button"` and `tabindex="0"`.
  Enter/Space are native for a button. Secondary actions live only in the drawer; do not nest
  links/buttons inside the card/row. External rows use the same single button and open the
  external drawer.
- The target selector uses a precise dialog + combobox/listbox pattern:
  - Trigger: `<button aria-haspopup="dialog" aria-expanded aria-controls>`.
  - Popover: `role="dialog" aria-label="Choose target"`, focus moves to the search input.
  - Search input: `role="combobox"`, `aria-expanded="true"`, `aria-controls`, `aria-autocomplete="list"`,
    and `aria-activedescendant` pointing at the active option.
  - List: `role="listbox"`; options `role="option"` with ids and `aria-selected`; group headings
    are presentation/`aria-hidden`; the current option is selected.
  - Focus stays in the combobox input; Arrow Up/Down/Home/End update the active option; Enter
    selects; Escape closes; click-outside closes; focus returns to the trigger.
  - Do not use `role="menu"` with a search input or a text input inside a bare listbox.
- Responsive: 3 card columns ≥1280 with a 300px rail; 2 at ≥900; 1 below 900. Rail below content
  below 900. Search full width on mobile; target selector and density share a row; filter chips
  scroll horizontally in a focusable, labelled region.
- Use existing Chart Room tokens only (status/neutral); no new colors. Light and dark both pass
  visual QA.

## 8. Shared target selector contract (introduced here, Stage B rollout)

```ts
type Target =
  | { kind: "global" }
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "app"; projectId: string; appKey: string; master?: boolean };

type TargetSelectorConfig =
  | { mode: "scope"; root: "global" | null }
  | { mode: "apps"; root: "master" | "all" | null; fixedProjectId?: string }
  | { mode: "projects" };
```

- `scope`: root Global + projects + their apps (Skills, Settings).
- `apps`: root Master/All + flat apps grouped by project headings; project rows are labels, not
  steps (Chat, SSH, handoff dialogs). The value always carries `(projectId, appKey)`; an app-only
  UI is a flattening, not a projectless identity. The selector shows the project label when app
  keys repeat.
- `projects`: projects only (grants target project).
- `fixedProjectId`: same-project dialogs; apps only, no project step.
- `all` = all operator apps, excludes master and deleting apps; `master` is the reserved
  `hanse-master/master` app; `fixedProjectId` disables project rows and the project root.
- The component emits `change(target)`; it does not navigate. Consumers map to routes/forms.
- Stage A implements and tests `mode="scope"` + `root="global"`; the remaining modes are Stage B.
  The exported type is a discriminated union so invalid combinations are unrepresentable.

## 9. Alternatives considered

1. Keep the table + rail. Rejected: the owner found it bulky and under-informative.
2. Card grid only (B). Rejected at scale; the list toggle retains density.
3. Triage ledger (C). Rejected as the default because it hides the library overview; its dense
   row pattern is retained in list mode.
4. Client-side attention from `view.rows`. Rejected: rows are server-filtered, so the band would
   disappear when a filter/search hides an item. A server `attention` summary + `filter=attention`
   keeps the band truthful and the filter shareable.
5. Reuse `/api/projects` or lazy `/api/ui/projects/:id` for the catalog. Rejected: `/api/projects`
   is public, excludes master, and has no route hrefs; lazy project detail is N+1 and heavy. A
   small cookie-only catalog endpoint backed by the already-built `site` is cheaper and shared.
6. Mutating actions in the preview drawer. Rejected for this stage: duplicates the detail
   workspace action/error/restart flows. The drawer links to the existing workspace.
7. Keep the `Inspected` strip. Rejected: no production "inspected" state; the drawer is the
   preview.

## 10. Test, QA, docs, and rollout impact

- Server unit tests: `attention` derivation (invalid/collision/disabled, order, >3, truncated),
  `filter=attention`, `SkillSummary.fileCount` for a shadowed/non-effective row, workspace
  `files`/`createdAt`/`updatedBy`, targets endpoint auth/version/shape/filters, no secrets.
- UI unit tests: `SkillsPage.test.ts` and fixtures must move from table rows to
  `[data-skill-row]`; test cards/list, target selector navigation/fallback, attention band/filter
  (including active-zero and search preservation), density persistence, drawer open/close/loading/
  error/effective link, external drawer, empty/error states. `SkillsPage.test.ts` selectors to
  rewrite: table `tr`, `a.mono`, `.settings-nav__link`, filter links, search form.
- E2E:
  - `e2e/spa-skills.spec.ts`: `.settings-nav` → target selector trigger/menu; `tr a.mono` →
    `[data-skill-row]` + drawer `Open full skill`; the "keeps current inventory visible" test
    intercepts the same `/api/ui/skills?scope=global` request after a target-selector click.
  - `e2e/skills.spec.ts`: all `[data-skill-inventory] tr[...]` selectors → `[data-skill-row]`;
    the `getByRole("link", { name: GLOBAL_SKILL })` and `a.mono` detail navigations become
    row click → drawer `Open full skill`; keep `data-skill-state` and `data-skill-state-label`
    assertions. The override/disable/revert flows use the same row→drawer→open path.
  - `e2e/spa-skill-sources.spec.ts`: the external `Open <name>` / name-exact button clicks become
    a click on the `[data-skill-mode="external"]` activation element; keep the
    `data-skill-mode` count assertions; replace the inventory `a[href]` / `/skills/null` scan
    with a check that no managed row/button exposes `/skills/null`.
  - `SkillsPage.test.ts`: the nested external "View" button interaction
    (`[data-skill-name="release-checklist"]` → `findAll("button")` → text "View") becomes a click
    on the row activation element, which opens the external drawer.
  - Add a target-selector E2E: switch project/app, current check, focus/Escape, mobile menu.
  - Add an attention E2E: `Show only`, active-zero, clear, search preserved.
- Browser QA: update `docs/design/skills-qa.mjs`:
  - `tr[data-skill-name]` → `[data-skill-row]`; keep `data-skill-state-label`.
  - `.settings-nav__scopes [aria-current]` → the target-selector trigger/current check.
  - The `[data-skill-name="shared-rules"] [data-skill-effective-link]` and
    `app-broken` count assertions move to the drawer: open the row, assert the drawer's
    `Open effective source` link / `data-skill-effective-link`, then close.
  - The read-only-context and post-disable reopens
    `[data-skill-name="ops-guide"] a[aria-label="Open ops-guide"]` and
    `deploy-notes` equivalent become row click → drawer `Open full skill`; the detail-page state
    assertions stay on the detail page.
  - Capture cards, list, attention, drawer, target menu, mobile; dark + light.
- Docs: `docs/current-state.md` skills section; `DESIGN.md` §5.22 and a new target-selector /
  preview-drawer subsection; `docs/design/README.md`, `docs/plans/README.md`,
  `docs/journal/README.md`; `docs/open-questions.md` resolved decisions.
- CSS: all new `skills-*`/`target-*` classes go in `src/http/styles.css`; no SFC `<style>`; run
  `npm run check:ui` to catch the CSS/build sentinel.
- No `UI_VERSION` bump for additive props; the new endpoint is added to `UI_API_PATHS` and reuses
  `authorizeUiRead` + `requireUiVersion`.

## 11. Risks and mitigations

- **Client attention parser drift**: add `attention` to both server and client parse lists and
  test boot hydration + refetch; a mismatch silently shows all rows.
- **Drawer identity drift**: use `row.primaryId`, `row.href`, `row.effectiveHref`; pass the scope
  page as `from`; share the detail query key/refetch on open. Test invalid, shadowed, and disabled
  rows.
- **Grouping**: use `row.scope` (definition), not `originScope`; test an app override of a project
  skill.
- **File count**: add `SkillSummary.fileCount`; test a shadowed scoped row with files.
- **Tombstone signal**: owner-approved; label it `Tombstone`, not an error; a future owner change
  is a predicate change.
- **Collision cap**: attention count is bounded by the warning cap; expose `truncated` and do not
  claim more than available.
- **Selector fallback**: trigger renders from page props; menu loading/error/retry; current target
  always visible.
- **Nested controls**: one button per card/row; secondary actions in the drawer; native
  Enter/Space.
- **ARIA**: dialog+listbox pattern as above; no search input inside a bare listbox.
- **References/files duplication**: files authoritative; references fallback only; default `[]`.
- **E2E/QA churn**: enumerated selector and flow updates; keep the existing data attributes.
- **Target endpoint cost**: one extra `buildSite` per page load; accepted; client cache 60 s; no
  server cache in v1.
- **Drawer staleness**: share the detail key or refetch on open; mutations invalidate the
  inventory as today.
- **Stage B ambiguity**: discriminated union; Stage A narrow.

## 12. Open questions

None. The owner delegated the remaining choices; the decisions above are the record.

## 13. Design review

### Round 1 (`oracle`, 2026-11-19) — PASS WITH FIXES

Verdict: the B2 direction, server-side attention + `filter=attention`, and the target catalog are
sound; the design was not decision-complete. Findings and resolutions:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | blocker | Client `FILTERS`/`parseFilter` did not know `attention`, so boot/refetch would drop it. | §6.2 now requires the client parse-only list, query key, API path, and boot tests. |
| 2 | blocker | Drawer id/`from`/effective link undefined; could open the wrong row or lose context. | §7.4 uses `row.primaryId`, `row.href`, `row.effectiveHref`, the scope `from`, and the shared detail key. |
| 3 | blocker | Test/QA migration under-scoped (unit, E2E, `skills-qa.mjs`, fixtures, data attributes). | §10 enumerates every selector/flow and keeps the QA data attributes. |
| 4 | major | Grouping by `originScope` misplaces invalid local overrides. | §7.3 groups by `row.scope`; origin is a note only. |
| 5 | major | Every disabled tombstone treated as attention. | §4 records the owner decision; §7.2 labels `Tombstone`, scope-local. |
| 6 | major | `fileCount` was the effective/legacy count, not the row's. | §6.3 adds `SkillSummary.fileCount`; §7.3 uses the row's count. |
| 7 | major | Selector had no loading/error/fallback current label. | §6.1/§8: trigger from page props; menu loading/error/retry. |
| 8 | major | Nested interactive controls and Enter/Space ambiguity. | §7.5: one native button per card/row; secondary actions in the drawer. |
| 9 | major | Ambiguous listbox/menu ARIA with a search input. | §7.5: dialog + listbox pattern, precise roles/keys. |
| 10 | major | References/files duplication and optional `files`. | §6.3/§7.4: files authoritative, default `[]`, references fallback only. |
| 11 | major | Attention count could undercount capped collision warnings. | §6.2 exposes `truncated`; no overclaim. |
| 12 | minor | Active-zero attention invisible; `Show only`/`Clear` dropped search. | §6.2 keeps the band visible when active and builds hrefs with `filterHref(..., search)`. |
| 13 | minor | CSS/docs placement and `DESIGN.md` drift. | §10 names `src/http/styles.css` and the doc updates. |
| 14 | minor | Targets endpoint integration/perf. | §6.1 adds `UI_API_PATHS`, uses the already-built `site`, accepts one extra `buildSite`, no version bump. |
| 15 | minor | Drawer cache/create metadata. | §7.4 shares the detail key/refetches; create mode nulls the fields. |
| 16 | minor | Stage B mode/root combinations ambiguous. | §8 uses a discriminated union and defines `all`/`master`/`fixedProjectId`. |

Round 2 (`oracle`, 2026-11-19) — PASS WITH REMAINING FIXES. Round-1 blocker #1 (client
attention parser) is closed. Blockers #2 and #3 were not fully closed. Remaining findings and
resolutions:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | blocker | `data-skill-effective-link` cannot live on a one-button row; QA asserts a descendant link, contradicting §7.5. | §5/§7.3 remove it from the row; §7.4 puts it on the drawer's `Open effective source`; §10 updates the QA flow to open the drawer. |
| 2 | major | Detail query key used `primaryId` as a number while the detail page uses a string id. | §7.4 uses `id = String(row.primaryId)` and `["skills-detail", id, from]`. |
| 3 | major | `from` described as the value in `row.href`, which is already encoded; would double-encode and lose context. | §7.4 uses `inventoryHref` (decoded scope page) and encodes only in the request URL. |
| 4 | major | Every disabled row counted as attention, including a disabled global row that hides nothing; reason reused `originText`. | §6.2 requires `shadows.length > 0` and uses `Hides ${shadows...}`. |
| 5 | major | Test/QA migration still missed row→detail navigation in `e2e/skills.spec.ts` and `skills-qa.mjs`. | §10 lists `getByRole("link")` and the two `a[aria-label="Open ..."]` reopens; all become row→drawer→`Open full skill`. |
| 6 | major | Search input inside a dialog/listbox had no combobox/active-descendant linkage. | §7.5 specifies the combobox + listbox focus model with `aria-activedescendant`. |

Round 3 (`oracle`, 2026-11-19) — PASS WITH FIXES. All six round-2 items are closed. Two
test-migration majors were still missing and are folded into §10:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | major | `e2e/spa-skill-sources.spec.ts` not listed; its `Open <name>`/name-exact button clicks and `a[href]` scan break with one-button rows. | §10 adds the file: click `[data-skill-mode="external"]` activation; keep mode counts; replace the vacuous `/skills/null` scan. |
| 2 | major | `SkillsPage.test.ts` nested external "View" button interaction is omitted from the selector list. | §10 adds the row-activation replacement for the external drawer test. |

Design gate: PASS (round 3, findings folded). Next: plan review with `momus`.
