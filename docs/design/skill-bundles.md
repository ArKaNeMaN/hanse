# Design - Skill bundles and the skill workspace

Status: **approved** - design review PASS (oracle, 2026-10-23).
Scope: extend the existing global/project/application skill registry from one Markdown body to a
portable skill bundle (`SKILL.md` plus `references/*.md`), expose the frontmatter metadata as
structured fields, and replace inline list-page editing with a dedicated skill workspace.
Out of scope: scripts/assets, nested reference trees, bulk import, version history, hot reload,
per-agent assignment, agent-authored skills, and changing opencode's discovery or precedence rules.

## 1. Problem

The current stage (0015, journal 0018) stores a skill as a name, one description, one Markdown
body, and an enabled flag. It generates a `SKILL.md` with only `name` and `description`, and
materializes exactly one file per skill. That is enough for a single-file procedure, but it cannot
represent the skills the owner actually uses: 11 of the 12 global skills under
`<AGENTS_SKILLS_ROOT>` are bundles with a main `SKILL.md` and a one-level `references/`
directory, and every one of those 11 carries a stable metadata family
(`author`, `version`, `domain`, `triggers`, `role`, `scope`, `output-format`, `related-skills`) plus
`license: MIT`.

The current Web UI also edits a skill inside an expanded row of the list page. The same skill appears
in both "Effective here" and "Defined here" with actions split between them; the body is only
reachable through "Edit"; Cancel collapses the row without reverting the draft; dialogs retain stale
values; and there is no dedicated page to inspect a skill, its metadata, or its reference files.

This stage makes the bundle the unit of storage and materialization, and makes the skill itself a
first-class page.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| K1 | A managed skill is a bundle: a generated `SKILL.md` plus zero or more `references/<slug>.md` files. References are one level below `SKILL.md`, Markdown only, and are written after CRLF/CR normalization. |
| K2 | The coordinator stores structured fields for `name`, `description`, `license`, `compatibility`, the skill body, and a string-to-string metadata map. The known family keys (`author`, `version`, `domain`, `triggers`, `role`, `scope`, `output-format`, `related-skills`) are first-class editor fields; unknown metadata keys are preserved. |
| K3 | `SKILL.md` is generated deterministically from stored fields: valid YAML frontmatter followed by the body. Stored data, not hand-edited frontmatter, is the source of truth. |
| K4 | The scope list pages become inventories, not editors. Every skill has a dedicated page for viewing and editing, reachable by URL and by navigation. |
| K5 | The dedicated page shows the skill's scope, source, state, metadata, body, and reference files. The body uses side-by-side source and preview on desktop, with a mobile fallback that does not lose edits. It supports save, discard, enable/disable, override at the current scope, revert, and delete with the existing inheritance semantics. |
| K6 | Global -> project -> application resolution, name-keyed shadowing, tombstones, override, and project/app deletion behavior are unchanged. Override copies the complete bundle, not just the body. |
| K7 | Materialization writes the complete bundle into the existing Hanse-owned per-instance root, removes stale bundle files, and keeps probe/apply bytes and hashes equal. |
| K8 | The effective hash includes everything that changes agent behavior: description, body, metadata, license, compatibility, and references. A skill without metadata, license, compatibility, or references must keep the pre-stage hash for the same name, description, and body, so an upgrade does not mark running agents restart-required. |
| K9 | Validation and filesystem safety cover reference paths, file counts, per-file and aggregate sizes, duplicate/reserved names, traversal, symlinks, and NUL bytes. All skill pages and APIs remain human-only, and mutations keep the existing cross-site Origin rejection. |
| K10 | No new runtime dependency. The implementation stays on TypeScript/ESM/NodeNext, SQLite, Tailwind CSS, and vanilla JS or existing ES modules. |
| K11 | Existing skill rows, scope pages, core APIs, restart semantics, deletion, collisions, and auth remain compatible. Intentional API changes: the list fragment envelope and `assets/skills.js` are removed; an invalid-name condition moves from `warnings` to the row’s `storedIssues` so it can be repaired; `POST /api/skills/:id` with `action=delete` remains. Migration v13 is additive. |

## 3. Verified facts

- `opencode` discovers `SKILL.md` recursively under its config skill roots. The portable frontmatter
  is `name` and `description`, with optional `license`, `compatibility`, and a string-to-string
  `metadata` map. The body is the Markdown below the frontmatter; additional files are not indexed
  separately and are read only when the body points to them.
- The owner's global skills use one-level `references/*.md`; no `scripts/` or `assets/` directories
  are present. The largest current main body is about 24k characters; reference directories hold up
  to 7 files and about 66k characters total, with the largest reference about 16k.
- Eleven of the twelve bundle skills share the same metadata shape; `find-skills` is a single-file
  skill with only `name` and `description`. The editor must keep single-file skills valid and must
  not require every metadata field.
- The current coordinator owns `<XDG_CONFIG_HOME>/opencode/{skills,skill}` per application, rebuilds
  each `<name>/` subtree on every apply, and hashes only the effective `{name, description, content}`
  set. `probe` stages outside the app tree before teardown; `apply` writes after teardown.
- The current `skills` table (migration v12) has no child table, no metadata column, and no
  `license`/`compatibility` fields. The current HTTP body limit for `/api/skills*` is 512 KiB.
- The current UI is server-rendered with a vanilla-JS fragment save. It has no `/skills/:id` page and
  no dedicated skill view; `GET /api/skills/:id` exists but is not used by the browser code.
- The safe Markdown renderer is a DOM-building subset inside `assets/chat.js`; it already imports
  `parseMarkdownTable` from the shared `assets/chat-core.js` ES module. There is no server-side
  Markdown renderer.

### 3.1 Current UX evidence

- The same skill is rendered twice: once in "Effective here" and once in "Defined at this scope"
  (`src/http/skills.ts:467-669`). Actions are split between the two copies, and "Edit here" is an
  anchor into a row further down the page.
- The only way to read the body is to open an inline editor; the effective row shows only the
  description. There is no dedicated page and no reference-file concept.
- Cancel is not a cancel: it only closes the `<details>` row (`assets/skills.js:366-373`), leaving the
  edited values in the DOM. There is no dirty guard or navigation warning.
- Dialogs live outside the `#skills-surface` fragment. A successful create closes the dialog but does
  not reset the form or its error (`assets/skills.js:212-218`; `src/http/skills.ts:671-719`), so the
  next open can show stale values.
