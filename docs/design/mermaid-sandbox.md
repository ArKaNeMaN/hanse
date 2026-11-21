# Design - Mermaid in a sandboxed renderer iframe

Status: **implemented and verified** (2026-11-20) - Oracle round 1 PASS WITH FIXES; journal 0064.

This document supersedes [`mermaid-diagrams.md`](./mermaid-diagrams.md) (variant A: inert image plus
source-text guards). Variant A reached Oracle round 8 FAIL; each round found another Mermaid grammar
path that the text guard had to model, so the guard was becoming a parser. Variant B moves the render
step into a sandboxed iframe and keeps only the inert-image artifact from A.

Scope: the shared browser Markdown renderer (`assets/markdown.js`), the chat feed
(`MarkdownBlock.vue`, including the handoff and OMO cards, which pass `sealed`), the safe Markdown
component (`SafeMarkdown.vue`) in its five consumers (the handoff review dialog, the skill workspace
preview, `SkillPreviewDrawer`, `ExternalSkillDrawer`, and `SkillSourceDrawer`), and the persistent
agent instruction.

Out of scope: a visible iframe per diagram; interactive diagrams (links, zoom, pan, popups); server-
side rendering or storage; non-Mermaid diagram syntaxes; a content-security-policy on the
application pages; binary previews in the skill drawers; changing the existing image/attachment
pipeline.

Governing context: [`docs/current-state.md`](../current-state.md) (the Markdown subset),
[`DESIGN.md`](../../DESIGN.md) §5.16 (chat primitives), [`docs/process.md`](../process.md) (the
delivery pipeline), and [`docs/open-questions.md`](../open-questions.md) (the owner decisions).

---

## 1. Problem

