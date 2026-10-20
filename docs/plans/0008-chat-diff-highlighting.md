# Plan 0008 - Chat diff highlighting

- Status: implemented and verified (journal 0010); commit/deployment pending.
- Design: [`docs/design/chat-diff-highlighting.md`](../design/chat-diff-highlighting.md) (Oracle
  design review **PASS**, 2026-10-20).
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) (no open items).
- Plan reviewer: `momus` (`docs/process.md`). Design reviewer: `oracle`.
- Bindings: design docs `docs/design/` (index `docs/design/README.md`); plans `docs/plans/` (index
  `docs/plans/README.md`); decisions `docs/decisions/`; journal `docs/journal/` (index
  `docs/journal/README.md`); open questions `docs/open-questions.md`; docs language English.
- Verification: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
  `node docs/design/chat-qa.mjs`.
- Commit policy: one coherent stage commit on explicit owner authorization (given); Conventional
  Commits. Deploy to `deployment-host` after all gates (owner authorization given; runbook `docs/deploy/host.md`).
- Outcome: completed `edit` (standard and OMO hashline), `apply_patch`, and `write` tool blocks render
  syntax-highlighted unified diffs or written content; the legacy `patch` part renders its file list;
  all existing chat behavior and gates stay green.

## Invariants

- `assets/chat.js` and every new Hanse client module contain no `innerHTML`; all text goes through
  `textContent`/`createTextNode` (`test/chat-page.test.ts:405`).
- Prism runs only in `assets/chat-highlight-worker.js`. The main chat module graph imports no Prism
  and has no top-level await; a failed/slow worker degrades to plain text without blocking chat.
- No new npm runtime dependency and no JS bundler. The Prism bundle is a checked-in same-origin asset
  with `LICENSE`, `VERSION`, and `SHA256SUMS`.
- The existing `<details class="tool-call">`, `openParts`, summary preview, status chip, elapsed,
  error auto-open, scroll behavior, markdown, queueing, and SSE contracts are preserved. The only
  upstream wire addition is `truncated.limit`.
- The server event caps are subtractive: they may drop output/diagnostics/input/paths/records, but
  the retained records keep their patches. No database, route, or schema change.

## Phases

### Phase 1 - Vendor Prism 1.30.0 and asset serving

Boundaries: vendor artifact and provenance only; no client logic.

Work:
- `npm pack prismjs@1.30.0` in a temp directory; verify `npm view prismjs@1.30.0 dist.integrity`
  matches the tarball.
- Extract `package/components/prism-*.min.js` for the component order in design §4.2; concatenate,
  prepend the license header, append `export default Prism;`.
- Add `assets/vendor/prism/{LICENSE,VERSION,SHA256SUMS,prism-1.30.0.min.js,README}`.
- Allowlist `/assets/vendor/prism/prism-1.30.0.min.js` in `src/http/handler.ts`.
- Add a checksum/size test (raw <= 88 KiB; SHA-256 matches `SHA256SUMS`) and a Node ESM smoke that
  imports the bundle and checks all required language IDs.

Acceptance:
- The bundle imports as an ESM default export in Node and exposes every required language in design
  §4.3.
- The checksum/size test passes; the asset is served with a JavaScript MIME type; unknown vendor
  paths 404.
- No `package.json`/lockfile change.

Tests: `test/chat-page.test.ts` (checksum/size/no-innerHTML), `test/http.test.ts` (asset 200/MIME/
unknown 404), `test/chat-diff.test.ts` language-ID smoke if it imports the bundle (Node).

Risk: concatenating a component out of dependency order. Mitigation: fixed order in design §4.2 and
the language-ID smoke test.

### Phase 2 - Pure `assets/chat-diff.js` and unit tests

Boundaries: pure functions only; no DOM, no Prism, no network.

Work:
- Implement the language resolver (extension/filename table, uncapped basename before display cap,
  required/optional language sets, per-language stream caps).
- Implement `parseUnifiedDiff(text, options)` with `Index:`/`====`, trailing `\ No newline`,
  add/delete/move metadata, binary, CRLF, `maxFiles`, `statsPartial`, `filesTruncated`, raw fallback.
- Implement payload extraction for `edit` (standard/hashline), `apply_patch`, `write`, and the
  `patch` part; metadata type/old-new path/count mapping; drop `filediff.before/after`.
- Implement the one allocator (per-file 64 KiB field cap, 128 KiB sum, whole-record drops, 50-file
  cap, path caps, live/hydrated parity) and the display truncation/notice model.