- Errors are form-level. The client marks the first visible control invalid
  (`assets/skills.js:47-76`), so a content error can highlight the name field; there is no
  `aria-describedby` link from the error to the field.
- After row-level actions outside a `<details>` (override, disable), focus restoration has no target;
  after deleting a tombstone the inherited row is in a different section, so focus is lost
  (`assets/skills.js:112-178, 220-231`).
- The 390px dialog remains a floating card with a nested 60dvh scroll body
  (`src/http/styles.css:1778-1801, 3264-3266`), not the full-width sheet the design contract
  describes. The inventory rail breakpoint is 1280px (`src/http/styles.css:2540-2544`), which
  matches `DESIGN.md:1066-1067`.
- The browser QA harness covers 1440 and 390 in dark mode only, and its 49 assertions check presence
  and one create/edit-open/disable/delete path (`docs/design/skills-qa.mjs:233-314, 360-445`). It does
  not save an edited body, exercise override/enable/revert, no-JS, empty/error/light states,
  768/1024 widths, focus restoration, or dialog reset. The harness is not part of CI.

### 3.2 Constraints

- The database is the source of truth. App state directories are rebuildable; reference files cannot
  live only on disk without a reconciliation model.
- Probe staging and live apply must produce identical bytes and hashes. Probe must not write into the
  agent-writable app tree before teardown.
- Existing single-file skills must not become restart-required merely because the feature ships; the
  hash payload is therefore additive only when the new fields are non-empty.
- Skill names are path segments and are validated twice: on write and during materialization. Any
  reference filename becomes a path segment too and needs the same defense in depth.
- The UI is server-rendered, progressively enhanced, and uses the Chart Room primitives. A new
  dependency or an SPA rewrite is out of scope.

## 4. Decisions

### D1 - Reference files live in a child table; metadata is a JSON map

A bundle has one generated `SKILL.md` and zero or more rows in `skill_references`. A reference row
stores a canonical path (`references/<slug>.md`) and its exact text. The child table is preferred
over a JSON column because it gives a unique path per skill, per-row content checks, a clean
`ON DELETE CASCADE`, and bounded per-file updates without rewriting every reference. A filesystem
source of truth is rejected: the DB is already the coordinator's source of truth, and app state
directories are disposable.

`license` and `compatibility` are nullable top-level columns because they are top-level frontmatter.
The family metadata is a `metadata_json` string-to-string map, because opencode defines `metadata`
that way and the editor must preserve unknown keys. The known keys are UI fields, not separate
columns; this keeps one source of truth and lets unknown keys survive. `create`, `update`, and
`override` each run in one database transaction; `update` and `override` replace the target's
reference set in that same transaction, so a parent row can never be saved with stale references.

Migration v13 (additive; existing rows get `NULL`, `NULL`, `'{}'`, and no reference rows):

```sql
ALTER TABLE skills ADD COLUMN license TEXT
  CHECK (license IS NULL OR (length(license) BETWEEN 1 AND 256));
ALTER TABLE skills ADD COLUMN compatibility TEXT
  CHECK (compatibility IS NULL OR (length(compatibility) BETWEEN 1 AND 512));
ALTER TABLE skills ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json) AND length(metadata_json) <= 16384);

CREATE TABLE skill_references (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (
    length(path) BETWEEN 15 AND 78
    AND path GLOB 'references/*.md'
    AND path NOT GLOB 'references/*/*'
  ),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 48000),
  PRIMARY KEY (skill_id, path)
);
```

`foreign_keys = ON` is already a connection invariant, so the cascade is real. The `(skill_id, path)`
primary key prefix serves both cascade and per-skill lookup, so no extra index is needed. Exact slug
validation remains application-level; the DB path checks are a coarse backstop.

### D2 - `SKILL.md` is generated; frontmatter is never hand-edited

The editor stores the body below the frontmatter. `license`, `compatibility`, and `metadata` are
fields. The materializer emits a fixed frontmatter order and JSON-escaped string scalars, so a
description or metadata value cannot break the YAML document. Known metadata keys emit in this order:
`author`, `version`, `domain`, `triggers`, `role`, `scope`, `output-format`, `related-skills`; custom
keys follow in lexicographic order. Empty optional fields are omitted. `name` is emitted unquoted
because it is a constrained slug; every other string is emitted as a JSON string literal, which is a
valid YAML double-quoted scalar.

The exact generated shape for a bundle with every optional field is:

```md
---
name: developer
description: "Use when implementing approved work."
license: "MIT"
compatibility: "Node >= 20"
metadata:
  author: "arkan"
  version: "1.0.0"
  domain: "engineering"
  triggers: "implement, bugfix"
  role: "engineer"
  scope: "implementation"
  output-format: "code"
  related-skills: "qa-engineer, software-architect"
---

# Developer
...
```

Metadata keys are constrained by validation and custom keys are emitted as quoted keys when they
contain anything outside the safe pattern; values are always JSON-quoted. The generated frontmatter
is shown read-only in the UI, with a Copy action. Hand-editing YAML would allow invalid frontmatter
to silently hide a skill; separate fields keep the document valid.

### D3 - Materialization keeps remove-and-rewrite, writing references before `SKILL.md`

For each effective skill, `apply` removes the entire `<name>/` subtree and recreates it, then writes
reference files in path order and `SKILL.md` last. Writing `SKILL.md` last means a crash mid-bundle
leaves a directory that opencode does not discover as a skill; the next apply repairs it. The old
container is already gone and the new one is not started until `apply` returns, so no agent reads a
partial bundle. Each file is written with the existing atomic temp-and-rename helper.

A per-bundle staging directory plus rename was considered. Directory rename over a non-empty target
is not atomic in portable Node; it still requires removing the old directory first, and probe staging
is on a different filesystem from the live agents volume. Remove-and-rewrite is simpler, shares the
probe and apply code path, and preserves the current stale-file and symlink guarantees. Probe writes
the same bundle into a private temporary directory and returns the same hash; it writes no live file.

### D4 - The launch hash is conditionally additive

