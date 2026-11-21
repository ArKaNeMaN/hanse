/**
 * Sandboxed Mermaid renderer.
 *
 * This module is the only place that imports Mermaid. It is built as a self-contained IIFE and
 * inlined into `assets/ui/mermaid-frame.html`; the document is loaded in an iframe with
 * `sandbox="allow-scripts"` and a strict CSP. The parent sends the source over a transferred
 * MessagePort and receives the serialized SVG string; it never inserts SVG markup.
 */
import mermaid from "mermaid";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SOURCE_CHARS = 32_000;
const MAX_SVG_CHARS = 1_048_576;
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "theme",
  "look",
  "layout",
  "themeCSS",
  "themeVariables",
  "dompurifyConfig",
];
const FIXED_WIDTH = {
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
};

interface RenderRequest {
  v: 1;
  type: "render";
  id: string;
  source: string;
  theme?: "dark" | "light";
  tokens?: Record<string, string>;
}

let port: MessagePort | null = null;

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    candidate.type === "render" &&
    typeof candidate.id === "string" &&
    typeof candidate.source === "string"
  );
}

function normalizeSvg(svg: string): string {
  const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = svgDocument.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") {
    throw new Error("Mermaid returned a non-SVG document");
  }

  for (const script of Array.from(root.querySelectorAll("script"))) {
    script.remove();
  }
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const viewBox = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox.length !== 4 ||
    viewBox.some((value) => !Number.isFinite(value)) ||
    (viewBox[2] ?? 0) <= 0 ||
    (viewBox[3] ?? 0) <= 0
  ) {
    throw new Error("Mermaid returned an SVG without a usable viewBox");
  }
  const width = root.getAttribute("width");
  const height = root.getAttribute("height");
  if (width === null || width.includes("%") || !Number.isFinite(Number.parseFloat(width))) {
    root.setAttribute("width", String(viewBox[2]));
  }
  if (height === null || height.includes("%") || !Number.isFinite(Number.parseFloat(height))) {
    root.setAttribute("height", String(viewBox[3]));
  }

  // The artifact is an SVG image: the frame's KaTeX stylesheet must travel with it, otherwise the
  // math renders as duplicate MathML/HTML. Fonts are unavailable in image context and fall back.
  // The frame uses the full KaTeX CSS (with data fonts) for measurement. The artifact cannot
  // carry the font data under the SVG cap, so it gets the same rules without @font-face; labels
  // fall back to the system stack.
  const katex = globalThis.document.getElementById("katex-css")?.textContent ?? "";
  if (katex.length > 0) {
    const style = svgDocument.createElementNS(SVG_NS, "style");
    style.textContent = katex.replace(/@font-face\s*\{[^}]*\}/gi, "");
    root.insertBefore(style, root.firstChild);
  }

  return new XMLSerializer().serializeToString(root);
}

async function render(request: RenderRequest): Promise<string> {
  if (request.source.length > MAX_SOURCE_CHARS) {
    throw new Error("Diagram source is too large");
  }
  const theme = request.theme === "light" ? "light" : "dark";
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE_CHARS,
    maxEdges: 500,
    htmlLabels: false,
    secure: SECURE_KEYS,
    theme: "base",
    themeVariables: { ...(request.tokens ?? {}), darkMode: theme === "dark" },
    look: "classic",
    ...FIXED_WIDTH,
  });
  const id = `hanse-frame-${request.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || String(Date.now())}`;
  const { svg } = await mermaid.render(id, request.source);
  if (svg.length > MAX_SVG_CHARS) {
    throw new Error("Rendered diagram is too large");
  }
  return normalizeSvg(svg);
}

async function handle(value: unknown): Promise<void> {
  if (!isRenderRequest(value) || port === null) return;
  try {
    const svg = await render(value);
    port.postMessage({ v: 1, type: "result", id: value.id, svg });
  } catch (error) {
    port.postMessage({
      v: 1,
      type: "error",
      id: value.id,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
  }
}

window.addEventListener("message", (event) => {
  if (port !== null) return;
  const data = event.data as Record<string, unknown> | null;
  if (data?.v !== 1 || data?.type !== "connect") return;
  const channel = event.ports[0];
  if (channel === undefined) return;
  port = channel;
  port.onmessage = (message) => {
    void handle(message.data);
  };
  port.postMessage({ v: 1, type: "ready" });
});
