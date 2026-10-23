# 13. Skill bundles in the coordinator database

- Status: Accepted
- Date: 2026-10-23
- Stage: `0017-skill-bundles`
- Design: [`docs/design/skill-bundles.md`](../design/skill-bundles.md)
- Plan: [`docs/plans/0017-skill-bundles.md`](../plans/0017-skill-bundles.md)

## Context

The stage-0015 skill registry stored one Markdown body per skill. The operator's reusable skills are
bundles with a main `SKILL.md` and a one-level `references/` tree, plus a metadata family and a
license. Representing them required multi-file storage, structured frontmatter, and a workspace that
can inspect and edit the whole bundle without inline list-page editors. The coordinator DB remains
the source of truth and app state directories remain rebuildable.

## Decision

1. **Store the bundle in the coordinator DB.** A skill row keeps name, description, body, license,
   compatibility, a string-to-string metadata map, enabled state, timestamps, and actor. A
   `skill_references` child table stores canonical `references/<slug>.md` paths and content with an
   FK cascade. Reference paths are flat, Markdown-only, 1-64-character lowercase slugs, 15-78 total
   characters, up to 20 files, 48,000 characters each, 192,000 aggregate.
2. **Generate `SKILL.md`; never hand-edit frontmatter.** Emit name, description, optional license/
   compatibility, and known/custom metadata in a fixed order with JSON-quoted scalars. The body is
   stored separately. `update`/`override` replace the reference set in the same transaction as the
   parent row.
3. **Resolve by name with validity-aware fallback.** Global -> project -> application; the narrowest
   valid enabled row wins. A disabled row is a tombstone. Invalid metadata, references, or bounds
   make a row ineligible so a wider valid row can win; invalid-name rows stay visible but are not
   resolution candidates. Stored issues remain repairable through a dedicated workspace.
4. **Keep legacy behavior.** With no license, compatibility, metadata, or references, the effective
   hash is exactly the old `{name, description, content}` projection and the generated `SKILL.md`
   bytes are unchanged. Only non-empty new fields extend the hash. Zero-skill installs keep their
   hash; changes to an effective set require an explicit restart.
5. **Materialize the complete bundle.** References first, `SKILL.md` last, whole subtree rebuilt,
   probe before teardown and apply after teardown. The existing first-deploy preservation, symlink
   containment, collision scanning, and state-collision guard remain.
6. **Replace list-page editing with an inventory and workspace.** One row per name, scope-aware
   filters, issue/collision indicators, and a dedicated page with metadata, source, preview,
   references, save/discard, override/disable/revert/delete, and a create page. A shared safe
   Markdown renderer is extracted from chat for the live preview; no new dependency.
7. **Human-only, progressively enhanced.** All pages/APIs remain human-only; mutations keep Origin
   and local-return validation. Without JavaScript the bundle controls are disabled/unnamed, one
   hidden snapshot preserves the bundle, and body/description/enabled save through normal forms.
8. **Scope the stage.** Bulk import, scripts/assets, nested reference trees, hot reload, per-agent
   assignment, and optimistic locking are deferred. Rollback after bundle rows exist requires a
   forward fix or restoring a pre-upgrade DB/state backup because older code would drop references
   during materialization.

## Consequences

Positive: the operator's real skill structure is representable, frontmatter is always valid,
reference changes participate in restart detection, and the UI has a single canonical place to
inspect/edit a bundle. Costs: migration v13, a 4 MiB `/api/skills*` body bound, a larger HTTP/UI
surface, and a deliberate no-fragment/no-inline-editor change. The old fragment contract and
`assets/skills.js` are removed.

## Alternatives

- **JSON column for references** - rejected: no per-file constraints, duplicate paths, and whole-
  bundle rewrites.
- **Filesystem as source of truth** - rejected: breaks DB backup/restore and rebuildability.
- **Directory staging plus rename** - rejected: not portable-atomic for non-empty targets and probe
  staging is cross-filesystem; reference-first/`SKILL.md`-last rebuild gives the discovery invariant.
- **Hand-edited YAML** - rejected: invalid frontmatter silently hides skills.
- **Server-rendered Markdown / duplicate renderer** - rejected: new dependency or a second unsafe
  implementation; the chat renderer is extracted and shared.
- **Bulk import in this stage** - deferred by the owner.
