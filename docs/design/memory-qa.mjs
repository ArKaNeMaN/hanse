#!/usr/bin/env node
/*
 * Visual gate for the application Memory card.
 *
 * Usage:
 *   node docs/design/memory-qa.mjs
 *
 * With no MEMORY_QA_URL the harness starts the deterministic E2E fixture
 * (e2e/support/server.ts) on MEMORY_QA_PORT (default 4317) and mocks
 * GET /api/apps/:app/memory locally. Captures and report.json land in
 * docs/design/artifacts/memory/. To target an existing coordinator, set
 * MEMORY_QA_URL, MEMORY_QA_TOKEN, MEMORY_QA_PROJECT, and MEMORY_QA_APP.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, "artifacts", "memory");
const REPORT = path.join(OUT, "report.json");
const PORT = Number(process.env.MEMORY_QA_PORT ?? 4317);
const BASE = (process.env.MEMORY_QA_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const TOKEN = process.env.MEMORY_QA_TOKEN ?? "memory-qa-token";
const PROJECT = process.env.MEMORY_QA_PROJECT ?? "e2e-project-one";
const APP = process.env.MEMORY_QA_APP ?? "alpha";
const HOST = new URL(BASE).hostname;
const SELF_START = process.env.MEMORY_QA_URL === undefined;

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const LIMIT = 2 * GIB;
const PEAK = 1.5 * GIB;
const CURRENT = 500 * MIB;
const AVERAGE = 400 * MIB;

function findPlaywrightModule() {
  const candidates = [];
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
    }
  }
  candidates.push("/usr/lib/node_modules/gsd-pi/node_modules/playwright/index.mjs");
  candidates.push(path.resolve(process.cwd(), "node_modules", "playwright", "index.mjs"));
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  if (existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((entry) => path.join(root, entry, "chrome-linux64", "chrome"))
    .find((candidate) => existsSync(candidate));
}

function memoryPayload() {
  const now = Date.now();
  const span = 24 * 60 * 60 * 1_000;
  const bucketMs = 30 * 60 * 1_000;
  const fromMs = now - span;
  const from = new Date(fromMs).toISOString();
  const buckets = Array.from({ length: 6 }, (_, index) => ({
    start: new Date(fromMs + Math.round((index * span) / 6)).toISOString(),
    minBytes: 300 * MIB,
    averageBytes: AVERAGE,
    maxBytes: index === 3 ? PEAK : 600 * MIB,
    samples: 8,
  }));
  return {
    appId: APP,
    window: { from, to: new Date(now).toISOString(), bucketSeconds: 1_800 },
    summary: {
      currentBytes: CURRENT,
      minBytes: 300 * MIB,
      peakBytes: PEAK,
      averageBytes: AVERAGE,
      limitBytes: LIMIT,
      samples: 48,
      lastSampleAt: new Date(now - 12_000).toISOString(),
    },
    buckets,
    events: [
      {
        at: new Date(fromMs + bucketMs * 4.5).toISOString(),
        kind: "oom_killed",
        message: "container exited with code 137",
      },
    ],
  };
}

const modulePath = findPlaywrightModule();
if (!modulePath) {
  console.error(
    "memory-qa: Playwright not found. Install it once with `npx playwright --version`.",
  );
  process.exit(1);
}
const { chromium } = await import(`file://${modulePath}`);
mkdirSync(OUT, { recursive: true });

const report = {
  tool: "memory-qa",
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  status: "PASS",
  assertions: 0,
  screenshots: [],
  metrics: {},
  errors: [],
};

function check(condition, message) {
  report.assertions += 1;
  if (!condition) {
    report.status = "FAIL";
    report.errors.push(message);
    throw new Error(message);
  }
}

let fixture;
async function startFixture() {
  if (!SELF_START) return undefined;
  const child = spawn(process.execPath, ["--import", "tsx", "e2e/support/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HANSE_E2E_PORT: String(PORT), HANSE_E2E_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited early:\n${output}`);
    }
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return child;
    } catch {
      // The fixture is still starting; keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`fixture server did not become ready:\n${output}`);
}

async function contextFor(browser, width, height, theme) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addCookies([{ name: "hanse_token", value: TOKEN, domain: HOST, path: "/" }]);
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("hanse-theme", value);
    } catch {
      // localStorage can be unavailable; the default theme is still valid.
    }
  }, theme);
  return context;
}

async function openMemory(context) {
  const page = await context.newPage();
  await page.route(/\/api\/apps\/[^/]+\/memory\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(memoryPayload()),
    }),
  );
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${BASE}/projects/${PROJECT}/apps/${APP}`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.querySelectorAll("#app-memory .memory-summary .watch__value").length === 4,
  );
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

async function captureCard(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.locator("#app-memory").screenshot({ path: file });
  report.screenshots.push(path.relative(process.cwd(), file));
}

const chromiumPath = findChromium();
if (chromiumPath === undefined) {
  report.status = "DEFERRED";
  report.errors.push(
    "Chromium unavailable: checked PLAYWRIGHT_CHROMIUM, /usr/bin/chromium, and ~/.cache/ms-playwright.",
  );
  report.finishedAt = new Date().toISOString();
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`DEFERRED: ${report.errors[0]}`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: chromiumPath });
const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];
const themes = ["dark", "light"];

try {
  fixture = await startFixture();
  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await contextFor(browser, viewport.width, viewport.height, theme);
      const { page, errors } = await openMemory(context);
      const label = `memory ${viewport.name} ${theme}`;

      check((await page.locator("#app-memory").count()) === 1, `${label}: card is missing`);
      const order = await page.evaluate(() => {
        const state = document.querySelector("#app-state");
        const card = document.querySelector("#app-memory");
        const git = document.querySelector("#group-git-toggle");
        if (state === null || card === null || git === null) return null;
        return {
          afterState:
            (state.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          beforeGit: (card.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        };
      });
      check(
        order?.afterState === true && order?.beforeGit === true,
        `${label}: card is not between the state strip and the Git group`,
      );

      const values = page.locator("#app-memory .memory-summary .watch__value");
      check((await values.count()) === 4, `${label}: expected four summary cells`);
      const texts = await values.allTextContents();
      check(texts[0] === "500 MiB", `${label}: Current is ${texts[0]}`);
      check(texts[1] === "1.5 GiB", `${label}: Peak is ${texts[1]}`);
      check(texts[2] === "400 MiB", `${label}: Average is ${texts[2]}`);
      check(texts[3] === "2 GiB", `${label}: Limit is ${texts[3]}`);
      check(
        (await page.locator("#app-memory .memory-oom-badge").textContent())?.includes("OOM") ===
          true,
        `${label}: OOM badge is missing`,
      );

      const chart = page.locator("#memory-chart-body");
      if (viewport.width < 768) {
        check((await chart.count()) === 0, `${label}: chart should start collapsed`);
        const toggle = page.locator("#app-memory .memory-chart-toggle");
        check((await toggle.textContent())?.trim() === "Show chart", `${label}: disclosure label`);
        check(
          (await page.locator("#app-memory .memory-summary").isVisible()) &&
            (await page.locator("#app-memory .memory-oom-badge").isVisible()),
          `${label}: summary or OOM badge hidden while collapsed`,
        );
        check(
          (await page.locator('#memory-bucket option[value="10m"]').getAttribute("disabled")) !==
            null,
          `${label}: 10-minute bucket is enabled below 768px`,
        );
        await captureCard(page, `memory-${viewport.name}-${theme}-collapsed`);
        await toggle.click();
        await chart.waitFor({ state: "visible" });
        check(
          (await page.locator("#app-memory .memory-legend").isVisible()) &&
            (await page.locator("#app-memory .memory-oom").isVisible()),
          `${label}: expanded chart is missing the legend or OOM marker`,
        );
        check(
          (await page.locator("#app-memory .memory-summary").isVisible()) &&
            (await page.locator("#app-memory .memory-oom-badge").isVisible()),
          `${label}: summary or OOM badge hidden while expanded`,
        );
      } else {
        check(await chart.isVisible(), `${label}: chart is not visible`);
        check(
          (await page.locator("#app-memory .memory-chart__line").count()) === 1 &&
            (await page.locator("#app-memory .memory-chart__band").count()) === 1 &&
            (await page.locator("#app-memory .memory-chart__limit").count()) === 1,
          `${label}: chart geometry is incomplete`,
        );
        check(
          (await page.locator("#app-memory .memory-legend").textContent())?.includes(
            "min–max band",
          ) === true,
          `${label}: legend is missing`,
        );
        check(
          (await page.locator("#app-memory .memory-oom").count()) === 1,
          `${label}: expected one OOM marker`,
        );
        check(
          (await page.locator("#app-memory .memory-chart__limit-label").textContent())?.includes(
            "Limit 2 GiB",
          ) === true,
          `${label}: limit label is missing`,
        );
      }

      const overflow = await page.evaluate(() => {
        const pageElement = document.querySelector(".page");
        return pageElement ? pageElement.scrollWidth > pageElement.clientWidth + 1 : false;
      });
      check(!overflow, `${label}: horizontal overflow`);
      if (viewport.width >= 768) {
        await captureCard(page, `memory-${viewport.name}-${theme}`);
      } else {
        await captureCard(page, `memory-${viewport.name}-${theme}-open`);
      }
      check(errors.length === 0, `${label}: console/page errors: ${errors.join(" | ")}`);
      report.metrics[`memory-${viewport.name}-${theme}`] = Math.round(
        await page
          .locator("#app-memory")
          .evaluate((element) => element.getBoundingClientRect().height),
      );
      await context.close();
    }
  }
} catch (error) {
  report.status = "FAIL";
  report.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  if (fixture !== undefined && fixture.exitCode === null) {
    fixture.kill("SIGTERM");
  }
}

console.log(`${report.status}: ${report.assertions} assertions, ${report.errors.length} errors`);
for (const error of report.errors) console.error(`- ${error}`);
process.exit(report.status === "PASS" ? 0 : 1);
