# 20. Skill bundles and the skill workspace

- Status: implemented and verified; not deployed from this checkout
- Date: 2026-10-23
- Stage: `0017-skill-bundles`
- Design: [`docs/design/skill-bundles.md`](../design/skill-bundles.md) (oracle PASS, round 5)
- Plan: [`docs/plans/0017-skill-bundles.md`](../plans/0017-skill-bundles.md) (momus PASS)

## Context

Stage 0015 made a skill a single Markdown body with a generated `name`/`description` frontmatter.
The operator's real skills are bundles: 11 of 12 use a one-level `references/*.md` tree and a
metadata family (`author`, `version`, `domain`, `triggers`, `role`, `scope`, `output-format`,
`related-skills`, plus `license`). The list page also edited skills inline in an expanded row, which
duplicated the same skill between effective/defined sections and made the body, metadata, and files
hard to inspect. The owner asked for modular bundles, structured metadata, a dedicated view/edit
page, and a general UX redesign using the UI specialist.

## What shipped

1. **Bundle storage (migration v13).** `skills` gains nullable `license`/`compatibility` and a
   `metadata_json` string map; `skill_references` stores canonical `references/<slug>.md` paths and
   content with an FK cascade. `create`/`update`/`override` run in one transaction and replace the
   reference set atomically. `SkillService.get` returns the full bundle; resolution and inventory
   use summaries without reference bodies; `hash`/`probe`/`apply` load full effective bundles
   internally.
2. **Structured validation.** Name, description (newlines allowed), body, license, compatibility,
   known/custom metadata, reference slug/path, content, count, and aggregate limits are enforced in
   one shared write path. Stored rows are revalidated on read; invalid metadata/refs/bounds make a
   row ineligible without deleting it, invalid-name rows stay visible for repair, and tombstones
   hide only on a valid name. `SkillWarning` is collision/resolution-only; stored problems are
   `SkillStoredIssue` entries (`metadataRaw` is available for raw repair).
3. **Deterministic materialization.** Each effective bundle is rebuilt as
   `skills/<name>/SKILL.md` plus `references/<slug>.md`; references are written first and
   `SKILL.md` last, so a crash cannot expose a discoverable partial bundle. The generated frontmatter
   emits `name`, description, optional license/compatibility, and known/custom metadata in a fixed
   order with JSON-quoted scalars. Probe/apply share the algorithm and hash.
4. **Backward-compatible launch hash.** Legacy single-file rows keep their exact pre-v13 hash and
   `SKILL.md` bytes; only non-empty new fields are added to the projection. Clearing every new field
   restores the legacy hash. Effective-set changes mark affected running apps restart-required;
   shadowed/disabled edits do not. Manager probe-before-teardown/apply-after and the state-collision
   guard are unchanged. App/project deletion cascades reference rows.
5. **Shared safe renderer.** `renderMarkdown` and its DOM helpers moved from the chat client into
   `assets/markdown.js`; the chat and skill preview both import it. It builds text nodes and anchors
   only and never assigns skill text through `innerHTML`. A synthetic fixture covers raw HTML,
   `javascript:` links, tables, code fences, and links.
6. **Inventory and workspace.** The list is now a server-rendered inventory with scope nav, search,
   `All`/`Defined here`/`Inherited`/`Disabled`/`Invalid` filters, one row per name, issue/collision
   indicators, `Invalid local override`, and a restart rail. `/skills/new` creates a bundle;
   `/skills/:id` is a dedicated workspace with the scope chain, grouped metadata, file rail/tabs,
   source and preview side by side at >=1024, Source/Preview tabs below that, sticky save/discard,
   reference/metadata editing, issue repair, and delete/override/disable/revert. The old fragment
   envelope and `assets/skills.js` are gone.
7. **No-JS and responsive behavior.** Without JavaScript metadata/license/compatibility/reference
   controls are disabled and unnamed, every file editor is stacked, and one hidden bundle snapshot
   preserves the bundle while body/description/enabled can still be saved. The preview states that it
   requires JavaScript. The workspace is usable at 390/768/1024/1440 in dark and light.
8. **Evidence.** Browser QA in `docs/design/skills-qa.mjs` self-starts a synthetic fixture server and
   covers inventory, layouts, save/discard, JSON 400 focus, reference/metadata editing, invalid
   metadata repair, inherited override/disable/revert, create 409/422, no-JS snapshot round-trip,
   and the safe renderer. A real `opencode debug skill` run listed a materialized bundle with its
   reference file.

## Decisions and deviations

- Bulk import was deferred by the owner; this stage supports manual creation and reference editing.
- The owner chose side-by-side source and preview; mobile falls back to Source/Preview tabs and a
  file selector.
- The design-exact types were restored after Phase 4a/4b: required reference content, required
  `metadataRaw`, no legacy warning variant, and `EffectiveSkill.updatedAt`/`updatedBy` so inherited
  inventory rows show the real Updated value.
- `test/commands.test.ts` was updated for the known future schema version 14; the plan's test list
  did not name that fixture.
- The old fragment/skills.js behavior is intentionally removed; invalid-name warnings moved to row
  `storedIssues`.
- Invalid-name rows now expose the design's `Delete and re-create` danger zone (they are not
  editable in place).
- No optimistic locking; last write wins (single operator). No-JS metadata/reference editing and
  preview are intentionally unavailable. No `scripts/`/`assets/` bundle support yet.

## Verification

- `npm run typecheck` and `npm run lint` pass (228 files checked).
- `npm test` passes: **97 files, 1,632 tests**.
- `npm run build` passes.
- `node docs/design/skills-qa.mjs` passes **12 scenarios, 505 assertions, 29 screenshots**, with
  zero unexpected console/page errors (four expected HTTP-error console entries).
- `node docs/design/chat-qa.mjs` passes **14 scenarios, 299 assertions, 32 screenshots**, zero
  console/page errors. Generated chat artifacts were reverted because the extraction is
  render-equivalent and the stage does not intentionally change chat pixels.
- A temporary HOME/XDG `opencode debug skill` run listed `bundle-smoke` at its materialized path
  after the reference file was written.
- `npm run check:sensitive` passes.

## Next steps

Deployment is separate; this checkout was not deployed. Accepted debt: no optimistic locking, no
no-JS metadata/reference editing or preview, no `scripts/`/`assets/`, no bulk import, and no
guarantee against same-named repository/plugin/external skills.
