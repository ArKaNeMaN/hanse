# Design - Chat diff highlighting

- Status: accepted; Oracle design review **PASS** (2026-10-20). Plan review: `momus` pending.
- Decision state: the owner direction is closed (Option B, real syntax highlighting); the library,
  worker architecture, loading policy, language set, and caps are accepted in this document.
- Design author: maintainers. Design reviewer: `oracle`. Plan reviewer: `momus`.
- Owner decision: **Option B - real syntax highlighting**, not only add/remove line coloring.
- Related: [`chat-ux-overhaul.md`](./chat-ux-overhaul.md) (tool renderers and non-goals),
  [`docs/current-state.md`](../current-state.md), [`docs/process.md`](../process.md).
- Outcome: a decision-complete design for syntax-highlighted unified diffs and syntax-highlighted
  `write` content in chat tool blocks. No implementation code is part of this document.

## 1. Context and problem

The chat workspace is a server-rendered shell whose message/tool DOM is built entirely by
`assets/chat.js`. Tool parts are `<details class="tool-call">` elements
(`assets/chat.js:1969-2009`). `updateToolPart` (`assets/chat.js:2167-2249`) currently reduces every
non-`todowrite`/non-`bash` tool that reaches the generic path to `<pre>` text (the `question` tool is
intercepted earlier by the inline question card), and `updateDetailPart`
(`assets/chat.js:2251-2292`) renders `patch`, `file`, and `reasoning` parts as plain `<pre>` text.
`toolPreview` (`assets/chat.js:1569-1629`) knows `write`/`edit` paths but has no `apply_patch` case,
and `toolOutputText` (`assets/chat.js:1631-1651`) merely selects a string. The result is readable but
not scannable: no language color, no line numbers, no add/remove structure, and no distinction
between a 4-line edit and a 400-line rewrite.

The upstream tools do provide structured diffs (verified against pinned `opencode-ai@1.19.3` and the
OMO plugin in this repository):

| Tool / part | Input | Completed metadata | Client-visible diff |
| --- | --- | --- | --- |
| `edit` (standard) | `{filePath, oldString, newString, replaceAll?}` | `metadata.diff` (unified), `metadata.filediff = {file, patch, additions, deletions}` | Yes |
| `edit` (OMO hashline) | `{filePath, delete?, rename?, edits[]}` | `metadata.diff`, `metadata.filediff = {before, after, additions, deletions, file/path/filePath}` | Yes, via `metadata.diff` |
| `apply_patch` | `{patchText}` | `metadata.diff`, `metadata.files[] = {filePath, relativePath, type, patch, additions, deletions, movePath?}` | Yes, per file |
| `write` | `{filePath, content}` | `{diagnostics, filepath, exists}` - no diff | No; content only |
| `patch` part | - | `{type:"patch", hash, files: string[]}` - no diff text | No |
| `bash` | `{command}` | text output | No structured diff |

`write` has a diff only in the transient permission-request metadata `{filepath, diff}`, not in the
completed message part. Hanse therefore must not promise a diff for `write`; the honest view is the
written content, syntax-highlighted, with the path and line count.

The OMO hashline variant is registered as tool id `edit` only when it is enabled; the extractor keys
off metadata shape, not a distinct tool name. `multiedit`, `str_replace`, `create`, and `lsp_rename`
do not exist in the pinned upstream versions and are out of scope.

The problem is therefore not "make diffs prettier"; it is "render the structured diff sources that
already exist, per file, with a safe tokenizer, while keeping the existing client-rendered chat
architecture and its payload caps".

## 2. Requirements and constraints

### 2.1 Functional requirements

- F1: `edit` (standard and hashline) completed diffs render as unified diff views with file header,
  hunk headers, old/new line numbers, add/delete/context lines, and syntax color.
- F2: `apply_patch` renders every file in a multi-file patch, each with its own path, type
  (add/update/delete/move), additions/deletions, and language; a combined `metadata.diff` is not
  rendered twice.
- F3: `write` renders its `input.content` as syntax-highlighted code with a path header, line count,
  and no `+`/`-` markers.
- F4: A `patch` part with only `files: string[]` renders a file list, not the literal placeholder
  "Patch"; if a legacy `patch`/`text` string exists, it is rendered through the same diff path.
- F5: Unknown/missing paths and unknown extensions fall back to plain text while preserving diff
  structure (line numbers, signs, file headers).
- F6: Live streaming, tool completion, hydration, and idle reconcile all use the same view rules; a
  completed diff does not flash from colored to plain or vice versa.
- F7: Truncation is field-aware and never claims more than the payload contains.
- F8: The existing `<details>` disclosure, `openParts` persistence, summary preview, status chip,
  elapsed time, error auto-open, scroll behavior, and keyboard focus behavior are preserved.

### 2.2 Testable quality-attribute scenarios

- Q1 (bundle/offline/laziness): with no registry or CDN access, the chat page loads everything from
  the same origin. The initial chat payload adds `chat-diff.js` + `chat-highlight.js` (budget
  **<= 88 KiB raw / 24 KiB gzip combined**) but fetches neither Prism nor the worker. The first
  opened diff fetches the worker (`chat-highlight-worker.js`, budget **<= 12 KiB raw / 8 KiB gzip**)
  and then the vendor bundle (**83,861 B raw / 28,169 B gzip** measured). The three new Hanse files
  together are budgeted at **<= 96 KiB raw / 32 KiB gzip**; the vendor figure is separate. The
  required language set is vendored unconditionally; optional languages are the first to drop if the
  vendor budget changes. `asset()` does not compress, so the vendor response is <= 88 KiB raw, or
  ~28 KiB on the wire only when a proxy compresses.
- Q2 (DOM safety): zero Hanse-authored diff/highlight code uses `innerHTML` or `Prism.highlight`;
  `test/chat-page.test.ts` continues to assert that `/assets/chat.js` contains no `innerHTML`
  (`test/chat-page.test.ts:405`), and new asset tests assert the same for `chat-diff.js`,
  `chat-highlight.js`, and `chat-highlight-worker.js`.
- Q3 (bounded work): highlighting runs only in the module worker, only for open diffs, under a
  250 ms per-stream timeout, a 64 KiB code-language / 8 KiB pathological-language stream cap, a
  10,000 token-node per-request cap, a 20,000 per-file aggregate, an all-or-nothing per-file
  reservation (10k/20k), up to 12 stream reservations / 6 two-stream files, a 120,000-node page
  budget, view/page work budgets, and a 2,000 rendered-line cap. If a file's reservation is
  unavailable it renders plain immediately; it does not wait for budget. A timed-out stream renders
  plain; a timed-out worker is terminated. A 200-file patch keeps at most 50 file records in one
  event and on screen (sections 5.3 and 5.4).
- Q4 (payload): after caps, a `message.part.updated` event carrying a diff remains <= 256 KiB,
  including serialized paths, `truncated.fields`/`limit`, and JSON overhead. The deterministic
  fallback is drop output, drop unrendered metadata, then drop whole trailing file records (per-file
  sources) or cap/parse the combined diff at 128 KiB, then `message.part.omitted`.
- Q5 (responsive + focus): at 390 px, `document.documentElement.scrollWidth` equals
  `document.documentElement.clientWidth`; the diff scrolls inside `.tool-diff__scroll`, not the page.
  Focusing that scroller and receiving a streaming update does not move focus.
- Q6 (theme): in dark and light themes, token colors and add/delete line backgrounds are computed
  from existing CSS variables; the same DOM yields different computed colors, and every diff line
  remains distinguishable by its `+`/`-` sign as well as color.
- Q7 (accessibility): line numbers are `aria-hidden`; the scroll container is keyboard-focusable;
  file path and hunk header remain readable text; no new live region is introduced.
- Q8 (adversarial): an 8 KiB stream of pathological Markdown, markup, or Bash (the language cap)
  either tokenizes within the 250 ms budget or is terminated and rendered plain; the feed remains
  responsive and no console/page error is produced.

### 2.3 Binding constraints

- **No JS bundler**: assets are raw checked-in files. The chat page loads `/assets/chat.js` as a
  module (`src/http/chat.ts:371`); `documentPage` supports classic `scripts` and `moduleScripts`
  (`src/http/ui.ts:253-287`).
- **Explicit asset allowlist**: every asset must be added to `ASSETS` in
  `src/http/handler.ts:61-75`; `asset()` reads it with `readFileSync(..., "utf8")`
  (`src/http/handler.ts:197-211`). Docker copies `assets/` recursively (`Dockerfile:9,33`), so a
  vendor subdirectory needs no Docker change.
- **No `innerHTML`** in client renderers; the no-`innerHTML` gate is
  `test/chat-page.test.ts:405`.
- **No CSP today**. The design must not require `unsafe-eval`; no external origins.
- Node.js >= 20 in the repository, but the renderer is browser code; current evergreen browsers are
  the target because the chat is already an ES module with modern syntax. Module workers
  (`new Worker(url, {type:"module"})`) are required; no fallback to a classic worker is needed.
- **No top-level await on the chat module graph.** `chat-highlight.js` must not import Prism and must
  not block `chat.js` startup. Worker creation and Prism loading happen lazily on the first open
  diff, behind a ready timeout. Prism is never fetched at page load.
- **Prism cannot be time-boxed in-process.** The Oracle measurement (~19.4 s for 64 KiB Markdown
  `[`, ~3.6 s markup, ~2.2 s Bash) means a main-thread timeout is impossible; the worker must be
  terminable. This is a binding architectural constraint, not an optimization.
- **Payload caps**: `MAX_PART_STRING_BYTES = 8 KiB` applies to `state.metadata.diff`,
  `filediff.patch`, `files[].patch`, `state.input.content`, and `state.input.patchText` today
  (`src/opencode/events.ts:20-38`, `420-455`). `state.output` gets 64 KiB; the per-part event cap is
  256 KiB (`src/opencode/events.ts:1121-1140`). Hydration through `GET /messages` is not per-field
  capped by these constants (8 MiB response cap), so live and hydrated payloads can differ.
- `assets/` is excluded from Biome (`biome.json`), so the vendored file is not reformatted or linted;
  the application modules still pass the repository gates.
- The old chat UX non-goal at `docs/design/chat-ux-overhaul.md:1865` forbids a syntax-highlighting
  library. The owner's Option B decision supersedes it; section 10 contains the exact proposed edit.

## 3. Decision

### 3.1 Decision

Use a **vendored PrismJS 1.30.0 module bundle**, tokenized in a **module Web Worker**
(`assets/chat-highlight-worker.js`), with a **main-thread controller and DOM renderer**
(`assets/chat-highlight.js`) that never imports Prism. The controller builds a plain skeleton
immediately and requests tokenization only for an opened diff/write view. The worker returns a
compact per-line token plan; the controller creates `span`/text nodes from it. Never call
`Prism.highlight()` or `Prism.highlightElement()`: those produce HTML strings, which would force
`innerHTML` or a parser and reintroduce the exact injection class the chat currently avoids.

The highlighter is shipped as one checked-in ESM file under `assets/vendor/prism/`, ending with
`export default Prism;` so the worker can `import()` it and receive the tokenizer. The worker
pre-sets `globalThis.Prism = { manual: true, disableWorkerMessageHandler: true }` before importing:
`manual` suppresses Prism's DOM auto-scan, and `disableWorkerMessageHandler` stops Prism from adding
its own worker `message` listener, which would try to `JSON.parse` this protocol. The controller
never fetches Prism; there is no npm dependency, no build step, and no external request at runtime.

The worker is the only place Prism runs. It is synchronous inside the worker, so a pathological
grammar can only block the worker; the controller enforces `HIGHLIGHT_TIMEOUT_MS`, calls
`worker.terminate()`, renders plain text, and creates a fresh worker for the next request.


### 3.2 Alternatives

| Option | Bundle / license | Integration | DOM safety | Verdict |
| --- | --- | --- | --- | --- |
| **PrismJS 1.30.0** | 34 minified component files = 83,861 B min / 28,169 B gzip for the language set in 4.3; MIT. | Concatenated ESM default export loaded only by the module worker; no bundler. `Prism.tokenize(text, grammar)` returns a string/Token tree inside the worker. | Hanse renders the returned token plan with `textContent` and `span` classes. `Prism.highlight` exists in the vendored file but is never called. | **Chosen.** Smallest safe tokenizing API with broad language coverage and a permissive license. |
| highlight.js 11.12.0 | Package 5,503,982 B unpacked; BSD-3-Clause. | Browser build, but the public `highlight()`/`highlightAuto()` API returns an HTML string. Integrating safely requires parsing that string into DOM (a new parser/sanitizer) or trusting it. | The string API is the wrong boundary for a no-`innerHTML` client. | Rejected: larger surface and an avoidable HTML trust boundary. |
| Shiki 4.5.0 | Package 602,495 B unpacked, plus Oniguruma WASM/grammars/themes (multi-megabyte client payload depending on languages); MIT. | ESM, async initialization; designed for build-time/server-side highlighting. Browser use needs a bundler or import map and a large asset graph. | Would be safe if tokenized, but the integration cost is high. | Rejected for the client. Server-side pre-highlighting would require a server-rendered message contract and does not fit the client-rendered, streaming chat (section 3.3). |
| Hand-written tokenizer | No dependency; maintenance cost. | Must implement and test 30 grammars, multi-line state (block comments, template strings), and language aliases. | Full control. | Rejected: high long-term cost and poor language coverage for a pre-alpha product. |
| Do nothing (plain `<pre>`) | Zero bytes. | Already implemented. | Safe. | Rejected by the owner's Option B decision. |

The sizes above were measured from `npm pack prismjs@1.30.0`, `highlight.js@11.12.0`, and
`shiki@4.5.0` metadata; they are inputs to the decision, not runtime claims. All options can run
offline/LAN if vendored; the difference is asset weight and initialization. Prism is the smallest
option here whose public browser API returns a token tree, so it can be vendored as an ESM module
used only inside a worker, without either a bundler or an HTML-string trust boundary; Shiki also
tokenizes but its asset graph and async engine make it the heavier client choice.

### 3.3 Why not server-side rendering

The chat feed is built client-side from SSE and hydrated messages; there is no HTML message payload
to decorate. Server-side highlighting would need a new per-part HTML/segments field, a second
rendering path for hydrated messages, and a streaming re-highlight contract. It would also move
untrusted source text into the server renderer, widening the injection surface. The client already
owns the DOM and the caps, so highlighting at render time is the smaller change and preserves the
existing architecture.

