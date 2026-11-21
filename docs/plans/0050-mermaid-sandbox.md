# Plan 0050 - Mermaid sandboxed renderer

Stage: `0050-mermaid-sandbox` (variant B). Design:
[`docs/design/mermaid-sandbox.md`](../design/mermaid-sandbox.md) (Oracle round 1 PASS WITH FIXES;
all findings folded). Superseded design: `docs/design/mermaid-diagrams.md` (variant A, rounds 1-8
FAIL).

Owner decisions (2026-11-20): one hidden shared sandboxed iframe renders full Mermaid syntax and
posts the SVG back; the parent shows an inert `data:image/svg+xml` `<img>`; diagrams are inert; all
Markdown surfaces including the three skill drawers; Mermaid 12.3.0 as a pinned devDependency; Node
floor `>=22.12.0`; the persistent agent line (restart-required accepted). Recorded in
[`docs/open-questions.md`](../open-questions.md).

## Bindings

- Design reviewer: `oracle`; plan reviewer: `momus`.
- Design docs: `docs/design/` (index `docs/design/README.md`); plans: `docs/plans/` (index
  `docs/plans/README.md`); ADRs: `docs/decisions/`; journal: `docs/journal/` (index
  `docs/journal/README.md`); open questions: `docs/open-questions.md`.
- Language: English. Verification commands are listed in §6. Commit policy: one coherent stage
  commit after every gate is green; the maintainer authorizes the commit/push (the earlier full-cycle
  authorization applies to this stage).

## Goal

