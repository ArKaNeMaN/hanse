#!/usr/bin/env node
/**
 * Collect the licenses of the Mermaid renderer's dependency tree.
 *
 * Two sources are merged:
 *   1. the declared installed tree under `npm ls --all --json mermaid`;
 *   2. the package paths embedded in Mermaid's published source maps, which finds packages that
 *      Mermaid bundles without declaring them (js-yaml, fastdom).
 *
 * Scan-only packages are not installed, so their license text comes from
 * `licenses/bundled-extra.json`. `--check` regenerates everything in memory and fails on drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const licensesDir = path.join(root, "licenses");
const packagesDir = path.join(licensesDir, "packages");
const check = process.argv.includes("--check");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function packageJson(name) {
  const file = path.join(root, "node_modules", name, "package.json");
  if (!existsSync(file)) return undefined;
  return readJson(file);
}

function licenseId(pkg) {
  if (typeof pkg?.license === "string") return pkg.license;
  if (
    typeof pkg?.license === "object" &&
    pkg.license !== null &&
    typeof pkg.license.type === "string"
  ) {
    return pkg.license.type;
  }
  if (Array.isArray(pkg?.licenses) && typeof pkg.licenses[0]?.type === "string") {
    return pkg.licenses[0].type;
  }
  return "UNKNOWN";
}

function licenseText(name) {
  const dir = path.join(root, "node_modules", name);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((file) => /^(licen[cs]e|copying|notice)/i.test(file))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return undefined;
  return files
    .map((file) => readFileSync(path.join(dir, file), "utf8").trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function mermaidDependencies() {
  const tree = JSON.parse(
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ls", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const mermaid = tree.dependencies?.mermaid;
  if (mermaid === undefined) throw new Error("mermaid is not installed");
  const packages = new Map();
  packages.set("mermaid", { version: mermaid.version, origin: "npm" });
  const walk = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (!packages.has(name)) {
        packages.set(name, { version: dependency.version, origin: "npm" });
      }
      walk(dependency);
    }
  };
  walk(mermaid);
  return packages;
}

function scanOnlyPackages(packages) {
  const extras = readJson(path.join(licensesDir, "bundled-extra.json"));
  const dist = path.join(root, "node_modules", "mermaid", "dist");
  const seen = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (path.extname(file) !== ".map") continue;
      let map;
      try {
        map = readJson(file);
      } catch {
        continue;
      }
      for (const source of map.sources ?? []) {
        const match =
          /node_modules\/\.pnpm\/((?:@[^/]+\/)?[^/]+)@([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(
            source,
          );
        if (match === null) continue;
        const name = match[3].replace("+", "/");
        if (!packages.has(name) && !seen.has(name)) {
          seen.set(name, match[2].split("_")[0]);
        }
      }
    }
  };
  walk(dist);

  for (const [name, version] of seen) {
    const extra = extras[name];
    if (extra === undefined) {
      throw new Error(
        `scan-only package ${name}@${version} has no licenses/bundled-extra.json entry`,
      );
    }
    packages.set(name, {
      version: extra.version ?? version,
      origin: "sourcemap+override",
      license: extra.license,
      url: extra.url,
      text: extra.text,
    });
  }

  // Packages bundled without a source map (langium) live only in this override file.
  for (const [name, extra] of Object.entries(extras)) {
    if (packages.has(name)) continue;
    packages.set(name, {
      version: extra.version,
      origin: "bundle-override",
      license: extra.license,
      url: extra.url,
      text: extra.text,
    });
  }
}

function build() {
  const packages = mermaidDependencies();
  scanOnlyPackages(packages);

  const files = new Map();
  const rows = [];
  for (const name of [...packages.keys()].sort((a, b) => a.localeCompare(b))) {
    const entry = packages.get(name);
    const pkg = packageJson(name);
    const license = entry.license ?? licenseId(pkg);
    const text = entry.text ?? licenseText(name);
    if (text === undefined) {
      throw new Error(`no license file for ${name}@${entry.version}`);
    }
    const relative = path.join("packages", `${name}@${entry.version}.txt`);
    files.set(relative, `${text}\n`);
    const url = entry.url ?? `https://www.npmjs.com/package/${name}/v/${entry.version}`;
    rows.push(`| ${name} | ${entry.version} | ${license} | ${url} | ${entry.origin ?? "npm"} |`);
  }

  const components = [
    "# Bundled Mermaid component licenses",
    "",
    "Generated by `npm run licenses:collect`. Do not edit by hand.",
    "",
    "| Package | Version | License | Source | Origin |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  files.set("components.md", components);
  return files;
}

const generated = build();

if (check) {
  const drift = [];
  for (const [relative, content] of generated) {
    const file = path.join(licensesDir, relative);
    if (!existsSync(file)) {
      drift.push(`missing ${relative}`);
      continue;
    }
    if (readFileSync(file, "utf8") !== content) drift.push(`changed ${relative}`);
  }
  const known = new Set([...generated.keys()].map((relative) => path.join(licensesDir, relative)));
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "packages") walk(file);
      } else if (!known.has(file) && entry.name !== "bundled-extra.json") {
        drift.push(`unexpected ${path.relative(licensesDir, file)}`);
      }
    }
  };
  if (existsSync(packagesDir)) walk(packagesDir);
  if (drift.length > 0) {
    process.stderr.write(`licenses:collect --check found drift:\n${drift.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`licenses:collect --check ok (${generated.size} files)\n`);
  }
} else {
  rmSync(packagesDir, { recursive: true, force: true });
  for (const [relative, content] of generated) {
    const file = path.join(licensesDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  process.stdout.write(`licenses:collect wrote ${generated.size} files\n`);
}
