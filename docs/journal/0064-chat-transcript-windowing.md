# Journal 0064 - Chat transcript windowing and lazy detail bodies

Status: **implementation complete (phases A-E); stage-specific gates green; not deployed**
(2026-11-20). Design `oracle` round 1 and focused round 2 PASS WITH FIXES; plan `momus` round 1
OKAY WITH FIXES; all findings folded before implementation. The working tree also contains the
in-flight `0050-mermaid-sandbox` stage; this stage's commit excludes those files. The full
repository lint currently reports only that stage's uncommitted files (see Verification).

Design: [`docs/design/chat-transcript-windowing.md`](../design/chat-transcript-windowing.md)
Plan: [`docs/plans/0051-chat-transcript-windowing.md`](../plans/0051-chat-transcript-windowing.md)
Owner decisions: design §9 (2026-11-20) - implement both lazy bodies and measured-height
windowing, two viewport heights of overscan, remember open details, and do not deploy this stage.

## Context

A long session rendered every loaded message and every detail body eagerly. Native `<details>`
hid bodies visually but kept them mounted, and older history pages were prepended and retained
forever, so a 500-message thread could freeze a tab or trigger the browser's kill-page prompt.
Grouping reasoning and tool cycles was visual only. The stage had two independent parts: mount
collapsed bodies only while open, and bound the number of rendered rows.

## Shipped

- **Phase A - pure modules.** `ui/chat/transcript-window.ts` (gap-aware prefix window),
  `ui/chat/transcript-memory.ts` (per-session heights and detail state with live-key pruning and
  caps), and `ui/chat/view-scope.ts` (shared scope key so scroll and transcript memory do not
  cycle). Contract names from the plan are frozen. Unit tests cover the pad identity, pinned tail,
  two-viewport overscan, keep-alive/reveal, unknown heights, disabled/zero-viewport modes, memory
  scope isolation, LRU refresh, and pruning.
- **Phase B - lazy bodies.** `ChatWorkGroup`, `ToolPart`, `ReasoningPart`, and the
  file/subtask `<details>` in `ChatMessage` mount their body only while open, use a controlled
  `open`, and remember the state through a provided per-session scope. Error opens win over a
  remembered closed state. Isolated component tests keep a no-op fallback.
- **Phase C - anchor and reactive scroll.** The O(all) DOM anchor scan became a bounded
  first-visible-row key plus `visualOffset`; `scrollTop`, viewport height, and pinned state are
  reactive inputs; programmatic scrolls, resizes, and height corrections update them
  synchronously. The outgoing-scope `persist(previous)` call was removed.
- **Phase D - measured window.** One `ResizeObserver` measures mounted rows (border-box), the
  window is a contiguous slice with gap-aware top/bottom spacers, activation waits for the initial
  restore and the first measurement pass (above 60 items or eight measured viewports), and a
  bounded focus keep-alive moves focus to the scroll container before a focused row unmounts.
  `ChatThread` exposes `data-chat-loaded-count` (messages), `data-chat-item-count` (items), and
  `data-chat-window-start`/`end` for tests and QA.
- **Phase E - proof and record.** The 500-message fixture gains deterministic reasoning and a
  ~16 KiB bash output on the tail message (and every 25th assistant message); the E2E test pages by
  the loaded message count, asserts a bounded window, expands the tail work group and tool to prove
  lazy mounting, and records chunk/heap/row metrics. `chat-qa.mjs` expands groups and nested tools
  through a re-query helper. Current-state and journal indexes are updated.

## Pad identity

For a rendered `[start, end)` slice with gap `G`, measured-or-fallback heights `h`, and prefix
`P[i] = sum(h[0..i-1])`:

```
topPad    = P[start] + G * start          (inline height; margin-block-end: -G)
bottomPad = (P[n] - P[end]) + G * (n-1-end)   (inline height; no negative margin)
```

The rendered run plus both pads reproduces `P[n] + G * (n-1)`. The pure module tests this identity
for the full, middle, and tail windows, with and without a top spacer. The DOM window test checks
the same identity against rendered spacer styles.

## Performance

500 loaded messages on the deterministic `ses_e2eperf` fixture:

| Measurement | Before | After |
| --- | --- | --- |
| Rendered transcript rows | 500 (every loaded message) | **17** |
| Detail bodies | every reasoning/tool body mounted | only open bodies |
| Window range | n/a (full list) | **495..510** of 510 items |
| Chunk resources / transfer | not recorded here | 8 resources, 91,947 B transfer, 167,614 B encoded (current build; varies) |
| `JSHeapUsedSize` | 16,859 KiB in journal 0039 (older fixture/content) | **16,064 KiB** on the post-crash run; 17,975 KiB on the phase run |

The heap figure is not a clean before/after: the fixture now carries roughly 160 KiB of additional
tool output and work-group rows, and the current build also includes the concurrent Mermaid stage's
uncommitted code. The stable win is the bounded DOM (500 -> 17 rows) while the loaded data stays in
the store. The E2E annotation/log carries the exact per-run numbers (`chat-perf`).

**Per-token projection measurement (E6a).** `test/ui/chat-perf.test.ts` mounts 500 loaded messages
and emits 20 streamed text deltas: **2002.9 ms total, 100.14 ms/delta** in the phase run and
**5402.3 ms total, 270.11 ms/delta** in the post-crash verification (jsdom full-render worst case;
environment variance). jsdom has no layout, so all 500 rows are patched; this is an upper bound, not
the projection alone. In the browser the window patches 17 rows. The per-token
`threadMessages`/`threadItems` projection is still O(loaded); it remains the deferred follow-up
recorded in design §6 and the plan non-goals rather than being silently dropped.