A ` ```mermaid ` fence renders as a diagram on every Markdown surface: the render step runs in one
hidden sandboxed iframe (opaque origin, hashed inline IIFE, strict CSP), and the parent receives only
an SVG string and displays it as an inert image. Full Mermaid syntax works inside the frame; no
source-text guards; no Mermaid in the main bundle.

## Non-goals

Visible per-diagram iframes, links/zoom/pan/popups, server-side rendering or storage, non-Mermaid
syntaxes, a CSP on application pages, binary previews, changing the existing image/attachment
pipeline.

## Invariants

- The parent never assigns `innerHTML` and never inserts SVG markup into the page DOM.
- Only the frame entry (`ui/mermaid-frame.ts`) imports Mermaid; the main Vite manifest contains no
  `node_modules/mermaid`.
- The frame is created lazily, is the only renderer instance, and is sandboxed with
  `allow-scripts` only.
- Every failure keeps the source and adds at most one caption; no page reload, no infinite retry.
- The frame is a public static asset with no data; the app's routes, APIs, schema, `/assets/*`
  allowlist, and existing image pipeline are unchanged.

## Frame/parent constants (carry into implementation)

- Source: 32,000 chars / 400 lines; SVG 1 MiB; encoded data URI 1.5 MiB (Chromium URL limit is
  2 MiB); 8 diagrams per container; 64-job queue; one in flight; 10 s timeout; one frame restart;
  session latch; 32-entry theme+source cache; 200 ms `SafeMarkdown` debounce; 0 for sealed chat.
- Frame config: `startOnLoad:false`, `securityLevel:"strict"`, `suppressErrorRendering:true`,
  `maxTextSize:32000`, `maxEdges:500`, `htmlLabels:false`, the `secure` list from design D5,
  `theme:"base"`, `look:"classic"`, theme variables from the parent, per-type `useMaxWidth:false`
  plus viewBox/`getBBox` width-height normalization.
- Consumers: `HandoffReviewDialog.vue` and `SkillBundleEditor.vue` (existing `SafeMarkdown`), plus
  `SkillPreviewDrawer.vue`, `ExternalSkillDrawer.vue`, and `SkillSourceDrawer.vue` (new Markdown
  previews with a raw-source disclosure); `MarkdownBlock.vue` covers chat/handoff/OMO.
- `assets/markdown.js` exports `setDiagramRenderer(renderer | null)`; null unregisters and restores
  code rendering.
- The parent reads the CSS token set with `getComputedStyle(document.documentElement)` and sends
  concrete values plus `darkMode`; `MarkdownBlock`/`SafeMarkdown` watch `useThemeRevision()`.

## Phase 0 - Build feasibility spike (blocking)

Boundaries: `package.json`/lock (mermaid exact `12.3.0`), `vite.mermaid-frame.config.ts`,
`ui/mermaid-frame.ts` (minimal), `scripts/build-mermaid-frame.mjs` (minimal), a temporary local
Chromium page. No app wiring yet.

Steps:
1. Add `mermaid@12.3.0` as an exact devDependency (`npm install --save-dev --save-exact mermaid@12.3.0`).
2. Build the frame entry as one IIFE (`build.lib`, `formats: ["iife"]`, `name`, 
   `inlineDynamicImports`, `cssCodeSplit:false`, minify, ES2022, no source map) into a temp dir.
3. Assert no top-level-await / `import.meta` / `eval`/`new Function` build failure; measure raw and
   gzip size.
4. Load the generated HTML in headless Chromium with `sandbox="allow-scripts"` and the meta CSP;
   confirm a flowchart renders, `getBBox` works with `visibility:hidden`, the inline script hash is
   accepted, and a `MessageChannel` port receives the SVG.
5. Stop and report if any step fails; do not build the app wiring on an unproven frame.

Acceptance: one self-contained frame HTML; a valid diagram renders in the sandbox; a canary fetch is
blocked; sizes recorded in a "Phase 0 evidence" subsection of this plan (or the journal). Tests: the
temporary Chromium smoke (not committed) plus the build run directly (`npx vite build --config
vite.mermaid-frame.config.ts` then `node scripts/build-mermaid-frame.mjs`); `npm run build:frame`
lands in Phase A.

Risk: IIFE build incompatibility or size. Mitigation: the standalone Mermaid bundle already exists
(~5.3 MB raw); if IIFE fails, stop and report (the design's architecture is invalidated).

## Phase A - Frame build, serving, and CSP plumbing

Boundaries: `vite.mermaid-frame.config.ts`, `scripts/build-mermaid-frame.mjs`, `ui/mermaid-frame.ts`,
`ui/chat/mermaid-protocol.ts`, `src/http/handler.ts`, `scripts/check-ui.mjs`, `package.json`.

Steps:
1. Full frame entry: connect on the transferred port, `ready`, `render` with the fixed config
   (`D5`), post `result`/`error`; normalize width/height from viewBox/`getBBox`; strip `<script>`
   and `on*` from the serialized SVG; inline `katex.min.css` at build time. The Vite config names
   `lib.entry: "ui/mermaid-frame.ts"` and `fileName: () => "mermaid-frame.iife.js"`.
2. Build script: read the IIFE, escape `</script`/`<!--`, hash the escaped text, write
   `assets/ui/mermaid-frame.html` with `<meta charset>`, the CSP meta, the KaTeX CSS, and the inline
   script; remove the temp dir.
3. `package.json`: `build` = `tsc && build:css && build:ui && build:frame`; add `build:frame`.
4. `uiAsset`: `.html` -> `text/html; charset=utf-8`; `no-store` for `mermaid-frame.html`; keep the
   immutable rule for the rest. Add `test/http.test.ts` coverage.
5. `check:ui`: frame HTML exists; CSP hash recomputes over the inline script; no external
   `<script src>`/`<link>`; main manifest has no `node_modules/mermaid`; frame gzip <= 4 MiB.
6. `Dockerfile` build stage: `COPY vite.mermaid-frame.config.ts ./` and
   `COPY scripts/build-mermaid-frame.mjs ./scripts/` before `RUN npm run build` (the stage currently
   copies only package/tsconfigs/vite/src/ui/assets). Phase E/F adds a `docker build --target
   runtime .` gate.

Acceptance: `npm run build` produces the frame; `npm run check:ui` proves hash/laziness/budget; the
server serves the frame as HTML/no-store. Tests: `test/http.test.ts`, `check:ui`; no app wiring.

## Phase B - Parent sandbox client and protocol

Boundaries: `ui/chat/mermaid-protocol.ts`, `ui/chat/mermaid-sandbox.ts`,
`ui/composables/theme-revision.ts`, `ui/main.ts`, `test/ui/mermaid-sandbox.test.ts` (new).

Steps:
1. Protocol types/validators (`v`, `id`, `connect/ready/render/result/error`) with no Mermaid import.
2. Parent client: lazy iframe creation (sandbox attribute set before `src`), MessageChannel connect,
   one in flight, 64 queue, 10 s timeout, one restart, session latch, theme+source 32-entry cache,
   `isCancelled` before start, `setDiagramRenderer` registration, `installMermaidSandbox()`.
3. Theme revision: one module-level `MutationObserver` on `html[data-theme]`, exposed as a ref/subscribe.
4. `ui/main.ts` installs the sandbox at boot; the main bundle imports no Mermaid.
5. Unit tests with fake ports/frame: ready, ids, stale result, timeout/restart/latch, queue overflow,
   cache key, disconnected job, unregister.

Acceptance: tests green; `ui/mermaid-sandbox.ts` has no static Mermaid import; no iframe before the
first render.

## Phase C - Markdown branch, surfaces, and styles

Boundaries: `assets/markdown.js`, `assets/markdown.d.ts`,
`ui/components/chat/MarkdownBlock.vue`, `ui/components/SafeMarkdown.vue`,
`ui/components/SkillPreviewDrawer.vue`, `ui/components/ExternalSkillDrawer.vue`,
`ui/components/SkillSourceDrawer.vue`, `src/http/styles.css`, `DESIGN.md`, `test/ui/chat-markdown.test.ts`.

Steps:
1. `renderMarkdown(container, text, options)`, `setDiagramRenderer(renderer | null)`,
   `hasDiagramRenderer`, `hasDiagramFence`, `frontmatterTitle`; fence info string exact `mermaid`
   case-insensitive after `trim()`; null unregisters.
2. Diagram states (`pending`/`ready`/`error`/`image-error`/`blocked`/`too-large`/`too-many`/`busy`),
   the exact caps from the constants block, `encodeURIComponent` try/catch, source until
   `img.decode()`, `img.onerror` restores source + caption, source `<details>`, cancellation/generation.
3. `MarkdownBlock` and `SafeMarkdown` options, theme watch; the three drawers render Markdown/text
   previews through `SafeMarkdown` with a raw-source disclosure; binary previews stay summaries;
   editor source panes stay raw.
4. Styles for `.message__diagram*` (image max-width, note, source pre overflow) and `DESIGN.md`.
5. Unit tests: fake renderer, caps, cancellation, alt, disclosure, no `innerHTML`, no renderer,
   theme re-render.

Acceptance: unit tests green; a fake renderer proves every surface; the app builds with no Mermaid in
the main manifest.

## Phase D - Real frame, CSP, and E2E

Boundaries: `e2e/spa-chat.spec.ts`, `e2e/support/*` (a deterministic diagram fixture if needed).

Steps:
1. Valid fence -> `img[data-mermaid-image]`; sandbox attribute `allow-scripts`; `contentDocument`
   inaccessible from the parent.
2. Full syntax: `classDef`, `style`, `@{ shape }`, a URL image (blocked), KaTeX (styled once), a
   near-cap diagram, a wide non-flowchart diagram (intrinsic size, no page scroll).
3. Malicious corpus: script, `onclick`, `<img>`, `url()`, `@{ img }`, `%%{init}%%`, external
   CSS/font/worker/frame; no canary response (CSP-blocked attempts are expected), no parent DOM/cookie
   change, and no unexpected page errors.
4. Theme toggle re-renders; blocked frame -> source + caption, no reload; the frame request is
   `no-store`; no Mermaid request on a page without a fence.

Acceptance: E2E green; no canary response; sandbox/CSP evidence captured in the journal.

## Phase E - Agent instruction, Node floor, notices

Boundaries: `src/opencode/process-rules.ts`, `test/process-rules.test.ts`, `package.json` engines,
`package-lock.json`, `.nvmrc`, `.github/workflows/ci.yml`, `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/current-state.md`, `docs/deployment.md`,
`scripts/collect-licenses.mjs`, `licenses/`, `THIRD_PARTY_NOTICES.md`, `Dockerfile`.

Steps:
1. Process rules v3 (`# Hanse agent rules`, `## Process safety`, `## Chat rendering`); hash/version
   tests; accept restart-required.
2. Node floor `>=22.12.0`: engines, lock root, `.nvmrc` 22.12.0, CI floor leg, live docs.
3. Generated licenses (`npm ls` + source-map scan + `bundled-extra.json` for `js-yaml`/`fastdom`),
   `licenses:collect --check`, notices, copies into runtime/agent-base/agent-ide/runner.
4. Update `docs/current-state.md` (the preload line, the Markdown-subset sentence, the static-asset
   list, and `HANSE_ASSETS`), `DESIGN.md` §5.16 and the accepted-debt row, and the ADR. Use content
   anchors, not stale line numbers.

Acceptance: process tests, `check:sensitive`, license check, docs consistency.

## Phase F - Record and commit

1. Run every gate in §6; capture evidence (frame sizes, E2E counts, canary, unit counts).
2. Write `docs/journal/0064-mermaid-sandbox.md`; update the journal/plan/design indexes; ADR 0020;
   set the design/README status to the Oracle verdict (they still say pending).
3. Commit one coherent stage (code + tests + docs + record) and push; report the SHA.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| IIFE build or size | Phase 0 proof; stop if it fails. |
| CSP hash/escape error | Static recomputation in `check:ui`; E2E loads the frame. |
| Same-process hang | Caps; documented residual; no infinite retry. |
| Data-URI limit | Encoded-URI cap 1.5 MiB; near-cap E2E. |
| KaTeX CSS/fonts | Inline CSS; MathML fallback documented. |
| Theme/drawer wiring | Unit + E2E coverage. |
| Node-floor breakage | CI floor leg and live-doc updates. |
| License drift | `licenses:collect --check` + static identifiers. |

## Rollback

Client-only: revert the commit. The frame asset is git-ignored; the main UI returns to code fences if
the sandbox install is removed. No schema/API/route migration.

## Verification commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
npm audit --audit-level=high   # manual, recorded
```

## Plan review

`momus`: **OKAY WITH FIXES** (2026-11-20). Findings folded: the Docker build stage now copies
`vite.mermaid-frame.config.ts` and `scripts/build-mermaid-frame.mjs`; Phase 0 uses the direct Vite
command before `build:frame` exists; the constants/config/consumers are carried in this plan; the
design index status and content anchors are recorded.

## Execution evidence

- Frame: IIFE 5,281.48 kB raw / 1,501.83 kB gzip; `mermaid-frame.html` 6,741,951 B raw /
  2,447,539 B gzip with inlined KaTeX fonts; ChatPage chunk 89,009 B gzip (budget 256,000).
- Unit: server 3,660 passed / 4 skipped; UI 849 passed; `licenses:collect --check` 112 files.
- E2E: 158 passed / 1 skipped; the Mermaid scenario proves the `allow-scripts` sandbox,
  `contentDocument === null`, an inert image, a `no-store` frame, no frame without a diagram, and no
  canary response (the CSP-blocked request is logged as expected).
- Gates: lint, typecheck, typecheck:ui, typecheck:e2e, build, check:ui, check:sensitive, E2E.
