# Design - Skill sources UI

Status: **implemented** - `oracle` round 2 **PASS** (2026-11-11); plan `momus` **OKAY**; all gates and
headless QA green (journal 0060). Fork-to-local and arbitrary-file/binary upload UI remain deferred.

Scope: a global settings-console section for operator-managed external skill sources, a read-only
source-skills drawer, and external read-only rows in the Skills inventory with a source badge,
an External filter, and a read-only skill drawer.

Out of scope: fork-to-local, editing external skills in place, arbitrary-file/binary upload UI,
git-backed sources, a new SPA route, schema changes, and changing sync/materialization semantics.

Governing context:
[`external-skill-sources.md`](./external-skill-sources.md) (backend design),
[`../current-state.md`](../current-state.md) (implemented API and deferred UI),
[`DESIGN.md`](../../DESIGN.md) (visual contract), and
[`agent-skills.md`](./agent-skills.md) (inventory/workspace primitives).

## 1. Goals

| ID | Goal |
| --- | --- |
| UI1 | An operator can add, inspect, sync, check, pin, disable, re-enable, and delete a source without leaving Settings. |
| UI2 | Source state, revision, counts, last success/error, and stale status are readable at a glance. |
| UI3 | A token is write-only in the UI: it is never rendered after save, never placed in a URL, and only explicit Replace/Clear actions change it. |
| UI4 | Destructive actions state what is removed and what is retained; deleting a source cannot be confused with deleting local skills or snapshots. |
| UI5 | External skills appear in the Skills inventory as read-only rows with a source badge and a working drawer, never as `/skills/null`. |
| UI6 | Every state is keyboard reachable, announced, and usable at 390px and 1440px in light and dark themes. |
| UI7 | The UI follows the Chart Room primitives in `DESIGN.md`; no new color, space, radius, shadow, or motion value is introduced. |

## 2. Information architecture

```
/settings (global)                         /skills (global/project/app)
└─ Skill sources                           └─ inventory rows
   ├─ source list (ledger)                    ├─ managed rows (unchanged)
   ├─ Add source dialog                       └─ external rows (read-only)
   ├─ source drawer                              ├─ Source badge
   │  ├─ overview + actions                      ├─ Read-only state
   │  ├─ credential actions                      └─ View -> external skill drawer
   │  └─ skills table + file preview
   ├─ Replace token dialog
   ├─ Clear token confirm
   └─ Delete source confirm
```

- The source manager is the `sources` section of the global settings console: a rail item and a
  `#settings-sources` pane. Project and application pages show a "Skill sources are global" guard
  inside that pane with a link to `/settings#settings-sources`.
- The canonical deep link is `/settings#settings-sources`; the previous
  `/settings#settings-skill-sources` hash remains a compatibility alias.
- Source detail is a drawer, not a route. External skill detail is also a drawer. No new route ID
  or SPA route is added.
- The Skills inventory keeps its existing scope navigation. External rows can appear at any scope
  because sources resolve globally; their badge says "Source", not "Global".

## 3. Source list

### 3.1 Desktop ledger (>= 1024px)

Use a `.table` ledger inside a `.card`, not card soup:

| Column | Content | Behavior |
| --- | --- | --- |
| Status | status chip + stale/pinned badges | status is text + glyph, never color only |
| Source | name (strong), slug, endpoint host, error, check result | row title; opens source drawer |
| Sync | last success relative + absolute `<time>`; interval | "Never synced" when null |
| Revision | short revision (7 chars) + lock if pinned | full revision in drawer |
| Skills | skill count + total bytes | tabular numerals |
| Actions | status-driven primary; overflow menu | one primary per row |

The source console pane is narrower than the full page, so endpoint and error are secondary lines in
the Source cell instead of separate columns. This keeps the six-column ledger readable at 1440px;
below 1024px the same content stacks as labelled rows.

Overflow menu: `Check for updates`, `Pin`/`Unpin` (Pin only when an active snapshot exists),
`Disable`/`Enable`, `Edit`, `Delete`. `Delete` is separated by a rule and uses danger styling.
`Force sync` appears only when the last error is `deletion_guard`, with an explanatory
confirmation.

