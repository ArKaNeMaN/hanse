#!/usr/bin/env node
/*
 * Browser gate for settings saves without a page refresh.
 *
 * Usage:
 *   SETTINGS_QA_URL=http://127.0.0.1:8799 \
 *   SETTINGS_QA_TOKEN=... \
 *   SETTINGS_QA_PROJECT=<project-id> \
 *   SETTINGS_QA_APP=storefront \
 *   [SETTINGS_QA_SSH=1] \
 *   node docs/design/settings-save-qa.mjs
 *
 * The target coordinator must expose a project/app settings page and have
 * mutable app-scope settings. The harness sets model/web/Git identity, adds a
 * provider key, saves and clears HTTPS credentials, and clears web/provider.
 * It never adds a product dependency: Playwright and Chromium are resolved like
 * docs/design/ux-qa.mjs.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, "artifacts", "ux");
const REPORT = path.join(OUT, "settings-save-report.json");
const BASE = (process.env.SETTINGS_QA_URL ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const TOKEN = process.env.SETTINGS_QA_TOKEN ?? "qa-token";
const PROJECT = process.env.SETTINGS_QA_PROJECT ?? "11111111-1111-4111-8111-111111111111";
const APP = process.env.SETTINGS_QA_APP ?? "storefront";
const RUN_SSH = process.env.SETTINGS_QA_SSH === "1";
const HOST = new URL(BASE).hostname;
const PROVIDER = "qa-live-save";

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
  console.error(
    "settings-save-qa: Playwright not found. Install it once with `npx playwright --version`.",
  );
  process.exit(1);
}
const { chromium } = await import(`file://${modulePath}`);
mkdirSync(OUT, { recursive: true });

const report = {
  tool: "settings-save-qa",
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  project: PROJECT,
  app: APP,
  status: "PASS",
  assertions: 0,
  scenarios: [],
  screenshots: [],
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

async function capture(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.screenshots.push(path.relative(process.cwd(), file));
}

const browser = await chromium.launch(
  findChromium() === undefined ? {} : { executablePath: findChromium() },
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});
await context.addCookies([{ name: "hanse_token", value: TOKEN, domain: HOST, path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

let alive = false;
async function navigate() {
  await page.goto(`${BASE}/projects/${PROJECT}/apps/${APP}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.__settingsDocument = "alive";
  });
  alive = true;
}

async function stillAlive(message) {
  check(alive && (await page.evaluate(() => window.__settingsDocument === "alive")), message);
}

async function dismissToasts() {
  await page.locator(".toast").evaluateAll((nodes) => {
    for (const node of nodes) {
      node.remove();
    }
  });
}

async function post(action, urlPart) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.url().includes(urlPart) && candidate.request().method() === "POST",
    ),
    action(),
  ]);
  const headers = await response.request().allHeaders();
  check(headers["x-hanse-fragment"] === "settings", `fragment header missing on ${urlPart}`);
  const data = await response.json();
  check(response.status() === 200, `status ${response.status()} on ${urlPart}`);
  check(
    data.ok === true && Array.isArray(data.changed) && data.sections !== undefined,
    `invalid fragment payload on ${urlPart}`,
  );
  return data;
}

async function scenario(name) {
  report.scenarios.push(name);
  alive = true;
}

try {
  await navigate();
  check((await page.locator("#settings-agent").count()) === 1, "settings page did not render");

  await scenario("context auto-compaction save and inherit");
  const pendingBefore = await page.locator("#settings-restart [id^=pending-]").count();
  await page.locator("#setting-context-auto-compact > summary").click();
  const contextEnabled = await post(async () => {
    await dismissToasts();
    await page.locator("#context-auto-compact-enabled").selectOption("true");
    await page.locator("#setting-context-auto-compact button[value=set]").click();
  }, "/api/settings");
  await stillAlive("context enabled save reloaded the document");
  check(
    contextEnabled.changed.join(",") === "context,restart,warnings",
    `unexpected context enabled changed: ${contextEnabled.changed}`,
  );
  check(
    (
      await page.locator("#setting-context-auto-compact .setting-row__effective").innerText()
    ).includes("On"),
    "context enabled summary did not update",
  );
  check(
    await page.locator("#setting-context-auto-compact").evaluate((element) => element.open),
    "context enabled row closed",
  );
  check(
    (await page.locator("#setting-context-auto-compact [data-confirm-clear]").count()) === 0,
    "non-clearable context setting rendered a clear action",
  );

  await page.locator("#setting-context-auto-compact-percent > summary").click();
  const contextPercent = await post(async () => {
    await dismissToasts();
    await page.locator("#context-auto-compact-percent").fill("70");
    await page.locator("#setting-context-auto-compact-percent button[value=set]").click();
  }, "/api/settings");
  await stillAlive("context percent save reloaded the document");
  check(
    contextPercent.changed.join(",") === "context,restart,warnings",
    `unexpected context percent changed: ${contextPercent.changed}`,
  );
  check(
    (
      await page
        .locator("#setting-context-auto-compact-percent .setting-row__effective")
        .innerText()
    ).includes("70%"),
    "context percent summary did not update",
  );
  check(
    (await page.locator("#context-auto-compact-percent").inputValue()) === "70",
    "context percent value did not stay",
  );

  const contextInherit = await post(async () => {
    await dismissToasts();
    await page.locator("#setting-context-auto-compact [data-settings-inherit]").click();
  }, "/api/settings");
  await stillAlive("context inherit reloaded the document");
  check(
    contextInherit.changed.join(",") === "context,restart,warnings",
    `unexpected context inherit changed: ${contextInherit.changed}`,
  );
  check(
    (await page.locator("#setting-context-auto-compact .setting-row__source").innerText()).length >
      0,
    "context inherit source line missing",
  );
  check(
    (await page.locator("#settings-restart [id^=pending-]").count()) <= pendingBefore,
    "context save added a restart requirement",
  );
  check(
    !(await page.locator("#settings-restart").innerText()).includes("Auto-compaction"),
    "context save rendered a restart warning",
  );
  await capture(page, "settings-save-context");

  await scenario("model save preserves open rows and drafts");
  await page.locator("#setting-llm-model > summary").click();
  await page.locator("#setting-web-search > summary").click();
  await page.locator("#web-search-driver").selectOption("deepseek");
  await page.locator("#web-search-provider").fill("qa-draft-provider");
  const model = await post(async () => {
    await dismissToasts();
    await page.locator("#model-value").fill("deepseek/deepseek-flash");
    await page.locator("#setting-llm-model button[value=set]").click();
  }, "/api/settings");
  await stillAlive("model save reloaded the document");
  check(
    model.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected model changed: ${model.changed}`,
  );
  check(
    (await page.locator("#setting-llm-model .setting-row__effective").innerText()).includes(
      "deepseek/deepseek-flash",
    ),
    "model summary did not update",
  );
  check(
    await page.locator("#setting-llm-model").evaluate((element) => element.open),
    "model row closed",
  );
  check(
    await page.locator("#setting-web-search").evaluate((element) => element.open),
    "other open row closed",
  );
  check(
    (await page.locator("#web-search-driver").inputValue()) === "deepseek",
    "driver draft lost",
  );
  check(
    (await page.locator("#web-search-provider").inputValue()) === "qa-draft-provider",
    "text draft lost",
  );
  check(
    (await page.evaluate(() => document.activeElement?.closest?.(".setting-row")?.id)) ===
      "setting-llm-model",
    "focus did not return to the saved row",
  );
  check(page.url().endsWith("#setting-llm-model"), `model hash not updated: ${page.url()}`);
  check(await page.locator(".toast").last().isVisible(), "model toast missing");
  await capture(page, "settings-save-model");

  await scenario("web save, clear, and inherit");
  const web = await post(async () => {
    await dismissToasts();
    await page.locator("#web-search-driver").selectOption("builtin");
    await page.locator("#setting-web-search button[value=set]").click();
  }, "/api/settings");
  await stillAlive("web save reloaded the document");
  check(
    web.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected web changed: ${web.changed}`,
  );
  check(
    (await page.locator("#setting-web-search .setting-row__effective").innerText()).includes(
      "builtin",
    ),
    "web summary did not update",
  );
  check(page.url().endsWith("#setting-web-search"), `web hash not updated: ${page.url()}`);
  await page.locator("#setting-web-search [data-confirm-clear]").click();
  check(
    await page.locator("#settings-clear-dialog").evaluate((element) => element.open),
    "web clear dialog did not open",
  );
  const webClear = await post(async () => {
    await page.locator("#settings-clear-form button[type=submit]").click();
  }, "/api/settings");
  await stillAlive("web clear reloaded the document");
  check(
    webClear.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected web clear changed: ${webClear.changed}`,
  );
  check(
    (await page.locator("#setting-web-search .setting-row__effective").innerText()).includes(
      "Cleared",
    ),
    "web clear summary did not update",
  );
  check(
    !(await page.locator("#settings-clear-dialog").evaluate((element) => element.open)),
    "web clear dialog stayed open",
  );
  const inherit = await post(async () => {
    await page.locator("#setting-web-search button[value=inherit]").click();
  }, "/api/settings");
  await stillAlive("web inherit reloaded the document");
  check(
    inherit.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected web inherit changed: ${inherit.changed}`,
  );
  check(
    (await page.locator("#setting-web-search .setting-row__effective").innerText()).includes(
      "builtin",
    ),
    "web inherit summary did not update",
  );

  await scenario("git identity save");
  await page.locator("#setting-git-user-name > summary").click();
  const identity = await post(async () => {
    await dismissToasts();
    await page.locator("#git-user-name").fill("QA Agent");
    await page.locator("#setting-git-user-name button[value=set]").click();
  }, "/api/settings");
  await stillAlive("git identity save reloaded the document");
  check(
    identity.changed.join(",") === "git,restart",
    `unexpected identity changed: ${identity.changed}`,
  );
  check(
    (await page.locator("#setting-git-user-name .setting-row__effective").innerText()).includes(
      "QA Agent",
    ),
    "identity summary did not update",
  );
  check(page.url().endsWith("#setting-git-user-name"), "identity hash not updated");
  await capture(page, "settings-save-git-identity");

  await scenario("HTTPS credential save and clear");
  await page.locator("#setting-git-https > summary").click();
  const https = await post(async () => {
    await dismissToasts();
    await page.locator("#git-https-hosts").fill("github.com");
    await page.locator("#git-https-username").fill("x-access-token");
    await page.locator("#git-https-token").fill("qa-https-secret");
    await page.locator("#setting-git-https button[value=set]").click();
  }, "/api/settings/git");
  await stillAlive("HTTPS save reloaded the document");
  check(https.changed.join(",") === "git,restart", `unexpected HTTPS changed: ${https.changed}`);
  check(
    (await page.locator("#setting-git-https .setting-row__effective").innerText()).includes(
      "github.com",
    ),
    "HTTPS summary did not update",
  );
  check(
    !(await page.locator("body").innerText()).includes("qa-https-secret"),
    "HTTPS secret leaked",
  );
  await dismissToasts();
  page.once("dialog", (dialog) => dialog.accept());
  const httpsClear = await post(async () => {
    await page.locator("#setting-git-https button[value=clear]").click();
  }, "/api/settings/git");
  await stillAlive("HTTPS clear reloaded the document");
  check(
    httpsClear.changed.join(",") === "git,restart",
    `unexpected HTTPS clear changed: ${httpsClear.changed}`,
  );
  check(
    (await page.locator("#setting-git-https .setting-row__effective").innerText()).includes(
      "Cleared",
    ),
    "HTTPS clear summary did not update",
  );
  await capture(page, "settings-save-git-https-clear");

  if (RUN_SSH) {
    await scenario("SSH credential save and clear");
    await page.locator("#setting-git-ssh > summary").click();
    const ssh = await post(async () => {
      await dismissToasts();
      await page
        .locator("#git-ssh-private-key")
        .fill("-----BEGIN OPENSSH PRIVATE KEY-----\nqa-body\n-----END OPENSSH PRIVATE KEY-----");
      await page.locator("#setting-git-ssh button[value=set]").click();
    }, "/api/settings/git");
    await stillAlive("SSH save reloaded the document");
    check(ssh.changed.join(",") === "git,restart", `unexpected SSH changed: ${ssh.changed}`);
    check(
      (await page.locator("#setting-git-ssh .setting-row__effective").innerText()).includes(
        "ssh-ed25519",
      ),
      "SSH summary did not update",
    );
    check(!(await page.locator("body").innerText()).includes("qa-body"), "SSH private key leaked");
    await dismissToasts();
    page.once("dialog", (dialog) => dialog.accept());
    const sshClear = await post(async () => {
      await page.locator("#setting-git-ssh button[value=clear]").click();
    }, "/api/settings/git");
    await stillAlive("SSH clear reloaded the document");
    check(
      sshClear.changed.join(",") === "git,restart",
      `unexpected SSH clear changed: ${sshClear.changed}`,
    );
    check(
      (await page.locator("#setting-git-ssh .setting-row__effective").innerText()).includes(
        "Cleared",
      ),
      "SSH clear summary did not update",
    );
  }

  await scenario("provider add and clear through the shared dialog");
  await page.locator("#providers .provider-add > summary").click();
  const provider = await post(async () => {
    await dismissToasts();
    await page.locator("#provider-new").fill(PROVIDER);
    await page.locator("#provider-new-key").fill("qa-provider-secret");
    await page.locator("#providers .provider-add button[value=set]").click();
  }, "/api/settings/provider");
  await stillAlive("provider save reloaded the document");
  check(
    provider.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected provider changed: ${provider.changed}`,
  );
  const providerRow = page.locator("#providers .setting-row", { hasText: PROVIDER }).first();
  check((await providerRow.count()) === 1, "provider row did not appear");
  check(
    !(await page.locator("body").innerText()).includes("qa-provider-secret"),
    "provider secret leaked",
  );
  await dismissToasts();
  if (!(await providerRow.evaluate((element) => element.open))) {
    await providerRow.locator("summary").click();
  }
  await providerRow.locator("[data-confirm-clear]").click();
  check(
    await page.locator("#settings-clear-dialog").evaluate((element) => element.open),
    "provider clear dialog did not open",
  );
  const providerClear = await post(async () => {
    await page.locator("#settings-clear-form button[type=submit]").click();
  }, "/api/settings/provider");
  await stillAlive("provider clear reloaded the document");
  check(
    providerClear.changed.join(",") === "agent,web,context,restart,warnings",
    `unexpected provider clear changed: ${providerClear.changed}`,
  );
  check(
    (await page.locator("#providers .setting-row", { hasText: PROVIDER }).count()) === 1,
    "cleared provider row disappeared",
  );
  check(
    (
      await page.locator("#providers .setting-row", { hasText: PROVIDER }).first().innerText()
    ).includes("Cleared"),
    "provider clear state not shown",
  );
  check(
    !(await page.locator("#settings-clear-dialog").evaluate((element) => element.open)),
    "provider clear dialog stayed open",
  );
  await capture(page, "settings-save-provider-clear");

  check(errors.length === 0, `console/page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "FAIL";
  report.errors.push(String(error));
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.error(String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
