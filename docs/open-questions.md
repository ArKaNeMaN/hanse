# Open questions

> Stage: `0008-chat-diff-highlighting`. Owner decisions were collected on 2026-10-20, before the
> plan was written. There are no open items for this stage.

## Resolved owner decisions

1. **Highlighting depth** - Option B: real syntax highlighting, not only add/remove line coloring.
   Rationale: the owner explicitly rejected the line-color-only variant.
2. **Implementation shape** - vendor PrismJS 1.30.0 as a checked-in same-origin asset and run it in a
   module Web Worker; the main chat module graph must not import Prism or block on it. Rationale:
   Prism tokenization is superlinear on pathological Markdown/markup/Bash and cannot be time-boxed
   in-process; a terminable worker keeps the feed responsive.
3. **`write` view** - render the written content with syntax highlighting, not a synthetic diff. The
   completed `write` metadata has no diff; the transient permission diff is not reliable.
4. **Non-goal change** - the old "no syntax-highlighting library" rule in
   `docs/design/chat-ux-overhaul.md` is superseded by a checked-in vendored asset; no new npm
   runtime dependency and no JS bundler.
5. **Scope** - cover `edit` (standard and OMO hashline), `apply_patch`, `write`, and the legacy
   `patch` part file list. Do not infer diffs from `bash` output or non-existent tools.
6. **Caps and UX** - the 64 KiB per-file / 128 KiB total / 2,000-line / 50-file caps, horizontal
   scrolling, hunk-local highlighting, lazy open-only highlighting, and the worker scheduler are
   technical decisions recorded in the design, not owner forks.
7. **Delivery** - the owner authorized commit, push to `origin/main`, and deployment to `deployment-host` after
   all gates pass.

## Deliberate non-goals

- No `multiedit`, `str_replace`, `create`, or `lsp_rename` support; those tools do not exist in the
  pinned upstream versions.
- No diff for `write` from permission metadata; no server-side rendering or pre-highlighted HTML.
- No content-based language detection or model-provided language hint; path/filename only.
- No new theme files, fonts, copy button, line-wrap toggle, word-level diff, or side-by-side diff.
- No nested per-file disclosures or persistent per-file open state.

Previous stage decisions are recorded in [`docs/journal/0007-web-tools-and-settings.md`](./journal/0007-web-tools-and-settings.md).