Primary-action precedence is explicit: `error` -> Retry sync; `disabled` -> Enable; `syncing` ->
disabled Sync now; `degraded` -> Review skills; `mode=pinned` and healthy -> Unpin; otherwise
Sync now. Pinned is a mode badge, not a status chip, so it never hides an error or disabled state.

### 3.2 Narrow layout (< 1024px)

Each source becomes a stacked ledger card:

```
[status] name                         [overflow]
slug · endpoint-host
last success · revision · skills/bytes
error (if any)
[Sync now] [View skills]
```

No hover-only controls. Actions are 44px high on touch. The endpoint wraps with
`overflow-wrap: anywhere`; the table never forces horizontal page scroll.

### 3.3 Empty and filtered states

- No sources:
  title "No skill sources"
  body "Connect a skills-hub to bring external skills into every application. Local skills always
  win."
  action "Add source" (primary).
- No filter results: "No sources match this filter." + "Clear filters".
- Loading: skeleton rows matching the ledger geometry; no "No sources" while loading.
- List load error: inline `.error-state` with Retry; do not replace an existing list with an error.

## 4. Source drawer

A native `<dialog class="dialog source-drawer">` opened from the row title or "View skills".
Desktop width min(720px, 92vw), full width below 768px; native focus trap, Escape, focus return.

Header: name, slug, status chip, endpoint host, close button.

Body order:
1. **Error callout** when `lastErrorCode` is set: message, code in mono, `Retry sync` button.
2. **Summary grid** (`.skill-metadata-row` style): kind, buckets, priority, sync interval, stale
   after, request timeout, last attempt/success/check, revision, active snapshot, pinned snapshot,
   token status, updated by/at.
3. **Credential row**: "Token: Set/Not set · updated <relative>"; actions `Replace token` and
   `Clear token`. The token value is never rendered. This requires `tokenUpdatedAt` on
   `SkillSourceView` (see §9); if it is not projected by the API, show only Set/Not set.
4. **Actions**: `Sync now` (primary), `Check for updates`, `Pin`/`Unpin`, `Disable`/`Enable`,
   `Edit`, `Delete`.
5. **Skills table**: name, bucket, version, files, bytes, state (`ok` / `quarantined`), error.
   Quarantined rows use a warning chip and show the error inline. Clicking a row expands its file
   list. Clicking a text file opens the preview pane; binary files show "Binary file · <size>" and
   the SHA-256 prefix.
6. Empty state: "No skills in the active snapshot. Run a sync."

The drawer is read-only except for the source actions. No skill can be edited here.

## 5. Create / edit / credential flows

### 5.1 Add source dialog

Title: "Add skill source". Primary: "Add and sync".

Fields:
- Name (required, 1-128).
- Slug (required, 1-64, lowercase letters/digits/single hyphens; auto-derived from name until
  edited).
- Endpoint (required, absolute http/https; placeholder `https://<skills-hub-host>`).
- Buckets (comma-separated; empty means all buckets; validated lowercase slugs). Show the
  placeholder `default` only as an example, not as a forced default.
- Token (password, optional; hint "Stored write-only. You will not be able to view it again.").
- `Allow insecure HTTP` checkbox, shown only for an `http` endpoint; unchecked by default with a
  warning "Only enable for a trusted LAN source. The token is sent unencrypted."
- Advanced disclosure: priority (default 100), sync interval seconds (900), stale after seconds
  (86400), request timeout ms (15000). Use existing input primitives; show current values.

On submit: create, close, toast "Source added. Syncing...", then call sync. On sync result:
- success: toast "Synced N skills · X KB" (or "Already up to date").
- degraded: toast "Synced with N warnings." + inline row state.
- failure: the source remains; row shows "Never synced" or "Error" and the error message. Do not
  silently discard the source.

### 5.2 Edit source dialog

Editable: name, endpoint, buckets, priority, intervals. Slug is immutable in the UI (identity is
used in links and logs). `enabled` is NOT in this form: use the explicit Disable/Enable actions so
the consequence copy is always shown. Token is not in this form.