The effective hash remains an array of effective skills sorted by name. Optional fields are
normalized before projection: `license` and `compatibility` are trimmed and `""` becomes `null`;
metadata keys and values are trimmed and empty values are dropped. Each skill contributes exactly
`{name, description, content}` when it has no license, no compatibility, no metadata keys, and no
references. It additionally contributes `license`, `compatibility`, a non-empty `metadata` map, and/or
a path-sorted `references` array only when those normalized values exist. Therefore a v12 skill with an unchanged
name, description, and body hashes exactly as it did before this stage and does not become
restart-required merely because the code shipped. Adding, changing, or removing a reference,
metadata, license, or compatibility value changes the hash and marks affected running agents
restart-required. A shadowed or disabled row still does not affect the hash.

### D5 - The list is an inventory; the skill is a workspace

The scope pages lose the duplicate "Effective here" and "Defined here" cards and all inline editors.
They become one filterable inventory table. The dedicated page is the only place a skill is edited.
The page is canonical at `/skills/:id`; the viewing context determines the breadcrumb and the row's
source is shown in the scope strip. The **viewing context** is `from` when it parses as one of the three skill scope paths, otherwise the
row's own scope. `from` is not a generic `safeLocalPath`: it must be `/skills`,
`/projects/:id/skills`, or `/projects/:id/apps/:key/skills`, and its target must exist. If the row's
scope is wider than the context, inspect `resolve(context).rows` for any scoped row with the same
name. If one exists with a different row id:

- if it is the effective winner, show **Shadowed**: read-only, only `Edit at source` and `Open
  effective source`;
- if it is a tombstone, show **Hidden at this context**: read-only, `Open tombstone` and `Revert to
  inherited` at the context;
- if it has stored issues, show **Invalid here**: read-only, `Open/repair` at the context.

Never offer Override/Disable in these three states, because both would replace the existing narrower
row. If no scoped row exists at the context and the wider row is effective, show read-only inherited
with Override/Disable at the context. If the wider row is disabled or invalid and the context owns no
row, show a read-only `Not effective here` state with `Open source`. If the row's scope equals the
context, the page is editable. If the context is wider than the row, it is ignored. Inventory links
append `from=<current scope page>`; this is what makes the inherited, shadowed, hidden, and invalid
states reachable.

The page is always a source-and-preview workspace, not a read/edit mode toggle. The owner sees an
editable source pane and a live preview. An inherited skill viewed from a narrower scope shows a
read-only source pane and the same preview, with "Override here" and "Disable here" actions. This is
the owner's chosen side-by-side reading model.

### D6 - One bundle form; JS adds preview and dirty state

Every editable surface is one normal HTML form for the whole bundle: metadata, `SKILL.md`, and every
reference file are in the DOM and submit together. This keeps file switching from losing edits and
makes one save produce one revision. JavaScript sends the structured JSON payload (`metadata` and
`references` as full replacements) and adds the live preview, dirty tracking, discard confirmation,
file tabs, counters, and inline field errors. Without JavaScript, the same form submits legacy
fields plus hidden JSON snapshots of the bundle fields (license, compatibility, metadata,
references), so body and description edits still work and bundle data is preserved; adding or removing reference files and editing metadata is a
JavaScript enhancement. No autosave and no silent restart.

The old list fragment contract and `assets/skills.js` are removed. This removes the dialog-reset,
fragment-scope, and focus-restoration bugs rather than patching around them.

### D7 - Metadata is exposed as grouped fields

The editor exposes the known family keys as fields, with labels that disambiguate the frontmatter
`scope` from the Hanse placement. Unknown metadata is preserved and editable in a custom key/value
area. `triggers` and `related-skills` are comma-separated strings in storage, rendered as chips and
links in the preview; the generated YAML keeps them as strings, matching the owner's files. The
frontmatter `scope` field is labelled **Operating scope**, never "Scope".

### D8 - References are flat Markdown files with bounded, validated paths

Reference files are one level under `references/`, Markdown only. The slug is 1-64 characters with
the same lowercase-hyphen pattern as skill names; the full path is 15-78 characters. The path is
immutable in the editor after creation; renaming is delete plus add. The bundle form includes every
reference, so a save replaces the complete reference set; immutability is a UI convention, not a
server-side rename prohibition. The UI shows path and size, and an "Add reference" action appends a
blank file row. Removing a file is a checked action in the file list and a confirm dialog; it is
destructive but does not delete the skill. `SKILL.md` never appears as a reference path, so a nested
`SKILL.md` cannot become a second skill.

### D9 - Validate on write and re-validate stored rows on read

Write validation returns stable 400 codes and a field identifier. Read validation lives in the
single shared `resolve` path, so `resolve`, `hash`, `preview`, `probe`, and `apply` agree. Per-field
eligibility is:

- invalid name: the row is unusable for resolution and never wins, but it remains in
  `resolve().rows` with `storedIssues` so the inventory can show `Invalid here` and link to repair;
- invalid metadata: the row does not win and a wider valid row can win; `metadataRaw` carries the
  unparseable JSON for a raw editor or clear action;
- invalid license/compatibility, reference count, or aggregate: the row does not win and a wider
  valid row can win; the issue is `invalid_skill_bundle` (or `invalid_skill_reference` for a
  path-specific overrun);
- invalid references on an enabled row: the row does not win and a wider valid row can win;
- a disabled tombstone is validated on name only; invalid metadata or references do not stop it
  hiding a wider skill because they are never materialized; an invalid name makes the tombstone
  unusable.

Invalid details are reported as `SkillStoredIssue` entries and remain visible for repair. They are
not duplicated into `SkillWarning`; warnings remain for collision/resolution conditions. Read
validation applies the same 0-20 count, 192,000-character aggregate, and license/compatibility bounds
as write validation. Reference paths and contents are re-validated immediately before materialization,
not just at write time. Tests must prove `hash() === probe().hash === apply().hash` for corrupted rows.

### D10 - Reuse the existing Markdown renderer by extracting it

Side-by-side preview must render the same safe subset as chat. The renderer in `assets/chat.js`
(`renderMarkdown`, `renderInline`, `renderTable`, and helpers) is extracted into
`assets/markdown.js`, an ES module that imports `parseMarkdownTable` from `assets/chat-core.js` and
exports `renderMarkdown`. The shared module also carries or exports the small `element` helper used
by the renderer; `assets/chat.js` imports the renderer and keeps or imports that helper rather than
duplicating the renderer. The skill page loads a new `assets/skill-detail.js` module that imports the
same renderer and drives preview, dirty state, file tabs, and counters. Both new assets are added to
the static allowlist in `src/http/handler.ts`, and the skill page uses `moduleScripts` in
`src/http/ui.ts`. It never assigns raw skill text through `innerHTML`. The chat QA
harness remains the regression gate for chat rendering, and a new skills browser scenario covers
preview and dirty state. Duplicating a renderer or adding a dependency is rejected.

