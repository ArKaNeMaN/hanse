# Design - Mermaid diagrams in chat and Markdown surfaces

> **Superseded (2026-11-20):** variant A is replaced by the sandboxed renderer in
> [`mermaid-sandbox.md`](./mermaid-sandbox.md). The variant-A review rounds below are kept as history.

Status: **draft, round 8** - Oracle rounds 1-7 returned FAIL; every finding is folded below. Owner
questions are closed (three product decisions 2026-11-20, plus the Node floor). This is the final
review round under the owner's limit.

Scope: the shared browser Markdown renderer (`assets/markdown.js`), the chat feed
(`MarkdownBlock.vue`, including the handoff and OMO cards, which pass `sealed`), and the safe Markdown
component (`SafeMarkdown.vue`) in its five consumers: the handoff review dialog
(`HandoffReviewDialog.vue`), the skill workspace preview pane (`SkillBundleEditor.vue`), and the three
read-only skill previews (`SkillPreviewDrawer.vue` for a managed/external `SKILL.md` body,
`ExternalSkillDrawer.vue` for text/Markdown file previews, and `SkillSourceDrawer.vue` for a source's
text/Markdown file previews). Plus the persistent agent instruction that
tells agents diagrams are supported.

Out of scope: server-side rendering or storage of diagrams; API/schema/database changes; inline SVG
in the page DOM; sandboxed iframes and interactive diagrams (variant B); diagram editing, zoom, pan,
download, or export; non-Mermaid diagram languages; Mermaid's `@{ ... }` metadata syntax (new node
shapes, image/icon shapes, YAML metadata); the terminal and the IDE extension; binary previews (hash/size summaries, never `<pre>`) and the raw `<pre>` source disclosures (they
stay source inspectors); adding a content-security-policy to the application pages.

Governing context: [`docs/current-state.md`](../current-state.md) (the deliberate Markdown subset and
the "no images, embeds, or raw HTML" rule), `assets/markdown.js` (the text-only DOM builder),
[`DESIGN.md`](../../DESIGN.md) §5.16 (chat primitives), and
[`docs/open-questions.md`](../open-questions.md) (owner decisions for this stage).

---

## 1. Problem