## Verification

Phase run (before the post-crash continuation, with the concurrent Mermaid stage present):

- `npm run lint` - PASS at the time (1016 files, no fixes).
- `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e` - PASS.
- `npm test` - **4492 passed, 4 skipped** (301 passed / 4 skipped files; 16m43s).
- `npm run build` - PASS (`tsc`, Tailwind, Vite).
- `npm run check:ui` - PASS (96 SFCs, sentinel present; chat chunk 81,824 B gzip).
- `npm run check:sensitive` - PASS.
- `npm run test:e2e` - **157 passed, 1 skipped** (158 total; 9m6s), including the rewritten
  500-message test.
- `CHAT_QA_ONLY="read,diff-adversarial,reasoning" node docs/design/chat-qa.mjs` - PASS, 41
  assertions, 5 screenshots, 0 console/page errors.

Post-crash continuation (current tree):

- `npm run typecheck:ui` - PASS.
- 144 targeted chat UI tests (`chat-anchor`, `chat-window`, `chat-scroll`, `chat-history`,
  `chat-perf`, `chat-page`, `chat-tools`, `chat-message`, `chat-work-group-row`,
  `chat-transcript-window`, `chat-transcript-memory`) - PASS.
- `npx biome check` on every file changed by this stage - PASS.
- `npm run build` - PASS (including the concurrent Mermaid frame build).
- 500-message E2E (`npx playwright test e2e/spa-chat.spec.ts --grep "500-message"`) - PASS:
  `loaded=500 rendered=17 window=495..510 JSHeapUsedSize=16,064 KiB`.
- `CHAT_QA_ONLY="read,diff-adversarial,reasoning" node docs/design/chat-qa.mjs` - PASS, 3
  scenarios, 41 assertions, 5 screenshots, 0 console/page errors; the checked-in report/screenshots
  are from this run.

**Full lint in the current tree:** `npm run lint` reports 14 errors, all in the concurrent in-flight
`0050-mermaid-sandbox` stage's uncommitted files (`test/ui/mermaid-markdown.test.ts`,
`scripts/build-mermaid-frame.mjs`, `scripts/check-ui.mjs`, `src/http/handler.ts`,
`test/http.test.ts`, `ui/chat/mermaid-sandbox.ts`, the skill drawers,
`ui/composables/theme-revision.ts`, `ui/main.ts`). No file changed by this stage is reported. This
stage does not fix or stage the Mermaid stage's files.

### Chat QA blocker

`CHAT_QA_ONLY=diffs` reaches the end of the rewritten lazy-body flow but fails on three stale
assertions for `prt_patch_files` / `prt_patch_string` / `prt_patch_text`. Those fixtures use part
type `patch`, which has been intentionally hidden from the SPA feed since commit `a268ea4`
("hide opencode patch parts in the feed"); the assertions predate that decision and are unrelated
to windowing. With only those three stale checks skipped in a temporary probe, `diffs` passes
**57 assertions**, so the lazy-body changes are verified. The real harness is left unchanged rather
than weakening the stale coverage in this stage. `main` was not added to the targeted run because
of the documented pre-existing feed/composer width assertion. The checked-in report is from the
`read,diff-adversarial,reasoning` run, not the temporary `diffs` probe.

### E2E assertions updated for lazy bodies (not weakened)

- `e2e/chat.spec.ts` live-delta test opens the work group before counting the live tool.
- `e2e/spa-chat.spec.ts` render-session test opens the group, then the bash tool, before the
  reasoning/bash assertions; the edit and oversized tool summaries are reached after the group
  opens.
- `e2e/spa-chat.spec.ts` stream test opens the group and tool before asserting output.
- The composer-grow test now clears its shared history draft; the width test waits for the reloaded
  chat stream before emitting fixtures. Both are baseline test-isolation/race fixes exposed by the
  full gate, not behavior changes.
- `docs/design/chat-qa.mjs` allows `.chat-work-group__body` as the known vertical scroller in the
  two horizontal-overflow checks (it is mounted only after the group opens).

## Accepted limitations

- Browser find-in-page and print see only mounted rows; offscreen history is not searchable or
  printable without scrolling it into the window.
- Full keyboard tab traversal does not reach unmounted history. Focus retention is guaranteed: a
  focused control stays mounted until focus leaves the bounded keep-alive range, then focus moves
  to the scroll container rather than `<body>`.
- Height/detail/scroll memory is in-memory per session; a hard reload starts empty.
- No server, API, schema, auth, permission, or dependency change; the stage is UI-only.

## Index and concurrent-stage note

`docs/design/README.md` and `docs/open-questions.md` carry the in-flight `0050-mermaid-sandbox`
stage's uncommitted changes and were not edited. Add this stage's design-index entry when that
stage lands; this journal is the stage record until then. `docs/plans/README.md` is shared: this
stage commits only its `0051` line and leaves the Mermaid `0050` line unstaged. `src/http/styles.css`
is likewise staged at hunk level (this stage's `.chat-thread__spacer` block only). The stage commit
does not contain any Mermaid-stage file or the unrelated `main-*` chat QA artifacts.

## Not deployed

The stage is committed only (no push, no deployment); rollback is a normal image rollback because
the change is UI-only and the new modules are additive.