Agents can emit ` ```mermaid ` fences; today the operator sees the source. Variant A made the final
artifact inert but had to inspect the source before Mermaid ran, because Mermaid's render step
touches the page DOM and can fetch. Eight reviews proved that the source inspection must model every
diagram type's CSS/metadata grammar, including new experimental types (`venn`, `agentflow`,
`treemap`, `swimlane`).

Variant B removes the source guard entirely: Mermaid runs inside a sandboxed, opaque-origin iframe
with a strict CSP, and the parent receives only an SVG string that it displays as an inert image. The
iframe cannot reach the parent, cookies, storage, or the network; the artifact cannot execute or
fetch. Full Mermaid syntax is allowed again.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | A fenced code block whose info string, after `trim()`, equals `mermaid` case-insensitively renders as a diagram on the enabled surfaces. Other info strings stay code. |
| R2 | The render step runs only inside a sandboxed iframe with `sandbox="allow-scripts"` (no `allow-same-origin`). The parent never inserts SVG markup into the parent DOM; it receives an SVG string and creates an inert `<img src="data:image/svg+xml,...">`. |
| R3 | Streaming: a chat part renders as code until it is sealed; `SafeMarkdown` renders after a 200 ms debounce. |
| R4 | Every failure - frame load, handshake, CSP, render, timeout, oversized source/SVG, queue full - falls back to the source block with one caption; no blank area, no page reload, no infinite retry. |
| R5 | Caps: source 32,000 chars / 400 lines, SVG 1 MiB, encoded data URI 1.5 MiB (Chromium's URL limit is 2 MiB), 8 diagrams per container, 64 queued, one in flight, 10 s timeout, a restarted frame at most once, a session failure latch, and a 32-entry theme+source cache. |
| R6 | Theme tokens are read in the parent and sent to the frame; `[data-theme]` changes re-render. |
| R7 | Full Mermaid syntax is allowed inside the frame (`classDef`, `style`, `linkStyle`, `@{...}`, URLs in labels), with `securityLevel: "strict"`, `startOnLoad: false`, `suppressErrorRendering: true`, `maxTextSize` and `maxEdges` set. |
| R8 | All Markdown surfaces render diagrams: chat/handoff/OMO via `MarkdownBlock`; `SafeMarkdown` in the handoff review, skill workspace, `SkillPreviewDrawer` body, and `.md`/`.markdown` previews in `ExternalSkillDrawer` and `SkillSourceDrawer`, each with a collapsed raw-source disclosure. Other text, binary previews, and editor source panes stay source-only. |
| R9 | The image has an accessible name (frontmatter title when present, else `Mermaid diagram`); the source stays in a collapsed disclosure whose `<pre>` scrolls on its own; the frame is hidden from assistive technology; wide diagrams never force page scroll. |
| R10 | The persistent agent instruction states that a Mermaid fence is rendered. |
| R11 | No server route, API, schema, or stored data change. The frame is a static asset under `/assets/ui/`; the existing asset handler gains a `text/html` MIME and a no-store rule for that file. |
| R12 | `assets/markdown.js` stays free of npm imports; the sandbox client and frame entry live under `ui/` and the frame entry is the only module that imports Mermaid. |
| R13 | A failed frame never reloads or replaces the SPA; the source stays. |
| R14 | The Node floor is `>=22.12.0`; Mermaid 12.3.0 is a pinned devDependency. |

## 3. Decisions

### D1 - One hidden shared sandbox renders; the parent shows an inert image

A single hidden iframe is created lazily on the first diagram. It imports Mermaid (bundled in the
frame), renders each source, and posts the SVG string over a `MessageChannel`. The parent uses the
string only in an `<img>` data URI. This keeps A's artifact boundary, uses one Mermaid instance, and
keeps the parent DOM text-only.

Rejected: a visible iframe per diagram (N frames, N Mermaid loads, height handshakes); rendering in
the parent and inserting the SVG into a sandboxed `srcdoc` (the dangerous render step would still
run in the parent); a worker (Mermaid needs the DOM).

### D2 - The frame document is self-contained, hashed, and CSP-locked

`ui/mermaid-frame.ts` is built as one minified IIFE and inlined into
`assets/ui/mermaid-frame.html`. The HTML carries:

```
default-src 'none';
script-src 'sha256-<hash>';
script-src-attr 'none';
style-src 'unsafe-inline';
img-src data:;
font-src data:;
connect-src 'none';
media-src 'none';
object-src 'none';
frame-src 'none';
child-src 'none';
worker-src 'none';
base-uri 'none';
form-action 'none'
```

The inline script is the only allowed script; an injected inline script, event handler, external
script, `@import`, font, image, media, worker, or frame is blocked. `style-src 'unsafe-inline'` is required for Mermaid's injected styles; CSS cannot fetch external
resources because `img-src`/`connect-src` allow only data/blocked origins and `font-src` is limited to
the inlined data fonts. Mermaid's `securityLevel: "strict"` also disables click and encodes HTML in labels.

The iframe is created with:

- `sandbox="allow-scripts"` only (no same-origin, popups, top navigation, forms, downloads, modals);
- `referrerpolicy="no-referrer"`, `aria-hidden="true"`, `tabindex="-1"`,
  `title="Mermaid renderer"`;
- offscreen but laid out: `position: fixed; inset-inline-start: -100000px; top: 0;
  inline-size: 1024px; block-size: 768px; visibility: hidden; border: 0`.

The frame is public and static; it contains no data, no secret, and no parent reference. The parent
never reads its DOM.

Rejected: `allow-same-origin` (restores the parent origin and defeats the sandbox); `srcdoc` with the
whole bundle (the parent would hold the 3+ MB string); an external script (module CORS is awkward in
an opaque origin; an external classic script weakens the CSP to a host allowlist); `unsafe-inline`
script (it would allow an injected script).

### D3 - Protocol: MessageChannel, ids, one render in flight, timeout, restart, latch

- The parent creates the iframe on the first render and, on `load`, creates a `MessageChannel`,
  transfers one port with `{ v: 1, type: "connect" }`, and waits for `{ v: 1, type: "ready" }` on its
  port (5 s).
- Each render sends `{ v: 1, type: "render", id, source, theme, tokens }`; the frame replies
  `{ v: 1, type: "result", id, svg }` or `{ v: 1, type: "error", id, message }`.
- One render is in flight; the parent serializes, ignores stale ids, and times out a render at 10 s.
  On a timeout it destroys and recreates the frame once; a second failure latches diagrams to source
  for the session. A queue of 64 bounds history; overflow uses the busy caption.
- The parent validates `v`, `id`, and the port; it does not rely on `event.origin` (the sandboxed
  origin is opaque). The frame only accepts messages on the transferred port.

Rejected: `window.postMessage` with `"*"` and origin checks (opaque origin, easier to confuse); one
iframe per diagram (N bundles); a retry loop (R4).

### D4 - Parent integration: states, cancellation, image-error fallback, exact surfaces

`assets/markdown.js` gains:

```js
export function setDiagramRenderer(renderer) {}   // (source, isCancelled) => Promise<string> | null
export function hasDiagramRenderer() {}
export function hasDiagramFence(text) {}
export function renderMarkdown(container, text, options = {}) {}
```

`options` is `{ diagrams?: boolean, diagramDelayMs?: number }`. The diagram branch creates
`div.message__diagram[data-mermaid="pending"]` with the source `<pre>` and the normal source
disclosure. The source stays visible until the image is proven to decode; on success the frame
replaces the pre with
`<img data-mermaid-image alt="${frontmatterTitle(source) ?? "Mermaid diagram"}"
src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">` plus the source `<details>`.
On `img.onerror`/`decode()` rejection the source is restored and one `Diagram could not be rendered.`
caption is appended. States: `pending`, `ready`, `error`, `image-error`, `blocked`, `too-large`,
`too-many`, `busy`.

