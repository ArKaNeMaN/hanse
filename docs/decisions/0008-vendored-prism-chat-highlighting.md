# ADR-0008: Vendored Prism in a worker for chat diff highlighting

## Status

Accepted (2026-10-20; design review PASS in
[`docs/design/chat-diff-highlighting.md`](../design/chat-diff-highlighting.md)).

## Context

The chat renders tool calls client-side from plain JSON/SSE. Completed `edit` and `apply_patch` parts
carry unified diffs, `write` carries the new file content, and the legacy `patch` part carries only a
file list. Before this stage all of these rendered as plain `<pre>` text. The owner chose real syntax
highlighting (Option B), which supersedes the old "no syntax-highlighting library" non-goal in
[`chat-ux-overhaul.md`](../design/chat-ux-overhaul.md).

The naive approach -- importing a highlighter into `assets/chat.js` and tokenizing on the main
thread -- was rejected: Prism is superlinear on pathological Markdown/markup/Bash (oracle
measurements: ~19.4 s for 64 KiB Markdown `[`, ~3.6 s markup, ~2.2 s Bash), and a synchronous
tokenizer cannot be interrupted. The chat also has a hard no-`innerHTML` rule and no JS bundler.

## Decision

We will:

1. Vendor PrismJS 1.30.0 as a checked-in same-origin ESM asset
   (`assets/vendor/prism/prism-1.30.0.min.js`, MIT, checksum + license + update procedure). No npm
   runtime dependency and no bundler.
2. Run Prism only in a module Web Worker. The main chat module graph imports no Prism, has no
   top-level await, and loads the worker/vendor lazily on the first open diff.
3. Tokenize with `Prism.tokenize` and build the DOM in Hanse code with `textContent`/`createTextNode`;
   never call `Prism.highlight`/`highlightElement` or use `innerHTML`.
4. Highlight only open diffs, with plain-first skeletons, a 250 ms per-stream timeout that terminates
   the worker, language-aware 8/64 KiB stream caps, 1,000-character lines, a 20k token/file and
   120k token/page budget, and a two-timeout/one-language circuit breaker.
5. Use one deterministic diff model for live and hydrated data: 64 KiB per-file / 128 KiB total /
   50 files / 2,000 rendered lines; whole trailing records are dropped for budget, never individual
   patches; `truncated.limit` distinguishes per-file/total/content/patch/output/files.
6. Keep `write` as syntax-highlighted content (the completed tool metadata has no diff), and render a
   legacy `patch` with only `files` as a file list.
7. Cover standard/hashline `edit`, `apply_patch` (add/update/delete/move), `write`, and `patch`;
   exclude `bash` diff detection and tools that do not exist in the pinned upstream versions.

## Consequences

Positive:

- Diffs and written files are scannable with language color, line numbers, and add/delete structure.
- Pathological tokenization cannot freeze the feed; the worker is terminable and falls back to plain.
- The chat remains compatible with the no-bundler, no-`innerHTML`, same-origin/offline deployment.
- Server caps keep one SSE part bounded; hydration and live rendering use the same rules.

Negative / residual:

- Prism 1.30.0 is third-party code that must be refreshed deliberately; provenance and checksum are
  checked in and tested.
- Highlighting is hunk-local: a token that began before a hunk may be mis-colored.
- The page budget can leave some files of a very large patch plain; the text remains readable.
- `write` shows content, not a synthetic diff; a true write diff would need a session-diff fetch.
- The vendored asset is ~84 KiB raw; the initial chat payload only adds the controller and diff model,
  and Prism/worker are fetched on first open.
