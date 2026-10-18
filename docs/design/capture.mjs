#!/usr/bin/env node
/*
 * Capture the primitive showcase with real Playwright Chromium.
 *
 * Usage:
 *   npm run design:showcase          # terminal 1, serves the repo at :4173
 *   node docs/design/capture.mjs     # terminal 2, writes docs/design/artifacts
 *
 * No Playwright dependency is added to the product. The script resolves a local
 * Playwright install (project, npx cache, or the optional gsd-pi global) and
 * reuses an installed Chromium build. Set PLAYWRIGHT_CHROMIUM to override the
 * browser binary.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BASE = process.env.SHOWCASE_URL ?? "http://localhost:4173";
const OUT = path.resolve("docs/design/artifacts");
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];
const THEMES = ["dark", "light"];

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

function findPlaywrightModule() {
  const candidates = [];
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
    }
  }
  candidates.push("/usr/lib/node_modules/gsd-pi/node_modules/playwright/index.mjs");
  candidates.push(path.resolve("node_modules/playwright/index.mjs"));
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = path.join(root, build, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const modulePath = findPlaywrightModule();
if (!modulePath) {
  console.error(
    "Playwright not found. Run `npx playwright --version` once, or install it globally.",
  );
  process.exit(1);
}

const { chromium } = await import(`file://${modulePath}`);
mkdirSync(OUT, { recursive: true });

const executablePath = findChromium();
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function open(width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  return { context, page: await context.newPage() };
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    const { context, page } = await open(viewport.width, viewport.height);
    await page.goto(`${BASE}/docs/design/showcase.html?capture=1&theme=${theme}`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const file = path.join(OUT, `showcase-${viewport.name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
    await context.close();
  }
}

// Real fixed shell at desktop and phone, plus the mobile drawer.
for (const theme of THEMES) {
  {
    const { context, page } = await open(1440, 900);
    await page.goto(`${BASE}/docs/design/showcase.html?theme=${theme}`, {
      waitUntil: "networkidle",
    });
    await page.screenshot({ path: path.join(OUT, `shell-1440-${theme}.png`) });
    await context.close();
  }
  {
    const { context, page } = await open(390, 844);
    await page.goto(`${BASE}/docs/design/showcase.html?theme=${theme}`, {
      waitUntil: "networkidle",
    });
    await page.screenshot({ path: path.join(OUT, `shell-390-${theme}.png`) });
    await context.close();
  }
}

{
  const { context, page } = await open(390, 844);
  await page.goto(`${BASE}/docs/design/showcase.html?theme=dark`, { waitUntil: "networkidle" });
  await page.locator("[data-nav-toggle]").click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(OUT, "shell-390-drawer-dark.png") });
  await context.close();
}

// Focus-visible evidence: real keyboard-visible ring on the text input.
{
  const { context, page } = await open(1440, 900);
  await page.goto(`${BASE}/docs/design/showcase.html?capture=1&theme=dark&focus=1`, {
    waitUntil: "networkidle",
  });
  await page.locator("#field-name").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "focus-visible-1440-dark.png") });
  await context.close();
}

// Overlay states: dialog, toast, tooltip.
for (const theme of THEMES) {
  const { context, page } = await open(1440, 900);
  await page.goto(`${BASE}/docs/design/showcase.html?capture=1&theme=${theme}`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-dialog-open]").first().click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(OUT, `dialog-1440-${theme}.png`) });
  await page.keyboard.press("Escape");
  await page.locator('[data-toast="success"]').first().click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(OUT, `toast-1440-${theme}.png`) });
  await page.locator(".toast button").first().click();
  if (theme === "dark") {
    await page.locator("[data-copy-id]").scrollIntoViewIfNeeded();
    await page.locator("[data-copy-id]").hover();
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(OUT, "tooltip-1440-dark.png") });
  }
  await context.close();
}

await browser.close();
console.log(`evidence in ${path.relative(process.cwd(), OUT)}`);
