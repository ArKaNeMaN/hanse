# ADR-0020: Sandboxed Mermaid rendering

## Status

Accepted (2026-11-20; design [`mermaid-sandbox.md`](../design/mermaid-sandbox.md), Oracle round 1
PASS WITH FIXES; implementation verified in journal 0064).

## Context

The chat and the other Markdown surfaces render fenced code. A ` ```mermaid ` fence is the notation
coding agents use for diagrams, but Mermaid renders by mutating the page DOM and can fetch while it
draws.

Variant A (an inert `data:image/svg+xml` image plus source-text guards) reached eight Oracle design
rounds. Each round found another diagram-specific grammar path (image shapes, KaTeX/HTML labels,
source CSS, `venn`, `agentflow`, `treemap`) that the guard had to model; the guard was becoming a
parser. The owner switched to a sandboxed renderer.

## Decision

1. One hidden iframe renders Mermaid. It is created lazily, shared for the page, and loads a static
   self-contained `assets/ui/mermaid-frame.html` document.
2. The frame is sandboxed with `sandbox="allow-scripts"` only (no same-origin, popups, top
   navigation, forms, downloads, or modals). The document has a meta CSP with a SHA-256 hash for its
   one inline IIFE, `default-src 'none'`, `script-src-attr 'none'`, `style-src 'unsafe-inline'`,
   `img-src data:`, `font-src data:`, `connect-src 'none'`, and no workers/frames/media/objects.
3. The frame renders full Mermaid syntax (`classDef`, `style`, `linkStyle`, `@{...}`, URL-like
   labels) with `securityLevel: "strict"`, `htmlLabels: false`, and a `secure` list for the
   security/appearance keys. KaTeX CSS and fonts are inlined; external images/fonts/CSS are blocked
   by CSP.
4. The parent sends the source over a transferred `MessageChannel` port, serializes renders, caps
   source/SVG/encoded size, times out and restarts the frame once, and latches to source on repeated
   failure. The frame posts only the SVG string.
5. The parent displays that string as an inert `<img src="data:image/svg+xml,...">`; it never inserts
   SVG markup into the page DOM and never assigns `innerHTML`.
6. The frame is a fixed-name static asset with `text/html`, `no-store`; the main Vite bundle does not
   import Mermaid. `/assets/*` allowlist, routes, APIs, schema, and storage are unchanged.

## Alternatives considered

- **Variant A, source-text guards**: rejected after eight review rounds; it was becoming a parser and
  kept missing new diagram types.
- **A visible iframe per diagram**: rejected (N frames, N Mermaid instances, height handshakes).
- **Rendering in the parent and inserting the SVG into a sandboxed `srcdoc`**: the dangerous render
  step would still run in the page.
- **Server-side rendering**: no headless renderer in the coordinator image, adds storage/API, and
  still needs a client boundary.
- **A CSP on application pages**: out of scope; the frame has its own CSP.

## Consequences

Positive: full Mermaid syntax with a real sandbox boundary; no per-type source guards; the final
artifact is inert; one Mermaid instance per page; the main bundle stays free of Mermaid.

Negative / residual:

- The frame HTML is ~6.7 MB raw / ~2.45 MB gzip with inlined KaTeX fonts, fetched once per page load
  only when a diagram appears (fixed-name `no-store`).
- The frame is same-process in the current deployment; a synchronous CPU loop can block the parent
  event loop, so source/SVG caps and `maxTextSize`/`maxEdges` are the control. The 10 s timeout only
  handles async hangs.
- External image/font/CSS requests are blocked by CSP; a diagram that depends on them falls back to
  its source. `@{ icon: ... }` needs a registered icon pack.
- Mermaid is a client devDependency; Node floor rises to `>=22.12.0`; the persistent agent rules
  change version and mark apps restart-required.
- There is still no CSP on the application pages.