- Export constants used by the controller/worker; keep the module browser/Node safe.
- Allowlist `/assets/chat-diff.js` in `src/http/handler.ts` (`file:"chat-diff.js"`,
  `text/javascript; charset=utf-8`) and add a 200/MIME/unknown-404 test to `test/http.test.ts`.

Acceptance:
- `test/chat-diff.test.ts` covers resolver, parser, extractor, allocator, clipping, notice selection,
  and the exact fixtures in design §7.3.
- 3 x 64 KiB -> two full + third whole record dropped; 200 files -> 50 records; `truncated.limit`
  values match design §5.3 (enum/severity) and §5.1 (constants); exact notice strings match §5.5;
  200 hashline `edits` are dropped by the normalizer test in phase 5.

### Phase 3 - Worker and controller

Boundaries: `assets/chat-highlight-worker.js` and `assets/chat-highlight.js`; no `chat.js` behavior
changes yet.

Work:
- Worker: synchronous `self.onmessage`, `{type:"init"}` handler sets
  `globalThis.Prism={manual:true,disableWorkerMessageHandler:true}`, dynamic-imports the vendor bundle,
  posts `{type:"ready"}`; validates the canonical language allowlist; tokenizes with
  `Prism.tokenize`; flattens iteratively; returns the compact line plan and `tokenNodes`; enforces
  stream/line/token caps; no HTML.
- Controller: lazy `ensureWorker()`, ready timeout, all-or-nothing per-file scheduler
  (`S x 10,000`, 12 stream reservations / 120k, 50 worker-ready pending), per-request 250 ms timeout
  with terminate, aggregate view/page work budgets, circuit breaker, stale `jobID`/`viewKey` drops,
  `resetHighlightController()`, plain-first DOM renderer, focus/scroll preservation, `data-highlight`
  states.
- Allowlist `/assets/chat-highlight.js` and `/assets/chat-highlight-worker.js`; extend asset tests.
- Keep the main module free of Prism imports and top-level await.

Acceptance:
- Node/browser static tests assert no `innerHTML`/`Prism.highlight` in the Hanse modules, no Prism
  import or top-level await in `chat-highlight.js`, and no top-level worker import in that module.
- Q1 asset budgets are asserted: `chat-diff.js` + `chat-highlight.js` <= 88 KiB raw / 24 KiB gzip,
  `chat-highlight-worker.js` <= 12 KiB raw / 8 KiB gzip, all three <= 96 KiB raw / 32 KiB gzip; the
  Prism vendor remains <= 88 KiB raw.
- A manual/worker smoke in browser QA loads the worker, receives `ready`, tokenizes one stream, and
  falls back to plain on a worker error/timeout.
- Scheduler math tests (pure helpers where practical) or QA assert 12 x 10k = 120k, `S x 10k` per-file
  admission, 20k aggregate, stale release, and immediate plain fallback when a file reservation is
  unavailable.
- A unit/static test asserts token classes are emitted only for `/^[a-z0-9-]+$/`.

### Phase 4 - Chat integration

Boundaries: `assets/chat.js`; no server changes yet.

Work:
- `toolPreview`: `apply_patch` path/file count and metadata path fallbacks; `write`/`edit` metadata
  fallbacks.
- `renderStateFor`/`ensureToolBody`: `diff`, `write`, and `none` body kinds; reuse the scroll element.
- `updateToolPart`/`updateDetailPart`: build the skeleton, enqueue only when open, apply token plans,
  restore focus/scroll, use the view/display truncation object, suppress the body for omitted parts.
- `attachOpenTracking`: open -> submit; close -> cancel, clear token spans, release reservations.
- `message.part.updated`: store `part.truncation = payload.truncated`; `message.part.omitted`: set
  `part.omitted = true` and suppress the normal body. Both feed `truncationNotice`.
- Hydration/session switch/part removal: call `resetHighlightController` at the design §4.8 call
  sites (`hydrateMessages` after `applySnapshot`, `selectSession`, `ensurePartNode`/part removal).
- Error parts keep the existing error `<pre>` and make no highlight request.
- `truncationNotice` consumes `{serverFields, serverLimit, omitted, display}` and exact strings.

Acceptance:
- Existing chat behavior is unchanged for non-diff tools; a completed `edit`/`apply_patch` shows a
  highlighted diff; `write` shows highlighted content; unknown language/binary shows plain structure;
  a `patch` part with only `files` shows a file list.
- No `innerHTML` in `chat.js`; the chat-page test still passes.
- Browser QA in phase 7 proves open/close, hydration, focus, omitted, and error behavior.

