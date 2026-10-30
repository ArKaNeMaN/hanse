#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(root, "ui");
const cssPath = path.join(root, "assets", "app.css");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(resolved)));
    } else if (entry.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

function fail(message) {
  process.stderr.write(`check:ui: ${message}\n`);
  process.exitCode = 1;
}

const files = await walk(uiDir);
const vueFiles = files.filter((file) => file.endsWith(".vue"));
const offenders = [];

for (const file of vueFiles) {
  const source = await readFile(file, "utf8");
  if (/<style(?:\s|>)/i.test(source)) {
    offenders.push(path.relative(root, file));
  }
}

if (offenders.length > 0) {
  fail(`<style> blocks are not allowed in SFCs: ${offenders.join(", ")}`);
}

let css = "";
try {
  css = await readFile(cssPath, "utf8");
} catch {
  fail(`${path.relative(root, cssPath)} is missing; run "npm run build:css" first`);
}

if (css.length === 0) {
  fail(`${path.relative(root, cssPath)} is empty; run "npm run build:css" first`);
} else if (!css.includes("hanse-ui-sentinel")) {
  fail(`${path.relative(root, cssPath)} is missing the "hanse-ui-sentinel" class`);
}

const manifestPath = path.join(root, "assets", "ui", ".vite", "manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  fail(`${path.relative(root, manifestPath)} is missing; run "npm run build:ui" first`);
}

if (manifest !== null) {
  const entry = Object.entries(manifest).find(([, value]) => value.isEntry === true);
  const chatKey = Object.keys(manifest).find((key) => key.endsWith("pages/ChatPage.vue"));
  const chat = chatKey === undefined ? undefined : manifest[chatKey];

  if (entry === undefined) {
    fail("the UI manifest has no entry chunk");
  } else if (chat === undefined) {
    fail("the UI manifest has no ChatPage chunk");
  } else if (chat.isEntry === true) {
    fail("ChatPage must stay a lazy chunk, not the entry");
  } else if (!(entry[1].dynamicImports ?? []).includes(chatKey)) {
    fail("ChatPage must stay a dynamic import of the entry");
  } else {
    const chatFile = path.join(root, "assets", "ui", chat.file);
    const chatBytes = await readFile(chatFile);
    const gzipBytes = gzipSync(chatBytes).length;
    if (gzipBytes > 250 * 1024) {
      fail(`ChatPage chunk is ${gzipBytes} B gzip; budget is 256000 B`);
    }

    const seen = new Set();
    const queue = [...(entry[1].imports ?? [])];
    while (queue.length > 0) {
      const key = queue.shift();
      if (typeof key !== "string" || seen.has(key)) continue;
      seen.add(key);
      const item = manifest[key];
      if (item === undefined) continue;
      queue.push(...(item.imports ?? []));
    }
    for (const key of seen) {
      const item = manifest[key];
      if (item === undefined) continue;
      if (/ChatPage|TerminalPage|Prism|prism|xterm/i.test(key) || /Prism|xterm/i.test(item.file)) {
        fail(`the entry statically imports ${key}; chat/terminal vendor code must stay lazy`);
      }
    }
    process.stdout.write(
      `check:ui chat chunk ${chat.file}: ${gzipBytes} B gzip (budget 256000 B)\n`,
    );
  }
}

if (process.exitCode !== 1) {
  process.stdout.write(`check:ui ok (${vueFiles.length} SFCs, sentinel present)\n`);
}