The chat and the other Markdown surfaces render a fenced ` ```mermaid ` block as plain monospace
source. Agents have no reason to emit Mermaid, and when they do the operator sees the source, not a
diagram. Mermaid is the de-facto diagram notation for coding agents, so this is a missing rendering
capability rather than a missing authoring tool.

The naive fix - feed the Mermaid SVG back through the document - would destroy the renderer's central
invariant: it builds nodes and never assigns Markdown text as HTML. This design adds diagrams while
keeping the invariant and making the final artifact inert. It does **not** make the render step
inert; that residual is contained and stated honestly in §4.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | A fenced code block whose info string, after `trim()`, equals `mermaid` case-insensitively renders as a diagram when a diagram renderer is installed and diagrams are enabled for that render. `mermaid title`, `mermaid-extra`, and inline occurrences stay code. `hasDiagramFence()` uses the same rule. |
| R2 | The rendered artifact is an inert image: an `<img>` whose `src` is a percent-encoded `data:image/svg+xml` URI. No SVG node, `<script>`, event handler, or `innerHTML` assignment is introduced by Hanse code. |
| R3 | While a chat part is unsealed (streaming), a Mermaid fence renders as today's `<pre><code>`; it becomes a diagram on the sealed re-render. No diagram is parsed from partial stream text. |
| R4 | Every failure - no renderer, optional-chunk load failure, oversized source, too many diagrams, parse error, oversized SVG, encoding/serialization error - falls back to the plain code block. Oversize/too-many/encoding/parse failures add one caption line. There is no blank area, no infinite retry, and no page reload. |
| R5 | Caps: per-diagram source length/line count, rendered SVG size, diagrams per container, a bounded render queue with a single retry, a 200 ms typing debounce, one in-flight render, and a bounded theme-aware cache. |
| R6 | Diagram colors use the mapped semantic tokens in the twelve enumerated diagram sections; unenumerated types receive the same root `themeVariables` wherever their palettes use those keys and otherwise keep their section defaults, and are not claimed as fully theme-matched. Switching `[data-theme]` re-renders without a reload. |
| R7 | Mermaid runs with `securityLevel: "strict"`, root-level `htmlLabels: false`, `startOnLoad: false`, `suppressErrorRendering: true`, an extended `secure` directive list, a `dompurifyConfig` forbid list, and no click bindings. |
| R8 | Every Markdown surface renders diagrams: sealed chat/handoff/OMO Markdown via `MarkdownBlock`, and `SafeMarkdown` in the handoff review dialog, the skill workspace preview, the `SkillPreviewDrawer` `SKILL.md` body, Markdown/text file previews in `ExternalSkillDrawer`, and Markdown/text file previews in `SkillSourceDrawer`. Binary previews and raw `<pre>` disclosures stay source-only. |
| R9 | The diagram is accessible: the image has an accessible name (the frontmatter title when present, else `Mermaid diagram`), the block is reachable in reading order, the source remains in a collapsed disclosure whose `<pre>` scrolls horizontally on its own, and wide diagrams never force horizontal page scroll. |
| R10 | The persistent agent instruction states that a Mermaid fence is rendered, so agents know the capability exists. |
| R11 | No diagram/artifact is stored, no route/API/schema changes, and the `/assets/*` allowlist is unchanged. The only server-adjacent change is the process-rule content/hash (R10) and the documented Node floor. |
| R12 | `assets/markdown.js` stays free of npm imports (it imports only `./chat-core.js`). The standalone `/assets/markdown.js` asset remains served and tested for compatibility and keeps rendering fences as code because no renderer is registered. |
| R13 | A failed optional Mermaid operation - the main chunk or any per-diagram chunk loaded inside the render - leaves the source block and does not reload the page or replace the SPA fallback. Only non-optional chunk failures keep the existing reload behaviour. |
| R14 | Mermaid never receives a source that can override its security configuration or use a known external-fetch vector: `%%{` directives, `@{...}` metadata, and source CSS directives (`classDef`/`style`/`linkStyle`) are rejected; `http(s)://`, protocol-relative `//`, `url(`, and `data:<type>/` are rejected; HTML tags outside a small attribute-free inline allowlist (KaTeX included) are rejected; `secure` and `dompurifyConfig` block overrides; the temporary render container is offscreen and removed; a canary E2E proves no request escapes for the malicious corpus. |
| R15 | The supported Node floor becomes `>=22.12.0`, and every live doc (`package.json`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/current-state.md`, `docs/deployment.md`) plus the CI matrix agrees. Historical design and journal records keep their original wording. |

## 3. Decisions

### D1 - Mermaid 12.3.0 as a pinned devDependency; Node floor raised

Add `mermaid@12.3.0` (exact version) to `devDependencies`, imported with `await import("mermaid")`
from the Vue client only when a Mermaid fence is first seen. Vite emits the main Mermaid chunk plus
per-diagram chunks; the initial entry and pages without diagrams do not download any of them.

Mermaid 12.3.0 and its `@mermaid-js/parser` dependency declare Node `>=22.12.0`; Mermaid also depends
directly on `chevrotain ~13.2.0` (which declares `>=22.0`), and the parser grammar forces the same
floor. The owner chose to raise the documented and CI floor to `>=22.12.0` rather than pin the
previous major line. The images, `.nvmrc`, and Docker build already use Node 22; the change drops
only source builds on Node 20.19.

Rationale for the dependency: the client already ships bundled npm devDependencies (Vue, Router,
Pinia, Vue Query), Vite handles the output, and the lockfile plus npm advisories give a real update
path. The Prism vendoring decision ([ADR-0008](../decisions/0008-vendored-prism-chat-highlighting.md))
was driven by the pre-SPA "no bundler" constraint that no longer exists. The Docker build stage has
devDependencies (`Dockerfile:20-25`), so a devDependency is correct; the final image runs
`npm ci --omit=dev` after the bundle is built.

Consequences: the lockfile grows; `THIRD_PARTY_NOTICES.md` and a shipped `licenses/` directory become
self-contained (D16); `npm ci` on Node <22.12 is no longer supported. Rejected: vendoring a prebuilt
file (manual 3 MB asset, no code splitting - owner declined); a hand-written flowchart renderer (new
parser/layout engine, no compatibility); server-side rendering (no headless renderer in the
coordinator image, adds storage and an API, still needs a client boundary).

### D2 - One owner per concern: the Markdown module owns the DOM, the renderer owns Mermaid

`assets/markdown.js` gains:

```js
export function setDiagramRenderer(renderer) {}   // (source: string) => Promise<string> | null
export function hasDiagramRenderer() {}
export function hasDiagramFence(text) {}
export function renderMarkdown(container, text, options = {}) {}
```

`options` defaults are `{ diagrams: false, diagramDelayMs: 0 }` (opt-in).

Ownership split, binding for implementation:

| Concern | Owner |
| --- | --- |
| Fence detection, frame states, DOM nodes, source disclosure, captions, `frontmatterTitle()` | `assets/markdown.js` |
| Data-URI encoding (`encodeURIComponent`), per-diagram source/SVG caps, per-container diagram cap | `assets/markdown.js` |
| Per-container debounce timers and cancellation checks | `assets/markdown.js` |
| Mermaid import, config, security guard, theme tokens, serial queue, render cache | `ui/chat/mermaid-renderer.ts` |
| The SVG string (and nothing else) | renderer return value; signature `(source, isCancelled) => Promise<string> | null` |

The per-container diagram counter is a **local variable inside each `renderMarkdown` call**, reset
per call. Module-level state is limited to the registered renderer reference, the timer `WeakMap`
keyed by container, and the monotonic diagram-id sequence. The module stays free of npm imports
(R12) and owns every DOM state, so the three surfaces cannot drift. Rejected: importing Mermaid
directly in `assets/markdown.js` (breaks R12 and the standalone asset); duplicating the diagram
branch per component.

### D3 - Asynchronous render with generation-checked frames and explicit timers

For each fence the renderer creates `div.message__diagram[data-mermaid="pending"]` containing the
normal source `<pre>`, assigns a monotonic `data-diagram-id`, and schedules the render after
`options.diagramDelayMs` (0 for sealed chat/history, 200 for `SafeMarkdown` typing). Timers are
tracked in a `WeakMap<Element, Set<timer>>` keyed by the container; the start of every
`renderMarkdown(container, ...)` clears that container's pending timers, so re-renders cannot stack
timers. A callback proceeds only if its frame is connected and still carries the same
`data-diagram-id`; a re-render, session switch, or unmount drops the result. A new render of the
same block creates a new frame, so a stale result can never overwrite fresh content. An unmount does
not notify the module; its last timer fires once and drops on the connectivity check (bounded by one
delay).

`assets/markdown.js` passes an `isCancelled()` closure (the frame is disconnected or its
`data-diagram-id` changed); the renderer's queue drops a job when `isCancelled()` is true before it
starts, so a burst of typing cannot make a fresh diagram wait behind obsolete work. Mermaid's
internal parse/layout cannot be interrupted, but no obsolete job starts.

**First-render gap:** `ensureDiagramRenderer()` returns a cached promise. The component calls it only
when diagrams are enabled for this render (the sealed chat part, or `SafeMarkdown`) and
`hasDiagramFence(text)` is true, then calls `renderNow()` when it settles (`then(fn, fn)` so a
rejection also settles). The call site is guarded by `rendererRequested`/`rendererFailed` flags and
lives outside `renderNow`, so a cached resolved promise or a rejected import cannot re-arm itself
(R4: no infinite retry). A sealed historical message shows the source block first and the diagram
once the chunk and renderer are ready; a rejection keeps the source, and an unsealed part never
downloads Mermaid from a partial stream. This is required behaviour, not an optimization.

Rejected: rendering during streaming (repeated parse cost and error noise; R3 forbids it); a
module-level generation counter per container (more state; DOM identity is already the cancellation
token).

### D4 - The artifact is an inert image, encoded safely

The renderer returns the SVG string; `assets/markdown.js` wraps the encode/serialize steps in
`try/catch` and creates
`<img data-mermaid-image alt="${frontmatterTitle(source) ?? "Mermaid diagram"}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`
and never inserts the SVG markup. The wrapper carries
`data-mermaid="pending|ready|error|blocked|too-large|too-many|busy"`; the image carries
`data-mermaid-image`, so tests and styles do not conflate the two. `frontmatterTitle()` is a pure helper in `assets/markdown.js` that extracts a leading `title:` from
the fence's frontmatter (the renderer still returns only the SVG string). `encodeURIComponent` is mandatory:
raw `#` (hex colors), `&`, `%`, and quotes would otherwise truncate or corrupt the URI, and a lone
surrogate throws; a unit test covers `#`/`&` and a lone-surrogate failure. An SVG loaded as an image
is rendered in the browser's secure static mode: it cannot execute scripts, cannot interact, and
does not load external subresources. That is the security boundary of variant A for the artifact,
and it does not depend on Mermaid's or DOMPurify's correctness for the artifact.

Hanse code never assigns `innerHTML`; the image is built with `document.createElement` and
attributes. Mermaid itself uses `innerHTML` for its theme stylesheet and injects a temporary SVG into
the document while drawing; §4 and D14 contain that step.

Rejected: inline SVG + DOMPurify (breaks the invariant, shares the page origin and CSS); a sandboxed
iframe (variant B, deferred); a blob URL (needs revocation and leaks object URLs across re-renders).

### D5 - Root-level `htmlLabels: false`, a small HTML tag allowlist, and dimensions

Set `htmlLabels: false` at the root config, so ordinary labels emit SVG `<text>`, not
`foreignObject` HTML. This is not absolute: some diagram paths force HTML labels for KaTeX (the class
shape helper and the sequence `drawKatex` path), so the render step must also constrain label HTML
(D14). The artifact is inert regardless, but the render step is the exposure.

`useMaxWidth: false` is set explicitly for the twelve core diagram types we test and support:
`flowchart`, `sequence`, `class`, `state`, `er`, `gantt`, `pie`, `journey`, `gitGraph`, `mindmap`,
`timeline`, `quadrantChart`. For any other type the image fallback applies: if the root `<svg>` has
no intrinsic width/height (percentages are not intrinsic) but has a `viewBox`, the renderer parses
the string with an inert `DOMParser` and writes `width`/`height` from the viewBox with
`XMLSerializer` (never `innerHTML`).

Failure ladder for sizing and encoding: empty SVG, no intrinsic size and no viewBox, a
`DOMParser`/`XMLSerializer` failure, an `encodeURIComponent` throw, or an `<img>` error event is a
rendering failure (source + `Diagram could not be rendered.`).

Rejected: `useMaxWidth: true` + CSS-only sizing; per-diagram `htmlLabels` only; `getBBox` measurement
of a detached SVG (returns zeros).

### D6 - Theme through computed tokens, one module-level observer

Mermaid 12.3.0 sections default to `theme: "redux-color"` and `look: "neo"`, and
`resolveAppearance` prefers the section over the root. The config therefore sets `theme: "base"` and
`look: "classic"` in each of the twelve enumerated sections, and `darkMode` is passed **inside
`themeVariables`** (Mermaid's base theme derives `rowOdd`/`rowEven`/`cScale`/`pie` values from
`themeVariables.darkMode`; the root key is inert and is not relied on).

Before each serialized render the renderer reads `getComputedStyle(document.documentElement)` for the
semantic tokens and maps them explicitly:

| Mermaid variable | Token |
| --- | --- |
| `background` | `transparent` |
| `primaryColor`, `mainBkg`, `taskBkgColor` | `--surface-2` |
| `primaryTextColor` | `--text-1` |
| `primaryBorderColor`, `nodeBorder`, `clusterBorder`, `noteBorderColor` | `--line` |
| `lineColor` | `--line-strong` |
| `secondaryColor`, `clusterBkg`, `edgeLabelBackground` | `--surface-1` |
| `tertiaryColor`, `sectionBkgColor`, `altSectionBkgColor` | `--inset` |
| `textColor` | `--text-2` |
| `noteBkgColor` | `--surface-2` |
| `noteTextColor` | `--text-1` |
| `rowOdd`, `rowEven`, `gridColor` | `--line` |
| `doneTaskBkgColor` | `--surface-1` |
| `pie1`-`pie12` | cycle of `--brass`, `--info`, `--success`, `--warning`, `--danger`, `--text-2` |
| `darkMode` | `theme === "dark"` |
| `fontFamily` | `--font-sans` |
| `fontSize` | `14px` |

`mermaid.initialize` is re-run per render over these values; renders are serialized, so the global
config cannot interleave. A module-level `useThemeRevision()` starts one `MutationObserver` on
`<html data-theme>` lazily and keeps it for the page lifetime (one observer for the whole app; tests
reset modules). `MarkdownBlock` and `SafeMarkdown` watch the ref and re-render. The cache key is
`theme + "\0" + source`, so both themes are cached. Root `themeVariables` are global: unenumerated
diagram types receive the mapped values wherever their palettes use those keys and otherwise keep
their section defaults, so R6 does not claim a full match for them.

Known limitation: a diagram is an image document and cannot use the page's `@font-face` resources;
labels fall back to the system font stack.

Rejected: `themeCSS` injection (the render-step vector T1/T3 close); hardcoded palettes (drift from
DESIGN tokens); relying on the section default themes (they override the root).

### D7 - Caps, serialization, cache, and per-container limits

| Cap | Value | Owner | Purpose |
| --- | --- | --- | --- |
| `MAX_DIAGRAM_CHARS` | 8,000 | markdown.js | Bound parse/layout work and the data URI. |
| `MAX_DIAGRAM_LINES` | 200 | markdown.js | Bound line-heavy parser input. |
| `MAX_DIAGRAM_SVG_CHARS` | 512 KiB | markdown.js | Bound the DOM attribute; over-cap uses the `too-large` caption; checked before caching too. |
| `MAX_DIAGRAMS_PER_CONTAINER` | 8 | markdown.js | A hostile message cannot schedule hundreds of renders; excess fences stay code with one caption. |
| Render queue | 64 pending jobs | renderer | Bounded work; jobs whose `isCancelled()` is true are dropped before start. |
| Queue overflow | one retry | renderer | An overflow job keeps the source and `busy` state, then retries once after the queue drains or after 1 s; a second failure shows the busy caption. |
| `DIAGRAM_DEBOUNCE_MS` | 200 | markdown.js | Typing coalescing only (`SafeMarkdown`); chat passes 0. |
| Render concurrency | 1 | renderer | Mermaid uses a global config and shared DOM; serialize. |
| Cache | 32 entries, theme+source key, ≤512 KiB each | renderer | Avoid re-rendering history on scroll and theme toggles. |

Mermaid's `maxTextSize` is set to `MAX_DIAGRAM_CHARS` and `maxEdges` to 500 as a second line of
defence. Rejected: an unbounded queue (hostile history); a worker (Mermaid needs the DOM); a timeout
(cannot cancel a layout; caps are the control); an infinite retry (livelock).

### D8 - Streaming gate, exact surfaces, and the delay split

`MarkdownBlock` passes `{ diagrams: props.sealed === true, diagramDelayMs: 0 }`; unsealed parts keep
the source. The handoff and OMO cards already pass `sealed`. `SafeMarkdown` passes
`{ diagrams: true, diagramDelayMs: 200 }`; the handoff review dialog, the skill workspace preview,
the `SkillPreviewDrawer` `SKILL.md` body, and `.md`/`.markdown` text previews in `ExternalSkillDrawer`
and `SkillSourceDrawer` inherit it (each keeps a `Source` disclosure with the raw `<pre>`). Binary
previews stay hash/size summaries and non-Markdown text stays `<pre>`.

An interrupted turn whose last part never seals keeps the source block - an honest fallback recorded
as a limitation.

Rejected: debouncing sealed chat; rendering unsealed text; converting the source drawers to Markdown.

### D9 - Fallback copy and source disclosure

- Guard-rejected syntax (`%%{`, `@{`, source CSS directives, non-inline tags, URL-like text): source
  block plus `This diagram uses unsupported Mermaid syntax; showing source.`
- Parse/rendering/sizing/encoding failure: source block plus `Diagram could not be rendered.`
- Oversized source/SVG: source block plus `Diagram is too large to render.`
- Too many diagrams in one container: source block plus one
  `Too many diagrams in this message; showing source.`
- Queue overflow after the retry: source block plus `Diagram rendering is busy; showing source.`
- Missing renderer (optional chunk failed/loading, offline, raw asset): plain source block, no caption.
- Success: image plus `<details class="message__diagram-source"><summary>Diagram source</summary>`
  with the source `<pre>`; this preserves copyability and screen-reader access.

Rejected: a "render" button; an error toast.

### D10 - Styles and design-system record

`src/http/styles.css` gains one scoped chat block (`.message__diagram`, `-image`, `-note`,
`-source`) using existing tokens and spacing; no SFC `<style>`, no new colors.
`.message__diagram-image` is `max-inline-size: 100%; block-size: auto; display: block;
margin-inline: auto`; the `.message__diagram-source pre` gets `overflow-x: auto` so long source lines
cannot widen the page. `DESIGN.md` §5.16 adds the primitive and its states, and the two stale claims
are corrected: `DESIGN.md:818` lists the rendered subset (now including tables and the inert diagram
image) and `DESIGN.md:1203` no longer says images/embeds/raw HTML are unrendered "without an HTML
sanitizer dependency" - author Markdown still has no images/embeds/raw HTML, Mermaid is the one
inert-image exception, and the sanitizer is a render-step dependency of Mermaid.

Rejected: SFC styles (repo gate); a fixed-height scroll box.

### D11 - Persistent agent instruction (version 3)

`src/opencode/process-rules.ts` is restructured into `# Hanse agent rules` with a
`## Process safety` section (existing bullets unchanged) and a `## Chat rendering` line saying a
fenced ` ```mermaid ` block is rendered as an image and should be used when structure beats prose,
not for decoration. `PROCESS_RULES_VERSION` goes from 2 to 3.

Consequence: the rule hash participates in `settingsHashFor`, so after the upgrade every managed
application reports **Restart required** until restarted. The owner accepted this. Sidecar/restore
semantics are unchanged. Rejected: a separate persistent instruction file.

### D12 - Test seam and the post-load re-render

`ensureDiagramRenderer()` returns a cached `Promise<void>`, is idempotent, and is a no-op when
`hasDiagramRenderer()` is already true (a test fake wins); `setDiagramRenderer(null)` unregisters.
Components call it only when diagrams are enabled for the render (sealed chat or `SafeMarkdown`),
`hasDiagramFence(text)` is true, and neither `rendererRequested` nor `rendererFailed` is set; they
call `renderNow()` when it settles (D3). Unit
tests (jsdom) never import Mermaid: they install a fake through `setDiagramRenderer` and test states,
caps, cancellation, the fence grammar, the data URI, fallbacks, theme re-render, and the "raw HTML
never creates script/img/iframe" invariant. Real Mermaid runs only in Chromium E2E. Rejected:
importing Mermaid in jsdom; a global mock module.

### D13 - Optional chunk failures must not reload the SPA

`ui/main.ts` currently prevents every `vite:preloadError` and reloads once, then renders the static
fallback. Two problems: (a) Mermaid's per-diagram chunks are imported inside `render()`, after a
one-time import tracker would have settled; (b) a route-chunk failure during a pending optional
operation must still reload. Add `ui/optional-chunk.ts`:

- `trackOptionalChunk(load)` increments a pending counter, awaits `load()`, marks the thrown error as
  claimed, and decrements in `finally`. When the counter reaches zero, it flushes any unclaimed
  errors to the normal handler. The renderer wraps the **whole** optional operation - the
  `import("mermaid")`, `mermaid.initialize`, and each `mermaid.render` call - so per-diagram chunks
  are inside the window.
- `notePreloadError(error)` returns `true` while an optional operation is pending and records the
  error; `main.ts` then returns without `preventDefault()`, so Vite rejects the import and the
  renderer catches it. Outside the window, `main.ts` keeps its existing prevent/reload/fallback path.
- If the optional operation succeeds but an unclaimed preload error was recorded (a route chunk
  failed concurrently), the flush runs the normal handler: no silent route failure.
- Failure latches: a failed main import disables diagrams for the session (no caption, no repeat
  attempts); a failed per-diagram chunk latches only that source (keyed by a source hash), so a
  sequence diagram can still render after a flow-diagram chunk failure. The helper exports
  `isOptionalChunkError(error)`, so the renderer can distinguish a preload/chunk failure (latched by
  source) from a parse/render error (normal fallback, no latch).
- A stale-deploy Mermaid chunk 404 therefore shows source instead of reloading; the operator can
  reload manually (documented limitation).

E2E: block the main chunk and a per-diagram chunk (target it from the manifest, not a guessed name),
assert no reload and the source block; unit-test the helper with a fake handler for the
concurrent-route case, the per-source latch, and the chunk-vs-parse predicate.

Rejected: removing the global handler; inspecting `event.payload` URLs; a single top-level import
tracker (misses per-diagram chunks).

### D14 - Contain and guard the render step

Variant A cannot make Mermaid's draw step inert, so the stage controls its inputs and its DOM. The
type-independent guards live in a pure `ui/chat/mermaid-guard.ts` (no Mermaid import) so jsdom tests
can exercise them; the renderer supplies the type from `mermaid.detectType`.


1. **Directive guard:** reject any source containing `%%{` (initialization/layout directives). This
   runs on the raw source, before comment stripping.
2. **Metadata guard:** reject any source containing `@{` (Mermaid's YAML metadata syntax). This is
   the only path to the image shape (`A@{ img: ... }`), which prefetches with `new Image()` before
   any sanitizer sees the SVG, and YAML quoting/escaping makes a keyword scan unsound. The new node
   shape syntax is declared unsupported; classic bracket shapes remain. This also removes YAML
   anchors/aliases.
3. **CSS guard:** reject a statement with the shape `classDef\s+\w+`, `style\s+\w+`, or
   `linkStyle\s+` at a line or `;` boundary (case-insensitive) on a guard copy with the leading
   frontmatter block and `%%` comments removed. The guard runs only when Mermaid's own exported
   `mermaid.detectType(source, config)` (12.3.0) returns one of the **detector keys**:
   `flowchart-v2`, `flowchart-elk`, `swimlane`, `classDiagram`, `stateDiagram`, `er`,
   `requirement`, `usecase`, `block`, `agentflow`, or `treemap`. (`flowchart`/`graph`/`graph TD`
   are headers, not keys; `swimlane`/`block` are the keys for the `swimlane-beta`/`block-beta`
   headers; `agentflow` and `treemap` also expose `classDef`.) `architecture` and `treeView` have no
   source-CSS grammar; `quadrantChart` accepts only `radius`/`color`/`stroke-color`/`stroke-width`,
   so it is not CSS-capable. `detectType` applies Mermaid's own frontmatter, directive, comment, and
   alias handling, so a frontmatter-prefixed diagram cannot defeat it. Detection runs after
   `mermaid.initialize`, with a **copy** of the fixed config (the `flowchart-elk` detector mutates
   `config.layout = "elk"`). `detectType` throws `UnknownDiagramError` for an unknown type; catch it
   and treat the source as unrenderable (no CSS guard needed), not as a returned `error` string. The
   `class` keyword is not rejected: without `classDef` it only names an existing/theme class and
   cannot introduce CSS, so class diagrams keep working. The statement-shape match avoids rejecting
   a class member `style: string`, a node named `style`, or a quoted label; remaining quoted-label
   false positives are accepted (the safe direction). Mermaid copies these values into a live `<style>` element or style attributes
   without URL sanitization, and CSS `image-set()`/`image()`/escaped/entity-encoded URLs bypass a
   keyword scan. Custom diagram styling is declared unsupported and falls back to source.
4. **Comment model:** the guard copy strips comments exactly as Mermaid does - only lines whose first
   non-space token is `%%` and not `%%{` (`/^\s*%%(?!{)[^\n]+\n?/gm`, plus `trimStart`, matching Mermaid 12.3.0) - never every `%%`. A mid-line
   `%%` is literal text to Mermaid, so stripping to end of line there would hide the tag, URL, and CSS
   guards. The raw `%%{` check runs before this.
5. **Fetch guard:** reject case-insensitive `http://`, `https://`, `//` (protocol-relative),
   `url(`, and `data:<type>/` in the comment-stripped source. Labels containing a URL fall back to
   source; recorded as a limitation.
6. **HTML tag guard:** scan the comment-stripped source for `<tagname`/`</tagname` with
   case-insensitive, namespaced-aware matching. A tag is allowed only when its name is one of `b`,
   `i`, `em`, `strong`, `code`, `span`, `p`, `br`, `sub`, `sup` **and it carries no attributes** (a
   trailing `/` is allowed). Everything else - `img`, `image`, `svg`, `foreignObject`, `style`,
   `script`, `iframe`, `object`, `embed`, `link`, `use`, `a`, `<IMG>`, `<svg:image>` - is rejected,
   as is any `style=`/`on*=`/`src=`/`href=`/`xlink:href=` attribute. The guard runs on source text,
   not on Mermaid/KaTeX-generated markup, so `$$x$$` and `<br/>` still work; `dompurifyConfig`
   remains defence in depth for generated labels.
7. **Config guard:** set `secure` to the default keys plus `theme`, `themeCSS`, `themeVariables`,
   `fontFamily`, `altFontFamily`, `htmlLabels`, `logLevel`, `suppressErrorRendering`, `darkMode`,
   `look`, `layout`, `fontSize`, `dompurifyConfig`, and the twelve diagram section keys
   (`flowchart`, `sequence`, `class`, `state`, `er`, `gantt`, `pie`, `journey`, `gitGraph`, `mindmap`,
   `timeline`, `quadrantChart`) so frontmatter cannot override `flowchart.htmlLabels` or a section
   theme, and set
   `dompurifyConfig: { FORBID_TAGS: ["img", "image", "svg", "foreignObject", "style", "script",
   "iframe", "object", "embed", "link", "use", "foreignobject"] }`. Mermaid's own directive sanitizer only strips
   `<`, `>`, and `url(data:`, and the default `secure` list excludes `themeCSS`, which Mermaid later
   writes with `innerHTML`.
8. **Offscreen temp container:** pass a dedicated `position: fixed; inset-inline-start: -100000px;
   top: 0` container to `mermaid.render(id, text, container)` instead of letting it append to
   `document.body`; it is `aria-hidden`, `pointer-events: none`, and removed in `finally`. The
   render id is a safe token, never derived from the source.
9. **Canary test:** Chromium E2E serves a local canary listener, renders the malicious corpus
   (`%%{init}%%`, `A@{ img: "//127.0.0.1:<port>/canary" }`, `A@{ "img": "/api/ui/auth" }`,
   `A@{ "\u0069mg": "\u002f\u002f127.0.0.1:<port>/canary" }`, a `stateDiagram-v2`
   `classDef pwn fill:image-set(\75rl(\2f\2f127.0.0.1:<port>/canary))` (escaped so only the CSS
   guard can catch it), a `classDiagram` `style A fill:image-set(...)`, an `erDiagram` and a
   `requirementDiagram`/`usecase-beta`/`block-beta`/`agentflow`/`treemap` `classDef` with the escaped CSS, a `graph TD`
   `A-->B; classDef pwn fill:red` (must be rejected before rendering, not styled), a
   frontmatter-prefixed `flowchart` with the escaped CSS, a sequence KaTeX label with a mid-line
   `%%` followed by `<span style="background-image:url(http://127.0.0.1:<port>/canary)">`, a rejected
   attributed `<span style=...>`, `<IMG>`, `<svg:image>`, a Markdown image label, a KaTeX label with
   `<img src="/api/ui/auth">`, mixed-case URLs, `url(...)`, and a frontmatter
   `config: { flowchart: { htmlLabels: true } }`), and asserts zero requests to the canary, zero
   page errors, and the guard caption `This diagram uses unsupported Mermaid syntax; showing
   source.` for the rejected CSS cases (not a generic parse failure). Negative cases with `<br/>`,
   `$$x$$`, a plain `A["label"]`, a mindmap node whose label starts with `style`, and a styled
   `classDiagram` using only built-in classes still render.

Rejected: relying on a keyword scan alone (YAML spelling/escapes); a post-render SVG sanitizer (the
`new Image()` fetch already happened); `securityLevel: "sandbox"` (variant B).

### D15 - Node floor and CI

Raise `package.json engines` to `>=22.12.0`, change the CI matrix to a single `22.12` floor leg (the
other jobs already run Node 22), pin `.nvmrc` to `22.12.0`, and update `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/current-state.md`, and `docs/deployment.md`. The images stay Node 22.
Rejected: pinning Mermaid 11.17.x (owner declined); a redundant `22.12` + `22` matrix (same major).

### D16 - Self-contained third-party notices

Add a generated `licenses/` directory, not a hand-maintained list. A new
`scripts/collect-licenses.mjs` (`npm run licenses:collect`) builds the component set from two
sources and merges them:

1. `npm ls --all --json mermaid` for the declared installed tree.
2. A scan of the installed Mermaid `dist/**/*.map` source maps for the **last**
   `node_modules/((?:@scope/)?name)/` segment of each source path, handling the pnpm layout
   `.pnpm/<name>@<version>/node_modules/<name>/`. This finds packages Mermaid bundles without
   declaring them (`js-yaml@4.3.2` and `fastdom@1.0.12` are the confirmed cases; `langium` is not
   bundled in 12.3.0 and is not asserted). A committed `licenses/bundled-extra.json` carries version, license id, upstream
   URL, and the full license text for scan-only packages that are not installed (so no
   `node_modules` LICENSE file exists), with provenance; `--check` fails if any scan-only package
   lacks an override entry.

For every package it copies `LICENSE`/`LICENSE.md`/`COPYING`/`NOTICE` into a collision-safe
`licenses/<scope>/<name>@<version>.txt` path, falls back to the standard text or the
`bundled-extra.json` text, and writes
`licenses/components.md` with package, version, license, upstream source URL, and whether it came
from `npm ls`, a source map, or the override file. Choose EPL-2.0 for elkjs and Apache-2.0 for
DOMPurify. The generated output is committed; `licenses:collect --check` re-runs it against the
installed tree and fails on drift, and a static test asserts that every package discovered by the
source-map scan appears in `components.md` (including `js-yaml`, not just the declared direct
dependencies); the expected set comes from the scan, not a hard-coded list. `THIRD_PARTY_NOTICES.md` links the directory, and the Dockerfile copies
`licenses/` **and** `THIRD_PARTY_NOTICES.md` into the runtime and IDE images (the IDE stage currently
copies `package.json`, `LICENSE`, and `assets`, but not the notices). `package-lock.json` is
regenerated so its root `engines` also says `>=22.12.0`.

Rejected: a hand-maintained component list (goes stale and misses transitives such as `js-yaml`);
shipping `node_modules` (size); listing URLs without the per-package texts/copyright notices (does
not satisfy MIT/BSD/Apache notices).

## 4. Threat model

Content that reaches these surfaces is untrusted: agent output is influenced by workspace files, web
content, attachments, and sibling handoff specs; handoff specs/results cross application and project
boundaries and are rendered **before** the operator approves them; skill bundles can come from
external sources. A script running on an operator page acts as the operator (the session cookie is
`HttpOnly; SameSite=Strict`, so it cannot be stolen, but same-origin `fetch` with credentials reaches
destructive APIs, SSH execution and approvals, provider-key settings, the terminal, and image
builds).

| # | Attack path | Control | Residual |
| --- | --- | --- | --- |
| T1 | Script/HTML in a label executing at render time | `securityLevel: "strict"` + Mermaid's DOMPurify pass over the serialized SVG + root `htmlLabels: false` + the D14 tag/attribute allowlist and `dompurifyConfig.FORBID_TAGS` (applied to label sanitization; Mermaid's final SVG pass uses its own fixed config) + no click bindings | A Mermaid/DOMPurify bypass in the render step. Pinned version, deliberate updates, an accepted-risk note, and a malicious corpus. |
| T2 | Script in the final artifact | The artifact is `<img src="data:image/svg+xml,...">`; SVG-as-image is script-inert and cannot reach the page | None known; this is the stage's security boundary. |
| T3 | External requests (beacon, LAN probe, tracking) during render | D14 rejects `@{...}` (the image-shape path), all source CSS directives (`classDef`/`style`/`linkStyle`), URL schemes/protocol-relative/`url(`/`data:<type>/`, and non-inline or attributed HTML tags; `secure`/`dompurifyConfig` block overrides; offscreen container; E2E canary | A future Mermaid feature that fetches from a form the guards do not match. The current known vectors (image shape and source CSS) are removed. |
| T4 | CSS bleed or layout hijack from the diagram | The final artifact is an image; the temporary container is offscreen, `aria-hidden`, and removed | The temp SVG lives in the page DOM while drawing (no visible layout, page CSS can influence measurement). Accepted for variant A. |
| T5 | CPU/memory exhaustion (huge graph, many diagrams, pathological input) | Per-diagram caps, 8 diagrams/container, 64-job queue with one retry, one render in flight, 200 ms typing debounce, 32-entry cache, lazy chunks | A graph under 8,000 chars can still be slow; Mermaid needs the DOM, so no cancellable worker. Accepted with caps. |
| T6 | Supply-chain compromise of a helper | Exact version + lockfile integrity + a manual `npm audit --audit-level=high` before merge + self-contained notices | The tree is large; updates are deliberate. |
| T7 | XSS elsewhere in the app reaching diagram content | Out of scope for this stage | No CSP exists on application pages; existing debt. |

Accepted residual, stated plainly: variant A trusts Mermaid and DOMPurify for the *render step*,
then makes the *result* inert. Variant B (sandboxed iframe) would remove T1's render-time exposure
and is the documented fallback if a real bypass appears.

## 5. Impact

| Area | Change |
| --- | --- |
| `assets/markdown.js`, `assets/markdown.d.ts` | Diagram hook, fence grammar, frame states, caps, per-container timers, data URI, try/catch encoding, fallbacks, options type. No npm imports. |
| `ui/chat/mermaid-renderer.ts` (new) | Lazy Mermaid import, whole-operation optional tracking, config + `secure` + `dompurifyConfig`, `detectType`, token theme, serial queue with cancellation and one overflow retry, cache, dimension safety net, per-source failure latch. |
| `ui/chat/mermaid-guard.ts` (new) | Pure source guards (directive, metadata, CSS with type set, URL, tag/attribute) and the comment/frontmatter normalization; no Mermaid import, jsdom-testable. |
| `ui/composables/theme-revision.ts` (new) | Module-level `MutationObserver` singleton exposed as a ref. |
| `ui/optional-chunk.ts` (new) + `ui/main.ts` | Pending counter, claimed/unclaimed preload errors, flush to the normal handler. |
| `ui/components/chat/MarkdownBlock.vue`, `ui/components/SafeMarkdown.vue`, `ui/components/SkillPreviewDrawer.vue`, `ui/components/ExternalSkillDrawer.vue`, `ui/components/SkillSourceDrawer.vue` | `rendererRequested`/`rendererFailed` flags; ensure the renderer only when diagrams are enabled and a fence exists; re-render once when it settles; sealed gating; delay split; theme re-render. |
| `src/http/styles.css`, `DESIGN.md` | `.message__diagram*` primitive; correct the stale subset/sanitizer claims at `DESIGN.md:818` and `:1203`. |
| `src/opencode/process-rules.ts`, `test/process-rules.test.ts` | Content version 3 and the Chat rendering line; hash assertions follow the constant. |
| `package.json` (`engines`), `package-lock.json`, `.nvmrc`, `.github/workflows/ci.yml`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/current-state.md`, `docs/deployment.md` | Node floor `>=22.12.0`, the CI floor leg, and the lockfile root engines. |
| `package.json`, `scripts/collect-licenses.mjs` (new), `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `licenses/` (generated), `licenses/bundled-extra.json`, `Dockerfile` | Mermaid 12.3.0; per-package license texts and a component table from `npm ls` plus the Mermaid source-map scan and the overrides file; `licenses:collect --check`; copies into the runtime and IDE images (including the notices). |
| Tests | New unit cases in the jsdom UI project (markdown, SafeMarkdown, optional-chunk helper, license/doc assertions); new Chromium E2E scenarios. |
| Docs | This design, the plan, ADR 0020, `docs/current-state.md` Markdown-subset sentence, journal 0064, indexes, open questions. |
| Not changed | Diagram storage, routes, APIs, schema, the `/assets/*` allowlist, CSP, terminal/IDE runtime. |

## 6. Non-goals

- Interactive diagrams (click, zoom, pan, links), download/export, or an editor.
- Server-side or cached diagram artifacts in the database.
- Non-Mermaid diagram syntaxes.
- Mermaid `@{ ... }` metadata (new shapes, image/icon shapes); Markdown images/embeds.
- A CSP or a sandboxed renderer (variant B).
- Rendering the raw skill source drawers.

## 7. Verification

| Level | Evidence |
| --- | --- |
| Unit (jsdom) | Valid fence renders an image through a fake renderer, including the delayed `ensureDiagramRenderer()` re-render; unsealed keeps source and does not trigger the renderer load; `Mermaid`, `mermaid title`, and inline occurrences stay code; `ensureDiagramRenderer` runs once and a failed import does not loop; `<br/>` and `$$x$$` still render with the fake; oversized source keeps source + caption and does not call the renderer; parse failure keeps source + caption; too many per container falls back with one caption; a full queue retries once then falls back with the busy caption; 10 containers x 1 diagram do not starve; a stale async result after a text change or unmount is dropped; theme change re-renders; the data URI survives `#`/`&` and a lone surrogate falls back; raw HTML never creates script/img/iframe; `html` fences stay code; `assets/markdown.js` has no bare imports and renders code with no renderer registered; `setDiagramRenderer(null)` unregisters and `ensureDiagramRenderer` respects a fake. |
| Unit (SafeMarkdown) | The handoff review, skill workspace, `SkillPreviewDrawer` `SKILL.md` body, `ExternalSkillDrawer` `.md` preview, and `SkillSourceDrawer` `.md` preview render a valid fence with the fake renderer after the 200 ms delay; a source disclosure keeps the raw text; a binary preview stays a hash/size summary. |
| Unit (guard module) | Pure `mermaid-guard.ts` with a supplied detector key: frontmatter and line-start comments are removed; mid-line `%%` is preserved; `classDef`/`style`/`linkStyle` statement shapes at line or `;` starts are rejected for `flowchart-v2`, `flowchart-elk`, `swimlane`, `classDiagram`, `stateDiagram`, `er`, `requirement`, `usecase`, `block`, `agentflow`, and `treemap`; a class member `style: string` and a node named `style` pass; mindmap labels starting with `style` pass; tags/attributes/URLs are rejected. The renderer catches `UnknownDiagramError` from `detectType`. |
| Unit (optional chunk) | Pending counter; claimed error (no reload); unclaimed error flushed (reload); main-import latch; per-source latch lets another diagram type render; `isOptionalChunkError` separates a chunk failure from a parse error. |
| E2E (Chromium) | `/chat` fixture renders a valid Mermaid fence as `img[data-mermaid-image]` with a `data:image/svg+xml` source, intrinsic size, `alt`, and a source disclosure; `scrollWidth <= clientWidth` with a wide diagram; invalid syntax falls back to source + caption and the CSS cases show the guard caption; the malicious corpus (script, `onclick`, `foreignObject`, `http(s)`, `@{ img }`, quoted/spaced/`\u0069mg` metadata, a `stateDiagram-v2` `classDef` with an escaped `image-set(\75rl(...))`, a `classDiagram` `style`, an `erDiagram`/`requirementDiagram`/`usecase-beta`/`block-beta`/`agentflow`/`treemap` `classDef`, a `graph TD` `A-->B; classDef ...`, a frontmatter-prefixed `flowchart` `classDef`, a sequence KaTeX label with a mid-line `%%` and a `style` URL, a rejected attributed `<span style=...>`, entity/escape-encoded style URLs, `<IMG>`, `<svg:image>`, a Markdown image label, KaTeX + `<img>`, `url(...)`, `%%{init}%%`, and frontmatter `config: { flowchart: { htmlLabels: true } }` for which the HTML-label override is proven ignored, e.g. the label stays SVG text with no `foreignObject`) creates no page error and no request to a local canary; a valid `<br/>` + KaTeX diagram and a mindmap label starting with `style` still render; light/dark toggle re-renders; a page/message without a fence fetches no Mermaid chunk; a blocked main chunk and a blocked per-diagram chunk keep the source and do not reload or replace the SPA. |
| Static | `scripts/check-ui.mjs` (or a named static test) asserts no `mermaid` module appears in any `imports` (static) list and at least one Mermaid chunk appears in `dynamicImports`; `licenses:collect --check` reproduces the committed `licenses/` (no drift); `components.md` contains every package found by the source-map scan (`js-yaml`, `fastdom`, and the rest of the scan set, not a hard-coded `langium`), and `--check` fails when a scan-only package lacks an override; the Dockerfile copies `licenses/` and `THIRD_PARTY_NOTICES.md` into the runtime, agent-base, and IDE images; `package-lock.json` root engines say `>=22.12.0`; the `/assets/*` allowlist and `deploy-contract.json` required assets are unchanged. |
| Gates | `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e`, `npm test`, `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e`. |
| Pre-merge manual | `npm audit --audit-level=high` recorded (not a repository gate). |
| Docs | `docs/current-state.md` no longer claims "no images" and its `vite:preloadError` line (`:492`) describes the optional-chunk source fallback; `DESIGN.md:818`/`:1203` are corrected; live docs (including `CONTRIBUTING.md`) say `>=22.12.0`; historical design/journal records keep their original wording; ADR 0020 records the choice. |

## 8. Open questions

None. Owner decisions (2026-11-20): npm devDependency with a lazy Vite chunk; all three Markdown
surfaces (the raw skill source drawers stay plain text); the persistent agent line with the accepted
restart-required consequence; raise the Node floor to `>=22.12.0` rather than pin Mermaid 11.
Recorded in [`docs/open-questions.md`](../open-questions.md). The `@{...}` metadata exclusion is a
design decision (the only sound way to remove the image-shape fetch path under variant A), not an
open question.

## 9. Design review

### Round 1 - Oracle, 2026-11-20: **FAIL** (4 blockers, 21 findings)

Node floor contradiction; `vite:preloadError` reload; no per-context diagram cap; the
`themeCSS`/directive render-step vector. Folded in rounds 2-3.

### Round 2 - Oracle, 2026-11-20: **FAIL** (3 blockers, 2 must-fix, 5 should-fix, nits)

`img:` shape fetch bypass; per-diagram chunks outside the import tracker; no re-render after the
lazy import resolved; queue starvation; partial notices. Folded in round 3.

### Round 3 - Oracle, 2026-11-20: **FAIL** (2 blockers, 3 must-fix, 5 should-fix, nits)

Blockers: (B1a) the literal `img:` scan is bypassable because Mermaid parses `@{...}` as YAML
(quoted keys, spaces, `\uXXXX` escapes); (B1b) KaTeX labels force HTML labels and a raw `<img>` in a
label survives DOMPurify and fetches during render, so `htmlLabels: false` alone is not a control.

Folded: `@{...}` metadata is rejected outright, which removes the image-shape path and YAML alias
tricks (D14, §6, R14); an inline HTML tag allowlist plus `dompurifyConfig.FORBID_TAGS` and
`dompurifyConfig` in `secure` covers KaTeX/HTML labels (D5, D14, T1); the canary corpus includes the
quoted/spaced/escaped metadata and KaTeX `<img>` variants plus a negative `<br/>` case (§7). Must-fix:
`CONTRIBUTING.md` added to the Node floor set (R15, D15, §5, §7); notices now ship the actual license
texts in `licenses/` with a complete component list, including the IDE image (D16, §5, §7); the stale
`DESIGN.md` subset/sanitizer claims are corrected (D10, §5, §7). Should-fix: `darkMode` moved into
`themeVariables` and R6 scoped to enumerated sections (D6, §2); queue overflow retries once (D7, D9);
encode/serialize wrapped in `try/catch` with a lone-surrogate case (D4, D5, §7); failure latches are
per-source for diagram chunks (D13); the manifest assertion now checks `imports` vs `dynamicImports`
(§7). Nits: chevrotain/Dockerfile/`.nvmrc` wording, module-state and option defaults, the
`data-mermaid` state enum, guard false positives, the chunk-pattern note, alt text, and YAML anchors
(D2, D4, D5, D13, D14, D15, R9).

### Round 4 - Oracle, 2026-11-20: **FAIL** (1 blocker, 1 must-fix, 2 should-fix, nits)

Blocker: Mermaid copies `classDef`/`style`/`linkStyle` CSS into a live `<style>` with only brace
balancing, and DOMPurify allows the `style` attribute on labels, so `image-set()`/escaped/entity
encoded URLs bypass the literal URL guard and fetch during render.

Folded: source CSS directives (`classDef`, `style`, `linkStyle`) are rejected, and the `class`
keyword stays allowed so class diagrams are unaffected; the CSS guard parses a comment-stripped copy,
and the tag guard now rejects attributes and case/namespace variants (D14 items 3-5, §7); a
guard-specific caption was added (D9); the notices move to a generated
`licenses/` directory built from `npm ls --all` with per-package texts (including `js-yaml` and
transitives), a drift check, and copies into the runtime and IDE images (D16, §5, §7); `R6` is
reworded for the global `themeVariables` (D6, R6); `darkMode` is only in `themeVariables` (D6);
`isOptionalChunkError` separates chunk from parse failures (D13); the canary gains CSS/attribute/
Markdown-image cases (D14, §7); the lockfile engines are added (D15, §5, §7); and
`ensureDiagramRenderer` is gated on the sealed/diagrams condition (D3, D12, §7). Nits:
case/namespace/comment handling, the final-pass `dompurifyConfig` wording, and the generic guard
caption (D5, D9, D14, T1).

### Round 5 - Oracle, 2026-11-20: **FAIL** (2 blockers, 1 must-fix, 3 should-fix, nits)

Blockers: (B1) comment stripping was broader than Mermaid's (every `%%` vs line-start only), which hid
the tag/URL/CSS guards for mid-line text; a live fetch was reproduced through a sequence KaTeX label
with a mid-line `%%` and a `style` URL. (B2) the CSS guard matched only line-start statements, but
flowchart allows `;` as a statement separator; `A-->B; classDef pwn fill:red` rendered. Must-fix:
the license collector cannot see `js-yaml`/`langium`, which Mermaid bundles without declaring them, so
`npm ls` alone is incomplete.

Folded: the guard copy strips comments exactly as Mermaid does (line-start, not `%%{`) and the tag/URL
guards run on it (D14 item 4); the CSS guard matches `(?:^|[;\n])\s*(classDef|style|linkStyle)` and is
scoped to flowchart/class/state so mindmap/gantt labels are not false-positive (D14 item 3, §7); the
license collector merges `npm ls`, the Mermaid source-map scan, and a committed
`licenses/bundled-extra.json` (D16, §5, §7); the ensure call site uses
`rendererRequested`/`rendererFailed` and cannot re-arm (D3, D12, §7); `secure` now includes the twelve
section keys so frontmatter cannot set `flowchart.htmlLabels` or a section theme (D14 item 7, §7); the
canary moves the CSS case to state/class, adds the `;` and mid-line `%%` variants, and keeps negative
`<br/>`/KaTeX/mindmap cases (D14 item 9, §7). Nits: `data-mermaid="blocked"`, the notices'
`node_modules` sentence, and the class-diagram wording (D4, D16, §9).

### Round 6 - Oracle, 2026-11-20: **FAIL** (3 blockers, 2 must-fix, 3 should-fix, nits)

Blockers: (B1) the design narrowed the owner's "including external skill sources" by excluding the
`SkillPreviewDrawer`/`ExternalSkillDrawer` previews; (B2) the CSS guard's type set omitted ER (in the
twelve supported types) and requirement/usecase/block, which also accept `classDef`/`style`; (B3)
type detection by "first non-comment word" is defeated by frontmatter and by the `graph`/
`swimlane-beta` flowchart aliases. Must-fix: the license source-map scan used a first-`node_modules`
regex that sees only `.pnpm`, asserted `langium` (not bundled in 12.3.0), and had no license text for
scan-only packages; the renderer queue could not see the frame it was supposed to drop.

Folded: the read-only skill previews are now Markdown surfaces with a `Source` disclosure, and binary
previews stay `<pre>` (scope, R8, D8, §5, §7); the CSS guard uses Mermaid's exported
`mermaid.detectType` (after `initialize`) and covers flowchart aliases, class, state, er, requirement,
usecase, and block, so frontmatter and `graph TD` cannot defeat it (D14 item 3); the guards are a pure
`ui/chat/mermaid-guard.ts` tested in jsdom (D14, §5, §7); the license scan takes the last
`node_modules` segment and handles `.pnpm`, drops the `langium` assertion, and carries scan-only
license text in `licenses/bundled-extra.json` (D16, §5, §7); the renderer contract is
`(source, isCancelled)` so the queue drops cancelled jobs before starting (D2, D3, D7); the canary
adds ER/requirement/usecase/block/`graph`/frontmatter cases with escaped CSS and asserts the guard
caption (D14 item 9, §7); `docs/current-state.md:492` is updated for the optional-chunk fallback (§5,
§7). Nits: Mermaid in the client-bundle notice, `licenses/` in the agent-base image, the `check-ui`
owner, lowercase `foreignobject`, title-based alt text, and the source `<pre>` overflow (D10, D16, R9,
§5, §7).

### Round 7 - Oracle, 2026-11-20: **FAIL** (2 blockers, 2 must-fix, 3 should-fix, nits)

Blockers: (B1) the CSS-capable detector keys were wrong (`class`/`state`/`swimlane-beta` instead of
`classDiagram`/`stateDiagram`/`swimlane`), so the class/state canaries would not be guarded; (B2)
`agentflow` and `treemap` also expose `classDef` and were missing. Must-fix: `detectType` throws
`UnknownDiagramError` (it does not return `error`/unknown); the `usecase` header is `usecase-beta`, not
`usecaseDiagram`. Should-fix: `SkillSourceDrawer` stayed raw; the frontmatter-config canary had no
assertion; `fastdom` is a second scan-only license case; the CSS regex false-positived a class member
`style: string`.

Folded: the guard uses the real detector keys (`flowchart-v2`, `flowchart-elk`, `swimlane`,
`classDiagram`, `stateDiagram`, `er`, `requirement`, `usecase`, `block`, `agentflow`, `treemap`) and
the statement shapes, with `architecture`/`treeView`/`quadrantChart` documented as non-CSS-capable
(D14 item 3, §7); `detectType` throwing is caught and the config copy avoids the `flowchart-elk`
mutation (D14 item 3); `usecase-beta`, `agentflow`, and `treemap` are in the canary (D14 item 9, §7);
`SkillSourceDrawer` is a Markdown surface with a source disclosure and binary previews are not `<pre>`
(scope, R8, D8, §5, §7); the frontmatter `htmlLabels` case asserts the override is ignored (D14 item 9,
§7); `fastdom` joins `js-yaml` in the scan-only overrides and `--check` fails on a missing override
(D16, §5, §7); the CSS match requires the statement shape so `style: string` passes (D14 item 3);
`frontmatterTitle()` supplies the alt text (D2, D4, R9, §7).

### Round 8 - Oracle, 2026-11-20: **FAIL** (1 blocker, 5 must-fix)

Blocker: `venn-beta` exposes a `style` statement, is detected as `venn`, and is absent from the CSS
guard's detector-key set. Oracle reproduced a live canary request from
`venn-beta ... style A fill: "\75rl(\2f\2f127.0.0.1:<port>\2fcanary)"` under
`securityLevel: "strict"`: the escaped value bypasses the URL guard and reaches a live `style`
attribute. Must-fix: the canary header is `agentflow` (the detector/header is `agentflow-beta`);
`swimlane-beta` is missing from the canary; §8 still says the raw skill source drawers stay plain
text, contradicting R8/D8/§5/§7; the license list omits the runner image and still carries the
`node_modules/` sentence; the §5 Tests row omits the guard-module test file.

Round 7 is otherwise closed: the detector keys are correct, `detectType` throws and is caught,
`flowchart-elk`'s config mutation is handled, `usecase-beta`/`classDiagram`/`stateDiagram`/
`block-beta`/`treemap` are valid canaries, the statement-shape regex avoids the class-member false
positive, and the license scan finds `js-yaml`/`fastdom`.

**Cycle paused at the owner's 8-round limit.** The remaining work is six small edits, but the
owner must decide whether to authorize one final targeted pass, switch to the sandboxed-iframe
variant B, or descope. No implementation has started.
