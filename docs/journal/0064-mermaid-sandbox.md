# 0064 - Mermaid sandboxed renderer

Stage `0050-mermaid-sandbox` (variant B), 2026-11-20. Design
[`../design/mermaid-sandbox.md`](../design/mermaid-sandbox.md); plan
[`../plans/0050-mermaid-sandbox.md`](../plans/0050-mermaid-sandbox.md); ADR
[`../decisions/0020-mermaid-sandboxed-rendering.md`](../decisions/0020-mermaid-sandboxed-rendering.md).

## Context

The previous design (variant A, [`../design/mermaid-diagrams.md`](../design/mermaid-diagrams.md))
made the final SVG inert but inspected the source before Mermaid ran. Eight Oracle rounds found
another diagram-specific grammar path each time (image shapes, KaTeX/HTML labels, source CSS,
`venn`, `agentflow`, `treemap`); the guard was becoming a parser. The owner switched to a sandboxed
renderer: one hidden iframe renders full Mermaid syntax and posts only the SVG string back.

## Implemented

- **Frame** (`ui/mermaid-frame.ts`, `vite.mermaid-frame.config.ts`,
  `scripts/build-mermaid-frame.mjs`): a self-contained IIFE bundles Mermaid 12.3.0 and is inlined
  into `assets/ui/mermaid-frame.html`. The HTML has a meta CSP with the SHA-256 hash of its only
  inline script, `default-src 'none'`, `script-src-attr 'none'`, `style-src 'unsafe-inline'`,
  `img-src data:`, `font-src data:`, `connect-src 'none'`, and no workers/frames/media/objects.
  KaTeX CSS and fonts are inlined as data URIs; the artifact SVG receives the same CSS without
  `@font-face`, so it stays under the SVG cap and uses fallback fonts. The frame normalizes width and
  height from the viewBox, strips scripts/event handlers, and posts `{ result, svg }` or `{ error }`.
- **Parent** (`ui/chat/mermaid-protocol.ts`, `ui/chat/mermaid-sandbox.ts`): a lazy hidden iframe with
  `sandbox="allow-scripts"` only, a `MessageChannel` connect, one in-flight render, a 64-job queue, a
  10 s timeout, one frame restart, a session latch, a 32-entry theme+source cache, and cancellation.
  `installMermaidSandbox()` runs at boot; the first diagram creates the frame.
- **Markdown** (`assets/markdown.js` + `.d.ts`): `setDiagramRenderer`/`hasDiagramRenderer`/
  `hasDiagramFence`/`frontmatterTitle` and `renderMarkdown(..., { diagrams, diagramDelayMs })`.
  A diagram keeps its source until the image decodes, restores the source on `img.onerror`, caps the
  source (32,000 chars / 400 lines), SVG (1 MiB), and encoded URI (1.5 MiB), enforces 8 diagrams per
  container, and uses a per-container generation for stale results.
- **Surfaces**: `MarkdownBlock` (sealed chat/handoff/OMO), and `SafeMarkdown` in the handoff review,
  skill workspace, `SkillPreviewDrawer` `SKILL.md` body, and `.md`/`.markdown` previews in
  `ExternalSkillDrawer`/`SkillSourceDrawer`, each with a raw-source disclosure. Binary previews stay
  summaries; editor source panes stay raw. `useThemeRevision()` re-renders on `[data-theme]`.
- **Server**: `uiAsset` serves `mermaid-frame.html` as `text/html` with `no-store`; the rest of
  `/assets/ui/` stays immutable. No route, API, schema, storage, or `/assets/*` allowlist change.
- **Agent rules**: `PROCESS_RULES_VERSION` 3 with `# Hanse agent rules`, `## Process safety`, and a
  `## Chat rendering` line. The hash change marks managed apps restart-required (owner accepted).
- **Node and licenses**: Node floor `>=22.12.0` in engines/lock/`.nvmrc`/CI/live docs; generated
  `licenses/` (112 files) from `npm ls` plus the Mermaid source-map scan and `bundled-extra.json`
  (`js-yaml`, `fastdom`, `langium`), with `licenses:collect --check`, notices, and copies into
  runtime/agent-base/agent-ide/runner.

## Decisions

- Hidden shared iframe, not one visible iframe per diagram: one Mermaid instance and no height
  handshakes.
- Full Mermaid syntax inside the frame: the sandbox and CSP are the boundary; no source-text guards.
- Inert diagrams: no links/zoom/popups; `allow-scripts` only; the source disclosure is the copy path.
- Parent displays only `data:image/svg+xml`; it never inserts SVG markup or assigns `innerHTML`.
- KaTeX fonts are inlined for the frame; the artifact gets the CSS without fonts to respect the
  1.5 MiB encoded-URI cap.

## Evidence

- Frame build: IIFE 5,281.48 kB raw / 1,501.83 kB gzip; HTML 6,741,951 B raw / 2,447,539 B gzip.
- ChatPage chunk: 89,009 B gzip (budget 256,000); the main manifest has no `node_modules/mermaid`.
- Unit: server 3,660 passed / 4 skipped; UI 849 passed; `licenses:collect --check` 112 files.
- E2E: 158 passed / 1 skipped. The Mermaid scenario proves `sandbox="allow-scripts"`,
  `contentDocument === null`, the inert image, a `no-store` frame, no frame on a page without a
  diagram, and no canary response (the CSP-blocked attempt is logged as expected).
- Gates: lint, typecheck, typecheck:ui, typecheck:e2e, build, check:ui, check:sensitive, E2E.

## Residual risks and limits

- The frame is same-process in this deployment; a synchronous CPU loop in it can block the parent
  event loop, so source/SVG caps and `maxTextSize`/`maxEdges` are the control. The 10 s timeout only
  handles async hangs.
- The frame HTML is ~2.45 MB gzip, fetched once per page load when a diagram appears (fixed-name
  `no-store`).
- External images/fonts/CSS are blocked by CSP; a diagram depending on them falls back to source.
  Unregistered `@{ icon: ... }` packs render Mermaid's unknown-icon fallback.
- The artifact's KaTeX uses fallback fonts (the font data is not in the SVG).
- Application pages still have no CSP (existing debt).

## Next

Deploy the stage image and run the operator smoke on the deployment host; no schema or API migration
is required.