Footer: Cancel / Save changes. On success: toast "Source updated." If the endpoint or buckets
changed, show "Sync now" as the row's primary action and mark the existing snapshot as not yet
verified against the new endpoint; do not claim it is current. Editing an `http` endpoint requires
the same insecure confirmation.

### 5.3 Replace token

Separate dialog: password field, hint "The current token is never shown. Replacing it takes effect
for the next sync.", primary "Replace token". On success: toast "Token replaced." and refetch.
After submit, clear the DOM field immediately.

### 5.4 Clear token

Confirmation dialog: title "Clear token?", body "Background sync will fail until a new token is
set. Cached skills remain available." Buttons Cancel / Clear token (danger). On success: toast
"Token cleared."

### 5.5 Disable / enable

Disable confirm: "Disable source? Scheduled sync stops and its skills stop resolving for new
launches. The cached snapshot is retained until cleanup; re-enabling will sync again." Primary
"Disable". Reversible. Disabling a pinned source resets it to tracking mode, because the active and
pinned pointers are cleared; this is a backend regression fix (see §9). Enable triggers a sync;
toast "Source enabled. Syncing...".

### 5.6 Pin / unpin

Direct action, no modal. Pin: "Source pinned. Scheduled sync will check but will not publish
changes." Unpin: "Source unpinned. The next sync will publish changes." Pinned state shows a lock
badge in the list and drawer.

### 5.7 Delete source

Confirmation dialog with typed slug. Body bullets:
- "Removes the source, its stored token, and its sync schedule."
- "The cached snapshot is retained for the cleanup window; local skills are not deleted."
- "N skills from this source will stop resolving for new launches."
- "Local skills are not deleted."
Input: `Type <slug> to confirm`.
Buttons: Cancel / Delete source (danger, disabled until match and not busy).

The mutation MUST send `{ "hard": true }`; the API's `delete` action defaults to a soft disable
when `hard` is absent. A test must assert the source row is gone, not merely disabled.
`Disable` is offered as the safer alternative in the body. No undo toast.

## 6. Status model

| Source state | Chip | Label | Primary action |
| --- | --- | --- | --- |
| `never_synced` | queued + clock | Never synced | Sync now |
| `syncing` | in_progress + spinner | Syncing | disabled Sync now |
| `ready` | delivered + check | Ready | Sync now |
| `degraded` | awaiting_approval + alert | Degraded | Review skills |
| `error` | failed + alert | Error | Retry sync |
| `disabled` | cancelled + slash | Disabled | Enable |
| `ready` + `stale` | warning badge + hourglass | Stale | Sync now |
| `mode=pinned` | lock badge | Pinned | Unpin |

The row also shows `lastSuccessAt` relative and absolute. Stale is derived from the server boolean,
not recomputed in the client. A degraded source publishes a new snapshot with quarantined skills
excluded; it never rewrites the previous snapshot. The chip is a warning, not an error state. A
successful `check` updates `lastCheckedAt` only; it must not advance `lastSuccessAt` (backend fix).

## 7. External rows in the Skills inventory

### 7.1 Data contract changes

- Server `SkillsInventoryRowProps` adds a structured origin:
```ts
readonly origin: {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly bucket: string;
  readonly revision: string;
  readonly snapshotId: string;
} | null;
```
- `id`, `primaryId`, `scope`, `originScope`, `href` become nullable in the client mirror.
- Add `mode: "managed" | "external"`, `externalKey: string | null`, `fileCount: number`.
- Add `external` to `InventoryFilter` and `SkillsCountsProps`.
- Warning props add `skill_source_conflict`, `skill_source_quarantined`, `skill_source_stale`.
- Issue props add `invalid_skill_file`.

### 7.2 Row behavior

- External row: name is a button, not a link; `View` opens the read-only skill drawer. The v-for key
  is `externalKey ?? String(id)`, never `${id}-${state}` (all external rows share `id=null` and
  `state=inherited`). Both the name cell and the trailing action cell branch on
  `mode === "external"`; `SmartLink` is never passed `href=null` because it calls
  `to.startsWith` and would throw at runtime.