Cancellation/ownership: every render receives an `isCancelled()` closure and a per-container
generation. `renderMarkdown` increments the generation at entry; the callback replaces DOM only when
the container is still connected, the generation matches, and the pending pre is still the one it
created. A text change, seal flip, unmount, or session switch drops the result; queued jobs check
`isCancelled()` before they start. `setDiagramRenderer(null)` unregisters; a missing renderer keeps
the source (the standalone-asset behavior).

Caps: source 32,000 chars / 400 lines, SVG 1 MiB, and **encoded** data URI 1.5 MiB
(`encodeURIComponent` can exceed Chromium's 2 MiB URL limit; a 1 MiB SVG is not safe). The encoded
length is checked before creating the image; over-cap uses `too-large`. `encodeURIComponent` is
wrapped in `try/catch` (a lone surrogate throws) and falls back to `error`. `frontmatterTitle()`
extracts a leading `title:` from the fence's frontmatter for the alt text.

Surfaces: `MarkdownBlock` passes `{ diagrams: sealed, diagramDelayMs: 0 }`; the handoff and OMO cards
already pass `sealed`. `SafeMarkdown` passes `{ diagrams: true, diagramDelayMs: 200 }`; it serves the
handoff review dialog, the skill workspace preview, and the three read-only previews:
`SkillPreviewDrawer` renders the `SKILL.md` body through `SafeMarkdown` (source in a disclosure),
`ExternalSkillDrawer` and `SkillSourceDrawer` render `.md`/`.markdown` text previews through
`SafeMarkdown` (source in a disclosure). Non-Markdown text stays `<pre>`; binary previews stay
hash/size summaries; the editor source panes stay raw.

Theme: `MarkdownBlock` and `SafeMarkdown` watch `useThemeRevision()` and call `renderNow()` on a
`[data-theme]` change; the cache key is `theme + "\0" + source`; the sandbox client re-reads the
tokens and sends the new theme; no page reload.

`ui/chat/mermaid-sandbox.ts` registers the renderer at boot (no Mermaid import in the main bundle);
the first render creates the frame. The parent never assigns `innerHTML`.

Rejected: guards on the source (the reason A failed); a lazy `import("mermaid")` in the parent (puts
the library back in the page); a per-component frame (N frames); a fire-and-forget render (stale DOM
after a re-render); keeping the source only as a fallback after a broken image (R4).

### D5 - Full syntax with fixed defaults inside the frame

The frame config is fixed per render. `secure` protects the security/appearance keys from
`%%{init}%%` and frontmatter overrides (Mermaid's default protected list is smaller), and
`htmlLabels: false` keeps ordinary labels as SVG text; `securityLevel: "strict"` remains:

```js
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: 32000,
  maxEdges: 500,
  htmlLabels: false,
  secure: [
    "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
    "suppressErrorRendering", "htmlLabels", "theme", "look", "layout",
    "themeCSS", "themeVariables", "dompurifyConfig",
  ],
  theme: "base",
  themeVariables: { ...tokens, darkMode: theme === "dark" },
  look: "classic",
  flowchart: { htmlLabels: false, useMaxWidth: false },
  sequence: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  gantt: { useMaxWidth: false },
  pie: { useMaxWidth: false },
  journey: { useMaxWidth: false },
  gitGraph: { useMaxWidth: false },
  mindmap: { useMaxWidth: false },
  timeline: { useMaxWidth: false },
  quadrantChart: { useMaxWidth: false },
});
```

Full syntax means `classDef`/`style`/`linkStyle`/`@{...}` and URL-like labels render inside the
frame. The CSP blocks their network effects: `img:` image shapes, CSS `url()`/`@import`, fonts,
`fetch`, WebSocket, workers, frames, and object/embed. `securityLevel: "strict"` disables click;
`htmlLabels: false` keeps ordinary labels as text; the script hash blocks injected scripts. A
`classDef` rule can still restyle the diagram; that is intended. `secure` prevents a directive or
frontmatter from re-enabling HTML, changing the theme/layout, or replacing `themeCSS`; the sandbox
and CSP remain the actual boundary.

`@{...}` covers the new shape/metadata syntax. Iconify icons need a registered pack; unregistered
`@{ icon: ... }` renders Mermaid's unknown-icon fallback. The E2E uses `@{ shape: ... }` and an image
URL case, not an unregistered icon pack.

Sizing: after `mermaid.render`, the frame parses the serialized SVG with `DOMParser` (inert), removes
`<script>` and `on*` attributes as defence in depth, and **always** replaces a missing, `%`, or
`auto` width/height with numbers derived from the `viewBox` (or `getBBox()` when there is no
viewBox). This covers every diagram type, including the ones without a `useMaxWidth` key. An empty
SVG or a failure to derive a size is an error.

Math: Mermaid imports KaTeX dynamically; Mermaid's `dist` does not include the KaTeX stylesheet.
The frame build inlines `katex/dist/katex.min.css` **and its fonts as data URIs**; `font-src data:`
allows those local fonts and blocks every external font URL. The math is styled once (the CSS hides
the duplicate MathML markup). If the
inlined CSS cannot be made to work, the plan records a MathML-only fallback and the E2E asserts no
duplicate/unstyled math rather than claiming full KaTeX fidelity.

Rejected: keeping A's source subset; `securityLevel: "loose"`; a source CSS allowlist (the sandbox is
the boundary); relying on per-type `useMaxWidth` only (incomplete).

### D6 - Theme and sizing

The parent reads `--surface-1`, `--surface-2`, `--inset`, `--line`, `--line-strong`, `--text-1`,
`--text-2`, `--brass`, `--info`, `--success`, `--warning`, `--danger`, `--font-sans` from
`getComputedStyle(document.documentElement)`, sends concrete values plus `darkMode`, and re-renders on
`[data-theme]` changes via one module-level `MutationObserver` (`useThemeRevision()`). The frame maps
them to the Mermaid theme variables (the A mapping table is retained: background transparent,
primary/secondary/tertiary, text, line, note, row/grid, pie cycle, font family).
The frame always normalizes the SVG root to numeric width/height from the viewBox or `getBBox` (D5);
the parent image scales with `max-inline-size: 100%; block-size: auto` and never widens the page.
`MarkdownBlock` and `SafeMarkdown` watch `useThemeRevision()` and call `renderNow()`; the cache key
includes the theme, so a toggle re-renders the visible diagrams. Diagram labels cannot use the page's `@font-face`
resources (the frame is a separate document); the system stack is the accepted fallback.

### D7 - Build and serve one static frame; the main bundle never imports Mermaid

- `vite.mermaid-frame.config.ts` builds `ui/mermaid-frame.ts` as one self-contained IIFE:
  `build.lib` with `name: "HanseMermaidFrame"`, `formats: ["iife"]`,
  `rollupOptions.output.inlineDynamicImports: true`, `cssCodeSplit: false`, minify, target ES2022,
  no source map. It writes to a temporary `assets/ui/.frame-build/` directory.
- `scripts/build-mermaid-frame.mjs` reads the IIFE, applies the exact escape (`</script` ->
  `<\/script`, `<!--` -> `\x3C!--`), computes the SHA-256 base64 hash **over the escaped text**, and
  writes `assets/ui/mermaid-frame.html` with `<meta charset="utf-8">`, the CSP meta, and the inline
  script. It also inlines `katex/dist/katex.min.css` (D5), and removes the temporary directory.
- Build order: `npm run build` is `tsc && build:css && build:ui && build:frame`. `build:ui` empties
  `assets/ui`; the frame is written after it, never before.
- `npm run check:ui` asserts: the frame HTML exists; the CSP `script-src` hash equals a recomputed
  hash of the inline script; there is no external `<script src>`/`<link>`; the main Vite manifest has
  no `node_modules/mermaid` entry (not merely a string match); the frame gzip size is within the
  4 MiB budget. The main chat chunk budget is unchanged.
- `src/http/handler.ts` `uiAsset` adds `.html: "text/html; charset=utf-8"` and a `no-store` rule for
  `mermaid-frame.html` (the rest of `/assets/ui/` stays immutable). The frame is public, static, and
  carries no data. `src/http/server.ts` gzip already covers `text/*`.
- The frame is fixed-name + no-store: it re-downloads once per page load (not per session) when a
  diagram appears. The measured standalone bundle is ~5.3 MB raw / ~1.58 MB gzip; the design records
  the frame's actual sizes and budget. The first diagram pays it; later diagrams reuse the frame.
- The frame HTML is served under the existing `/assets/ui/*` prefix; no new route, API, schema, or
  `/assets/*` allowlist change.

Rejected: an ESM frame chunk in an opaque origin (module CORS/CSP host matching is fragile); a new
HTTP route; Mermaid in the main bundle; an external classic script with a host allowlist.

### D8 - The persistent agent instruction

`src/opencode/process-rules.ts` becomes `# Hanse agent rules` with `## Process safety` (existing
bullets unchanged) and `## Chat rendering` (a fenced ` ```mermaid ` block is rendered as an image; use
it when structure beats prose). `PROCESS_RULES_VERSION` 2 -> 3. The rule hash participates in
`settingsHashFor`, so every managed application reports **Restart required** after the upgrade; the
owner accepted this. Rejected: a separate instruction file (same restart cost, new sidecar).

### D9 - Dependency, Node floor, notices

`mermaid@12.3.0` is a pinned `devDependency`; only the frame build imports it. Node floor
`>=22.12.0` (Mermaid 12.3.0 and `@mermaid-js/parser` declare it), updated in `package.json`,
`package-lock.json`, `.nvmrc` (pin `22.12.0`), the CI matrix (the floor leg), `README.md`,
`AGENTS.md`, `CONTRIBUTING.md`, `docs/current-state.md`, and `docs/deployment.md`; the Dockerfile
`ARG NODE_VERSION` stays on the 22 line and the floor is documented; historical design/journal
records stay unchanged.

The generated `licenses/` plan from variant A is retained: `npm ls --all --json mermaid` plus the
Mermaid source-map scan (last `node_modules` segment, pnpm-aware) and `licenses/bundled-extra.json`
for scan-only packages (`js-yaml`, `fastdom`), per-package texts, `components.md`, `--check`, and
copies into every final image that ships the UI bundle or `node_modules` (runtime, agent-base,
agent-ide, runner). `THIRD_PARTY_NOTICES.md` links `licenses/` and lists Mermaid in the client bundle.

## 4. Threat model

Content is untrusted: agent output is influenced by workspace files, web content, attachments, and
sibling handoff specs; handoff specs/results cross projects and are rendered before approval; skill
bundles can come from external sources. A script in the operator page acts as the operator (the
session cookie is `HttpOnly; SameSite=Strict`, so it cannot be stolen, but same-origin `fetch` reaches
destructive APIs, SSH, provider keys, and builds).

| # | Attack path | Control | Residual |
| --- | --- | --- | --- |
| T1 | Script in a label or Mermaid directive executing in the page | Mermaid runs only in a sandboxed opaque-origin iframe with `allow-scripts`; injected scripts are blocked by the CSP script hash; `securityLevel: "strict"`, `htmlLabels: false`, and the `secure` list; the parent never inserts SVG markup | A browser sandbox or CSP bypass; a Mermaid bug still runs only inside the frame. |
| T2 | Script in the final artifact | The artifact is an `<img>` with a `data:image/svg+xml` source; SVG-as-image is script-inert | None known. |
| T3 | External requests (beacon, LAN probe, tracking) during render | CSP `connect-src 'none'`, `img-src data:`, `font-src data:`, `style-src` with no host, `worker-src/frame-src/child-src/object-src 'none'`, `script-src` hash; sandbox opaque origin | Subresource fetches are blocked. The frame can navigate itself (sandbox and CSP do not reliably block self-navigation); trusted frame code never does, the frame holds no secrets, and the artifact is inert. Canary E2E. |
| T4 | Parent access, cookies, storage, navigation | Sandbox without `allow-same-origin`, popups, top navigation, forms, downloads, or modals; opaque origin | A browser sandbox bypass. |
| T5 | CPU/memory exhaustion | Source/SVG caps, 8/container, 64 queue, 10 s timeout, one in flight, frame restart, `maxTextSize`/`maxEdges` | The timeout handles async hangs only; a synchronous CPU loop in the same-process iframe blocks the parent event loop, so the timeout cannot fire. Caps are the control; a graph under 32,000 chars can still be slow. Accepted. |
| T6 | Supply-chain compromise | Exact version, lockfile, manual `npm audit --audit-level=high`, generated notices | Large tree; deliberate updates. |
| T7 | XSS elsewhere in the app | Out of scope; no app CSP exists (existing debt) | The frame's CSP is independent. |

Accepted residual: the iframe is same-site and may share the renderer process, so a runaway script can
block the event loop; caps are the control. The frame is a public static document with no data.

## 5. Impact

| Area | Change |
| --- | --- |
| `assets/markdown.js`, `assets/markdown.d.ts` | Diagram hook, fence grammar, states, caps, data URI, `frontmatterTitle`, fallbacks; no npm imports. |
| `ui/chat/mermaid-sandbox.ts` (new) | Parent client: lazy frame, protocol, queue, timeout/restart/latch, theme tokens, cache. |
| `ui/chat/mermaid-protocol.ts` (new) | Shared message types and validators; testable with fake ports. |
| `ui/mermaid-frame.ts` (new) | Frame entry: Mermaid import, fixed config, render, post result/error; inlines `katex/dist/katex.min.css` at build time. |
| `ui/composables/theme-revision.ts` (new) | One `MutationObserver` on `[data-theme]`. |
| `ui/main.ts` | `installMermaidSandbox()` at boot. |
| `ui/components/chat/MarkdownBlock.vue`, `SafeMarkdown.vue`, `SkillPreviewDrawer.vue`, `ExternalSkillDrawer.vue`, `SkillSourceDrawer.vue` | Sealed/delay gating, source disclosure, Markdown previews in the drawers. |
| `vite.mermaid-frame.config.ts`, `scripts/build-mermaid-frame.mjs` (new) | IIFE frame build, hash, inline HTML, CSP. |
| `src/http/handler.ts` | `.html` MIME and no-store for the frame; no new route. |
| `src/http/styles.css`, `DESIGN.md` | Diagram primitive and documentation. |
| `src/opencode/process-rules.ts`, test | Version 3 and the Chat rendering line. |
| `package.json`, lock, `.nvmrc`, CI, README, AGENTS, CONTRIBUTING, current-state, deployment | Mermaid devDependency and Node floor. |
| `THIRD_PARTY_NOTICES.md`, `licenses/`, `Dockerfile` | Generated licenses; copies into runtime, agent-base, agent-ide, runner. |
| Tests | `test/ui/mermaid-sandbox.test.ts` (protocol/queue/timeout/latch), `test/ui/chat-markdown.test.ts` (states/caps/cancellation/alt), `test/http.test.ts` (`.html` MIME/no-store), `e2e/spa-chat.spec.ts` (real frame, sandbox/CSP/canary, full syntax, theme, fallback), static checks (hash/manifest/budget). |
| Docs | This design, plan, ADR 0020, current-state, DESIGN, journal 0064, indexes. |
| Not changed | Server routes, APIs, schema, storage, `/assets/*` allowlist, app CSP, existing image pipeline. |

## 6. Non-goals

- A visible iframe per diagram, links, zoom, pan, popups, or editing.
- Server-side rendering or storing diagrams.
- Source-text guards for Mermaid syntax (the sandbox is the boundary).
- Markdown images/embeds outside Mermaid; binary previews.
- A CSP on application pages (the iframe has its own).

## 7. Verification

| Level | Evidence |
| --- | --- |
| Unit (parent) | Fence grammar and states; sealed/delay; source/SVG/encoded-URI caps; the source stays until `img.decode()`; `img.onerror` restores the source + caption; data URI `#`/`&`; lone-surrogate fallback; cancellation on text change/unmount/seal flip; `frontmatterTitle` alt; source disclosure; no `innerHTML`; raw HTML never creates script/img/iframe; theme revision re-renders; `setDiagramRenderer(null)` keeps code. |
| Unit (protocol) | Fake ports/frame: connect/ready, serialized ids, stale responses ignored, timeout -> one restart -> latch, queue overflow -> busy, theme payload, cache keyed by theme+source, a disconnected queued job is dropped. |
| Unit (server) | `uiAsset` serves `mermaid-frame.html` as `text/html` with `no-store`; the rest of `/assets/ui/` stays immutable; traversal is still blocked. |
| E2E (Chromium) | A valid fence renders `img[data-mermaid-image]`; the iframe has `sandbox="allow-scripts"` (no `allow-same-origin`); `contentDocument` is inaccessible from the parent; full syntax (`classDef`, `style`, `@{ shape }`, a URL image, KaTeX styled once) renders; a near-cap diagram does not become a broken image; a wide non-flowchart diagram has intrinsic size and no page scroll; the malicious corpus (script, `onclick`, `<img>`, `url()`, `@{ img }`, `%%{init}%%`, external CSS/font/worker/frame) reaches no canary response and changes no parent DOM/cookie; theme toggles; a blocked frame shows source + caption without reload; the frame is fetched with `no-store`; no Mermaid request on a page without a fence. |
| Static | Frame HTML exists; the CSP hash recomputes over the **escaped** inline script; no external `<script src>`/`<link>`; the inlined KaTeX fonts keep the frame at ~6.7 MB raw / ~2.45 MB gzip (within the 4 MiB budget); the main Vite manifest has no `node_modules/mermaid` entry; notices/licenses present; `check:ui` asserts all of it. |
| Gates | `npm run lint`, `typecheck`, `typecheck:ui`, `typecheck:e2e`, `test`, `build`, `check:ui`, `check:sensitive`, `test:e2e`; manual `npm audit --audit-level=high`. |
| Docs | current-state Markdown subset (`:2130`) and the preload line (`:492`); DESIGN §5.16/`:1203`; `test/process-rules.test.ts` version 3; ADR 0020; journal 0064; live Node-floor docs. |

## 8. Open questions

None. Owner decisions (2026-11-20): hidden shared sandbox renderer -> inert image; full Mermaid
syntax inside the sandbox; inert diagrams. Recorded in [`docs/open-questions.md`](../open-questions.md).

## 9. Design review

### Implementation note - 2026-11-20

Implemented as designed (journal 0064). Two implementation corrections: the CSP uses `font-src
data:` and the build inlines KaTeX's fonts as data URIs; the artifact SVG receives the KaTeX CSS with
`@font-face` removed (fonts fall back), because carrying the font data would exceed the SVG cap. The
license collector also lists `langium`, which is bundled without a source map, from
`licenses/bundled-extra.json`; the E2E canary asserts no **response** because CSP logs the blocked
request attempt. Full gates: lint/typecheck/server 3,660/UI 849/E2E 158 passed (1 skipped).

### Round 1 - Oracle, 2026-11-20: **PASS WITH FIXES**

The sandbox/CSP/protocol core is sound and buildable; Mermaid 12.3.0 has no top-level await,
`import.meta`, or `eval`/`new Function` path, and a standalone IIFE is realistic (~5.3 MB raw /
~1.58 MB gzip). Mermaid's `securityLevel`/`maxTextSize`/`maxEdges` are protected by its default
`secure` list; the frame build, `uiAsset` HTML/no-store addition, MessageChannel flow, and canary
strategy are implementable. Findings folded:

- B1: the three skill drawers are not current `SafeMarkdown` consumers; the design now names the
  per-drawer Markdown/source split and the tests.
- B2: the 1 MiB SVG cap can exceed Chromium's 2 MB data-URL limit; an encoded-URI cap (1.5 MiB) was
  added.
- B3: no image-error fallback; the source now stays until `img.decode()` and `img.onerror` restores it.
- B4: async renders had no cancellation; `isCancelled`/generation/container checks were added.
- B5: theme re-render was not wired; components watch `useThemeRevision()` and the cache is
  theme-keyed.
- B6: intrinsic sizing was not guaranteed for every type; the frame always normalizes width/height
  from the viewBox or `getBBox`.
- B7: "fixed config"/"strict encodes HTML" was too strong; `htmlLabels: false`, the `secure` list, and
  the sandbox/CSP boundary are now stated precisely.
- B8: the KaTeX claim was unsupported; the frame inlines `katex.min.css`, with a documented MathML
  fallback.
- B9: build order/hash exactness; `build:ui && build:frame`, escaping before hashing, `charset`, and a
  static hash recomputation are specified.
- Should-fix: same-process freeze wording, frame self-navigation residual, unregistered icon
  fallback, per-page no-store re-download, Vite lib details, `setDiagramRenderer(null)`, precise
  `check:ui` assertion, and Node pins.
- Nits: R2 wording, current-state/DESIGN corrections, process-rule test version, and the "fixed
  defaults" wording.