## 5. Shared interfaces

```ts
export type SkillScope = "global" | "project" | "app";

export interface SkillReference {
  /** Canonical stored path: references/<slug>.md. */
  path: string;
  /** Exact text written; CRLF/CR normalized to LF at input. */
  content: string;
}

export type SkillMetadata = Record<string, string>;

export type SkillStoredIssue =
  | { code: "invalid_skill_name" }
  | { code: "invalid_skill_metadata"; detail: string }
  | { code: "invalid_skill_reference"; path: string; detail: string }
  | { code: "invalid_skill_bundle"; detail: string };

export interface SkillBundle {
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  references: SkillReference[];
}

export interface SkillRow extends SkillBundle {
  id: number;
  scope: SkillScope;
  projectId: string;
  appKey: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  storedIssues: SkillStoredIssue[];
  /** Raw invalid metadata_json, when parsing failed; null otherwise. */
  metadataRaw: string | null;
}

export interface EffectiveSkill {
  id: number;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  /** Summary projection; contents are not loaded for the inventory. */
  references: SkillReferenceView[];
  source: SkillScope;
  shadows: SkillScope[];
}

/** Internal bundle used by hash, probe, and apply. */
export interface EffectiveBundle extends Omit<EffectiveSkill, "references"> {
  references: SkillReference[];
}

export interface SkillInput {
  name?: string;
  description: string;
  content: string;
  enabled?: boolean;
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;
  references?: SkillReference[];
}

export interface SkillUpdate {
  description?: string;
  content?: string;
  enabled?: boolean;
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;        // full replacement; {} clears
  references?: SkillReference[];   // full replacement; [] clears
}

export interface SkillReferenceView {
  path: string;
  /** UTF-8 byte size of the stored content. */
  size: number;
}

export interface SkillSummary {
  id: number;
  scope: SkillScope;
  projectId: string;
  appKey: string;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  references: SkillReferenceView[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  storedIssues: SkillStoredIssue[];
}

export interface SkillDetail extends Omit<SkillSummary, "references"> {
  references: Array<SkillReferenceView & { content: string }>;
  /** Raw invalid metadata_json for repair, when present. */
  metadataRaw: string | null;
}
```

When `metadataRaw` is non-null, `metadata` is the empty map; the raw editor parses a valid object
on save or sends `{}` on `Clear metadata`, so the form never renders both stale known fields and raw
JSON. `SkillSummary` (which has no `metadataRaw`) projects `metadata: {}` for a row with
`invalid_skill_metadata`; `SkillRow`/`SkillDetail` carry the raw value.

```ts
export type SkillWarningCode =
  | "skill_collision"
  | "skill_disabled_elsewhere";

export interface SkillWarning {
  code: SkillWarningCode;
  name?: string;
  root?: string;
}

export interface ResolvedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  rows: SkillSummary[];
  disabled: Array<{ id: number; name: string; source: SkillScope | null; disabledBy: SkillScope }>;
  warnings: SkillWarning[];
}
```

`SkillService` keeps `get(id): SkillRow | undefined` and changes `create`, `update`, `override`,
`delete`, `resolve`, `hash`, `preview`, `probe`, and `apply` to understand bundles. `get` returns the full bundle; `resolve().rows`
uses `SkillSummary` projections and `resolve().effective` uses `EffectiveSkill` summaries, so the
inventory loads no reference contents. `hash`, `probe`, and `apply` load `EffectiveBundle` internally.
`SkillValidationError` gains an
optional `field` string. `SkillWarning` is reserved for collision/resolution warnings; stored-row problems are reported only
through `SkillStoredIssue`. `SkillPreview`
and `SkillMaterializeResult` keep their current shapes, except `written` now includes reference
paths. `resolve`, `preview`, and the inventory load summaries only; `hash`, `probe`, and `apply` load
`EffectiveBundle` internally. `SkillSource`'s public method signatures do not change.

### 5.1 HTTP routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/skills`, `/projects/:projectId/skills`, `/projects/:projectId/apps/:appKey/skills` | Inventory pages |
| GET | `/skills/new` | Create page, target from query |
| GET | `/skills/:id` | Dedicated skill workspace; optional `from` context |
| GET | `/api/skills?project=&app=` | Resolution; list projections |
| GET | `/api/skills/:id` | Full `{ skill: SkillDetail }` |
| POST | `/api/skills` | `action=create` or `action=override` |
| POST | `/api/skills/:id` | Update metadata/body/enabled/references; legacy `action=delete` remains |
| POST | `/api/skills/:id/delete` | Delete form |
| DELETE | `/api/skills/:id` | Delete JSON |

The create page target is explicit: `scope=global|project|app`, plus `project` and `app` where
required; a missing project or app renders the normal 404 page. `POST /api/skills` keeps the existing
scope/target rules and accepts optional bundle fields.
The detail page is canonical; `from` is only a return/context hint and cannot change the row's scope.
`isSkillsRoute` additionally accepts `GET /^\/skills\/\d+$/` and `/skills/new`; every existing API
rule stays. All pages and APIs remain human-only; every mutation keeps the existing Origin rejection
and `return_to` validation.

Browser form mutations return `303` to `return_to` with a notice on success. A browser form that
fails validation returns `422` with the workspace or create page re-rendered from the submitted
values and inline field errors, so no-JS input is not lost. JSON callers get `{skill}` /
`{deleted:true}`; validation is `400 {error, code, field?}`; a missing row is `404`; a duplicate
create is `409 skill_exists`. The bundle request bound becomes 4 MiB for `/api/skills*`
(the general server bound stays 64 KiB). The form carries the bundle once; no-JS metadata/reference
controls are disabled and unnamed, with all bundle fields in one hidden JSON snapshot, so content is
not duplicated. A worst-case 240,000-character bundle percent-encoded at 12 bytes per 4-byte character is
about 2.88 MiB plus field overhead, inside 4 MiB. The old fragment envelope
(`x-hanse-fragment: skills`) and `assets/skills.js` are removed; `POST /api/skills/:id` with
`action=delete` remains available for compatibility.

### 5.2 Page data

- Inventory: `resolve(target)`, `preview(target, options)` for app scope, `pendingRestart` for the
  scope's running apps, and counts. The table is server-rendered; filters and search use query
  parameters.