- Origin cell: `.badge` "Source" + `<sourceName> · <bucket>`; branch on `mode`, never on
  `originScope` (null would fall through to "Global").
- State cell: `Read-only` badge with lock glyph; not the managed enabled/disabled state.
- Files column: use `effective.fileCount` for ALL rows and label the column "Files". Managed rows
  currently send `references.length`; change the server to send the effective file count so
  arbitrary local files are included.
- Updated: snapshot publication time from `origin.publishedAt`, not request time. The backend must
  carry `publishedAt` on the external record/origin; do not display `new Date()` as "updated".
- Managed rows are unchanged, including the effective link and edit/override actions.
- Add `External` to the segmented filter. External rows are EXCLUDED from `counts.inherited` and
  from the "Inherited" filter; `counts.external` is separate. Search matches name, description,
  source name, and bucket.
- Local rows that shadow an external row show a warning: `"<name>" is also provided by <source>
  but this local skill wins.`

### 7.3 External skill drawer

Header: skill name, `Read-only` badge, source name + revision.
Body: description, bucket, version, file count, bytes, updated; a banner:
"This skill is provided by <source>. Editing is disabled; manage the source in Settings."
Actions: `Manage source` (link to `/settings#settings-sources`) and `Close`. No Edit, no
Fork, no Disable.
File list: path, size, SHA-256 prefix. Selecting a file calls the bounded preview endpoint; the
client does NOT guess text vs binary from the path. The endpoint returns
`{ path, size, sha256, encoding: "text" | "binary", text? }`; text is capped (see §9), binary shows
metadata only. The request includes `snapshotId` (and the endpoint verifies it is the active
snapshot) so the preview matches the revision/SHA listed. The drawer refetches
`/api/skill-sources/:id/skills` and finds the skill by `(bucket, name)`; if the source was disabled
or the skill disappeared, show "This skill is no longer in the active snapshot" with a link to the
source manager. File-list rows are buttons with `aria-expanded` for the preview pane.

## 8. Data flow and API

- Source list: `useQuery({ queryKey: ["skill-sources"], queryFn: () => apiQuery<{sources:
  SkillSourceView[]}>("/api/skill-sources") })`.
- Mutations: `apiMutation` to `/api/skill-sources` with the existing action bodies; per-source
  path actions for sync/check/pin/unpin/delete/secret.
- Source skills: `useQuery({ queryKey: ["skill-source-skills", id], queryFn: () =>
  apiQuery<{source: SkillSourceView; skills: SnapshotSkill[]}>(`/api/skill-sources/${id}/skills`) })`.
- File preview: `apiQuery<SourceFilePreview>(`/api/skill-sources/${id}/files?bucket=...&name=...&path=...`)`.
- After create/update/token/sync/check/pin/enable/disable/delete: invalidate `["skill-sources"]`
  AND `["skill-source-skills", id]` (the drawer embeds its own `source` view); close and remove the
  skills query on delete. After a successful sync with `changed: true`, invalidate the skills
  inventory queries and call the existing `markSkillsMutated()` helper so the SSR boot inventory is
  not reused.
- Check result: show `Update available · <next revision>` with a `Sync now` action when
  `changed`, or `Up to date · <revision>` otherwise; do not reduce this to a toast.
- Source list refresh after a background sync is best-effort; refetch on window focus/visibility and
  after every mutation. While a foreground sync request is in flight, set the row to a local
  `syncing` state so the chip does not lie if the request is slow.
- The source section owns its query; SettingsPage does not need to put source data in the SSR
  boot payload. A loading skeleton is acceptable on first settings visit.
- The Skills inventory read path uses `deps.effectiveSkills ?? deps.skills`; managed mutations and
  the numeric detail route keep `deps.skills`.

## 9. Backend changes required

