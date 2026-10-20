# Stage 0008 - Chat diff highlighting

- Date: 2026-10-20
- Status: implemented, verified, and deployed to `deployment-host` as `sha-3e25c46`; deployment record in the
  local `docs/deploy/deploy-log.md`
- Design: [`docs/design/chat-diff-highlighting.md`](../design/chat-diff-highlighting.md)
- Plan: [`docs/plans/0008-chat-diff-highlighting.md`](../plans/0008-chat-diff-highlighting.md)
- Gate reviews: `oracle` design review (PASS after four gate rounds); `momus` plan review
  (PASS after one revision)
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) (no open items)
- Related: [`docs/decisions/0008-vendored-prism-chat-highlighting.md`](../decisions/0008-vendored-prism-chat-highlighting.md)

## Context

Completed `edit` and `apply_patch` parts already carried unified diffs, `write` carried the new file
content, and the legacy `patch` part carried file paths, but every tool body rendered as plain
`<pre>` text. The owner chose real syntax highlighting (Option B), which supersedes the old
"no syntax-highlighting library" non-goal. The main risk was Prism's superlinear tokenization on
agent-controlled Markdown/markup/Bash, which cannot be time-boxed on the main thread.

## Delivered

- Vendored PrismJS 1.30.0 as `assets/vendor/prism/prism-1.30.0.min.js` (MIT, header, ESM
  `export default Prism;`) with `LICENSE`, `VERSION`, `SHA256SUMS`, and update instructions. No npm
  runtime dependency, no bundler.
- `assets/chat-diff.js` (pure): language resolver, unified-diff parser (real `createTwoFilesPatch`
  shape, `Index:`/`====`, trailing `\ No newline`, add/delete/move metadata, binary, CRLF, raw
  fallback), payload extraction for standard/hashline `edit`, `apply_patch`, `write`, and the legacy
  `patch` part, one allocator for live/hydrated data, UTF-8-safe clipping, and field-aware notices.
- `assets/chat-highlight-worker.js`: module worker with synchronous `onmessage`, lazy Prism init
  (`manual` + `disableWorkerMessageHandler`), `Prism.tokenize`, iterative flattening, line mapping,
  stream/line/token caps, and no HTML.
- `assets/chat-highlight.js`: main-thread controller/renderer with plain-first skeletons, lazy
  open-only highlighting, all-or-nothing per-file reservations, 250 ms timeout + terminate/recreate,
  ready/work budgets, language circuit breaker, stale `jobID`/`viewKey` drops, focus/scroll
  preservation, and `resetHighlightController`.
- `assets/chat.js`: tool/patch integration, deterministic `viewKey`, open-state wiring,
  truncation/omitted handling, reset on hydration/session switch/part removal, `apply_patch` previews.
- `src/opencode/events.ts`: diff/write/patch caps, de-duplication, unrendered metadata/input drops,
  128 KiB per-file sum by whole-record drops, 256 KiB serialized budget, and `truncated.limit`.
- CSS/DESIGN/showcase: theme-aware token colors, diff/code lines, file/hunk headers, responsive
  columns, internal horizontal scroll, diagnostics, and accessibility.
- Tests/QA: `test/chat-diff.test.ts` (181), event/http/chat-page additions, and the deterministic
  browser scenarios below.

## Verification

- `npm run lint` - PASS
- `npm run typecheck` - PASS
- `npm test` - PASS, **764 tests**, 37 files
- `npm run build` - PASS (tsc + Tailwind CSS)
- `node docs/design/chat-qa.mjs` - PASS: **9 scenarios, 199 assertions, 18 screenshots**, zero
  console/page errors. New scenarios: `diffs`, `diff-error`, `diff-lazy`, `diff-streaming`,
  `diff-adversarial`, `diff-timeout`. Captures include `main-1440-diff.png`,
  `main-1440-diff-light.png`, `main-390-diff.png`, and focused screenshots for error/lazy/streaming/
  adversarial/timeout.