### Phase 5 - Server event caps, dedup, and budget

Boundaries: `src/opencode/events.ts` and its tests; no route/DB changes.

Work:
- Add `MAX_DIFF_BYTES=64 KiB`, `MAX_DIFF_EVENT_BYTES=128 KiB`, `MAX_WRITE_CONTENT_BYTES=64 KiB`,
  `MAX_PATCH_INPUT_BYTES=64 KiB`, `MAX_DIFF_FILES=50`, `MAX_DIFF_PATH_BYTES=1 KiB`,
  `MAX_DIFF_PATH_TOTAL_BYTES=16 KiB`, `MAX_TRUNCATED_FIELDS=32`,
  `MAX_TRUNCATED_FIELD_BYTES=8 KiB`.
- Normalize before bounding: dedup combined vs per-file sources; drop `oldString/newString`,
  `filediff.before/after`, unrendered metadata (`diagnostics`), and unrendered input (hashline
  `edits`, `replaceAll`); keep render allowlist fields; cap paths/total/truncated fields; add
  `truncated.limit`.
- Enforce per-file 64 KiB field caps, the 128 KiB per-file sum by dropping whole trailing records,
  the combined 128 KiB cap, and the 256 KiB serialized event budget with the deterministic drop order
  (output -> diagnostics/unrendered metadata -> whole records/combined cap -> omit).
- Keep `message.part.omitted` for unrepresentable events.

Acceptance:
- `test/opencode-events.test.ts` covers all design §7.3 server cases: 64 KiB fields, dedup, 3 x 64 KiB
  (two full + third dropped), 200 files -> 50, adversarial paths, large diagnostics, 200 hashline
  edits, `truncated.fields/limit`, combined >50 files, and omitted fallback.
- Existing event tests remain green; the typed SSE shape is additive.

Risk: changing the normalizer can drop a field the client renders. Mitigation: the explicit render
allowlist, the regression test, and no other `src/` consumer.

### Phase 6 - CSS, DESIGN.md, and showcase

Boundaries: presentation only.

Work:
- Add the token theme and `.tool-diff`/`.tool-code`/`.diff-line`/`.token` styles to
  `src/http/styles.css`, scoped to the diff/code containers, theme-aware, responsive columns,
  horizontal scrolling, line-number/sign accessibility.
- Update `DESIGN.md` with the diff/code component and token mapping; add specimens to
  `docs/design/showcase.html`.
- Run `npm run build:css`.

Acceptance:
- Dark/light token contrast and diff backgrounds pass the visual check; 390 px has no page overflow;
  the diff scroller is the only horizontal scroller.
- `DESIGN.md` and the showcase match the implemented classes; no new global primitive or font.

### Phase 7 - Browser QA and evidence

Boundaries: `docs/design/chat-qa.mjs`, `docs/design/artifacts/chat/`.

Work:
- Add fixtures for standard `edit` (filediff.patch), hashline `edit` (metadata.diff), multi-file
  `apply_patch` (add, update, delete, move), `write` (40-line TS, empty, representative 64 KiB),
  `patch` files-only and a legacy `patch` string, unknown extension, binary, truncated diff, omitted
  part, >50-file combined diff, and a live streaming diff that completes then hydrates.
- Add adversarial fixtures: 8 KiB of pathological Markdown `[`, markup, and Bash, plus a
  representative 64 KiB code write; assert tokenization or plain fallback within the 250 ms worker
  budget plus paint, worker termination on timeout, and no console/page error.
- Assertions: `.tool-diff`/`.tool-code`, file count, +/- stats, old/new line numbers, add/del lines,
  `.token.keyword`/`.token.string`, plain fallback, exact notices, file-list mode, lazy closed diffs,
  focus preservation, live streaming + hydration with no colored→plain→colored flash, error
  no-highlight, scheduler plain fallback, data-highlight states, theme colors, `aria-hidden` line
  numbers, `tabindex="0"`/`aria-label` scroller, no new live region, no console/page errors.
- Capture dark/light desktop and 390 px screenshots; update `docs/design/artifacts/chat/README.md`.
- Document the Playwright/Chromium prerequisite; a missing browser is a blocked gate, not a skip.

Acceptance:
- `node docs/design/chat-qa.mjs` exits 0 with the new report/screenshots and no console errors.

### Phase 8 - Docs, record, gates, commit, deploy

Work:
- Update `docs/current-state.md` (assets, chat renderer, caps/limitations, HANSE_ASSETS).
- Apply the design §10 non-goal/§9.4 replacement in `docs/design/chat-ux-overhaul.md`; update
  `docs/design/README.md` if not already; update `docs/plans/README.md`.