| File | Change |
| --- | --- |
| `src/http/spa.ts` | Add an effective-skills resolver for the inventory read path; keep managed detail/mutations. |
| `src/http/skills.ts` | Use the effective resolver for `GET /api/skills`; keep managed service for POST/DELETE. |
| `src/http/props/skills.ts` | Widen `previewFor`/`surfaceModel`/`SkillsInventoryBuildInput` to `SkillSource`; add structured `origin` with `publishedAt`; exclude external from inherited counts/filter; add external filter/count; source-aware search; source warning text; use `effective.fileCount` for all rows; add `invalid_skill_file` anchor if needed. |
| `ui/skills-types.ts` | Mirror nullable fields, `mode`, `externalKey`, `fileCount`, structured `origin`, new filter/warning/issue codes. |
| `ui/skills-fixtures.ts` | Add an external row fixture and counts, including `origin.publishedAt`. |
| `src/http/spa.ts`, `src/http/skills.ts` | Use `deps.effectiveSkills ?? deps.skills` for `/api/ui/skills` and `GET /api/skills`; keep managed service for mutations and numeric detail. |
| `src/http/skill-sources.ts` | Add `GET /api/skill-sources/:id/files?snapshotId=&bucket=&name=&path=`; text-only bounded preview; extend the route matcher; require a non-empty token for replace; map duplicate slug to 409. |
| `src/skill-sources/composite.ts`, `types.ts`, `service.ts` | Carry `publishedAt` on external records/origin; add `tokenUpdatedAt` to `SkillSourceView`; reset `mode` to `track` on disable; make `check` update only `last_checked_at`; define warning source fields. |
| `src/http/props/settings.ts`, `ui/settings-types.ts` | Add the `sources` label to the server-provided section labels and the client mirror. |
| `ui/settings-view.ts` | Add `sources` to `SettingsSectionId` and `SETTINGS_SECTIONS`; add its rail summary; map `#settings-sources` and the legacy alias. |
| `ui/pages/SettingsPage.vue` | Add the `sources` rail/pane, mount the manager when the pane is active at global scope, and render the global-only guard at project/app scopes. |
| `ui/pages/SkillsPage.vue` | External row branch, key by `externalKey`, External filter, source-aware empty states, drawer trigger. |

## 10. Accessibility and security

- Status chips include a glyph and text; stale/pinned are text badges, not color only.
- Sync results and background state changes use one polite live region (`role="status"`,
  `aria-live="polite"`); errors use `role="alert"`. Do not announce progress percentages or every
  row update.
- Native `<dialog>` for the add/edit/confirm/drawer surfaces; focus returns to the trigger.
- Every icon-only button has an `aria-label`; row actions are reachable by keyboard; no hover-only
  menu.
- Delete requires typing the slug; the confirm input is labelled and the error is associated with
  `aria-describedby`.
- Relative times use `<time datetime>` with an accessible absolute description; tables may use
  absolute time.
- Token fields use `type="password"`, `autocomplete="new-password"`, allow paste, and are cleared
  after submit. No token is ever placed in a URL, DOM text, toast, or error.
- The list shows only the endpoint host; the drawer shows the full endpoint. Plain HTTP is flagged
  in place.
- The API remains human-only and same-origin; the UI does not add a bearer-token prompt.

## 11. Responsive and visual rules

- >= 1024: ledger table; source drawer 720px; external drawer 620px.
- 768-1023: ledger rows become stacked cards; actions remain visible; drawer min(92vw, 720px).
- < 768: one column; drawer full width; dialogs full width with 16px gutters; buttons 44px.
- Use existing `.card`, `.table`, `.table--stack`, `.status`, `.badge`, `.field`, `.input`,
  `.dialog`, `.disclosure`, `.hint`, `.btn` primitives. New structural classes must use existing
  tokens and be added to `src/http/styles.css` plus `DESIGN.md` if they are reusable.
- Light and dark must both pass contrast; status colors are not used as large fills.

## 12. Test plan

- Server props: external row origin with `publishedAt`, external filter/count and inherited
  exclusion, source-aware search, warning text for all three source codes, `invalid_skill_file`,
  managed `fileCount` including arbitrary files.
