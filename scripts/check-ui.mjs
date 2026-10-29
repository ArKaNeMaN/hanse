#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

if (process.exitCode !== 1) {
  process.stdout.write(`check:ui ok (${vueFiles.length} SFCs, sentinel present)\n`);
}