- Add `docs/decisions/0008-vendored-prism-chat-highlighting.md`.
- Write `docs/journal/0010-chat-diff-highlighting.md` and update `docs/journal/README.md`.
- Fix the design §7.2 journal reference from `0009` to `0010` (0009 is the packaging stage).
- Run the full gate: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
  `node docs/design/chat-qa.mjs`.
- Commit (Conventional Commit), push to `origin/main`.
- Deploy to `deployment-host` per `docs/deploy/host.md`: wait for the published `sha-<short>` image (step 2),
  back up state/workspace/env/compose override and rollback-tag the current image (step 3), deliver
  the commit with `git archive --format=tar HEAD | ssh deployment-host 'tar xf - -C <INSTALL_DIR>'` (step 4), update
  `HANSE_TAG` in `.env` (step 5), `docker compose pull && docker compose up -d --remove-orphans`
  (step 6), run the health-check including the new asset paths (step 7), and append
  `docs/deploy/deploy-log.md`. Do not `docker compose build`; the documented flow pulls the
  published image.

Acceptance:
- All five verification commands pass.
- The journal and indexes are updated; the design non-goal is superseded.
- The deployed host returns the expected health-check codes; both containers are up; deploy-log is
  updated.

## Verification commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
node docs/design/chat-qa.mjs
```

Deploy (after gates): follow `docs/deploy/host.md` steps 2-7 exactly.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Prism superlinear tokenization blocks the feed | Module worker, 250 ms timeout + terminate, language caps/line cap, view/page work budgets, circuit breaker, plain fallback |
| Prism bundle size/provenance drift | Pinned 1.30.0, integrity check, SHA256SUMS, raw-size test, optional-language drop rule |
| Scheduler starvation/partial files | All-or-nothing per-file reservation; unavailable -> plain immediately; 12 stream reservations / 120k; no budget waitlist |
| Live vs hydrated divergence | One allocator spec, combined 128 KiB both paths, client path-total 16 KiB, whole-record drops |
| Event budget overflow/omission | Whole-event `jsonBytes` loop, drop output/diagnostics/input/records, combined 128, omit only last |
| Focus/scroll loss | Stable scroll element, focus/scroll restore, QA assertion |
| Dropping a rendered field | Explicit render allowlist, `test/opencode-events.test.ts` regression, no other consumer |
| Playwright absent | Documented prerequisite; missing browser blocks the gate |

## Rollout and rollback

Additive assets/renderer branch; no DB migration or route change. Rollback removes the new asset
allowlist entries and the `chat.js` imports; the old `<pre>` path remains the fallback. Server caps are
subtractive; revert them with the same commit if needed. A failed Prism/worker load degrades to plain,
not broken chat.

## Plan review

First Momus verdict: **PASS WITH REQUIRED CHANGES** (2026-10-20). Findings and resolutions:

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | `/assets/chat-diff.js` missing from the asset allowlist | BLOCKER | Added to Phase 2 work/tests (`handler.ts` + `test/http.test.ts` 200/MIME/404) |
| 2 | Journal `0009` already taken by packaging | BLOCKER | Plan uses `docs/journal/0010-chat-diff-highlighting.md`; design §7.2 corrected |
| 3 | Phase 7 QA missing Q8 adversarial, F6 live streaming, delete/move, patch-string cases | MAJOR | Added adversarial/live/delete/move/patch-string fixtures and assertions plus Q7 accessibility checks |
| 4 | Q1 module budgets and `test/http.test.ts` placement unassigned | MAJOR | Added <=88/12/96 KiB raw and gzip assertions to Phase 3; asset tests split between chat-page/http |
| 5 | Phase 8 deploy used `docker compose build` and omitted publish/HANSE_TAG/git archive | MAJOR | Replaced with runbook steps 2-7: published `sha-<short>`, backup/rollback, `git archive`, `HANSE_TAG`, `docker compose pull`/`up`, health-check |
| 6 | Phase 4 omitted `part.truncation`/`part.omitted` storage and exact reset call sites | MAJOR | Added both event handlers and design §4.8 call sites |
| 7 | `truncated.limit` referenced §5.5 instead of §5.3/§5.1 | MINOR | Cross-reference corrected |
| 8 | Token-class regex and accessibility assertions missing | MINOR | Added unit/static token-class test and Phase 7 aria/tabindex/live-region assertions |

Final gate: re-review pending. Implementation starts only after the re-review passes.