### 3.4 Falsifiers

- Prism tokenization on a bounded 8 KiB pathological language input (or a 64 KiB code write) still exceeds the 250 ms worker budget,
  or terminating/recreating the worker causes a visible feed stall -> lower the per-language cap,
  render that language plain by default, or replace Prism; do not move tokenization back to the main
  thread or weaken the timeout.
- The worker cannot be created (module-worker support, CSP, or asset 404) -> the controller renders
  plain skeletons; chat must still start. This is the accepted fallback, not a blocker.
- The vendored bundle exceeds 88 KiB raw or 40 KiB gzip after a required language is added -> drop
  optional languages first (the extras in 4.3), never the required set.
- A required upstream tool shape differs from the table in section 1 -> resolve it in the extractor
  and add a fixture before shipping; do not guess a field.
- Browser QA shows focus loss, scroll jump, or page overflow at 390 px -> fix the DOM/CSS or defer the
  feature; do not accept a regression in the existing tool disclosure.
- The license/notice cannot be reproduced in the vendored file -> do not vendor it.

### 3.5 Decision record

A decision record is warranted because this supersedes a recorded non-goal, locks a third-party
vendor and loading policy, and defines a security boundary. Recommended:
`docs/decisions/0008-vendored-prism-chat-highlighting.md` with Status/Context/Decision/Consequences,
recording Prism 1.30.0, the rejected alternatives, the module-worker/lazy policy, the no-`innerHTML`
rule, and the caps.

## 4. Architecture

### 4.1 Modules, worker, and loading order

New client modules:

| File | Runs in | Responsibility | Prism? |
| --- | --- | --- | --- |
| `assets/chat-diff.js` | Main thread | Pure language resolver, payload extraction, unified-diff parser, view models, one shared budget allocator, display truncation model. No DOM, no Prism. | No |
| `assets/chat-highlight.js` | Main thread | Lazy worker controller with a per-file scheduler, reservations, aggregate work/timeouts, plain skeleton builder, token-plan-to-DOM renderer, focus/scroll preservation. | No |
| `assets/chat-highlight-worker.js` | Worker | Loads the vendored Prism bundle, validates the language allowlist, tokenizes a stream, flattens to a compact line plan, enforces worker-side caps. | Yes |
| `assets/vendor/prism/prism-1.30.0.min.js` | Worker import | Checked-in Prism core + vendored components (section 4.2), ESM default export. | - |

`assets/chat.js` statically imports the pure view builders from `./chat-diff.js` and the controller
from `./chat-highlight.js`. Neither module awaits Prism or a worker at import time, so `chat.js`
starts exactly as today. The worker file is not fetched until the first open diff needs
highlighting; the vendor file is not fetched until the worker starts. The worker installs
`self.onmessage` synchronously at module top and does its dynamic import inside the `init` handler;
there is no top-level await in the worker either, so there is no init-before-handler race or
deadlock.

Loading sequence:

1. `chat.js` starts; the controller module defines functions and constants only. No Prism, no
   worker, no top-level await.
2. On the first diff/write view whose outer `<details>` is open (including a restored `openParts`
   part; errors are NOT eligible), the controller calls `ensureWorker()`.
3. `ensureWorker()` owns a single current worker: it creates
   `new Worker(new URL("./chat-highlight-worker.js", import.meta.url), {type:"module"})` on first
   need and replaces it after a timeout/circuit-breaker decision. It posts `{type:"init"}` only after
   `onmessage` is attached; the worker installs its handler synchronously, imports the vendor bundle
   in the init handler, and posts `{type:"ready"}`.
4. The controller queues **files**, not requests, until `ready`. Before any stream starts, a file
   reserves `S x MAX_TOKEN_NODES_PER_REQUEST` (10,000 for one stream, 20,000 for two). At most
   `MAX_INFLIGHT_HIGHLIGHT_STREAMS` (12) stream reservations (120,000 nodes) are outstanding. If the
   reservation is unavailable, the file renders plain immediately; it does not wait for budget.
   `MAX_PENDING_HIGHLIGHT_FILES` (50) is only the worker-ready admission queue. On load failure/
   timeout, terminate, mark highlighting disabled for the page, and leave every view in plain mode;
   chat continues.
5. Each request has `HIGHLIGHT_TIMEOUT_MS` (250 ms) and each view/page has an aggregate work budget.
   On timeout, terminate the worker, mark that **file** plain, and create a fresh worker for
   subsequent work unless the language has hit `MAX_TIMEOUTS_PER_LANGUAGE` (2) or the view/page work
   budget is exhausted; then remaining files of that language/view render plain. Worker recreation
   re-imports and re-parses the 84 KiB bundle, which is why the breaker exists.

`documentPage` and the chat page stay unchanged: `moduleScripts: ["/assets/chat.js"]`
(`src/http/chat.ts:371`). No `scripts` array is added. The worker URL is same-origin and fixed; it is
derived from `import.meta.url`, not from agent input.

Asset allowlist additions in `src/http/handler.ts:61-75`:

- `/assets/chat-diff.js` -> `chat-diff.js`, `text/javascript; charset=utf-8`
- `/assets/chat-highlight.js` -> `chat-highlight.js`, `text/javascript; charset=utf-8`
- `/assets/chat-highlight-worker.js` -> `chat-highlight-worker.js`,
  `text/javascript; charset=utf-8`
- `/assets/vendor/prism/prism-1.30.0.min.js` ->
  `vendor/prism/prism-1.30.0.min.js`, `text/javascript; charset=utf-8`

`asset()` joins `entry.file` under `HANSE_ASSETS`, so a subdirectory works without changing the
reader (`src/http/handler.ts:197-211`). `docs/current-state.md:309` must list the new paths. The
worker import resolves `/assets/vendor/prism/...` relative to the worker URL, so the allowlist entry
is mandatory and covered by an asset test.


### 4.2 Vendored asset layout, version, license, checksum, and update procedure

```
assets/vendor/prism/
  LICENSE                       # full MIT text, copyright Lea Verou
  VERSION                       # PrismJS 1.30.0
  SHA256SUMS                    # sha256 of prism-1.30.0.min.js
  prism-1.30.0.min.js           # concatenated minified components
```

`prism-1.30.0.min.js` starts with a license header and ends with `export default Prism;`:

```
/*! PrismJS 1.30.0 | MIT | https://prismjs.com | generated from npm prismjs@1.30.0
    components: core, markup, css, clike, javascript, markup-templating, typescript,
    jsx, tsx, json, yaml, bash, markdown, python, go, rust, sql, docker, diff,
    toml, ini, java, c, cpp, csharp, ruby, php, kotlin, swift, scala, lua,
    makefile, graphql, powershell */
... minified components ...
export default Prism;
```

The `export default Prism;` footer is required by this design's worker import contract, not optional:
the core declares `Prism` with `var` at module scope; its `_self.Prism` assignment is an
implementation detail that varies with the global shape (window/worker/Node). The explicit default
export gives the worker a deterministic binding and is what the Oracle review confirmed. The file is
therefore ESM-only and must not be loaded as a classic script.

Component order is dependency order and must not change:

`prism-core, prism-markup, prism-css, prism-clike, prism-javascript,
prism-markup-templating, prism-typescript, prism-jsx, prism-tsx, prism-json, prism-yaml,
prism-bash, prism-markdown, prism-python, prism-go, prism-rust, prism-sql, prism-docker,
prism-diff, prism-toml, prism-ini, prism-java, prism-c, prism-cpp, prism-csharp, prism-ruby,
prism-php, prism-kotlin, prism-swift, prism-scala, prism-lua, prism-makefile, prism-graphql,
prism-powershell`.

Concatenation is a one-time vendoring step, not a product build step: the repository still ships raw
checked-in assets, `npm run build` does not touch this file, and there is no runtime bundler.

The upstream tarball is `https://registry.npmjs.org/prismjs/-/prismjs-1.30.0.tgz` with npm integrity
`sha512-DEvV2ZF2r2/63V+tK8hQvrR2ZGn10srHbXviTlcv7Kpzw8jWiNTqbVgjO3IY8RxrrOUF8VPMQQFysYYYv0YZxw==`.
Measured on 2026-10-20 from that tarball: **45,517 B minified** for the required set and
**83,861 B minified / 28,169 B gzip** for the full set above (before the license header). The final
file's checksum is generated at vendoring time and recorded in `SHA256SUMS`; a test recomputes it.