- Server API: file preview text/binary/limit/missing file/404, snapshot-id mismatch, path not in
  the snapshot, no caller-supplied sha; duplicate slug 409; missing token on replace 400; check
  does not advance `lastSuccessAt`; pinned disable -> enable regression; effective-skills wiring
  for `GET /api/skills` and `/api/ui/skills`.
- Component: source list states, empty/error/loading, create validation (including non-ASCII slug
  fallback), edit, token replace/clear, typed delete, sync busy/error, source drawer, external
  row/drawer, duplicate-key/href-null regression.
- SPA e2e: add a fake hub to the fixture server or use an injected fetch; create/sync/pin/disable/
  delete a source; assert token sentinel never appears; external row/filter/drawer; `href=null`
  never reaches `/skills/null`; direct `/settings#settings-sources` deep link; screenshots at
  390/1440 light/dark.
- Gates: `npm run typecheck`, `typecheck:ui`, `lint`, `test`, `build`, `check:sensitive`,
  `test:e2e`.

## 13. Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC1 | A source can be created from Settings, synced, checked, pinned/unpinned, disabled/enabled, edited, token-replaced/cleared, and deleted. |
| AC2 | Every source state has a readable chip, last success/error, revision, counts, and a next action. |
| AC3 | The token is never present in the DOM, a URL, a toast, or an error after save; only Replace/Clear change it. |
| AC4 | Delete requires typing the slug and explains source vs local-skill vs snapshot consequences. |
| AC5 | External rows render without a `/skills/null` link or duplicate-key warnings, show a Source badge, are excluded from Inherited counts, support the External filter, and open a read-only drawer. |
| AC6 | External file preview is bounded and read-only, matches the active snapshot/revision, and binary files show metadata only. |
| AC7 | All new surfaces are keyboard reachable, focus-managed, responsive at 390/1440, and correct in light/dark. |
| AC8 | `lint`, `typecheck`, `typecheck:ui`, `test`, `build`, `check:sensitive`, and `test:e2e` pass. |

## 14. Open questions

1. Should `Add and sync` auto-sync on create, or leave the source in `never_synced` with a clear
   primary action? Recommendation: auto-sync; the source remains if sync fails.
2. Should the file preview allow binary base64 download? Recommendation: no; metadata only in this
   stage.
3. Should the External filter be a single filter or a per-source select? Recommendation: single
   External filter; per-source filtering is a follow-up when multiple sources are common.
4. Fork-to-local remains deferred; the read-only drawer explains the source of truth and links to
   source management.
5. Delete is a hard delete (the UI sends `hard: true`); Disable remains the reversible action.
6. External rows are not counted as Inherited; they have a separate External count/filter.

## 15. Review record

Round 1 (`oracle`, 2026-11-11): **CHANGES REQUESTED**. The findings below are folded into the
sections above and are binding on the implementation:

- Delete must send `hard: true`; the API defaults to soft disable.
- Disabling a pinned source must reset mode to `track` so re-enable can publish; add a regression
  test.
- External rows must key by `externalKey`, never pass null to `SmartLink`, and must not fall back
  to "Global".
- External rows are excluded from Inherited counts/filter and counted separately.
- Add `origin.publishedAt` (snapshot publication) and `tokenUpdatedAt`; do not display request
  time as "updated".
- File preview is text-only with a bounded size, resolves only the active snapshot's listed files,
  includes `snapshotId`, and returns `encoding: "text" | "binary"`; never accept a caller sha/path.
- Warning data must carry source name (not just source id); `warningText` must handle conflict,
  quarantined, and stale; source-level warnings are not skill-name collision matches.
- Use `effective.fileCount` for the Files column for all rows.
- Hide Pin when there is no active snapshot; define primary-action precedence.
- Invalidate `["skill-source-skills", id]` on every source mutation; use `markSkillsMutated()`.
- Add the server-provided nav label and explicit hash handling for
  `/settings#settings-sources`.
- Map duplicate slug to 409 and require a non-empty token for replace; reserve clearing for the
  clear action.
- `check` updates `last_checked_at` only; `last_success_at` means a published snapshot.
- Fake hub + `skillSources`/`effectiveSkills` must be wired into the e2e fixture server.
