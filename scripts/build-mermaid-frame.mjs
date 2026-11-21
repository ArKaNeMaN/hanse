#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Builds the sandboxed Mermaid frame.
 *
 * 1. Vite bundles `ui/mermaid-frame.ts` (and Mermaid) as one IIFE.
 * 2. The IIFE is escaped for an inline `<script>` and inlined into a CSP-locked HTML document.
 * 3. The CSP hash is computed over the exact escaped script text that the browser receives.
 * 4. KaTeX's stylesheet is inlined; the frame entry copies it into the serialized SVG so the
 *    artifact (rendered as an image) keeps the math styling.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "assets", "ui", ".frame-build");
const outputPath = path.join(root, "assets", "ui", "mermaid-frame.html");
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

execFileSync(process.execPath, [viteBin, "build", "--config", "vite.mermaid-frame.config.ts"], {
  cwd: root,
  stdio: "inherit",
});

const scriptPath = path.join(buildDir, "mermaid-frame.iife.js");
const code = readFileSync(scriptPath, "utf8");
const escapedCode = code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "\\x3C!--");
const hash = createHash("sha256").update(escapedCode, "utf8").digest("base64");

const katexDir = path.join(root, "node_modules", "katex", "dist");
const katexCss = readFileSync(path.join(katexDir, "katex.min.css"), "utf8")
  .replace(/url\(fonts\/([^)]+)\)/g, (_match, file) => {
    const bytes = readFileSync(path.join(katexDir, "fonts", file));
    const extension = path.extname(file).slice(1);
    const mime =
      extension === "woff2" ? "font/woff2" : extension === "woff" ? "font/woff" : "font/ttf";
    return `url(data:${mime};base64,${bytes.toString("base64")})`;
  })
  .replace(/<\/style/gi, "<\\/style");

const csp = [
  "default-src 'none'",
  `script-src 'sha256-${hash}'`,
  "script-src-attr 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>Mermaid renderer</title>
<style id="katex-css">${katexCss}</style>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{max-width:none}</style>
</head>
<body>
<script>${escapedCode}</script>
</body>
</html>
`;

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, { encoding: "utf8", mode: 0o600 });
rmSync(buildDir, { recursive: true, force: true });

const rawBytes = Buffer.byteLength(html);
const gzipBytes = gzipSync(html).length;
process.stdout.write(
  `build:frame wrote ${path.relative(root, outputPath)} (${rawBytes} B raw, ${gzipBytes} B gzip)\n`,
);