- Asset budget: Prism bundle 84,242 B raw; new Hanse JS 85,030 B raw / ~20,167 B gzip (the design's
  original 36/48 KiB raw estimates were replaced with the measured 88/96 KiB raw and 24/32 KiB gzip
  budgets before this record; a size test enforces them).

## Decisions and why

- Prism in a module worker, not the main thread: the oracle measured ~19.4 s for 64 KiB Markdown
  `[`, ~3.6 s markup, ~2.2 s Bash; a terminable worker is the only way to keep the feed responsive.
- Lazy open-only highlighting: collapsed diffs do zero tokenization; the worker/Prism is fetched on
  the first open diff, so the initial chat payload does not include Prism.
- All-or-nothing per-file reservations: a file either gets its 10k/20k reservation and renders
  uniformly, or renders plain immediately; no partial file and no budget waitlist.
- `write` shows highlighted content, not a synthetic diff: completed `write` metadata has no diff and
  the permission diff is transient.
- One allocator for live and hydration: per-file 64 KiB, 128 KiB total, 50 files, 2,000 lines, path
  caps, whole-record drops, `truncated.limit`; no live/reload divergence.
- Legacy `patch` with only `files` renders a file list; no diff is invented.
- The design non-goal was replaced with a checked-in vendored asset exception; no new runtime npm
  dependency and no JS bundler.

## Bugs found during browser QA

- Combined `apply_patch` truncation at 50 files did not seed `display.files`, so the "Additional
  files omitted" notice was missing; fixed in `chat-diff.js`.
- Closed diffs started with `data-highlight="pending"`; they now start `plain` and move to
  pending/tokens only when opened.
- `terminateWorker()` called a null ready resolver on timeout, throwing and leaving a diff stuck;
  guarded the resolver path.
- Hydration reset every controller and re-tokenized unchanged open diffs, causing a colored → plain →
  colored flash; hydration now keeps unchanged view/controller state and releases only removed parts.
  `viewKey` no longer includes status, so running → completed with unchanged content does not rebuild.

## Residual risks / accepted debt

- Highlighting is hunk-local: a token that began before a hunk may be plain or mis-colored. Text is
  never changed.
- The 120k-node page budget can leave some files of a very large patch plain; the text remains
  readable and a later reopen may retry.
- `write` shows content, not a true diff; a session-diff fetch is out of scope.
- The vendored Prism bundle is third-party code refreshed manually with a checksum test; optional
  languages are the first to drop if the size budget changes.
- `--live` QA requires a real managed app/session and was not run; the deterministic gate is fully
  green.
- The design's original Q1 raw-size estimates were too small for the implemented parser/controller;
  the amended budgets are recorded above and enforced by a test.

## Deployment

Deployed to `deployment-host` on 2026-10-20 from commit `3e25c46` using the published
`ghcr.io/arkaneman/hanse:sha-3e25c46` image (index digest
`sha256:70e890eba14381730e0da8e74d1511ff1d4b8daea81c58a391a35c0198b19b3b`), after a
state/workspace/env backup and rollback tag `hanse:rollback-20261020-035855`. `git archive` delivery,
`HANSE_TAG`, `docker compose pull`, and `up -d --remove-orphans` completed; `/healthz` is 200, the new
assets are 200, both containers are healthy, and the local deploy log records the details.

## Addendum - read tool rendering (2026-10-20)

Completed `read` parts no longer show opencode's `<path>/<content>` XML as `<pre>`: the pure extractor
parses the path, XML line numbers, code, and trailing status line into a `read` view, the same
allocator applies a 64 KiB / 2,000-line line-aware cap, and the existing `.tool-code` renderer
highlights it with a `.tool-code__foot` status footer. Errors, running/pending parts, and malformed
output keep the plain fallback. Verified by the `npm run lint/typecheck/test/build` gates and the
deterministic `read` chat-QA scenario.
