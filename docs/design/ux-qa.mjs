#!/usr/bin/env node
/*
 * Browser gate for the UX polish pass.
 *
 * Usage:
 *   UX_QA_URL=http://127.0.0.1:8799 UX_QA_TOKEN=... node docs/design/ux-qa.mjs
 *
 * The target must be a coordinator with the seeded fixture described in
 * docs/design/artifacts/ux/README.md and a terminal-capable runner (the local
 * fixture uses a fake exec bridge). The harness never adds a product
 * dependency: Playwright and Chromium are resolved like capture.mjs.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, "artifacts", "ux");
const REPORT = path.join(OUT, "report.json");
const BASE = (process.env.UX_QA_URL ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const TOKEN = process.env.UX_QA_TOKEN ?? "qa-token";
const PROJECT = process.env.UX_QA_PROJECT ?? "11111111-1111-4111-8111-111111111111";
const APP = process.env.UX_QA_APP ?? "storefront";
const STOPPED = process.env.UX_QA_STOPPED_APP ?? "fulfillment";
const HOST = new URL(BASE).hostname;

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
  candidates.push(path.resolve(process.cwd(), "node_modules", "playwright", "index.mjs"));
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((entry) => path.join(root, entry, "chrome-linux64", "chrome"))
    .find((candidate) => existsSync(candidate));
}

const modulePath = findPlaywrightModule();
if (!modulePath) {
  console.error("ux-qa: Playwright not found. Install it once with `npx playwright --version`.");
  process.exit(1);
}
const { chromium } = await import(`file://${modulePath}`);
mkdirSync(OUT, { recursive: true });

const report = {
  tool: "ux-qa",
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

const GIT_STATUS = {
  status: {
    state: "ok",
    root: "/tmp/hanse-qa/app",
    branch: { name: "main", detached: false, head: "abc" },
    upstream: null,
    clean: true,
    files: [],
    branches: ["main"],
    remotes: [],
    lastCommit: null,
    operation: null,
    conflicted: false,
    identity: { configured: true },
  },
};

async function openPage(context, url) {
  const page = await context.newPage();
  await page.route(/\/api\/projects\/.*\/git\/status$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(GIT_STATUS),
    }),
  );
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { page, errors };
}

function assertNoErrors(errors, where) {
  check(errors.length === 0, `${where}: console/page errors: ${errors.join(" | ")}`);
}

async function capture(page, name, options = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: options.fullPage === true });
  report.screenshots.push(path.relative(process.cwd(), file));
}

const browser = await chromium.launch(
  findChromium() === undefined ? {} : { executablePath: findChromium() },
);
const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 900 },
  { name: "1440", width: 1440, height: 900 },
];
const themes = ["dark", "light"];

try {
  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await contextFor(browser, viewport.width, viewport.height, theme);
      const { page, errors } = await openPage(context, `/projects/${PROJECT}/apps/${APP}`);
      check(
        (await page.locator("#app-state").count()) === 1,
        "application: state strip is missing",
      );
      check(
        (await page.locator("#settings-pending").count()) === 0,
        "application: legacy pending banner is still rendered",
      );
      const order = await page.evaluate(() => {
        const state = document.querySelector("#app-state");
        const git = document.querySelector("#git-panel");
        return state && git
          ? state.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING
          : 0;
      });
      check(Boolean(order), "application: state strip is not before the git workbench");
      check(
        (await page.locator(".rail-stack #image-panel").count()) === 1,
        "application: image card is not in the rail",
      );
      check(
        (await page.locator(".rail-stack #ssh-panel").count()) === 1,
        "application: SSH card is not in the rail",
      );
      check(
        (await page.locator("details.menu .menu__item").count()) === 2,
        "application: overflow menu is missing its two links",
      );
      await page.locator("details.menu > summary").click();
      check(
        await page.locator("details.menu").evaluate((element) => element.open),
        "application: overflow menu did not open",
      );
      await page.keyboard.press("Escape");
      check(
        !(await page.locator("details.menu").evaluate((element) => element.open)),
        "application: Escape did not close the overflow menu",
      );
      await page.locator("#image-details > summary").click();
      check(
        await page.locator("#image-details").evaluate((element) => element.open),
        "application: image details did not open",
      );
      if ((await page.locator("#image-rollback").count()) === 1) {
        await page.locator("#image-rollback").click();
        check(
          await page.locator("#image-rollback-dialog").evaluate((element) => element.open),
          "application: rollback dialog did not open",
        );
        await page.locator("#image-rollback-dialog [data-dialog-close]").click();
      }
      const overflow = await page.evaluate(() => {
        const pageElement = document.querySelector(".page");
        return pageElement ? pageElement.scrollWidth > pageElement.clientWidth + 1 : false;
      });
      check(!overflow, `application ${viewport.name}: horizontal overflow`);
      await capture(page, `application-${viewport.name}-${theme}`);
      assertNoErrors(errors, `application ${viewport.name} ${theme}`);
      await context.close();
    }
  }

  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await contextFor(browser, viewport.width, viewport.height, theme);
      const { page, errors } = await openPage(context, `/projects/${PROJECT}/apps/${APP}/settings`);
      const rows = await page.locator("details.setting-row").count();
      check(rows >= 7, `settings ${viewport.name}: expected at least 7 setting rows, got ${rows}`);
      check(
        (await page.locator(".page__body table").count()) === 0,
        `settings ${viewport.name}: scope tables are still rendered`,
      );
      check(
        (await page.locator("form[data-settings-form]:visible").count()) === 0,
        `settings ${viewport.name}: a setting form is visible at rest`,
      );
      check(
        (await page.locator("form[data-settings-form]").count()) >= 7,
        `settings ${viewport.name}: expected the setting forms inside disclosures`,
      );
      const height = await page.evaluate(
        () => document.querySelector(".page__body")?.getBoundingClientRect().height ?? 0,
      );
      report.metrics[`settings-${viewport.name}-${theme}`] = Math.round(height);
      await capture(page, `settings-${viewport.name}-${theme}`);
      if (viewport.name === "1440" && theme === "dark") {
        await page.locator("#setting-llm-model > summary").click();
        check(
          (await page.locator("#model-value").getAttribute("placeholder"))?.startsWith(
            "Inherited:",
          ) === true,
          "settings: model placeholder does not name the inherited value",
        );
        await capture(page, "settings-1440-dark-open");
        await page.locator("#setting-web-fetch > summary").click();
        await page.locator("#web-fetch-driver").selectOption("deepseek");
        await page.locator("#setting-web-fetch button[value=set]").click();
        await page.waitForTimeout(600);
        check(
          await page.locator("#setting-web-fetch [data-settings-error]").isVisible(),
          "settings: inline validation error is not visible",
        );
        check(
          (await page.locator("#setting-web-fetch [aria-invalid='true']").count()) >= 1,
          "settings: no field is marked aria-invalid",
        );
        await capture(page, "settings-1440-dark-validation");
        await page.locator("#setting-web-fetch [data-confirm-clear]").click();
        check(
          await page.locator("#settings-clear-dialog").evaluate((element) => element.open),
          "settings: clear dialog did not open",
        );
        await page.locator("#settings-clear-dialog [data-dialog-close]").click();
        await page.locator("#setting-git-ssh > summary").click();
        check(
          (await page.locator("#setting-git-ssh form[data-git-auth]").count()) === 1,
          "settings: Git credential form is missing",
        );
        await capture(page, "settings-1440-dark-git");
      }
      assertNoErrors(
        errors.filter((message) => !message.includes("status of 400")),
        `settings ${viewport.name} ${theme}`,
      );
      await context.close();
    }
  }

  for (const viewport of [
    { name: "390", width: 390, height: 844 },
    { name: "1440", width: 1440, height: 900 },
  ]) {
    for (const theme of themes) {
      const context = await contextFor(browser, viewport.width, viewport.height, theme);
      const { page, errors } = await openPage(context, `/terminal?app=${APP}&project=${PROJECT}`);
      await page.waitForSelector(".xterm", { timeout: 5000 });
      await page.waitForTimeout(500);
      check(
        (await page.locator("#terminal-status").textContent()) === "Live",
        `terminal ${viewport.name}: did not reach Live`,
      );
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("hello");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const screen = await page.locator(".xterm-rows").innerText();
      check(screen.includes("qa:hello"), `terminal ${viewport.name}: input was not echoed`);
      await capture(page, `terminal-${viewport.name}-${theme}`);
      await page.locator("#terminal-close").click();
      await page.waitForTimeout(250);
      check(
        (await page.locator("#terminal-status").textContent()) === "Terminal closed",
        `terminal ${viewport.name}: manual close state is wrong`,
      );
      await page.locator("#terminal-reconnect").click();
      await page.waitForTimeout(700);
      check(
        (await page.locator("#terminal-status").textContent()) === "Live",
        `terminal ${viewport.name}: reconnect did not reach Live`,
      );
      assertNoErrors(errors, `terminal ${viewport.name} ${theme}`);
      await context.close();
    }
  }

  const stoppedContext = await contextFor(browser, 1200, 760, "dark");
  const stopped = await openPage(stoppedContext, `/terminal?app=${STOPPED}&project=${PROJECT}`);
  await stopped.page.waitForTimeout(600);
  check(
    (await stopped.page.locator(".terminal-empty").count()) === 1,
    "terminal stopped: empty state is missing",
  );
  check(
    (await stopped.page.locator("#terminal-status").textContent()) === "Agent stopped",
    "terminal stopped: status is not Agent stopped",
  );
  await capture(stopped.page, "terminal-stopped-1200-dark");
  assertNoErrors(stopped.errors, "terminal stopped");
  await stoppedContext.close();
} catch (error) {
  report.status = "FAIL";
  report.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

console.log(`${report.status}: ${report.assertions} assertions, ${report.errors.length} errors`);
for (const error of report.errors) console.error(`- ${error}`);
process.exit(report.status === "PASS" ? 0 : 1);