Update procedure (documented in the vendor `README` or in this design's implementation plan):

1. `npm pack prismjs@<version>`; verify `npm view prismjs@<version> dist.integrity` matches the
   tarball before extracting. Never vendor a tarball from a URL that is not the registry.
2. Extract; confirm every file in the component list exists at
   `package/components/prism-<name>.min.js` and that the dependency order above is unchanged.
3. Concatenate in order, prepend the license header, append `export default Prism;`, write
   `prism-<version>.min.js`.
4. Run `sha256sum` and write `SHA256SUMS`; update `VERSION` and the versioned allowlist path in
   `src/http/handler.ts` and the dynamic import in `assets/chat-highlight-worker.js`.
5. Run `npm test` (checksum and asset tests), `npm run build`, and
   `node docs/design/chat-qa.mjs` (see the Playwright note in section 7.4).
6. Keep `LICENSE` verbatim. No `package.json` entry is added; Prism is not a runtime npm dependency.

### 4.3 Language resolver

`assets/chat-diff.js` exports a pure resolver. It never accepts a language from the payload; only
the path/filename is used.

Algorithm:

1. Take the last path segment after `/` and `\`; strip a trailing query/hash. Do not resolve URLs.
2. Compare the basename against the special-filename table first (case-sensitive where noted; treat
   `dockerfile` and `containerfile` case-insensitively).
3. Otherwise lowercase the basename, take the longest matching extension, and return the canonical
   Prism language ID.
4. If no rule matches, or the resolved ID is not in the vendored set, return `null` (plain text).
5. For `apply_patch`, resolve independently for each file, never once for the patch.
6. Aliases (`ts`, `js`, `sh`, `shell`, `yml`, `html`, `xml`, `svg`, `dockerfile`, `patch`) exist only
   as documentation/Prism aliases; the resolver returns the canonical ID in this table.

| Path pattern (basename, lowercased unless noted) | Canonical ID |
| --- | --- |
| `*.js`, `*.mjs`, `*.cjs` | `javascript` |
| `*.jsx` | `jsx` |
| `*.ts`, `*.mts`, `*.cts`, `*.d.ts` | `typescript` |
| `*.tsx` | `tsx` |
| `*.json`, `*.jsonc`, `*.json5`, `*.jsonl`, `*.ndjson` | `json` |
| `*.yaml`, `*.yml` | `yaml` |
| `*.sh`, `*.bash`, `*.zsh`, `*.ksh`, `.env`, `.env.*` | `bash` |
| `*.md`, `*.markdown`, `*.mdx`, `README` (exact) | `markdown` |
| `*.css` | `css` |
| `*.html`, `*.htm`, `*.xhtml`, `*.xml`, `*.svg` | `markup` |
| `*.py`, `*.pyw`, `*.pyi` | `python` |
| `*.go` | `go` |
| `*.rs` | `rust` |
| `*.sql` | `sql` |
| `Dockerfile`, `Containerfile`, `Dockerfile.*` (exact prefix), `*.dockerfile` | `docker` |
| `*.diff`, `*.patch` | `diff` |
| `*.toml` | `toml` |
| `*.ini`, `*.cfg`, `*.conf`, `*.properties`, `.editorconfig`, `.gitconfig`, `.gitmodules`, `.npmrc`, `.yarnrc` | `ini` |
| `*.java` | `java` |
| `*.c`, `*.h` | `c` |
| `*.cpp`, `*.cc`, `*.cxx`, `*.hpp`, `*.hh`, `*.hxx` | `cpp` |
| `*.cs`, `*.csx` | `csharp` |
| `*.rb`, `*.rake`, `*.gemspec`, `Rakefile`, `Gemfile`, `Podfile` | `ruby` |
| `*.php` | `php` |
| `*.kt`, `*.kts` | `kotlin` |
| `*.swift` | `swift` |
| `*.scala`, `*.sc` | `scala` |
| `*.lua` | `lua` |
| `Makefile`, `GNUmakefile`, `makefile`, `*.mk`, `*.mak` | `makefile` |
| `*.graphql`, `*.graphqls`, `*.gql` | `graphql` |
| `*.ps1`, `*.psm1`, `*.psd1` | `powershell` |

Everything else is plain text, including extensionless files other than the exact names above,
`LICENSE`, `package-lock.json` (it is JSON but too large/low-value; it still resolves as `json` by
extension if passed), `go.mod`/`go.sum`, `requirements.txt`, `.lock` files, CSV/TSV, and binary paths.

Vendored canonical IDs (also the allowlist for `Prism.languages[...]`):

- **Required:** `javascript`, `typescript`, `jsx`, `tsx`, `json`, `yaml`, `bash`, `markdown`, `css`,
  `markup`, `python`, `go`, `rust`, `sql`, `docker`, `diff`.
- **Optional (drop first if the bundle budget changes):** `toml`, `ini`, `java`, `c`, `cpp`,
  `csharp`, `ruby`, `php`, `kotlin`, `swift`, `scala`, `lua`, `makefile`, `graphql`, `powershell`.

`clike` and `markup-templating` are vendored dependencies, not resolver targets. A raw vendor-size
assertion is part of the tests; gzip is a documented QA measurement because the repository has no
compression harness.

Documented imperfections: `.mdx` is highlighted as Markdown (embedded JSX is not parsed), `.jsonc`
as JSON (comments are not a Prism JSON token), `.zsh` as Bash (zsh-only syntax may be plain), `*.h`
as C (a C++ header may be mis-tokenized), and `.vue`/`.svelte` are plain (no components vendored).
These are presentation-only and never affect the underlying text.

The resolver also selects the per-stream highlight cap (section 4.6): `markdown`, `markup`, and
`bash` use **8 KiB**; every other resolved language uses **64 KiB** (including `write` content). The
Oracle measurement is the reason for the stricter three: those grammars are the measured superlinear
cases. Unknown/plain views never call the worker.

### 4.4 Payload extraction

`assets/chat-diff.js` builds a view model from the part data, never from DOM. The precedence is
deterministic and mirrors the server de-duplication in section 5.2.

| Source | Precedence | Fallback |
| --- | --- | --- |
| `edit` (standard) | `metadata.filediff.patch` (when `filediff.file`/`path`/`filePath` is usable) > `metadata.diff` | No diff -> `state.output`/`state.error` in the existing `<pre>`; do not synthesize a diff from `oldString`/`newString`. |
| `edit` (hashline) | `metadata.filediff.patch` (if present) > `metadata.diff` | `filediff.before`/`after` are not a diff and are dropped server-side; fall back to output. |
| `apply_patch` | `metadata.files[]` when every record has a non-empty `patch` > `metadata.diff` (parsed as multi-file) > `metadata.files[]` when at least one record has a patch (partial per-file view) > `metadata.files[]` headers only | While running with no metadata diff, `input.patchText` is shown as a plain `<pre>` ("Patch being prepared"), not parsed as a unified diff. |
| `write` | `input.content` (completed or running) | Path from `input.filePath` > `metadata.filepath`; if content is absent, `state.output`/error in `<pre>`. |
| `patch` part | `data.patch` string > `data.files` string list > `data.text` string | "No patch body" only when none exists; never assume a diff. |
| `bash` | Existing output path only. | No diff detection from `git diff` output. |

`apply_patch` per-file patches are unified diffs: upstream builds `files[].patch` from
`trimDiff(createTwoFilesPatch(...))`, so the parser can consume them directly; `defaultPath` from
`relativePath` covers a per-file patch whose headers are absent. `state.input.patchText` is the
custom `*** Begin Patch` format, not a unified diff, and is shown as plain text only.

`apply_patch` metadata is authoritative for type, paths, and counts. Add/delete patches use the same
path on both `---`/`+++` (there is no `/dev/null`), and moves carry `relativePath`/`movePath`.
Therefore a per-file parse receives
`{defaultPath, type, oldPath, newPath, additions, deletions}` and metadata wins over inferred
`/dev/null`, rename headers, or parsed counts. The client also merges a metadata record whose patch
was omitted as header-only, so add/delete/move headers survive truncation.

OMO hashline: `rename` has `input.filePath` as the old path and
`metadata.filediff.file`/`path`/`filePath` as the new path, with `type: "move"`; pass those to the
parser when rendering `metadata.diff`. `delete` has no `metadata.diff`; fall back to
`state.output`/error, never synthesize a deletion diff. `filediff.before`/`after` are full-file
duplicates and are dropped by the server (section 5.2); the client does not render them.

Create inference:

- `write`: `metadata.exists === false` -> `add`; `true` -> `update`; absent -> `update` for the
  header only (the content is still shown).
- `edit`: `add` only when the patch (`metadata.diff`/`filediff.patch`) contains `--- /dev/null` or
  `new file mode`; otherwise `update`. Do not infer `add` from a missing `oldString`.

Path resolution for language and header:

- `edit`: `input.filePath` > `input.path` > `filediff.file` > `filediff.path` > `filediff.filePath`
  > `state.title`.
- `apply_patch`: per record `relativePath` > `movePath` for a move > `filePath`; for a parsed combined diff,
  `+++ b/...` > `--- a/...` > `Index: ...`; for a single-file diff with no headers, `input.filePath`
  > `state.title`.
- `write`: `input.filePath` > `input.path` > `metadata.filepath` > `state.title`.
- `patch` part file list: each `data.files` string, capped by `MAX_DIFF_FILES` and
  `MAX_DIFF_PATH_BYTES` (section 5.1).
- Missing path: header text `Changed file` (or `File N`), language `null`, diff structure still
  rendered.

`state.title`, `input.filePath`, and `data.files` strings are subject to `MAX_DIFF_PATH_BYTES` too;
they are display-only and never used for resolution beyond the basename/extension. Resolve the
language from the **uncapped** basename first, then cap the displayed path; never cap before
resolution, or an extension at the end of a long path would be lost.

`write` line count is exact for the displayed (possibly clipped) content: count the
newline-separated segments and do not count a single trailing newline; empty content is zero lines.
It renders `1 line` / `N lines`; empty content renders `Empty file` and no line rows. The header also
shows the language label when one was resolved.

`write` deliberately does **not** consume permission-request metadata. That metadata is transient,
may be auto-approved or dismissed, and is not guaranteed to be present in the message part. Showing
it would create a diff view that disappears or disagrees with the completed part. The owner's
decision is satisfied by highlighting the written content.

`toolPreview` (`assets/chat.js:1569-1629`) gains an `apply_patch` case: the first file path from
`metadata.files[0].relativePath`/`filePath`, else the first `*** (Add|Update|Delete) File:` or
`*** Move to:` line in `input.patchText`, else `state.title`; when more than one file exists, append
`· N files` before the 120-character cut. `write`/`edit` previews gain metadata path fallbacks in the
same order as above. `detailPreview` for a `patch` part uses `data.title` and then the first
`data.files` string; the file-list body remains the detail.

### 4.5 Unified diff parser

`parseUnifiedDiff(text, options)` is pure and returns:

- `files: DiffFile[]`, each `{path, oldPath, newPath, type, language, additions, deletions,
  statsPartial, binary, headerOnly, truncated, hunks}`;
- `truncated` if the source ended mid-hunk or counts did not match;
- `filesTruncated` when `MAX_DIFF_FILES` stopped parsing further file sections;
- `raw: true` when no recognizable file/hunk was found, so the caller can render the original text
  in a plain `<pre>` rather than losing it.

Options: `{defaultPath, type, oldPath, newPath, additions, deletions, maxFiles}`. They are supplied
per `apply_patch` file record or per `edit` source. Explicit metadata wins over inference:
`type` (add/update/delete/move), `oldPath`/`newPath` (including hashline rename and `apply_patch`
move), and `additions`/`deletions`. `defaultPath` is used only when a hunk/file has no path.
`maxFiles` defaults to `MAX_DIFF_FILES` (50) and is applied to **every** source, including a
combined `metadata.diff`.

`DiffFile.type` is `add | update | delete | move | binary | unknown`. Without metadata, `/dev/null`,
`new file mode`, `deleted file mode`, and `rename from/to` infer it. `hunks` are
`{header, oldStart, oldCount, newStart, newCount, lines}`; lines are
`{kind: "context" | "add" | "del" | "meta", text, oldNumber, newNumber}`.

Parser rules:

1. Normalize CRLF to LF; split on `\n`; drop one trailing empty line.
2. A `diff --git ...` line starts a file. Prefer the following `---`/`+++` pair for paths; a
   `diff --git` line alone does not lose the file.
3. `Index: <path>` and a following `====...` separator are recognized and ignored as body text.
   `Index:` is retained as a path fallback when `---`/`+++` are absent (this is the shape emitted by
   `createTwoFilesPatch`). A real upstream-shaped `Index:`/`====`/`---`/`+++`/`@@` patch is a
   required test fixture.
4. `--- <path>` / `+++ <path>` outside a hunk starts or completes a file. `/dev/null` means
   add/delete. Strip a leading `a/` or `b/`, a tab plus any timestamp that follows the path, and
   surrounding double quotes; do not execute or URL-decode the path.
5. `@@ -old[,count] +new[,count] @@ section` starts a hunk. Missing counts default to 1; `0` is
   valid. Section text is kept in the hunk header.
6. Inside a hunk, `' '` is context, `'+'` is add, `'-'` is delete, `'\'` is the
   "No newline at end of file" meta line. A bare empty line is treated as context while the hunk's
   declared counts still require lines (some generators omit the leading space); otherwise it ends
   the hunk. A line with any other prefix ends the hunk, marks the file `truncated`, and is rendered
   as a meta line (never dropped silently).
7. Line numbers start at the hunk header and advance per kind: context advances both; add advances
   new; delete advances old; meta advances neither. A start of 0 yields a blank number for that side.
8. **Hunk termination and trailing meta:** when the declared old/new counts are reached, do not end
   the hunk immediately. Consume every following `'\'` meta line into the current hunk first. A new
   `@@` header or file header (`diff --git`, `Index:`, `---`/`+++`) ends the hunk normally. A
   `+`/`-`/context line after the declared counts is an **extra line**: end the hunk and mark the file
   `truncated`; do not silently ignore it. Any other non-meta line also ends the hunk and marks the
   file `truncated`. The real `createTwoFilesPatch` shape
   `-a\n\ No newline at end of file\n+b\n\ No newline at end of file` therefore keeps both meta
   lines attached. If the counts are not reached at end of input, `truncated = true`.
9. Metadata lines outside hunks (`index`, modes, `similarity index`, `rename from/to`, `new file
   mode`, `deleted file mode`, `===...`) are not rendered as body text. `rename from/to` and
   `movePath` populate `oldPath`/`newPath`; explicit metadata overrides them.
10. `Binary files ... differ` and `GIT binary patch` mark the file `binary` and `headerOnly`; base64
    payload lines are skipped, not tokenized.
11. A file with headers but no hunks is `headerOnly`; it renders its header plus "No textual
    changes" (or "Binary file changed").
12. If `defaultPath` is supplied and a hunk/header has no path, use it. If no file was recognized,
    return `raw: true`.
13. Stop after `maxFiles` file sections; set `filesTruncated = true`. This bounds both combined
    diffs and per-file sources before the budget allocator runs.

Additions/deletions use metadata counts when provided; otherwise they count parsed add/delete lines
and set `statsPartial = true` when the file is truncated or `filesTruncated` cut later sections. The
parser is tolerant, not a patch applier: it never reads the working tree and never asserts that the
patch is valid.

### 4.6 Worker tokenization and mapping onto diff lines

Tokenization is per file and per hunk side, not per character and not per isolated line. All Prism
work happens in `assets/chat-highlight-worker.js`; the main thread never imports Prism.

#### Worker protocol

- The worker installs `self.onmessage` synchronously at module top. On `{type:"init"}` it sets
  `globalThis.Prism = { manual: true, disableWorkerMessageHandler: true }`, dynamically imports
  `./vendor/prism/prism-1.30.0.min.js` in that handler, and posts `{type:"ready"}`. There is no
  top-level await in the worker, so there is no init-before-handler race or deadlock. The import must
  resolve the bundle's `export default Prism;`.
- Requests are `{type:"tokenize", jobID, streamID, text, language}`. The worker accepts only the
  canonical language IDs in section 4.3 and re-checks `Prism.languages[language]`; a payload-supplied
  language is never trusted.
- Success is `{type:"tokens", jobID, streamID, lines, tokenNodes}`, where `lines` is
  `Array<Array<[text, types[]]>>` (one entry per source line) and `tokenNodes` is the number of
  created token spans. No HTML is returned.
- `{type:"plain", jobID, streamID, reason}` is returned for an unknown language, a stream over the
  cap, a line over `MAX_HIGHLIGHT_LINE_CHARS`, or `tokenNodes > MAX_TOKEN_NODES_PER_REQUEST`
  (10,000).
- `{type:"error", jobID, streamID, reason}` is returned for an internal failure. The controller
  renders the affected file plain and does not retry it in the same view.

The controller uses an **all-or-nothing per-file scheduler with reservation accounting**, not a
per-stream or per-request rejection queue. A job carries `{jobID, partID, viewKey, fileIndex,
streamID, generation}`. A file has S streams (one for `write`, two for a diff with both sides). Before
any stream starts, the file must reserve `S x MAX_TOKEN_NODES_PER_REQUEST` (10,000 for one stream,
20,000 for two) from the page budget; at most `MAX_INFLIGHT_HIGHLIGHT_STREAMS` (12) stream reservations
(120,000 nodes) are outstanding. Only open/visible parts submit files; a closed part has no job and no
reservation.

- If the full `S x 10,000` reservation is unavailable, the file renders plain with
  `data-highlight="budget"` **immediately**. It never starts partially and never waits indefinitely for
  budget. Closing another view frees budget; a later reopen can retry.
- `MAX_PENDING_HIGHLIGHT_FILES` (50, equal to `MAX_DIFF_FILES`) is only the admission queue for files
  that already hold a reservation and are waiting for the worker to become ready; it is not a budget
  waitlist. If it is full, new files render plain with `data-highlight="budget"`.
- On completion, replace the file's reservation with its actual `tokenNodes` (release the difference).
  If a stream exceeds 10,000, or the file's aggregate actual tokens exceed 20,000, discard the whole
  file's plan and render plain, then release the reservation.
- Closing/removing a view releases its reservation immediately and drops its queued work. A response
  whose `jobID`/`viewKey` is stale is dropped and its reservation released; the token count is never
  committed.

There is therefore no fragmentation and no partial file: either all of a file's streams are admitted
at once, or the file is plain. A 50-file diff highlights the files whose reservations fit the page
budget; the rest are plainly rendered immediately, and closing a highlighted file lets a later reopen
retry. A view/page whose work budget is exhausted renders its remaining files plain.

Aggregate limits:

- `HIGHLIGHT_TIMEOUT_MS` (250 ms) per request; `WORKER_READY_TIMEOUT_MS` (2,000 ms) for worker startup.
- `MAX_HIGHLIGHT_VIEW_WORK_MS` (1,000 ms) and `MAX_HIGHLIGHT_PAGE_WORK_MS` (3,000 ms) measure active
  worker time (request start to response/timeout), not queue waiting. Once a view/page budget is
  exhausted, the controller aborts that file's remaining stream requests and renders the file plain,
  then renders its remaining files plain.
- `MAX_TIMEOUTS_PER_LANGUAGE` (2). After two timeouts for a language in a view, remaining files of
  that language in that view render plain; a timeout also aborts the current file's remaining streams.
  A timeout terminates the worker and recreates it for subsequent work only if the breaker has not
  tripped; recreation re-imports and re-parses the 84 KiB bundle, so retrying a pathological language
  would only add latency.
- On `WORKER_READY_TIMEOUT_MS` or worker `error` during init, terminate, set
  `highlightingDisabled = true` for the page, and render everything plain. A caught
  `{type:"error"}` renders only the affected file plain and releases its reservations. An uncaught
  worker `error`/`messageerror` at runtime fails every in-flight request plain, terminates the worker,
  and disables highlighting for the page (no runtime retry; this avoids repeated 2 s reloads). No
  queued request is left pending.

#### Mapping

1. Iterate the hunk lines in their original order. Append context and add lines to the **new-side**
   stream; append context and delete lines to the **old-side** stream. Do **not** group all context
   before adds/deletes: interleaving is what preserves multi-line token state. Each stream joins line
   text with `\n`; marker lines and line numbers are excluded. Keep an explicit index map from each
   stream line to its diff line.
2. Send each stream once as a worker request. This preserves multi-line tokens (block comments,
   template literals, here-docs) within the hunk.
3. The worker flattens the token tree iteratively (explicit stack, no recursion) into
   `{text, types: string[]}` leaves. A leaf's types are the stack of enclosing token types plus
   `token.alias` when present (string or array; aliases normalize and sanitize like types).
4. **Line split rule (off-by-one safe):** start at line 0. For each leaf, scan its text: append the
   segment before a `\n` to the current line (including an empty segment), then increment the line
   index for that `\n` and continue after it. Never increment before appending. A trailing `\n`
   therefore produces a final empty line, which maps only if the diff has a corresponding empty
   line; an empty line in the middle is a zero-length segment but still advances the index. The
   stream's line count must equal the number of context+add (new side) or context+delete (old side)
   lines; otherwise the controller renders that side plain. Tests cover multi-line block comments,
   template literals, leading/trailing empty lines, and a line containing only a newline.
5. Render context and add lines from the **new-side** plan; render delete lines from the
   **old-side** plan. A context line is tokenized twice (once per side) but only the new-side tokens
   are displayed. This keeps deletions from changing the highlighting of the new file.
6. If a hunk starts inside a multi-line construct that began before the hunk, Prism cannot know the
   earlier state. Highlighting is **hunk-local**; such lines may be plain or mis-colored, but the
   text is never changed. This limitation is documented and tested.
7. For `write`, send the whole content once and map the same way to its line containers.
8. For the `diff` language inside a unified diff, use plain text for hunk lines (the diff structure
   already supplies the signs); `diff` is still used for a `write` of a `.diff`/`.patch` file.

#### Caps, budgets, and fallback

- `MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT = 64 KiB` for code languages, so a 64 KiB `write` is admitted;
  `markdown`, `markup`, and `bash` use **8 KiB**. `MAX_HIGHLIGHT_WRITE_BYTES = 64 KiB` documents the
  write case explicitly. The controller checks the byte cap before posting and the worker re-checks
  it. Over the cap -> plain.
- The 64 KiB byte gate does not override the token-node gate: a 64 KiB write that produces more than
  10,000 tokens in its single stream (or more than 20,000 aggregate, impossible for one stream)
  renders plain. A representative 64 KiB code write under the token budget must highlight; a
  pathological one may not.
- `MAX_HIGHLIGHT_LINE_CHARS = 1,000`: a 1,024-character line is rejected; over the limit -> plain for
  that stream. This is a cheap pre-check, not the primary defense; the worker timeout is.
- `MAX_TOKEN_NODES_PER_REQUEST = 10,000`; `MAX_TOKEN_NODES_PER_FILE = 20,000`;
  `MAX_INFLIGHT_HIGHLIGHT_STREAMS = 12`; `MAX_PENDING_HIGHLIGHT_FILES = 50`;
  `MAX_PAGE_TOKEN_NODES = 120,000`; `HIGHLIGHT_TIMEOUT_MS = 250`;
  `WORKER_READY_TIMEOUT_MS = 2,000`; `MAX_HIGHLIGHT_VIEW_WORK_MS = 1,000`;
  `MAX_HIGHLIGHT_PAGE_WORK_MS = 3,000`; `MAX_TIMEOUTS_PER_LANGUAGE = 2`.
- The scheduler reserves `S x 10,000` nodes per in-flight file (10k/20k) and releases the unused
  difference on completion. There is no projected-total rejection, no partial-file start, and no
  per-request queue of 24. If a file's reservation is unavailable, it renders plain immediately;
  `MAX_PENDING_HIGHLIGHT_FILES` is only the worker-ready admission queue, not a budget waitlist.
- If `Prism.tokenize` throws, the language is missing, the worker failed to load, a timeout fired, or
  the breaker tripped, render plain lines.
- A token type is used as a CSS class only if it matches `/^[a-z0-9-]+$/`; the `token` class is always
  added. Token types come from vendored grammars, never from agent text.
- Plain fallback still renders file header, hunk header, line numbers, and signs; only color is lost.

### 4.7 DOM structure, classes, and accessibility

The outer `<details class="tool-call">` and its summary are unchanged. The body is one of:

```
.tool-diff
  .tool-diff__scroll            (tabindex=0, overflow)
    .tool-diff__file
      .tool-diff__head          (path, type, +N/-N)
      .tool-diff__hunks
        .tool-diff__hunk
          .tool-diff__hunk-head
          .diff-line[data-kind=...]
            .diff-line__num         (old, aria-hidden)
            .diff-line__num         (new, aria-hidden)
            .diff-line__sign        (+ / - / space)
            .diff-line__code        (text or .token spans)
```

For `write`:

```
.tool-code
  .tool-code__head              (path, "N lines", language)
  .tool-code__scroll            (tabindex=0, overflow)
    .code-line
      .code-line__num           (aria-hidden)
      .code-line__code          (text or .token spans)
```

Rules:

- **Skeleton first:** every diff/write body is rendered synchronously as plain text with file/hunk
  headers, line numbers, signs, and text nodes. The body carries
  `data-highlight="pending"` until the worker responds, then `"tokens"`, `"plain"`, `"budget"`, or
  `"error"`. Highlighting never gates the first paint.
- **Stable scroll container:** `ensureToolBody` reuses the existing `.tool-diff__scroll` /
  `.tool-code__scroll` element and replaces only its descendants when the token plan arrives. The
  focusable element is therefore not recreated on a streaming update; scrollTop/scrollLeft are
  restored, and focus is preserved if it was inside the body. If the body kind itself changes
  (diff -> pre/omitted), focus moves to the new scroll container or the summary.
- All path, hunk, sign, and code text is created with `document.createTextNode`/`textContent`.
  There is no `innerHTML`, no `insertAdjacentHTML`, and no HTML string from Prism.
- File headers show the path (ellipsis with a `title` carrying the same capped path), type label
  (`Added`, `Updated`, `Deleted`, `Moved`, `Binary`), and `+N`/`-N` counts when known. A move shows
  `old -> new`.
- Line numbers are `aria-hidden="true"` and `font-variant-numeric: tabular-nums`; the sign is visible
  text so the add/delete meaning is not color-only.
- The scroll container has `tabindex="0"` for keyboard horizontal/vertical scrolling, with
  `aria-label="Diff for <path>, scrollable"` (or `"Written content for <path>, scrollable"`). It uses
  `overscroll-behavior: contain` so the feed does not scroll when the diff ends.
- Token classes are scoped to the diff/code containers (`.tool-diff .token`,
  `.tool-code .token`) so Prism class names cannot affect other chat prose.
- Multi-file diffs render one section per file, all inside the single outer disclosure. Nested
  per-file `<details>` are deliberately not used: streaming re-renders would reset their open state,
  and the existing `openParts` key is per part, not per file. The outer disclosure is the only
  collapsibility control.
- Errors keep the existing behavior: `status === "error"` renders the error in the existing `<pre>`
  and auto-opens; a diff is not shown instead of an error.
- Diagnostics are a footer inside the diff/write body: strip the known first line
  (`Edit applied successfully.` / `Wrote file successfully.`) from `state.output`; if text remains,
  render it in `.tool-diff__diagnostics` (mono, muted, capped). No diagnostics means no footer.
- The `patch` part with only `files: string[]` renders `.tool-diff[data-mode="files"]` with a
  `.tool-diff__file-list` of paths; this replaces the current "Patch" placeholder.
- `part.omitted` suppresses the normal body entirely; only the omitted notice is rendered (section
  5.5). It must not fall through to "No output".

### 4.8 Integration points, lazy open-only highlighting, and focus

| Location | Change |
| --- | --- |
| `assets/chat.js:1518-1521` `partMetadata` | Unchanged; extractors read `state.metadata`. |
| `assets/chat.js:1569-1629` `toolPreview` | Add `apply_patch`; add metadata path fallbacks for `write`/`edit`; append file count. |
| `assets/chat.js:1631-1651` `toolOutputText` | Unchanged for pre fallback; add a small diagnostics stripper used by the diff/write views. |
| `assets/chat.js:1682-1691` `truncationNotice` | Replace the field string argument with a view/display truncation object (section 5.5); handle `part.omitted`. |
| `assets/chat.js:1719-1730` `detailBodyText` | Keep as the fallback for `patch`/`file`/`reasoning`; diff extraction runs before it. |
| `assets/chat.js:1962-1967` `attachOpenTracking` | Extend the toggle handler: open -> submit that part's files to the scheduler; close -> cancel its pending/in-flight jobs, drop stale responses, clear token spans to skeleton, and release its reservations. Keep `openParts` behavior. |
| `assets/chat.js:1969-2009` `createPartNode` | Unchanged. |
| `assets/chat.js:2046-2053` `renderStateFor` | Add `bodyKind`, `viewKey`, `view`, `highlightState`, `highlightJobs`, `highlightGeneration`, `tokenNodes`, `plainReason`, `scrollTop`, `scrollLeft`. |
| `assets/chat.js:2086-2119` `ensureToolBody` | Add `"diff"` and `"write"` kinds; create the container once and reuse its scroll element across updates. |
| `assets/chat.js:2167-2249` `updateToolPart` | Build `view`, choose `bodyKind`, render the plain skeleton, enqueue only if open, preserve focus/scroll, then update the notice. Omitted parts render no body. |
| `assets/chat.js:2251-2292` `updateDetailPart` | For `kind === "patch"`, build `patchView`; use the diff renderer for a patch string or file-list mode; else the existing `<pre>`. The same lazy/open rule applies. |
| `assets/chat.js:3316-3342` part event handling | Store `part.truncation = payload.truncated` and `part.omitted`; keep the live view's highlight state keyed by part. |
| `assets/chat.js:3396-3424` omitted handling | Set `part.omitted = true`; suppress the normal body and show the omitted notice. |
| `assets/chat.js:6219,6389` `hydrateMessages` after `applySnapshot` | Call `resetHighlightController({reason:"hydration"})` after the store is replaced. Hydration replaces parts and drops live truncation metadata; the renderer rebuilds skeletons and enqueues only open parts. |
| `assets/chat.js:6500-6510` `selectSession` | Call `resetHighlightController({reason:"session-switch"})` before adopting the new session. All old jobs/reservations are released. |
| `assets/chat.js:2324-2345,2408-2424` `ensurePartNode`/`removeStoredMessage` | Call `resetHighlightController({reason:"part-removed", partID})` when a part/message node is removed. |
| `assets/chat-core.js:applySnapshot` | Unchanged merge logic. The controller reset is a `chat.js` call site after hydration, not a `chat-core` change. |

Flow in `updateToolPart`:

1. Build the diff view first, then the write view, then fall back to the existing output. The extractor
   returns `null` when no diff/content source exists or when status is `error`.
2. `viewKey` includes source kind, file type/counts, path(s), language, byte length, and a
   **64-bit** FNV-1a (two 32-bit lanes) over the **clipped** raw diff/content plus server truncation
   fields/limit. Do not use a 32-bit key alone. `state.view` is reused only when the full key matches;
   a key change cancels that part's jobs, releases reservations, and rebuilds. The cache holds one
   clipped model per rendered part and is replaced on a key change, never an unbounded history.
3. `bodyKind` = `"none"` for `part.omitted`, `"todo"` for `todowrite`, `"bash"` for `bash`,
   `"diff"` for a diff view, `"write"` for a write view, otherwise `"pre"`.
4. Signature includes tool, status, preview, elapsed, `viewKey` (or output for pre), notice,
   diagnostics, and `highlightState`. If it is unchanged, return before touching the DOM.
5. Render the plain skeleton immediately (section 4.7). If the outer `<details>` is closed, do
   nothing else: no worker, no scheduler entry, no token nodes. If it is open, submit the part's
   files to the per-file scheduler (reservations/in-flight/pending); on the first open,
   `ensureWorker()` starts the worker/Prism load.
6. While running, diff/write bodies use `TOOL_DIFF_THROTTLE_MS = 250` (completion is not throttled).
   Bash keeps its existing 100 ms throttle; markdown keeps 50 ms.
7. Before updating body children, record `scrollTop`/`scrollLeft` and whether focus is inside the
   body. After the token plan is applied, restore scroll and focus. The scroll element is reused, so
   a focused scroller is not replaced by a new element.
8. `syncTruncationNotice` runs after the body, using the view/display truncation object (section
   5.5). `openParts` and the existing error auto-open logic are unchanged, but an error body is
   **not eligible** for highlighting: errors render the existing error `<pre>` and the scheduler is
   never asked to tokenize them.

`updateDetailPart` keeps its 50 ms throttle for non-streaming detail parts and uses the same
`viewKey`/renderer for a `patch` string. `patch` file-list mode has a small key (paths joined) and
does not call the worker.

`resetHighlightController({reason, partID?})` is the reconciliation entry point. It increments a
controller generation, drops pending and in-flight jobs, releases every reservation (including the
unused remainder), clears the per-view/page work and timeout counters for the reset scope, and marks
all responses with an older generation stale. It is called after
hydration (`hydrateMessages` following `applySnapshot`, both tail and older-page paths), on session
switch (`selectSession`), on part/message removal, and whenever a part's `viewKey` changes. It does
not mutate `chat-core` state. Every job carries `{jobID, partID, viewKey, fileIndex, generation}`;
the worker echoes `jobID`/`streamID`, and the controller drops any response whose generation or
`viewKey` is stale before committing tokens or releasing a reservation. Reservation release is
idempotent per `jobID`/generation, so a stale response cannot double-release. This also covers a part
that is re-rendered while a request is in flight.

Hydration and reconnect: `applySnapshot` rebuilds parts without token state; `updateToolPart` renders
a skeleton for every part, then submits only parts whose `<details>` is open (restored from
`openParts`). A closed hydrated diff does zero tokenization and consumes zero page budget. This is
what bounds a session with hundreds of collapsed diffs.

`chat-highlight.js` never awaits Prism or a worker at import time. `ensureWorker()` returns a promise
that resolves when `{type:"ready"}` arrives; `updateToolPart` does not await it, it attaches a
callback to the request ID. This is why there is no top-level await on the `chat.js` module graph and
why chat startup is unaffected by a slow/failed worker.

### 4.9 CSS and theme

No new color tokens are introduced. The token theme maps Prism token classes to existing semantic
tokens in `src/http/styles.css:10-218`; both themes inherit automatically. Selectors are scoped to
`.tool-diff .token` / `.tool-code .token` so Prism class names cannot affect other chat prose. The
design-system contract (`DESIGN.md` §5.16 and the §9 class/token contract) and
`docs/design/showcase.html` are updated in the implementation with the diff/code/token specimens;
this is a property of the chat surface, not a new global primitive.

| Token classes | Color |
| --- | --- |
| `comment`, `prolog`, `doctype`, `cdata` | `--text-3`, italic |
| `punctuation` | `--text-2` |
| `keyword`, `atrule`, `selector` | `--brass` |
| `string`, `char`, `attr-value`, `inserted` | `--success` |
| `number`, `boolean`, `constant`, `symbol` | `--warning` |
| `function`, `class-name`, `builtin` | `--info` |
| `property`, `tag`, `attr-name`, `deleted` | `--danger` (the diff line's `-` sign carries the deletion meaning; no token-level strike-through) |
| `variable`, `parameter`, `operator` | `--text-1` / `--info` |
| `regex`, `important` | `--warning`; `important` bold |
| `bold` / `italic` | font weight 600 / italic |

Diff structure:

- `.tool-diff`, `.tool-code`: `background: var(--inset)`, `color: var(--text-2)`, mono font at
  `--text-mono-sm`, `border-radius: var(--radius-sm)`, `min-inline-size: 0`.
- `.tool-diff__scroll`, `.tool-code__scroll`: `max-block-size: 24rem`, `overflow: auto`,
  `overscroll-behavior: contain`, `scrollbar-gutter: stable`.
- `.tool-diff__head`, `.tool-code__head`: sticky at `top: 0` inside the scroll container,
  `background: var(--inset)`, `border-block-end: 1px solid var(--line)`, `z-index: 1`; path uses
  `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` and a same-capped `title`.
- `.diff-line`, `.code-line`: grid with old/new number columns, sign, and code. Desktop columns
  `3.25rem 3.25rem 1.25rem minmax(0, 1fr)`; at `max-width: 48rem` use
  `2.5rem 2.5rem 1rem minmax(0, 1fr)`. `white-space: pre` on code; horizontal scrolling, never
  wrapping, so columns stay aligned.
- `.diff-line[data-kind="add"]`: background `color-mix(in oklab, var(--success) 9%, transparent)`;
  sign/numbers use `--success`.
- `.diff-line[data-kind="del"]`: background `color-mix(in oklab, var(--danger) 9%, transparent)`;
  sign/numbers use `--danger`.
- `.diff-line[data-kind="context"]`: transparent; numbers `--text-3`.
- `.diff-line[data-kind="meta"]`: `--text-3`, italic, no numbers.
- `.tool-diff__hunk-head`: `--wash-1`, `--text-3`, mono, `--text-micro`, no sticky (the file header
  is the sticky element).
- `.tool-diff__diagnostics`: `border-block-start: 1px solid var(--line)`, `--text-3`, max 8rem,
  `overflow: auto`, `white-space: pre-wrap`.
- No hover-only affordances, no animations, no new motion. Color is never the only signal: the `+`/
  `-` signs and `data-kind` remain.

## 5. Truncation policy

### 5.1 Server and client budget constants

Add to `src/opencode/events.ts` next to `MAX_PATCH_BYTES` (`src/opencode/events.ts:28-30`):

| Constant | Value | Applies to |
| --- | --- | --- |
| `MAX_DIFF_BYTES` | 64 KiB | Head of `state.metadata.filediff.patch`, each `state.metadata.files[i].patch`, and a single-file `edit` `state.metadata.diff`. |
| `MAX_DIFF_EVENT_BYTES` | 128 KiB | Combined multi-file `apply_patch` `state.metadata.diff`, and the sum of all diff strings in one part after per-field caps. |
| `MAX_WRITE_CONTENT_BYTES` | 64 KiB | Head of `state.input.content` when `tool === "write"`. |
| `MAX_PATCH_INPUT_BYTES` | 64 KiB | Head of `state.input.patchText` when `tool === "apply_patch"` and no completed diff exists. |
| `MAX_DIFF_FILES` | 50 | Maximum file records kept in one event **and** accepted from any parsed source (combined or per-file). |
| `MAX_DIFF_PATH_BYTES` | 1 KiB | Each `filePath`/`relativePath`/`movePath`/`filediff.file`/`state.title`/`input.filePath`/`data.files[]` path. |
| `MAX_DIFF_PATH_TOTAL_BYTES` | 16 KiB | Sum of all displayed/metadata path strings in one event. |
| `MAX_TRUNCATED_FIELDS` | 32 | Maximum entries in `truncated.fields`. |
| `MAX_TRUNCATED_FIELD_BYTES` | 8 KiB | Serialized size of `truncated.fields`; over budget collapses to the `"more"` sentinel. |

Client/worker constants (shared by `chat-diff.js`, `chat-highlight.js`, and
`chat-highlight-worker.js`):

| Constant | Value | Purpose |
| --- | --- | --- |
| `HIGHLIGHT_TIMEOUT_MS` | 250 ms | Per request/stream; timeout terminates the worker and renders plain. |
| `WORKER_READY_TIMEOUT_MS` | 2,000 ms | Worker creation + Prism load; failure disables highlighting for the page. |
| `MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT` | 64 KiB | Default per-stream text cap for code languages. |
| `MAX_HIGHLIGHT_WRITE_BYTES` | 64 KiB | Explicit `write` content cap; covered by the default. |
| `HIGHLIGHT_STREAM_CAPS` | `markdown: 8 KiB`, `markup: 8 KiB`, `bash: 8 KiB` | Oracle-measured pathological grammars. |
| `MAX_HIGHLIGHT_LINE_CHARS` | 1,000 | Pre-check; a 1,024-character line is rejected. |
| `MAX_TOKEN_NODES_PER_REQUEST` | 10,000 | Worker returns `plain` above this for one stream; scheduler reservation per stream. |
| `MAX_TOKEN_NODES_PER_FILE` | 20,000 | Controller aggregate; discards the file's plan and renders plain above this. |
| `MAX_INFLIGHT_HIGHLIGHT_STREAMS` | 12 | Streams holding a 10,000-node reservation; 12 x 10,000 = 120,000. |
| `MAX_PENDING_HIGHLIGHT_FILES` | 50 | Worker-ready admission queue only; equals `MAX_DIFF_FILES`; not a budget waitlist; overflow renders plain. |
| `MAX_PAGE_TOKEN_NODES` | 120,000 | In-flight reservation budget; not a projected-total rejection gate. |
| `MAX_HIGHLIGHT_VIEW_WORK_MS` | 1,000 ms | Active worker time per view. |
| `MAX_HIGHLIGHT_PAGE_WORK_MS` | 3,000 ms | Active worker time per page. |
| `MAX_TIMEOUTS_PER_LANGUAGE` | 2 | Circuit breaker per view/language. |
| `MAX_DIFF_DISPLAY_BYTES` | 64 KiB | Per-file display allocation. |
| `MAX_DIFF_DISPLAY_TOTAL_BYTES` | 128 KiB | Multi-file display allocation. |
| `MAX_WRITE_DISPLAY_BYTES` | 64 KiB | `write` content display allocation. |
| `MAX_RENDERED_LINES` | 2,000 | Per-file render cap. |

`MAX_TOOL_OUTPUT_BYTES`/`MAX_PATCH_BYTES` (64 KiB) and `MAX_PART_EVENT_BYTES` (256 KiB) are
unchanged.
`MAX_PART_ARRAY_ITEMS` (200) still applies to other arrays. The caps are UTF-8 byte caps using the
existing `headBytes` helper, so a cut never splits a code point (`src/opencode/events.ts:248-281`);
the cut may still end mid-line, and the parser marks that file truncated and renders the partial
line.

### 5.2 De-duplication and ordering before the budget

`boundPart` (`src/opencode/events.ts:497-555`) runs a deterministic normalizer before serialization:

1. **`apply_patch`:** if `metadata.files` is a non-empty array and every record has a non-empty
   string `patch`, delete `metadata.diff` (prefer per-file patches, which carry paths). Otherwise, if
   `metadata.diff` is a non-empty string, delete each `files[i].patch` but keep path/type/counts. If
   neither exists, keep `files` headers only. If `metadata.diff` is absent and only some records have
   a patch, keep those partial patches; the client renders the rest as header-only sections.
2. **`edit` / hashline:** if `metadata.filediff.patch` is a non-empty string and a filediff path is
   usable, delete `metadata.diff`. Otherwise, if `metadata.diff` is a non-empty string, delete
   `filediff.patch` but keep filediff path/counts. If a diff source exists, delete
   `state.input.oldString` and `state.input.newString` (they are not rendered and only duplicate the
   patch).
3. **`apply_patch` while running:** keep `state.input.patchText` (capped at 64 KiB) only when no
   `metadata.diff`/`files[].patch` exists. Once a completed diff source exists, drop `patchText`.
4. **`write`:** keep `state.input.content`; there is no diff to deduplicate.
5. **`patch` part:** keep `data.patch` (64 KiB); cap `data.files` to `MAX_DIFF_FILES` and cap each
   path to `MAX_DIFF_PATH_BYTES` (the array is path-only and currently unrendered).
6. **All diff sources:** cap every path field (`filePath`, `relativePath`, `movePath`, `filediff.*`,
   `state.title`, `input.filePath`, `data.files[]`) to `MAX_DIFF_PATH_BYTES` and the total path bytes
   to `MAX_DIFF_PATH_TOTAL_BYTES`; later paths are shortened and marked.
7. **`edit`/hashline duplicate payload:** drop `metadata.filediff.before` and
   `metadata.filediff.after` unconditionally. They are full-file duplicates and are never rendered;
   the diff (or the output fallback) is authoritative.
8. **Unrendered metadata:** for diff-bearing parts, keep only rendered metadata (`filepath`,
   `exists`, `filediff` path/counts, `files[]` path/type/counts, `diff`). Drop
   `state.metadata.diagnostics` and any other string/object metadata the renderer does not read,
   before patches/files are dropped in 5.3. Diagnostics are not displayed by this design.
9. **Unrendered input:** for diff-bearing parts, keep only the render allowlist: `state.input.filePath`,
   `state.input.content` for `write`, `state.input.patchText` for `apply_patch` only while running and
   no completed diff exists (already capped at 64 KiB), `state.input.rename`/`delete` for hashline
   (small), and `state.input.replaceAll` only if the renderer reads it (it does not). Drop
   `state.input.oldString`/`newString` when a diff source exists (already in step 2), and drop
   hashline `edits` unconditionally: up to 200 edits x 8 KiB would otherwise exhaust the event budget
   even though the diff is authoritative. Test a hashline payload with 200 large edits.

The per-file patch drops in steps 1-2 are **source de-duplication** when the combined diff is the
chosen source; they are not budget trimming. Budget-driven drops always remove whole trailing
records (5.3/5.4), never individual patches. These rules are **subtractive**, not additive: they
remove duplicate or unrendered fields from the event. They do not add a new upstream field;
`truncated.fields`/`omittedBytes` already exist, and `truncated.limit` is the only new subfield. The
only current consumer is `assets/chat.js`; a repository search confirms no current `src/` or test
module reads `oldString`, `newString`, `patchText`, `filediff.before`, or `filediff.after`. The new
extractor will read `patchText` only while an `apply_patch` is running with no completed diff. The
implementation adds a regression test that the normalizer never drops a field the client renders.

### 5.3 Per-event budget

The budget is the serialized event, not just the diff strings. `jsonBytes(event)` must be <=
`MAX_PART_EVENT_BYTES` (256 KiB) after every step. It includes identity fields, metadata keys, every
path, `truncated.fields`, and JSON overhead. `truncated` is extended to
`{fields: string[], omittedBytes: number, limit: "per-file" | "total" | "content" | "patch" |
"output" | "files"}`; `limit` is additive and lets the client distinguish a 64 KiB per-file cut from
the 128 KiB total. The algorithm is deterministic:

1. Apply per-field caps, path caps (`MAX_DIFF_PATH_BYTES`, `MAX_DIFF_PATH_TOTAL_BYTES`), and
   de-duplication (5.2). Apply `MAX_DIFF_FILES` to file records from every source (server-side
   `metadata.files`; client-side parsed combined diff), including a combined `metadata.diff`
   (parser rule 13); dropped file sections set `filesTruncated`.
2. Cap `truncated.fields` to `MAX_TRUNCATED_FIELDS` entries and `MAX_TRUNCATED_FIELD_BYTES`
   serialized bytes **including the `"more"` sentinel**. If the list would exceed either limit,
   rebuild it with the first entries that fit plus `"more"`; if even `["more"]` cannot fit, keep only
   `"more"` and `omittedBytes`. `omittedBytes` still sums all dropped bytes.
3. Per-file sources: apply `MAX_DIFF_BYTES` (64 KiB) as a **per-field head cap independent of the
   remaining event bytes**; the record keeps its header and capped patch. Then sum the retained
   per-file patches in file order; if the sum exceeds `MAX_DIFF_EVENT_BYTES` (128 KiB), drop whole
   trailing records (headers included) until the sum fits, and set `filesTruncated` /
   `truncated.limit = "total"`. Never clip an individual patch to fit the event sum. A per-file patch
   is never head-clipped to "remaining" event bytes.
   A combined `apply_patch` `metadata.diff` is capped at `MAX_DIFF_EVENT_BYTES` (128 KiB) on both live
   and hydrated paths; set `truncated.limit = "total"` if that cap cuts it.
4. Serialize and measure. If over 256 KiB and the part has a diff source, drop `state.output` and
   `state.metadata.output` (`limit:"output"`), then drop unrendered metadata per 5.2 item 8
   (including `state.metadata.diagnostics`); serialize again.
5. If still over:
   - **Combined `metadata.diff`:** the 128 KiB combined string is already the effective cap; do not
     clip it below 128 KiB for event overhead. Drop whole `metadata.files` header records from the
     end and/or `truncated.fields` entries until the event fits, and set `filesTruncated`. Only if it
     still exceeds 256 KiB after those drops do we omit. Do **not** claim that dropping per-file
     patches trims a combined string.
   - **Per-file sources:** drop **whole trailing file records** (headers included) from the end, set
     `filesTruncated`, and mark the dropped records. Do not strip an individual patch while keeping
     its record: that would break source-selection consistency between live and hydrated data. The
     remaining records all keep their patches.
6. Set `truncated.limit` for content/patch/file-cap cases (`"content"`, `"patch"`, `"files"`).
7. If still over, emit `message.part.omitted` with `reason: "too_large"` exactly as today. The
   client shows the omitted notice (section 5.5), not "No output".

The 50-file adversarial case is bounded: 50 records x 3 paths x 1 KiB is reduced by the 16 KiB path
total; 128 KiB of patches plus paths plus output can exceed 256 KiB, so step 4 drops output and
diagnostics and step 5 drops whole trailing records. It must not reach omission in the required
tests. `truncated.fields` uses the actual dotted paths (`state.metadata.diff`,
`state.metadata.filediff.patch`, `state.metadata.files[3].patch`, `state.input.content`,
`state.input.patchText`, `state.output`, `state.metadata.files.length`) and `omittedBytes` sums the
dropped bytes. `truncated.limit` is one of `per-file | total | content | patch | output | files` and
is what lets the client distinguish 64 KiB per-file from 128 KiB total. When several limits are hit,
the most severe is recorded in this order: `total` > `per-file` > `files` > `content` > `patch` >
`output`.

### 5.4 One allocation rule for live and hydrated data

There is one allocator spec, implemented by the server for live events and by `assets/chat-diff.js`
for hydration. It is deterministic and is tested on both paths with the same fixtures.

**Source selection (identical on both paths):**

1. `apply_patch`: if every `metadata.files[]` record has a non-empty `patch`, use per-file patches.
2. Otherwise, if `metadata.diff` is a non-empty string, use the combined diff.
3. Otherwise, use the partial per-file patches/headers.
4. `edit`/hashline: `filediff.patch` when present, else `metadata.diff`.
5. `write`: `input.content`; no allocation across files.

**Input bounds before parsing:** an `apply_patch` combined diff is capped at
`MAX_DIFF_EVENT_BYTES` (128 KiB) before parsing on both paths. A per-file patch and an `edit`
single-file diff are capped at `MAX_DIFF_BYTES` (64 KiB). Hydration uses the same caps, not the 8 MiB
response size. `parseUnifiedDiff` applies `MAX_DIFF_FILES` to every source.
For `apply_patch` combined sources, metadata records are merged back after parsing using the
**normalized new path** as the key: `relativePath` when present, otherwise `movePath` for a move,
otherwise the parsed `+++` path, otherwise `filePath`, otherwise the old path. A move therefore
matches its new path, not its old one. A metadata record whose patch is absent after combined text clipping (not a budget-driven
record drop) stays header-only with its type/paths/counts.
A move fixture is required.

**Allocator:** given ordered file records, allocate sequentially:

- keep the header, path (capped 1 KiB), type, and counts for every retained record;
- give each file at most `min(MAX_DIFF_BYTES, remaining display budget)` of the 128 KiB display total;
- if a record's patch does not fit, drop that record **and every later record** (headers included),
  set `filesTruncated`, and set `truncated.limit = "total"` for the 128 KiB total; do not keep a
  budget-dropped record as header-only and do not strip an individual patch. The retained records all
  keep their patches, so source selection is identical on live and hydrated data;
- a record supplied without a patch (partial per-file source) remains header-only with
  `statsPartial`; that is not a budget drop;
- keep at most 50 records; excess records set `filesTruncated` and `truncated.limit = "files"` only
  when no higher limit (`total`) already applies;
- never invent a file that was not in the source metadata/parse.

The same allocator runs on a live per-file source, a live combined source, a hydrated per-file
source, and a hydrated combined source. The 128 KiB event sum is enforced before the 256 KiB event
budget by dropping whole trailing records; retained records keep their patches. A combined source is
capped at 128 KiB on both paths; if the event still exceeds after dropping non-diff metadata/records,
it is omitted rather than clipped below 128, so the live and hydrated text limit is identical. Client
hydration mirrors the server path cap: `MAX_DIFF_PATH_TOTAL_BYTES = 16 KiB` is applied to the sum of
displayed/metadata paths before rendering. This removes the previous divergence where the server
allocated per file but the client clipped a combined string before parsing.

**Display caps:** `MAX_DIFF_DISPLAY_BYTES = 64 KiB` per file,
`MAX_DIFF_DISPLAY_TOTAL_BYTES = 128 KiB` across a multi-file diff, and
`MAX_WRITE_DISPLAY_BYTES = 64 KiB`. Clip with `TextEncoder`/`TextDecoder` at the same byte caps; never
split a UTF-8 code point. Keep the partial last line and let the parser mark it truncated, matching
the server's `headBytes`. `MAX_RENDERED_LINES = 2,000` per file: over the line cap, render the first
2,000 and set `display.lines = true`. For `write`, the 64 KiB content cap sets
`display.write = true`.

The renderer receives a **display truncation object**:
`{serverFields, serverLimit, omitted, display: {write, perFile, total, lines, files}}`.

`serverFields` is `part.truncation.fields` (live) or empty (hydration); `serverLimit` is
`part.truncation.limit`; `omitted` is `part.omitted`. The display flags are set by the
allocator/renderer, and when `serverLimit` is present it seeds them
(`per-file` -> `display.perFile`, `total` -> `display.total`, `content` -> `display.write`,
`files` -> `display.files`). This object is what `truncationNotice` consumes in 5.5; a boolean field
argument cannot express a hydrated line/total cap. `state.input.patchText` maps to `diff`, not to
`output`.

### 5.5 Truncation notices

`truncationNotice(part, status, view)` consumes the display truncation object from 5.4. The field is
resolved from `serverFields` in this order: `state.input.content` -> `write`;
`state.metadata.diff`, `state.metadata.filediff.patch`, `state.metadata.files[...]`,
`state.metadata.files.length`, `state.input.patchText` -> `diff`; `patch` -> `patch`;
`state.output` -> `output`; `"more"` -> `diff`; otherwise the view's own field, finally `output`.
Diff/content fields outrank output because output may be dropped to make room for the diff (5.3).

Precedence: omitted > live/snapshot > display.write > total > per-file > lines > files >
field-specific. Exact strings:

| Condition | Notice |
| --- | --- |
| `part.omitted` | `Result omitted; it exceeded the 256 KiB stream budget.` |
| running/pending and `part.partial` | `Diff truncated for live view; the full result may load when the turn ends.` / `Content truncated for live view; the full result may load when the turn ends.` / `Output truncated for live view; the full result may load when the turn ends.` |
| completed, `sessionSnapshotTooLarge` | `Full diff unavailable; session snapshot exceeds 8 MiB.` / `Full content unavailable; session snapshot exceeds 8 MiB.` / `Full output unavailable; session snapshot exceeds 8 MiB.` |
| `display.write` | `Content truncated at 64 KiB.` |
| `display.total` | `Diff truncated at the 128 KiB total limit.` |
| `display.perFile` | `Diff truncated at 64 KiB per file.` |
| `display.lines` | `Diff truncated at 2,000 lines.` / `Content truncated at 2,000 lines.` |
| `display.files` | `Additional files omitted from the view.` |
| `field === "diff"`, `serverLimit === "per-file"` | `Diff truncated at 64 KiB per file.` |
| `field === "diff"`, `serverLimit === "total"` | `Diff truncated at the 128 KiB total limit.` |
| `field === "write"` / `serverLimit === "content"` | `Content truncated at 64 KiB.` |
| `field === "patch"` / `serverLimit === "patch"` | `Patch truncated at 64 KiB.` |
| `field === "output"` / `serverLimit === "output"` | `Output truncated at 64 KiB.` (existing bash string) |

`part.omitted` suppresses the normal body; only this notice and the summary are rendered. The notice
is still `.tool-call__truncated` below the body, so existing styling and tests apply. A field's own
truncation flag wins over the generic output message; e.g. a truncated `files[].patch` never says
"Output truncated". Hydration has no `serverFields`, so the display object's flags are the source of truth there; live
data may have both, and the display flags win for total/per-file/lines/files. When `serverLimit` is
present, it seeds `display.perFile`/`display.total`/`display.write`/`display.files` before rendering.
Exact strings are asserted by unit tests (pure notice selection) and browser QA.

## 6. Security

- **Untrusted input:** diff text, written content, paths, and hunk headers are agent-controlled. All
  are rendered as text nodes. There is no HTML, no markdown renderer, no image/embed, and no URL
  creation from a path.
- **No `innerHTML`:** Hanse-authored modules use `createElement`, `createTextNode`, `textContent`,
  `classList`, and `append`. The vendored Prism file contains its own `highlightElement`/
  `innerHTML` implementation, but it runs only in the worker and Hanse never calls it; a test asserts
  the Hanse modules contain no `innerHTML` and no `Prism.highlight` call. `Prism.manual = true` and
  `disableWorkerMessageHandler = true` prevent Prism's DOM scan and its own worker message parser.
- **Worker isolation and timeout:** Prism's regex work runs off the main thread. The controller never
  imports Prism. A pathological stream is bounded by the language-aware stream cap and line cap, then
  by `HIGHLIGHT_TIMEOUT_MS`; on timeout the worker is terminated, not merely ignored. This is the
  only defensible response because in-process Prism cannot be time-boxed (Oracle: ~19.4 s for 64 KiB
  Markdown `[`).
- **Tokenizer only:** `Prism.tokenize` receives text and a grammar from the vendored allowlist inside
  the worker. The language ID is derived from a path through the resolver; a payload-provided
  language is ignored. Token type strings become classes only after `/^[a-z0-9-]+$/` validation.
- **DoS:** byte caps on the wire and at display; `MAX_DIFF_FILES` on every parsed source;
  `MAX_DIFF_PATH_BYTES`/`MAX_DIFF_PATH_TOTAL_BYTES`; `MAX_TRUNCATED_FIELDS`/
  `MAX_TRUNCATED_FIELD_BYTES`; per-language stream caps; line-length skip; per-file and per-page token
  budgets; the per-file scheduler; worker termination on timeout; iterative flatten (no recursion stack);
  plain fallback on any failure. The main-thread parser runs on bounded input, not the full session.
- **Dependency/license:** Prism 1.30.0 is MIT. The full license and the upstream tarball integrity
  are checked in; a checksum test detects an accidental edit. There is no npm dependency and no
  external fetch at runtime.
- **CSP:** no CSP exists today. The design needs no `unsafe-eval` and no new origin; it is compatible
  with a future `default-src 'self'` / `script-src 'self'` / `worker-src 'self'` policy, except for
  the page's existing inline theme bootstrap, which is outside this change.
- **Paths:** paths are display text and `title` only; they are never used as selectors, URLs, or
  filesystem operations. Absolute paths are not shortened into links.

## 7. Impact

### 7.1 Files to change

| File | Change |
| --- | --- |
| `assets/vendor/prism/LICENSE`, `VERSION`, `SHA256SUMS`, `prism-1.30.0.min.js` | New vendored Prism build and provenance, ESM default export. |
| `assets/chat-diff.js` | New pure resolver, extractor, parser, one allocator, view/display truncation models, notice selection. |
| `assets/chat-highlight.js` | New main-thread controller: lazy worker, per-file scheduler/reservations, aggregate work budgets/timeouts, skeleton builder, token-plan DOM renderer, focus/scroll preservation. No Prism import. |
| `assets/chat-highlight-worker.js` | New module worker: pre-set Prism flags, dynamic vendor import, language allowlist, tokenization, compact line plan, worker-side caps. |
| `assets/chat.js` | Imports; `toolPreview`; `truncationNotice`; `renderStateFor`; `ensureToolBody`; `updateToolPart`; `updateDetailPart`; `attachOpenTracking`; part truncation/omitted storage; lazy open-only scheduler submission; controller reset on hydration/session/part removal. |
| `src/opencode/events.ts` | New caps, path/field budgets, de-duplication, deterministic per-event fallback loop. |
| `src/http/handler.ts` | Four asset allowlist entries (`chat-diff.js`, `chat-highlight.js`, `chat-highlight-worker.js`, versioned Prism file). |
| `src/http/styles.css` | Scoped token theme, diff/code-line layout, backgrounds, responsive columns, diagnostics. |
| `DESIGN.md` | Update §5.16 and the §9 class/token contract with the diff/code/token surface; no new global primitive. |
| `docs/design/showcase.html` | Add diff/code specimens in both themes. |
| `test/chat-diff.test.ts` | New pure resolver/parser/extractor/allocator/notice tests. |
| `test/opencode-events.test.ts` | New caps/dedup/path/field/serialized-budget tests. |
| `test/chat-page.test.ts` | Asset imports, no-`innerHTML`, Prism allowlist/checksum assertions. |
| `test/http.test.ts` | Prism/worker asset 200/MIME/404 allowlist behavior. |
| `docs/design/chat-qa.mjs` | Diff/write/truncation/binary/unknown-language/adversarial/focus/hydration fixtures and assertions. |
| `docs/design/artifacts/chat/README.md` | New scenario/screenshot/report counts after the QA run. |

No change is needed to `src/http/ui.ts`, `src/http/chat.ts`, `Dockerfile`, `package.json`, or
`package-lock.json`. `asset()` already supports subdirectories under `HANSE_ASSETS`.

### 7.2 Docs to update

| Doc | Change |
| --- | --- |
| `docs/design/chat-diff-highlighting.md` | This design. |
| `docs/design/README.md` | One-line index entry (done in this task). |
| `docs/design/chat-ux-overhaul.md` | Apply the exact non-goal replacement in section 10 after design approval; replace the §9.4 `edit/apply_patch/patch` and `write` bullets as specified there. Do not edit it in this task. |
| `docs/current-state.md` | Add `chat-diff.js`, `chat-highlight.js`, `chat-highlight-worker.js`, and the Prism asset to the asset list (`:60-61`), update the chat renderer bullet (`:104-160`), the chat capability bullet (`:155-157`), the `HANSE_ASSETS` row (`:309`), and add the worker/lazy/cap limitations. |
| `DESIGN.md` | §5.16 and the §9 class/token contract add the diff/code/token surface; no new global primitive. |
| `docs/design/showcase.html` | Diff/code specimens, dark and light. |
| `docs/journal/0010-chat-diff-highlighting.md` + `docs/journal/README.md` | Stage record after implementation: evidence, caps, accepted debt, verification. |
| `docs/plans/0008-chat-diff-highlighting.md` + `docs/plans/README.md` | Implementation plan after design review (not part of this task). |
| `docs/decisions/0008-vendored-prism-chat-highlighting.md` | ADR recording the vendor/worker/security decision and the superseded non-goal. |

The chat UX non-goal is superseded by the owner's decision; the old text must not remain as an
unqualified prohibition after this design is accepted.

### 7.3 Tests

Pure unit tests (`test/chat-diff.test.ts`), no DOM:

- Resolver: every row in 4.3, special filenames/case, longest-extension (`*.d.ts`, `*.min.js`),
  unknown/no extension, `.mdx`/`.jsonc` caveats, Windows separators, query strings, language-aware
  stream caps, and **resolution from the uncapped basename before display capping**.
- Parser: single-file hunk; multi-file `diff --git`; real `createTwoFilesPatch` shape with
  `Index:`/`====` headers; `---`/`+++` only; add/delete via `/dev/null`; metadata type/paths/counts
  for add/delete/move; move headers; binary; trailing `\ No newline` after counts; **two** trailing
  no-newline lines; CRLF; context/add/del numbering; zero counts; header-only; malformed/truncated
  tail; quoted paths; `defaultPath`; an extra `+`/`-`/context line after declared counts ends the hunk and marks truncated; `MAX_DIFF_FILES` on combined and per-file sources; raw fallback.
- Extractor: `edit` filediff vs metadata.diff precedence; hashline rename (`filePath` old,
  `filediff.file/path` new) and delete (output fallback); `filediff.before`/`after` ignored;
  `apply_patch` files vs metadata.diff vs patchText, including same-path add/delete and move;
  `write` content/path and create/update inference, empty content and line count; `patch` files-only;
  absent metadata; error status; multi-file counts.
- Allocator: 3 x 64 KiB -> 2 full + third whole record dropped (`filesTruncated`); 50-file
  adversarial paths; combined diff with many tiny files; combined-diff head-clip with `limit:"total"`;
  identical results for live and hydrated fixtures; file order preserved; move merge key (new path);
  header-only only for records supplied without a patch; client 16 KiB path total.
- Mapping: multi-line block comments, template literals, empty lines, leading/trailing newline, a
  line containing only a newline, and a trailing newline that has no diff line.
- Notice selection: every row in 5.5, including `patchText -> diff`, `"more"`, hydration display
  flags seeded from `truncated.limit`, per-file vs total 128 KiB, content/patch/output, line cap,
  file cap, live, snapshot, omitted.

Server tests (`test/opencode-events.test.ts`):

- 64 KiB `metadata.diff`, 64 KiB `write` `input.content`, and 64 KiB running `input.patchText`
  survive; over-cap fields are head-clipped.
- `apply_patch` with both `metadata.diff` and complete `files[].patch` drops `metadata.diff`.
- `edit` with both `filediff.patch` and `metadata.diff` drops one, and drops `oldString`/`newString`
  plus `before`/`after`.
- 3 x 64 KiB file patches allocate 2 full + third record dropped (`filesTruncated`); all retained
  records keep patches; serialized event <= 256 KiB.
- 50 files x 3 paths x 1 KiB does not exceed 256 KiB; path total/field caps apply; whole trailing
  records are dropped (headers included) only after output/diagnostics; retained records keep patches.
- 200 files keep 50 and do not emit `message.part.omitted`; a truly unrepresentable event still does.
- A large `metadata.diagnostics` (and other unrendered metadata) is dropped before patches/files;
  `filepath`/`exists`/counts/paths remain.
- A hashline payload with 200 large `edits` is normalized to the input allowlist; `edits` is dropped,
  the diff survives, and the event stays under 256 KiB.
- `truncated.fields` is capped at 32/8 KiB including `"more"`; if even `"more"` cannot fit, only
  `"more"` + `omittedBytes` remain; `omittedBytes` stays correct.
- `truncated.limit` is set to `per-file` vs `total` vs `content` vs `patch` vs `output` vs `files`
  in the corresponding cases; a combined diff that is head-clipped is parsed/allocated and marked
  `total` before any omission.
- Combined `metadata.diff` with >50 tiny files is capped by the parser/allocator on both paths.

HTTP/client asset tests:

- `/assets/chat-diff.js`, `/assets/chat-highlight.js`, and `/assets/chat-highlight-worker.js` are
  served as JavaScript; unknown vendor/worker paths are 404.
- `/assets/vendor/prism/prism-1.30.0.min.js` is served with the JavaScript MIME type; its SHA-256
  matches `SHA256SUMS` and its raw size is <= 88 KiB (the measured 83,861 B plus the license header).
  Gzip size is a documented QA measurement, not a unit-test assertion.
- `chat.js`, `chat-diff.js`, `chat-highlight.js`, and `chat-highlight-worker.js` contain no
  `innerHTML`; the worker calls `Prism.tokenize`, and no Hanse module calls `Prism.highlight`.
- The chat page still emits only `/assets/chat.js` as a module and preserves `openParts`.
- The initial module graph does not import the vendor bundle or fetch the worker; a static check
  asserts `chat-highlight.js` has no top-level `import` of Prism/worker.
- `chat-diff.js` + `chat-highlight.js` are <= 88 KiB raw / 24 KiB gzip combined, and all three new
  Hanse JS files are <= 96 KiB raw / 32 KiB gzip combined (Q1 budget). The check reads the checked-in
  files and gzip output.

Browser QA (`docs/design/chat-qa.mjs`):

- Fixtures: standard `edit` with `metadata.filediff.patch`; hashline `edit` with only
  `metadata.diff`; apply_patch with add/update/delete/move records (same-path add/delete, move);
  a `write` with 40 lines of TypeScript, an empty write, and a representative 64 KiB code write; a
  `patch` part with `files` only; an unknown-extension file; a binary file; a truncated diff; an
  omitted part; and a scene with many collapsed diffs.
- Assertions: `.tool-diff` skeleton appears before any token spans while the worker is pending;
  `.tool-diff__file` count; `+N`/`-N`; old/new line numbers; add/del kinds; `.token.keyword`/
  `.token.string` > 0 for TypeScript after open; `.tool-code` line count for `write`; unknown ->
  `data-highlight="plain"` with no tokens; binary label and no hunks; exact truncation strings;
  file-list mode; omitted notice with no "No output" body.
- Lazy/open-only: a closed diff has zero `.token` spans and makes zero worker requests (assert via a
  worker-request counter/fixture hook); opening it highlights; closing it clears tokens and releases
  budget; reopening highlights again.
- Adversarial wall-clock: open a diff containing 8 KiB of Markdown `[`, markup, and Bash, plus a representative 64 KiB code write; assert
  the UI remains responsive and each file finishes as tokens or plain within the 250 ms + paint
  budget; the worker must be terminated on timeout rather than the page hanging.
- Focus: focus `.tool-diff__scroll`, emit a streaming update, assert `document.activeElement` is still
  the same scroller and scrollTop/scrollLeft are preserved.
- Error auto-open: a failed `edit` auto-opens the error `<pre>`, makes zero highlight requests, and
  shows no diff body.
- Hydration/reload: reload with a closed and an open diff; only the open one tokenizes. Live streaming
  update then hydration must not flash colored -> plain -> colored.
- Scheduler: open a 50-file diff; assert at most 6 two-stream files are reserved and the rest render
  plain immediately with `data-highlight="budget"` (no waitlist); closing a highlighted file and
  reopening a plain one may succeed. No partial file, no indefinite pending.
- Work/circuit breaker: simulate two timeouts for one language and assert the remaining files of that
  language in the view render plain and no new worker is created for them; exhaust the view/page work
  budget and assert the same.
- Layout: at 1440 and 390, open every tool disclosure; assert no page horizontal overflow, the diff
  scroll container is the only horizontal scroller, and the 390 columns are narrower. Capture
  `main-1440-diff.png` and `main-390-diff.png` (dark) and one light diff capture; add them to
  `docs/design/artifacts/chat/README.md`.
- Theme: switch `data-theme` to light and assert a keyword token's computed color changes while the
  add-line background is still derived from `--success`.
- No console/page errors; the harness exits 1 on any.

Playwright is not a product dependency. `docs/design/chat-qa.mjs` resolves an installed Playwright
module and Chromium (or `PLAYWRIGHT_CHROMIUM`); a missing browser/build is a blocked gate, not a skip.
CI must provide one of: a cached Playwright install + browser, a `PLAYWRIGHT_CHROMIUM` binary, or an
external `CHAT_QA_URL`/`CHAT_QA_TOKEN` target. `npm test` covers the pure/server logic; the browser
gate is a required additional command where a browser is available.

### 7.4 Verification commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
node docs/design/chat-qa.mjs
```

`npm run build` rebuilds `assets/app.css` from `src/http/styles.css`; the vendored Prism file is not
built. `npm run lint` ignores `assets/` by repository configuration, but the new `src/` code must
still pass. The checksum and asset tests are part of `npm test`.

`node docs/design/chat-qa.mjs` is the browser gate. This repository does not ship Playwright as a
product dependency; the harness resolves an installed Playwright module and Chromium (or
`PLAYWRIGHT_CHROMIUM`) and treats a missing browser/build as a blocked gate. On a host without one,
the implementer must install Playwright/Chromium in the dev/CI environment (the same optional
resolver used by `docs/design/capture.mjs`) or target an external `CHAT_QA_URL`/`CHAT_QA_TOKEN`
server; the gate is not skipped. The live smoke
`node docs/design/chat-qa.mjs --live` remains optional and requires the documented
`CHAT_QA_URL`/`CHAT_QA_TOKEN`/session.

### 7.5 Rollout and rollback

The feature is additive: new assets, new CSS, and a new renderer branch. Rolling back means
removing the allowlist entries and the `chat.js` imports. The server changes are **subtractive**:
they drop duplicate/unrendered fields and cap diff data; they do not "only preserve more diff data".
If the caps remain after a client rollback, the old client renders a plain `<pre>` with the capped
diff/content, and the dropped `oldString`/`newString`/`before`/`after`/diagnostics fields stay
dropped. Review the server commit together with the client rollback; do not assume the old payload
shape is unchanged. No database migration, route, or schema change is involved. The old `<pre>` path
remains the fallback for every tool, so a worker/Prism failure degrades rather than breaks chat.

The owner has authorized commit/push/deploy after implementation, but implementation remains gated
on: this revised design passing re-review, closed owner questions, an approved plan, and plan review
(`docs/process.md:9-20`). This revision does not implement or deploy anything.

## 8. Non-goals

- No detection or rendering of diffs inside `bash` output (`git diff`, `patch` command output).
- No `multiedit`, `str_replace`, `create`, or `lsp_rename` tool support; those tools do not exist in
  the pinned upstream versions.
- No diff for `write` from permission-request metadata; `write` shows content only.
- No server-side rendering or pre-highlighted HTML payload.
- No language detection from content or model hints; path/filename only.
- No new theme files, fonts, icons, copy button, line-wrap toggle, word-level diff, or side-by-side
  diff.
- No nested per-file disclosures or persistent per-file open state; the outer `<details>` remains the
  only collapsibility control.
- No changes to `chat-core.js` merge/queue logic, markdown rendering, prompt handling, or the
  tool-output streaming behavior.
- No change to the raw upstream SSE contract; all new fields are existing upstream metadata read by
  the client.
- No main-thread/in-process Prism tokenization, no top-level await in the chat module graph, and no
  eager Prism/worker fetch at page load.
- No second highlighter/theme and no per-language grammar supplied by an agent.

## 9. Open questions

None. The owner decided real syntax highlighting (Option B). The following are **technical decisions
recorded here**, not owner questions:

- Module worker + lazy open-only highlighting + 250 ms timeout + terminate/recreate, plus
  per-view/page work budgets and a 2-timeout language circuit breaker, because Prism cannot be
  time-boxed in-process.
- 8 KiB caps for Markdown/markup/Bash, 64 KiB for other languages (including `write`), 1,000-character lines,
  10,000 tokens/request, 20,000 tokens/file, 12 in-flight streams / 50 pending files, 120,000 tokens/page.
- 64 KiB per-file / 128 KiB total display and event diff allocation, 2,000 rendered lines, 50 files.
- Horizontal-scroll diffs (no wrapping), hunk-local highlighting, and content-only `write`.
- `DESIGN.md` and the showcase are updated for the diff/code/token surface; it is not treated as a
  new global primitive.

Remaining assumptions (not owner forks): the caps are tunable constants; hunk-local highlighting is
acceptable; `write` content is more useful than a transient permission diff.

## 10. Superseded non-goal and exact proposed edits

The owner's Option B decision supersedes this line in `docs/design/chat-ux-overhaul.md:1865`:

```
- No React/Vue/Svelte, bundler, new runtime dependency, or syntax-highlighting library.
```

Proposed replacement (apply only after this design passes review; do not edit it in this task):

```
- No React/Vue/Svelte or JS bundler. No new runtime npm dependency; chat tool diffs and written
  content use a checked-in, vendored PrismJS 1.30.0 ESM build (MIT) loaded by a module worker from a
  same-origin asset. See [chat-diff-highlighting.md](./chat-diff-highlighting.md).
```

Required §9.4 sync edit (`docs/design/chat-ux-overhaul.md:1097-1121`). Replace the two old body
bullets rather than adding new ones:

Old:

```
- **patch / file / subtask:** generic details with a preview and `<pre>` text.
- **read/write/edit/grep/glob/webfetch/websearch/generic:** preview + `<pre>` for `state.output`,
  `state.error`, or the best available string.
```

New:

```
- **edit / apply_patch / write:** completed edit/apply_patch diffs and write content use the
  syntax-highlighted diff/code renderer (plain skeleton until the worker responds); if no
  diff/content source exists, fall back to preview + `<pre>`.
- **patch:** a `patch` part with `data.patch` uses the diff renderer; with only `files` it renders a
  file list. `file`/`subtask` remain generic preview + `<pre>`.
- **read/grep/glob/webfetch/websearch/generic:** preview + `<pre>` for `state.output`, `state.error`,
  or the best available string.
```

Update the §9.4 preview-table row (`docs/design/chat-ux-overhaul.md:1081`) too:

Old:

```
| `write`, `edit` | `state.input.filePath` or `state.input.path`. |
```

New:

```
| `write`, `edit`, `apply_patch` | `state.input.filePath`/`path`; `apply_patch` uses the first `metadata.files[]` path or the first `*** ... File:`/`*** Move to:` line in `patchText`. |
```

Also replace the old truncation paragraph (`docs/design/chat-ux-overhaul.md:1114-1118`) with a
pointer, because the field-aware notices in this design supersede it:

```
- A truncated diff/content/output renders `.tool-call__truncated` with the notice defined in
  [chat-diff-highlighting.md](./chat-diff-highlighting.md) §5.5. Do not restate a 64 KiB-only notice.
```

The remaining preview rows (bash/read/grep/glob/webfetch/websearch/task/todowrite/question/generic),
error auto-open, and `openParts` rules remain valid. The `edit/write` preview row, the two body
bullets, and the truncation paragraph are replaced; do not add new bullets beside the old ones. Do
not apply these edits in this task.

## 11. Design review

Oracle verdict: **PASS WITH REQUIRED CHANGES**. This revision incorporates the required architecture
change and all findings; a re-review is required before the plan.

| # | Finding | Severity | Resolution | Section changed |
| --- | --- | --- | --- | --- |
| A | Prism superlinear tokenization cannot be time-boxed on the main thread | Required architecture | Module worker owns Prism; 250 ms timeout terminates the worker; language-aware 8/64 KiB caps; 1,000-char line pre-check; adversarial wall-clock QA | 2.2 Q3/Q8, 2.3, 3.1, 3.4, 4.1, 4.6, 5.1, 6, 7.3 |
| B | No top-level await / eager Prism fetch | Required architecture | Controller has no Prism import or top-level await; worker/Prism load lazily on first open; ready timeout + plain fallback | 2.3, 4.1, 4.8, 7.3 |
| C | Lazy, open-only highlighting; page budget | Required architecture | Plain skeleton first; enqueue only when `<details>` open; close cancels/clears/releases; all-or-nothing per-file reservation (10k/20k), 12 stream reservations / 6 two-stream files, 50 worker-ready pending | 4.6, 4.7, 4.8, 5.1, 7.3 |
| D | Worker protocol / pre-set Prism flags / export default | Required architecture | `manual` + `disableWorkerMessageHandler` before dynamic import; synchronous handler + init/ready/tokens/plain/error protocol; `export default Prism;` retained | 3.1, 4.1, 4.2, 4.6 |
| E | Q1 conflated vendor and new JS | Required architecture | Separate controller, worker, and vendor budgets; initial vs first-open payload; no 84 KiB total claim | 2.2 Q1, 3.2, 7.1 |
| 1 | Superlinear Prism / 2,000-char line cap insufficient | BLOCKER | Worker timeout + terminate, 1,000-char check, 8/64 KiB stream caps, adversarial QA | 3.1, 3.4, 4.3, 4.6, 5.1, 6, 7.3 |
| 2 | Hunk ends before trailing `\ No newline` meta | BLOCKER | Consume backslash meta lines after counts; only `@@`/file header/non-meta ends hunk; two-meta test | 4.5 rule 8, 7.3 |
| 3 | `Index:`/`====` headers unhandled | MAJOR | Recognize/ignore; `Index:` path fallback; real `createTwoFilesPatch` fixture | 4.5 rule 3, 7.3 |
| 4 | apply_patch/hashline type/path/count mapping | MAJOR | Parser options `{type, oldPath, newPath, additions, deletions}`; same-path add/delete; move; hashline rename/delete; drop before/after | 4.4, 4.5, 5.2, 7.3 |
| 5 | Live vs hydrated allocation divergence | MAJOR | One allocator spec; identical source selection and 128 KiB/50-file caps; combined parse capped identically; whole trailing record drops keep retained patches; metadata merge by new path | 5.3, 5.4, 7.3 |
| 6 | Event budget ignored paths/fields/JSON | MAJOR | Whole-event `jsonBytes` budget; path/field caps; deterministic drop output -> unrendered metadata -> combined clip/trailing records -> omit | 5.1, 5.3, 7.3 |
| 7 | `MAX_DIFF_FILES` not applied to combined parser output | MAJOR | Parser `maxFiles` on every source; metadata merge preserves headers | 4.5 rule 13, 5.3, 5.4, 7.3 |
| 8 | Token-to-line mapping off-by-one | MAJOR | Append-before-increment rule; empty segments/trailing newline; block-comment/template tests | 4.6 Mapping, 7.3 |
| 9 | Focus loss when the scroll container is replaced | MAJOR | Reuse scroll element; preserve focus + scrollTop/Left; QA focus assertion | 4.7, 4.8, 2.2 Q5, 7.3 |
| 10 | `truncationNotice` cannot express hydrated display caps | MAJOR | Display truncation object; `patchText -> diff`; exact per-file/total/line/file strings | 5.4, 5.5, 7.3 |
| 11 | `part.omitted` falls through to "No output" | MAJOR | Suppress body, omitted notice only; live + hydrated test | 4.7, 4.8, 5.5, 7.3 |
| 12 | Dedup called "additive to the wire shape" | MINOR | Reworded as subtractive; no other consumer verified; regression test | 5.2 |
| 13 | Incomplete §9.4 sync | MINOR | Exact old/new body bullets and truncation paragraph replacement; old bullets removed | 10 |
| 14 | `DESIGN.md`/showcase not updated | MINOR | §5.16 and §9 contract updated; showcase specimens added; no new global primitive | 4.9, 7.1, 7.2 |
| 15 | Model gaps (`statsPartial`, create inference, path caps, token scope, patch files, write tests) | MINOR | Added to model/parser/extractor/CSS/tests | 4.4, 4.5, 4.9, 5.1, 5.4, 7.3 |
| 16 | Test plan gaps / Playwright availability | MINOR | Adversarial, focus, hydration/reload, live streaming, real shapes, hashline, combined cap, page budget; explicit Playwright/CI note | 7.3, 7.4 |

### Design review 2

Second Oracle gate: **PASS WITH REQUIRED CHANGES**. The gate remains **open** until a final re-review
confirms this table.

| # | Finding | Severity | Resolution | Section changed |
| --- | --- | --- | --- | --- |
| 1 | Per-request rejection queue / projected-total semantics | BLOCKER | All-or-nothing per-file reservation: `S x 10,000`, 12 stream reservations (120,000 budget), 20,000 per-file aggregate cap, 50 worker-ready pending; unavailable -> plain immediately; close/stale release | 2.2 Q3, 4.1, 4.6, 4.8, 5.1, 7.3 |
| 2 | 16 KiB default prevented a 64 KiB `write` from highlighting | BLOCKER | Default stream cap 64 KiB for code languages; `MAX_HIGHLIGHT_WRITE_BYTES = 64 KiB`; Markdown/markup/Bash remain 8 KiB; token caps still apply | 2.2 Q3/Q8, 3.4, 4.3, 4.6, 5.1, 7.3 |
| 3 | Worker top-level-await/init-before-handler race | BLOCKER | Worker installs `self.onmessage` synchronously; init handler sets stub, imports vendor, posts ready; no TLA in worker | 2.3, 4.1, 4.6 |
| 4 | No controller reconciliation on hydration/session/part removal | MAJOR | `resetHighlightController()` generation/reservations; jobs carry jobID/partID/viewKey/fileIndex; stale responses dropped; called after `applySnapshot`, session switch, part removal, viewKey change | 4.8, 7.2, 7.3 |
| 5 | No aggregate time budget/circuit breaker | MAJOR | 1,000 ms/view, 3,000 ms/page, 2 timeouts/language; remaining files plain; no worker recreation after breaker; recreation cost documented | 4.1, 4.6, 5.1, 6, 7.3 |
| 6 | Notices cannot distinguish per-file/total; missing output variants | MAJOR | `truncated.limit` added; display flags seeded from server limit; field-diff and Output live/snapshot rows; bash output string retained | 5.3, 5.4, 5.5, 7.3 |
| 7 | Metadata budget ignored `diagnostics`/unrendered metadata | MAJOR | Drop `metadata.diagnostics` and other unrendered metadata before patches/files; keep filepath/exists/counts/paths; large-diagnostics test | 5.2, 5.3, 7.3 |
| 8 | Combined diff over budget had no clip path | MAJOR | Head-clip combined `metadata.diff` at a line boundary to remaining budget, `limit:"total"`, then parse/allocate; omit only after that | 5.3, 5.4, 7.3 |
| 9 | Individual patch dropping broke source-selection consistency | MAJOR | 64 KiB is a per-field cap; event-budget drops remove whole trailing records (headers included), set `filesTruncated`; remaining records keep patches; combined stays 128 KiB on both paths | 5.3, 5.4, 7.3 |
| 10 | Extra hunk line after counts silently ignored | MINOR | Extra `+`/`-`/context line ends hunk and marks file truncated | 4.5 rule 8, 7.3 |
| 11 | Move metadata-merge key ambiguous | MINOR | Key is normalized new path (`relativePath` / `movePath` / parsed `+++`, then `filePath`/old); move fixture | 5.4, 7.3 |
| 12 | Language resolved after path cap | MINOR | Resolve from uncapped basename first, then cap displayed path | 4.3, 4.4, 7.3 |
| 13 | `truncated.fields` could exceed 8 KiB with sentinel | MINOR | Build list including `"more"` within 8 KiB; if sentinel alone cannot fit, keep only `"more"` + omittedBytes | 5.3, 7.3 |
| 14 | §9.4 sync omitted `apply_patch` and preview row | MINOR | `edit / apply_patch / write` bullet; preview row updated; no "rest accurate" claim | 10 |
| 15 | Q1/language set required vs optional unclear; no raw size test | MINOR | Required/optional lists; raw vendor size <= 88 KiB assertion; gzip documented QA measurement | 2.2 Q1, 4.2, 4.3, 7.3 |
| 16 | Error auto-open contradiction / 32-bit viewKey | MAJOR | Errors render error `<pre>` and are not highlight-eligible; 64-bit viewKey including type/counts | 4.7, 4.8, 7.3 |
| 17 | Rollout claimed caps "only preserve more data" | MINOR | Reworded: caps are subtractive; review server rollback with client rollback | 7.5 |
| 18 | Second gate table/gate state | PROCESS | This table; gate remains open until final re-review | 11 |

Re-review focus for Oracle: per-file scheduler/reservations and release/stale semantics, worker
init without TLA, aggregate work/circuit breaker, controller reset call sites, `truncated.limit` and
source-selection consistency, combined-diff clipping, and the §9.4 preview/body replacement. The
design is not plan-ready until the final re-review confirms these.

### Design review 3

Third gate: **PASS WITH REQUIRED CHANGES**. This revision closes the remaining scheduler and input
gaps; the gate stays open until one final re-review.

| # | Finding | Severity | Resolution | Section changed |
| --- | --- | --- | --- | --- |
| 19 | Per-file 20k reservations fragmented the page budget; a 12k free balance could not start a file | MAJOR | All-or-nothing per-file reservation: `S x 10,000` (10k/20k) before any stream starts; 12 stream reservations / 120k; unavailable -> plain immediately, no partial file and no indefinite wait | 4.6, 5.1, 7.3 |
| 20 | 5.3 step 3 still head-clipped per-file patches to "remaining" event bytes and dropped the 128 KiB sum for per-file sources | MAJOR | `MAX_DIFF_BYTES` is a per-field 64 KiB cap; the 128 KiB sum is enforced by dropping whole trailing records; individual patches are never clipped; combined stays 128 on both paths | 5.3, 5.4, 7.3 |
| 21 | Unrendered `state.input` (hashline `edits` up to 200 x 8 KiB) could exhaust the event budget | MAJOR | Input allowlist per tool; drop `edits`, `oldString`/`newString`, `replaceAll`; keep `filePath`, `content`, running `patchText`, `rename`/`delete`; 200-edit test | 5.2, 7.3 |
| 22 | Combined diff event clipping could diverge from the hydrated 128 KiB limit | MAJOR | Combined is always 128 KiB on both paths; drop metadata/truncation/records instead of clipping below 128; omit only if still over | 5.3, 5.4, 7.3 |
| 23 | Within-file abort, runtime worker error, pending overflow, and measurement guarantees were unspecified | MINOR | Abort current file's remaining streams on budget/breaker; caught error file-plain, uncaught error page-disable; pending overflow plain; gzip/write-token counts documented as QA measurements | 4.6, 5.3, 7.3 |

Re-review focus for this gate: all-or-nothing per-file reservation math (S x 10k, 12 stream
reservations = 120k) and immediate-plain fallback, 5.3 per-file versus combined budget rules, the new
input allowlist, and the combined 128 KiB rule. The remaining items are minors with documented
deferrals.

### Design review 4

Fourth gate: **PASS WITH REQUIRED CHANGES**. Two scheduler/budget majors were still open; this
revision closes them. The gate remains open until the final re-review.

| # | Finding | Severity | Resolution | Section changed |
| --- | --- | --- | --- | --- |
| 24 | Per-stream admission could start a two-stream file with only 10k free and leave it partial | MAJOR | All-or-nothing per-file reservation `S x 10,000` before any stream; 12 stream reservations / 120k; if unavailable, plain immediately; no partial file, no budget waitlist | 4.6, 5.1, 7.3 |
| 25 | The 128 KiB event sum was not applied to per-file sources (3 x 64 KiB survived under 256) | MAJOR | Sum retained per-file patches in file order; if >128 KiB, drop whole trailing records until it fits; never clip an individual patch; `filesTruncated`/`limit=total` | 5.3, 5.4, 7.3 |

Re-review focus for this gate: 4.6 all-or-nothing reservation, 5.3 per-file 128 KiB sum, and the
3 x 64 KiB / 200-file fixtures. This is the last expected gate.

**Final Oracle gate (2026-10-20): PASS.** No blocker/major remains. Accepted residual minors:
gzip and representative 64 KiB write-token counts are QA measurements rather than unit guarantees;
`MAX_PENDING_HIGHLIGHT_FILES` is a worker-ready upper bound and the 120k budget binds first.




## 12. Review and references

- Design review: `oracle` - **PASS** (2026-10-20). Plan review: `momus` after owner questions are
  closed (`docs/process.md:9-20`).
- What would change this design: section 3.4.
- References: `assets/chat.js:1518-1521, 1569-1651, 1682-1691, 1719-1730, 1962-2009, 2046-2119,
  2167-2292, 3316-3342, 3396-3424`; `src/opencode/events.ts:20-38, 248-281, 420-455, 497-555,
  1121-1140`; `src/http/handler.ts:61-75, 197-211`; `src/http/ui.ts:253-287`;
  `src/http/chat.ts:371`; `src/http/styles.css:10-218, 2194-2253, 5020-5034`;
  `DESIGN.md:718-750, 945-1005`; `test/chat-page.test.ts:405`; `test/http.test.ts:631-666`;
  `docs/design/chat-ux-overhaul.md:531-615, 1068-1121, 1854-1871`;
  `docs/current-state.md:60-61, 104-160, 309`;
  `docs/design/chat-qa.mjs` and `docs/design/artifacts/chat/README.md`.