- Workspace: `get(id)`, `resolve(context)` for the scope chain and effective state, `preview` when the
  context is an app, and `pendingRestart` for the affected scope. `from` is parsed to a target and
  validated; the page shows "Back to ..." only when valid.
- Create: target validation and an empty draft; no list scan.

### 5.3 Validation and limits

Write validation returns `400` with `{error, code: "VALIDATION", field?}`. Browser form posts that
fail validation re-render the workspace or create page with `422`, the submitted values, and inline
field errors; JSON callers receive the `400` envelope. The following limits are enforced in the
service and, where practical, as DB checks:

| Field | Rule |
| --- | --- |
| `name` | 1-64 characters; `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `description` | 1-1024 characters; CRLF/CR normalized to LF; newlines allowed; other C0/C1 rejected; trimmed |
| body (`content`) | 1-48,000 characters; trimmed; no NUL; no unpaired surrogates |
| `license` | `null` or 1-256 characters; single line; trimmed |
| `compatibility` | `null` or 1-512 characters; single line; trimmed |
| metadata | plain object, at most 32 entries; key `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, 1-64 characters; value 1-1024 characters, no C0/C1; reserved top-level keys (`name`, `description`, `license`, `compatibility`, `metadata`) rejected; serialized JSON at most 16,384 characters |
| reference path | exactly `references/<slug>.md`; slug `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1-64 characters; total path 15-78; one level; no `SKILL.md` (case-insensitive), traversal, backslash, drive prefix, trailing dot/space, NUL, or control characters |
| reference content | 1-48,000 characters; CRLF/CR normalized to LF; no NUL; C0 except `\n` and `\t`; no unpaired surrogates; not trimmed |
| reference count | 0-20 per skill |
| aggregate references | at most 192,000 characters across all reference files; the 48,000-character `SKILL.md` body is separate |
| request body | at most 4 MiB for `/api/skills*`; the general server bound stays 64 KiB |

`description` is allowed to contain newlines because the owner's existing frontmatter uses folded and
literal block scalars; the generated frontmatter emits it as a JSON-quoted YAML string. Metadata
values stay single-line so the known comma-separated fields remain predictable. Empty optional
fields are normalized to `null`/absent rather than stored as empty strings.

Stored-row handling is separate from write validation: invalid names, metadata JSON, reference
paths, or bundle bounds become `SkillStoredIssue` entries. A row with any stored issue is excluded
from `effective` and `hash` if it is an enabled winner; it remains in `resolve().rows` and its
references/metadata remain visible on the detail page for repair. A disabled tombstone is not
invalidated by metadata/reference issues because it materializes nothing; an invalid name makes it
unusable. Invalid paths are never joined to disk paths.

## 6. UI design

### 6.1 Inventory page

- Header: scope overline, title `Skills`, one-sentence explanation, primary `New skill`.
- Sticky scope nav: Global / Project / Application, canonical current marker; application label
  shortens to `App` below 480px. The nav scrolls horizontally below 640px.
- Toolbar: a `search` GET form, a segmented set of links `All`, `Defined here`, `Inherited`,
  `Disabled`, `Invalid`, and a count line. Filters are links with `aria-current="page"`, so they work without
  JavaScript and are shareable.
- One inventory table. No duplicate effective/defined sections.
  - `Skill`: name in mono, description clamped to two lines.
  - `Origin`: scope badge plus `Overrides Global/Project` or `Inherited from Global/Project`.
  - `State`: `Enabled here`, `Inherited`, `Disabled here`, `Invalid here`, or
    `Invalid local override`, with the issue/collision glyph and accessible text when present.
    `Invalid here` is used when the row has `storedIssues`; an effective wider row plus an invalid
    scoped row uses `Invalid local override`, with both repair and effective-source links.
  - `References`: count, `0` shown muted.
  - `Updated`: absolute date with a title tooltip for time, mono.
  - Trailing chevron; the name links to the canonical workspace with the current scope page as
    `from` (`/skills/:id?from=<scope-page>`).
- Row model: the inventory has exactly one row per name at this scope. Merge `effective` and the
  scoped `rows` by name:
  - scoped enabled and valid -> `Enabled here` (effective);
  - scoped row with stored issues -> `Invalid here`; if a wider valid row is also effective, the
    state is `Invalid local override`, `Origin` names the effective source, the primary name link
    opens the scoped invalid row for repair, and a secondary `Open effective source` link opens the
    wider row; an invalid-name tombstone is `Invalid here`, not `Disabled here`;
  - scoped valid tombstone -> `Disabled here`, with the wider source in `Origin`;
  - no scoped row and a wider valid row -> `Inherited`;
  - no scoped row and only a wider disabled/invalid row -> not listed at this scope.
  - Filter membership: `Invalid` and `Defined here` include `Invalid here` and `Invalid local
    override`; `Inherited` excludes them; `Disabled` includes only valid scoped tombstones.
- Sorting is name-ascending. Realistic counts are small; no pagination in v1.
- Empty state: no skills at all explains the concept and offers `Create the first skill`. A
  filter-empty state offers `Show all skills`. A search-empty state offers `Clear search`.
- The right rail exists at >=1280: `Scope & inheritance` (resolution order, shadowing, collision
  note), `Restart required` when any running app is stale, and `Summary` counts. At 1024-1279 the
  rail becomes a two-card row below the table; at <1024 it is a single column.
- No inline editors, no create dialog, no row actions that mutate. The table is a directory.

### 6.2 Dedicated skill workspace

Header:
- Breadcrumb uses the viewing context, with the row's source in the scope strip; truncates with
  ellipsis at 390.
- Overline `GLOBAL SKILL` / `PROJECT SKILL` / `APPLICATION SKILL`.
- Title: skill name. Description below. Meta line: license, compatibility, version, updated,
  references, collision warning. A scope strip directly under the header lists Global -> Project -> Application with the
  current context marked, the winning source, and shadowed/disabled notes.
- Actions:
  - Owned row: no page-header primary; the sticky edit bar owns `Save changes`. `Delete skill` lives
    in a danger zone at the bottom.
  - Inherited from a wider scope: `Override here` primary, `Disable here` secondary, `Edit at source`
    ghost. The source/preview panes are read-only.
  - Tombstone at the current scope: no header primary; the State card explains that it hides the
    wider skill. The enabled switch plus `Save changes` re-enables it. `Revert to inherited` lives in
    the danger zone and requires confirmation.
  - Shadowed / Hidden / Invalid / Not effective: the D5 rule selects the read-only header actions;
    invalid-name sources use `Open source`, not `Edit at source`.

Workspace:
- Details card above the file workspace, full width:
  - Identity: name (read-only mono), description (textarea, required, counter), enabled (switch).
  - Classification: domain, role, operating scope (label, not Hanse placement), output format
    (free text with a datalist: mixed, code, report, document, plan, decision).
  - Discovery: triggers, related skills (comma-separated, chips/links in preview).
  - Version and license: version, license, compatibility, author.
  - Custom metadata: key/value rows or a JSON textarea for unknown keys, with add/remove. The form
    preserves unknown keys.
  - The card is a `<details>` open by default on desktop, collapsed on mobile after first paint.
- File workspace:
  - File rail at >=1280: `SKILL.md` first, then `references/*.md` sorted; each row shows file name,
    size, dirty dot. `Add reference` at the bottom. At 1024-1279 the rail becomes a horizontal tab
    strip; below 768 a native `<select>`.
  - Source pane: textarea for the selected file. For `SKILL.md` it contains only the body; a caption
    says the frontmatter is generated from Details. For a reference it contains the exact reference
    text. Read-only inherited files use a `<pre>` with the same typography. A counter shows
    characters and the limit.
  - Preview pane: rendered Markdown from the current source. `SKILL.md` preview includes a
    collapsible read-only `Frontmatter` block generated from the current fields, with Copy. Reference
    previews render that file. The preview is updated with a short debounce while typing.
  - Layout: >=1024 three columns (file rail | source | preview) at >=1280; at 1024-1279 file tabs
    above a two-column source/preview split; <1024 Source | Preview tabs per active file, with the
    file switcher above. At <768 source and preview remain available as tabs, with a 44px tab strip.
  - The source and preview panes share one card shell and a 1px divider. The source minimum height is
    24rem on desktop and 16rem on mobile.
- Save/discard:
  - The form is one bundle form: metadata, `SKILL.md`, and every reference. File tabs only show and
    hide panes; all values stay mounted, so switching files never loses edits.
  - Dirty is computed against the last saved snapshot. `Save changes` is enabled only when dirty;
    `Discard changes` resets the form to the server-rendered snapshot, clears the preview, and
    announces the discard. `Discard` is a real reset with JS cleanup of added rows and counters.
  - Navigating away or reloading while dirty prompts. Without JavaScript every file editor is
    stacked, so there is no tab switch to lose state; the normal form post is the source of truth.
  - On success, the server redirects to the workspace with a toast. The restart banner appears when
    the effective hash changed and names the affected running apps, with a restart link. If the row is
    not effective at the context, the banner says no restart is needed.
- Reference files:
  - Each file has path (read-only after creation), size, content textarea, and a `Remove this file`
    checkbox/action. Add reference appends a blank `references/<slug>.md` row; a row with both blank
    path and blank content is pruned on submit, a partially filled row fails validation. Renaming is
    delete plus add.
  - Max 20 files, 48,000 characters each, 192,000 aggregate characters across references.
    `SKILL.md` is never a valid reference path. Paths are flat and lowercase-hyphenated.
- Delete:
  - Owner only. Danger zone below the workspace with a rule, explanation, and `Delete skill` button.
    The native dialog requires typing the exact skill name. Without JavaScript, an inline form in the
    danger zone includes a `confirm_name` field; the server re-checks the exact name and rejects a
    mismatch. Deleting a tombstone is labelled
    `Revert to inherited`; deleting an override explains that the wider skill becomes effective.
- Errors:
  - Field errors appear under the field, linked with `aria-describedby`, and the first invalid field
    receives focus. Inline page errors cover cross-field conflicts, 404, and 409.
  - Stored-row issues render as an `Issues` strip above the workspace, sourced from `storedIssues`.
    An invalid row owned at this context is editable: metadata issues link to a raw JSON textarea or
    `Clear metadata`, reference issues link to the file/remove action, and bundle bounds link to the
    affected fields. An invalid name is read-only with `Delete and re-create`, because names are
    immutable. A wider invalid row viewed from a narrower context is read-only with `Edit at source`.
    An invalid row is never silently presented as healthy.
  - Collision warnings are a text-and-glyph strip near the title and a details disclosure listing the
    roots. No color-only signal.
  - Loading: the page is server-rendered; save uses `aria-busy` and a spinner. The preview is
    synchronous DOM rendering and has no network loading state.

### 6.3 Create page

- `GET /skills/new` with a target from query. Same shell and workspace, title `New skill`, no file
  rail until references are added.
- Identity fields, body source/preview, optional metadata collapsed, enabled on by default. The
  create page starts with no reference rows; `Add reference` (JS) adds a blank row, and references can
  also be added after creation. A blank path with blank content is pruned on submit; a partially
  filled row is a validation error.
- Primary `Create skill` in a sticky bar; secondary `Back to skills`. A duplicate create returns the
  create page with status `409`, a name-field error, and a link to the existing skill; this is not
  treated as the generic `422` validation page. No dialog, no bulk import.

### 6.4 State summary

| State | Header action | Source/preview | Notes |
| --- | --- | --- | --- |
| Owned, enabled | Save bar | Editable | Effective at this scope |
| Inherited, enabled | Override here; Disable here | Read-only | Override copies metadata and references |
| Owned, disabled tombstone | Save bar; Revert in danger | Editable | Hides the wider skill; source preserved |
| Shadowed at this context | Edit at source; Open effective source | Read-only | A different row is the effective winner |
| Hidden at this context | Open tombstone; Revert to inherited | Read-only | A context-owned tombstone hides this wider row |
| Invalid here | Repair (owned) / Edit at source (wider) | Editable when owned; read-only when wider | Sourced from `storedIssues`; never shown as healthy |
| Not effective here | Open source | Read-only | Wider row disabled/invalid; no context row owns the name |
| Save changed effective hash | Restart required banner | Editable | No automatic restart |
| Save did not change effective hash | Saved, no restart needed | Editable | Truthful shadow/tombstone case |

### 6.5 Responsive and accessibility

- 1440: inventory table + 320px rail; workspace file rail + 1:1 source/preview split; 68ch prose
  measure in preview.
- 1024: inventory full width with a rail below; workspace two-column source/preview with file tabs;
  metadata two columns.
- 768: one-column inventory; workspace Source | Preview tabs; metadata one column.
- 390: stacked inventory rows with labels; workspace file select + Source | Preview tabs; fixed
  bottom save bar; no horizontal page overflow; touch targets >=44px.
- Keyboard: file rail is a list of buttons/links with `aria-current`; dialogs trap focus natively;
  Escape closes; focus returns to the trigger; save/discard announce through the toast region and a
  status line. Every icon-only control has an accessible name. Source and preview are labelled.
- Dark and light themes, reduced motion, and 200% zoom are part of the browser QA.

### 6.6 No-JS behavior

- Inventory: fully server-rendered; filters, search, and links work.
- Workspace: the description, body, and enabled state are editable. Metadata controls, license,
  compatibility, and reference editors are rendered `disabled` and unnamed until JavaScript
  initializes; their current values are carried in one hidden JSON snapshot. A no-JS save therefore
  preserves the bundle while changing only body/description/enabled, and cannot silently discard a
  no-JS edit to a control it could not save. All file editors are rendered stacked without JavaScript; JS collapses them into tabs, so a
  no-JS file switch never destroys edit state. Without JavaScript the preview cannot run, so the page
  shows `Preview requires JavaScript` and a read-only source view for inherited rows. Adding/removing
  reference files and editing metadata is a JS enhancement. Save, discard, create, delete, override,
  enable, and revert remain normal form posts; validation returns the `422` page from section 5.1.
- This is the honest cost of avoiding a server renderer and a second Markdown implementation.

## 7. Alternatives considered

- **References in a JSON column.** Rejected: duplicate paths and aggregate limits are harder to
  enforce, each save rewrites the whole bundle, and querying a single file is awkward.
- **Filesystem as the source of truth.** Rejected: breaks the DB source-of-truth invariant, backup
  and restore, and app state rebuildability.
- **Per-bundle staging directory plus rename.** Rejected for v1: directory rename over a non-empty
  target is not atomic in portable Node, and probe staging is cross-filesystem. Reference-first,
  `SKILL.md`-last remove-and-rewrite gives the needed discovery invariant with less machinery.
- **Scope-qualified detail routes.** Rejected for v1: a row id is unique and the page is
  operator-only; `from` carries the context without duplicating route families. A future access
  control model can add scoped routes.
- **Inline expansion or a modal editor.** Rejected: causes the current duplicate/scroll/dirty
  problems and cannot host a file tree plus side-by-side preview comfortably.
- **Rendered preview only (no source), source only, or a toggle-only page.** Rejected by the owner:
  both are needed side by side for authoring.
- **A new Markdown dependency or a second renderer.** Rejected: duplicates an existing safe renderer
  and adds a dependency; extraction has a smaller security surface.
- **Bulk import in this stage.** Deferred by the owner; the model supports it later.
- **Optimistic locking in v1.** Deferred: single operator, explicit saves, visible updated time. A
  conflict guard can be a follow-up.

## 8. Risks and mitigations

- **Legacy hash drift.** A migration or hash change could mark every running app restart-required.
  Mitigation: the conditional projection and a test that computes the v12 hash after migration.
- **Renderer extraction regressions.** Chat rendering could break. Mitigation: keep the module API
  narrow, keep the chat QA harness green, and add a skills preview scenario.
- **Partial bundle writes.** A crash mid-apply can leave a partial directory. Mitigation: references
  first, `SKILL.md` last, probe before teardown, error state after a post-teardown failure, and the
  next apply rebuilds.
- **Large bundles.** A 20-file bundle can be expensive to render. Mitigation: per-file limits,
  aggregate bounds, preview only the selected file, and a 4 MiB request bound.
- **Stored-row corruption.** A restored or hand-edited DB can contain unsafe paths or invalid
  metadata. Mitigation: re-validate on read and immediately before materialization; exclude unsafe
  effective winners and show issues.
- **Metadata/placement confusion.** `metadata.scope` is not the Hanse scope. Mitigation: label it
  "Operating scope" and show placement separately.
- **Concurrent tabs.** Last write wins; there is no optimistic lock in v1. Mitigation: visible
  updated time and no autosave; a conflict guard can be a follow-up.
- **Hash cost on page render.** `buildSite` computes `pendingRestart` per app, and `hash()` now reads
  reference content. Mitigation: memoize `hash(target)` in the page/build context for the duration of
  one render, so each target is read once; the service cache remains a follow-up.
- **Reference deletion is destructive.** Mitigation: a confirm dialog and an inline no-JS form; the
  skill itself is not deleted.
- **Removing the fragment path.** Existing tests and links may assume it. Mitigation: keep the JSON
  API, update tests and docs, and make the inventory JS-free.

## 9. Non-goals

- `scripts/` and `assets/` bundles, binary files, and nested reference directories.
- Bulk import of an existing skill directory tree (deferred by the owner).
- Agent-assisted skill authoring or a global management agent (future stage).
- Version history, diffs, or rollback of skill content.
- Hot reload into a running agent.
- Per-agent skill assignment or allowlists.
- Guaranteeing a managed skill wins over a same-named repository/plugin/external skill.
- Changing opencode's built-in discovery or external roots.
- Optimistic concurrency control in v1.

## 10. Acceptance criteria

| ID | Acceptance check |
| --- | --- |
| A1 | A v12 skill with no license, compatibility, metadata, or references keeps its exact effective hash after migration v13; its generated `SKILL.md` bytes are unchanged. Clearing every new field on a saved bundle restores that same legacy hash. |
| A2 | A skill with references materializes `SKILL.md` and every `references/*.md`; `written` includes every reference path; a second apply produces identical paths and bytes; `probe().hash === apply().hash === hash()` with metadata, license, compatibility, and references included. |
| A3 | Adding, editing, or deleting a reference or metadata value changes the effective hash and marks affected running apps restart-required; a shadowed or disabled row edit does not. |
| A4 | Reference paths reject traversal, absolute paths, nested directories, `SKILL.md`, uppercase/unsupported names, slugs over 64 characters, NUL, and files over the limits; a forged stored path is revalidated on read and cannot escape the skill directory. |
| A5 | Override copies license, compatibility, metadata, and references; a tombstone copies them but stays disabled; delete cascades references; app and project deletion remove the corresponding reference rows. |
| A6 | Every skill page and API remains human-only; anonymous and agent requests are denied; cross-site Origins are rejected; `return_to` rejects unsafe paths; per-file body limits hold. |
| A7 | The inventory page renders one row per name with no inline editor; `Invalid local override` merges the effective source and the scoped repair entry without duplicating the skill; the workspace shows source and live preview side by side at desktop with JavaScript and both panes at 390; metadata groups, including compatibility, and reference files are usable. |
| A8 | The workspace saves, discards, creates, enables/disables, overrides, reverts, and deletes without JavaScript for body/description/state; JavaScript adds live preview, dirty guarding, inline field errors, and reference/metadata editing. |
| A9 | Chat Markdown rendering is unchanged after the renderer extraction; skills preview never executes raw HTML; a real `opencode debug skill` load lists a bundle with metadata/license/references; the chat QA and skills QA harnesses pass as manual stage gates, with their reports recorded. |
| A10 | `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass; manual browser QA covers 390/768/1024/1440 in dark and light with zero console/page errors. |
| A11 | An enabled winner with corrupted metadata, references, or bundle bounds does not win; the next wider valid row wins; an invalid-name row is not effective but is listed as `Invalid here`; a disabled tombstone with a valid name still hides the wider row, while an invalid-name tombstone does not; an effective wider row plus an invalid scoped row shows `Invalid local override` with both repair and source links; `hash`, `probe`, and `apply` agree on the corrupted set. |
| A12 | Migration v13 runs once, is a no-op on a second run, keeps existing rows defaulted, and deleting a skill or its app/project cascades reference rows with `foreign_keys = ON`. |

## 11. Open questions

There are no open questions for the core bundle/editor stage. Q1 (bulk import) and Q2 (side-by-side
preview) are resolved; Q3 (agent-assisted authoring) is deferred to a future stage.

## 12. Future direction - agent-assisted skill authoring

The owner wants the `skill-author` skill to be usable inside Hanse, but does not want every
application agent to have skill-write access. A later stage added a narrow exception for the built-in
master agent: `create_skill` can create bundles at global, project, or app scope, requires operator
confirmation for global scope, refuses the reserved master project/app, and audits the creation.
Reading, updating, deleting, overriding, enabling, and disabling skills remain operator-only. The
human HTTP API stays human-only; the master surface is separate, target-guarded, and audited. See
[`master-skill-creation.md`](./master-skill-creation.md).

## 13. Design review record

Round 1 (`oracle`, 2026-10-23): **CHANGES REQUESTED**. Findings folded into this revision:

- removed the tracked-file absolute home path and used `<AGENTS_SKILLS_ROOT>`;
- made no-JS editing truthful: metadata/reference controls are disabled and unnamed until JS, all
  file editors stack without JS, and one hidden JSON snapshot carries the bundle once;
- specified the exact generated frontmatter, metadata key constraints/quoting, and validation
  limits, including the 1-64 reference slug and 15-78 path bounds;
- defined the viewing context from a parsed scope path, making the inherited read-only state
  reachable and the Override/Disable target unambiguous;
- updated the shared interfaces with `EffectiveSkill`/`EffectiveBundle`, `ResolvedSkills`,
  `SkillWarning`, and the no-reference-content inventory projection;
- defined one shared `resolve` validation path and consistent fallback for corrupted rows;
- normalized optional fields and defined the legacy hash projection, including clearing fields;
- required one transaction for create/update/override and replacement of the target reference set;
- added the 422 browser validation contract, exact v13 SQL, cascade tests, the 4 MiB worst-case
  calculation, and acceptance criteria A11/A12;
- retained `action=delete`, reworded K11 for the intentional fragment removal, and corrected the
  `DESIGN.md` rail citation;
- documented the renderer helper/asset allowlist and the manual browser QA gates.

Round 2 (`oracle`, 2026-10-23): **CHANGES REQUESTED**. Remaining findings folded into this revision:

- added the Shadowed-state rule: if the context already has a different winning row id, offer only
  Edit at source / Open effective source, never Override/Disable over a narrower row;
- added the `compatibility` field to the Details group, meta line, create page, and A7;
- added the `Invalid here` inventory state and the Issues strip sourced from `storedIssues`, and
  removed the duplicate stored-issue codes from `SkillWarning`;
- removed the stale no-JS file-switch hint, pruned blank reference rows, extended read validation to
  count/aggregate/license/compatibility, made the breadcrumb use the viewing context, specified the
  browser 409 create conflict, added server-side `confirm_name` for no-JS delete, and added per-render
  hash memoization to the risks.

Round 3 (`oracle`, 2026-10-23): **CHANGES REQUESTED**. Remaining findings folded into this revision:

- the shadowed/hidden/invalid guard now inspects any context-owned row for the same name, adds the
  `Hidden at this context` state, and offers Override/Disable only when the context owns no row;
- invalid-name rows remain in `resolve().rows` for `Invalid here` repair while being unusable for
  resolution; `invalid_skill_name` is removed from `SkillWarningCode`, leaving warnings for
  collision/resolution only;
- the invalid repair path is defined per issue: owned invalid rows are editable with field/file
  links, wider invalid rows are read-only with `Edit at source`, invalid names are
  `Delete and re-create`, and `metadataRaw` supports invalid JSON repair;
- breadcrumb now consistently uses the viewing context, blank-row pruning applies to the workspace
  too, and `SkillStoredIssue` gains `invalid_skill_bundle` for license/compatibility/count/aggregate
  failures; unused `SkillWarning` fields are removed.

Round 4 (`oracle`, 2026-10-23): **CHANGES REQUESTED**. Remaining findings folded into this revision:

- defined the inventory row model for an effective wider row plus an invalid scoped row:
  `Invalid local override`, with both the repair entry and the effective source, without duplicating
  the skill;
- removed the now-unused `SkillWarning.id`, added `Not effective here` to the state table and the
  read-only action list, and qualified A11 for an invalid-name tombstone;
- specified no-JS preservation of license/compatibility in the hidden snapshot;
- specified `metadataRaw` semantics (`metadata` is `{}`; raw editor parses or clears) and used an
  issue glyph for invalid rows instead of the collision glyph.

Round 5 (`oracle`, 2026-10-23): **PASS**. No blocker or major remains. Minor clarifications folded:
D5 uses `Open source` for `Not effective here`; the row model checks stored issues before the
tombstone state; the no-JS snapshot is defined as all bundle fields; `SkillSummary.metadata` is
`{}` for invalid metadata; and filter membership for `Invalid local override` is explicit.
