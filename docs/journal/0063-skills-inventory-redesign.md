# Journal 0063 - Skills inventory redesign (B2)

Status: **implementation complete (phases A-E); full gates, E2E, and the inventory QA/visual pass
are green** (2026-11-19). Design `oracle` round 3 PASS WITH FIXES; plan `momus` OKAY WITH FIXES.
Stage B selector rollout is a separate follow-up.

Design: [`docs/design/skills-inventory-redesign.md`](../design/skills-inventory-redesign.md)
Plan: [`docs/plans/0049-skills-inventory-redesign.md`](../plans/0049-skills-inventory-redesign.md)
Owner decisions: [`docs/open-questions.md`](../open-questions.md), stage
`0049-skills-inventory-redesign` (2026-11-19). No open questions.

## Context

The old inventory was a server-rendered table with a scope ladder, a dense row per skill, and a
separate workspace. The owner selected the B2 library: cards/list grouped by definition scope, a
truthful attention band, a shared target selector, Cards/List density, a collapsible rail, and a
read-only preview drawer. The same selector contract is introduced here for the later Stage B
rollout to Chat, Settings, SSH, and handoff dialogs; this stage only uses `scope` + `global`.

## Shipped

- **Server truth:** `SkillSummary.fileCount` is the row's own bundle count; the inventory uses the
  scoped count, the effective count only for effective-only rows, and the external count for
  external rows. `SkillsAttentionProps` is derived from the unscoped `allRows` (invalid, managed
  collision, hiding tombstone), sorted invalid -> collision -> disabled -> name, capped at three
  with `omitted`/`truncated` and search-preserving `href`/`clearHref`. `filter=attention` parses
  and filters without adding a chip. Workspace props add content-free `files` and row
  `createdAt`/`updatedBy`; create returns `[]`/`null`/`null`.
- **Target catalog:** `GET /api/ui/targets` is cookie-only and UI-version gated. It returns
  operator projects (zero-app projects included), non-deleting apps, and the reserved master app
  separately; no hrefs, paths, or secrets. `ui/target-types.ts` mirrors the payload and the
  `Target`/`TargetSelectorConfig` discriminated union.
- **Shared selector:** `TargetSelector.vue` is a 32px trigger plus a native dialog with a
  combobox/listbox, search, loading/error/retry, current-target fallback, keyboard navigation and
  focus return. `ui/skills-target.ts` maps targets to the three Skills routes and provides stable
  keys/equality. It does not navigate; the page maps `change` to `router.push`.
- **B2 inventory:** header/meta, live search (250 ms `router.replace`, Enter immediate, `/` focus,
  Escape clear), six filter chips in a scrollable focusable strip, Cards/List density persisted at
  `localStorage["hanse.skills.density"]`, attention band, scoped card/list groups, and a
  collapsible overview rail. Each managed/external row is one native button; managed rows open
  `SkillPreviewDrawer`, external rows keep `ExternalSkillDrawer`.
- **Preview drawer:** `SkillPreviewDrawer.vue` uses the existing
  `GET /api/ui/skills/:id?from=...` and the detail query key, refetches on open, and renders
  identity, content, metadata, authoritative files plus only missing legacy references, and
  `Open full skill`/`Open effective source`. It is read-only and has no forms or mutation controls.
- **Fixture/E2E/QA:** `e2e/support/seed.ts` adds deterministic invalid, disabled-tombstone,
  shadowed-invalid-local, and repository-root collision rows (the collision file is amended into
  the initial `fixture commit`). The three Skills specs use row -> drawer -> detail and the target
  selector dialogs. `docs/design/skills-qa.mjs` captures cards, list, attention, drawer, target
  menu, and mobile at 1600/1280/900/390 in both themes; `SKILLS_QA_ONLY=inventory` runs the B2
  surface alone.

## Verification

- `npm run lint` - PASS (998 files, no fixes).
- `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e` - PASS.
- `npm test` - **4413 passed, 4 skipped** (295 files; 14m18s).
- `npm run build` - PASS (`tsc`, Tailwind, Vite).
- `npm run check:ui` - PASS (95 SFCs, sentinel present).
- `npm run check:sensitive` - PASS.
- `npm run test:e2e` - **156 passed, 1 skipped** (157 total; 8m36s). One first-run chat-stream
  failure passed on rerun and in the full green run; the seed's collision commit was amended
  after the first full run so `spa-app` still sees `fixture commit` as the last commit.
- `SKILLS_QA_ONLY=inventory node docs/design/skills-qa.mjs` - PASS, **488 assertions**, 56
  screenshots, 0 console/page errors. Visual review at 1600/1280/900/390 in dark and light; fixed
  the mobile trigger/density squeeze and attention-name wrapping after the first pass.
  The QA harness's workspace scenarios still carry pre-SPA selectors and are out of this stage's
  inventory gate; that debt is explicit in the script header and is not claimed as a pass.

## Decisions and risks

- Attention is server-derived from the unscoped rows, so the band stays truthful when the visible
  list is filtered or searched; the active-zero band remains visible with `Clear`.
- External rows are read-only and never create `/skills/null` links; the managed drawer is
  read-only because the existing workspace owns mutations and restart/error flows.
- The target catalog is a separate cookie-only request; it deliberately carries no hrefs, so each
  consumer maps a target to its own route. Stage B owns catalog invalidation on project/app changes.
- No schema migration and no new npm dependency.
- The tree already had one ahead commit and the untracked `docs/design/settings-redesign/`
  directory before this stage; neither is rewritten or staged.

## Next stage

Stage B: reuse `TargetSelector` in Chat (Master root + app-only flat mode), Settings, SSH, and
handoff dialogs; add `all`/`fixedProjectId` consumers, catalog invalidation, and the remaining
mode tests. The Skills page stays on `mode="scope"` + `root="global"`.
