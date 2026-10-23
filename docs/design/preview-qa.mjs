#!/usr/bin/env node
/*
 * Deterministic browser QA for app previews (plan 0023, phase 5, design 8.13).
 *
 * Usage:
 *   npm run build
 *   node docs/design/preview-qa.mjs
 *
 * The harness self-starts a throwaway coordinator (the same shell as the real chat page), injects
 * the server-rendered preview block for scenarios that need previews, intercepts `/api/apps/**`
 * with deterministic fixtures, and injects a fake `EventSource`. Playwright and Chromium are
 * resolved like `docs/design/chat-qa.mjs`; no product dependency is added.
 *
 * Screenshots and `report.json` are written to `docs/design/artifacts/previews/`. The command exits
 * 1 on the first failed assertion, console error, or page error. Missing Playwright is a blocked
 * gate, not a skip.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const ARTIFACTS = path.join(SCRIPT_DIR, "artifacts", "previews");
const REPORT_PATH = path.join(ARTIFACTS, "report.json");

const PROJECT_ID = process.env.PREVIEW_QA_PROJECT ?? "22222222-2222-4222-8222-222222222222";
const APP = path.basename(process.env.PREVIEW_QA_APP ?? "web");
const SESSION_ID = "ses_preview_qa";
const DEMO_HINT = "Demo only. Preview pages share the coordinator's origin and session.";

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
  candidates.push(path.resolve(ROOT, "node_modules", "playwright", "index.mjs"));
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
    "preview-qa: Playwright not found. Run `npx playwright --version` once, set " +
      "PLAYWRIGHT_CHROMIUM to a Chromium binary, or install Playwright globally.",
  );
  process.exit(1);
}

const { chromium } = await import(`file://${modulePath}`);

const report = {
  tool: "preview-qa",
  startedAt: new Date().toISOString(),
  status: "PASS",
  baseUrl: null,
  app: APP,
  project: PROJECT_ID,
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
};

let activeChecks = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
  activeChecks.push(message);
}

function assertEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  check(actualText === expectedText, `${label}: expected ${expectedText}, got ${actualText}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relative(file) {
  return path.relative(ROOT, file);
}

async function shot(page, name) {
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.screenshots.push(relative(file));
  return relative(file);
}

function json(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

async function scenario(name, body) {
  activeChecks = [];
  const startedAt = Date.now();
  try {
    await body();
    report.scenarios.push({
      name,
      status: "PASS",
      checks: activeChecks.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    report.scenarios.push({
      name,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      checks: activeChecks.length,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      probe.close(() => {
        if (port === null) reject(new Error("Could not allocate a local port"));
        else resolve(port);
      });
    });
  });
}

function authFile() {
  const candidates = [
    process.env.HANSE_AUTH_FILE,
    path.join(homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(homedir(), ".config", "opencode", "auth.json"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `preview-qa: server exited with code ${child.exitCode} before it was ready.\n${logs()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status > 0) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`preview-qa: server did not become ready at ${baseUrl}.\n${logs()}`);
    }
    await wait(100);
  }
}

async function startServer() {
  const dist = path.join(ROOT, "dist", "index.js");
  if (!existsSync(dist)) {
    throw new Error(
      [
        "preview-qa: dist/index.js is missing, so the harness cannot self-start a server.",
        "Fix: run `npm run build`, then re-run `node docs/design/preview-qa.mjs`.",
      ].join("\n"),
    );
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "hanse-preview-qa-"));
  const workspace = path.join(tempRoot, "workspace");
  const stateHome = path.join(tempRoot, "state");
  const appRoot = path.join(workspace, APP);
  mkdirSync(path.join(workspace, ".hanse"), { recursive: true });
  mkdirSync(path.join(appRoot, ".hanse"), { recursive: true });
  mkdirSync(stateHome, { recursive: true });

  writeFileSync(
    path.join(appRoot, ".hanse", "app.yaml"),
    [`name: ${APP}`, "kind: web", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(workspace, ".hanse", "project.yaml"),
    [
      `id: ${PROJECT_ID}`,
      "name: Preview QA",
      "base_branch: main",
      "apps:",
      `  - path: ${APP}`,
      "    kind: web",
      "",
    ].join("\n"),
    "utf8",
  );

  const port = await freePort();
  const token = process.env.PREVIEW_QA_TOKEN ?? "qa-token";
  const env = {
    ...process.env,
    HANSE_OPERATOR_TOKEN: token,
    HANSE_RUNTIME_TOKEN: process.env.HANSE_RUNTIME_TOKEN ?? "qa-runtime-token",
    HANSE_IDE: "0",
    HANSE_ASSETS: path.join(ROOT, "assets"),
  };
  const auth = authFile();
  if (auth !== undefined) env.HANSE_AUTH_FILE = auth;

  let output = "";
  const child = spawn(
    process.execPath,
    [
      dist,
      "serve",
      "--workspace",
      workspace,
      "--state-home",
      stateHome,
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child, () => output);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    token,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const deadline = Date.now() + 5_000;
        while (child.exitCode === null && Date.now() < deadline) await wait(50);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function installFakeEventSource() {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      window.__qaEventSource = this;
      window.setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        this.emit({ type: "stream.ready", seq: 0, streamID: "preview-qa-stream" });
      }, 10);
    }

    emit(payload) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    }

    close() {
      this.readyState = 2;
      if (window.__qaEventSource === this) window.__qaEventSource = null;
    }
  }
  window.EventSource = FakeEventSource;
}

function preview(key, name, options = {}) {
  const basePath = `/preview/${encodeURIComponent(PROJECT_ID)}/${encodeURIComponent(
    APP,
  )}/${encodeURIComponent(key)}/`;
  return {
    key,
    name,
    port: options.port ?? 3000,
    url: options.url ?? basePath,
    basePath: options.url ?? basePath,
    basePathWithoutTrailingSlash: (options.url ?? basePath).replace(/\/$/, ""),
    createdAt: "2026-10-23T10:00:00.000Z",
    expiresAt: "2026-10-23T12:00:00.000Z",
  };
}

const LONG_NAME = "Long preview name for the storefront page".slice(0, 40);
const LONG_KEY = "abcdefghijklmnopqrstuvwxyz012345";

function previewsOf(count) {
  return Array.from({ length: count }, (_, index) =>
    preview(`preview-${index + 1}`, `Preview ${index + 1}`),
  );
}

function previewPayload(item) {
  return JSON.stringify({
    ok: true,
    preview: {
      key: item.key,
      name: item.name,
      port: item.port,
      url: item.url,
      base_path: item.basePath,
      base_path_without_trailing_slash: item.basePathWithoutTrailingSlash,
      operator_host: null,
      operator_hostname: null,
      expires_at: item.expiresAt,
    },
  });
}

function toolMessage(id, tool, status, options = {}) {
  const state = { status, input: options.input ?? {} };
  if (options.output !== undefined) state.output = options.output;
  if (options.error !== undefined) state.error = options.error;
  return {
    info: { id: `msg_${id}`, role: "assistant", time: { created: Date.now() } },
    parts: [
      {
        id: `prt_${id}`,
        type: "tool",
        tool,
        state,
      },
    ],
  };
}

function contextSnapshot() {
  return {
    sessionID: SESSION_ID,
    state: "ready",
    used: 124000,
    limit: 200000,
    percent: 62,
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    status: "idle",
    updatedAt: "2026-10-23T12:00:00.000Z",
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: true, percent: 80, source: "app", percentSource: "global" },
  };
}

async function installApiFixture(page, config) {
  const state = {
    previews: structuredClone(config.previews ?? []),
    close: config.close ?? { status: 200, body: { ok: true, closed: true } },
    closeCalls: [],
    previewGets: 0,
  };

  await page.route("**/api/apps/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname.endsWith("/previews") && method === "GET") {
      state.previewGets += 1;
      return json(route, { previews: state.previews });
    }
    const closeMatch = /\/previews\/([^/]+)\/close$/.exec(pathname);
    if (closeMatch !== null && method === "POST") {
      const key = decodeURIComponent(closeMatch[1]);
      state.closeCalls.push({ key, at: Date.now() });
      const response = typeof state.close === "function" ? await state.close(state) : state.close;
      if (response.delayMs) await wait(response.delayMs);
      if (response.status >= 200 && response.status < 300) {
        state.previews = state.previews.filter((item) => item.key !== key);
      }
      return json(route, response.body ?? {}, response.status);
    }
    if (pathname.endsWith("/ssh/approvals")) return json(route, { approvals: [] });
    if (pathname.endsWith("/runtime")) return json(route, { state: "running" });
    if (pathname.endsWith("/sessions") && method === "GET") {
      return json(route, {
        sessions: [{ id: SESSION_ID, title: "Preview QA", time: { updated: Date.now() } }],
      });
    }
    if (pathname.endsWith("/sessions") && method === "POST") {
      return json(route, { id: SESSION_ID, title: "Preview QA", time: { updated: Date.now() } });
    }
    if (pathname.endsWith("/messages") && method === "GET") {
      return json(route, { messages: config.messages ?? [], nextCursor: null });
    }
    if (pathname.endsWith("/prompts")) {
      return json(route, { questions: [], permissions: [], warnings: [] });
    }
    if (pathname.endsWith("/permissions/saved")) return json(route, { permissions: [] });
    if (pathname.endsWith("/todo")) return json(route, { todos: [], truncated: false });
    if (pathname.endsWith("/context")) return json(route, contextSnapshot());
    if (pathname.endsWith("/commands")) {
      return json(route, {
        sources: { hanse: "ok", opencode: "ok" },
        warnings: [],
        commands: [],
      });
    }
    return json(route, {});
  });

  return state;
}

function ssrRow(item) {
  return `<li class="chat-preview" data-preview-key="${item.key}">
        <a class="chat-preview__link" href="${item.url}" target="_blank" rel="noopener noreferrer" title="${item.name}">
          <span class="chat-preview__name">${item.name}</span>
          <span class="chat-preview__key mono" title="${item.key}">${item.key}</span>
          ${externalIcon()}
          <span class="sr-only">(opens in a new tab)</span>
        </a>
        <button class="btn btn-ghost btn-icon btn-sm chat-preview__close" type="button" aria-label="Close preview ${item.name}" hidden>${xIcon()}</button>
      </li>`;
}

function externalIcon() {
  return '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-external"></use></svg>';
}

function xIcon() {
  return '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-x"></use></svg>';
}

function ssrWrapper(previews) {
  return `<div class="chat-context__group" id="chat-previews">
        <hr class="rule" />
        <section class="chat-context__section" aria-labelledby="context-previews-title">
          <div class="cluster summary-row"><h2 class="overline" id="context-previews-title">Previews</h2><span class="caption" id="chat-previews-count">${previews.length} active</span></div>
          <p class="hint">${DEMO_HINT}</p>
          <ul class="chat-previews" id="chat-previews-list" role="list">${previews
            .map(ssrRow)
            .join("")}</ul>
        </section>
      </div>`;
}

async function installDocumentFixture(page, options) {
  await page.route(/\/chat\?/, async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    let html = await response.text();
    html = html.replace(
      '<html lang="en" data-theme="dark">',
      `<html lang="en" data-theme="${options.theme ?? "dark"}">`,
    );
    if (options.previews.length > 0) {
      html = html.replace(
        /<div class="chat-context__group" id="chat-previews" hidden>[\s\S]*?(?=<section class="chat-context__section chat-context-usage")/,
        `${ssrWrapper(options.previews)}\n      `,
      );
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ status: response.status(), headers, body: html });
  });
}

async function openPage(browser, target, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: options.theme ?? "dark",
    reducedMotion: "no-preference",
    javaScriptEnabled: options.javaScript !== false,
  });
  const targetUrl = new URL(target.baseUrl);
  await context.addCookies([
    {
      name: "hanse_token",
      value: target.token,
      domain: targetUrl.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: targetUrl.protocol === "https:",
    },
  ]);
  if (options.javaScript !== false) await context.addInitScript(installFakeEventSource);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  let state = null;
  if (options.javaScript !== false) {
    state = await installApiFixture(page, options.api ?? { previews: [] });
  }
  await installDocumentFixture(page, {
    previews: options.ssrPreviews ?? options.api?.previews ?? [],
    theme: options.theme ?? "dark",
  });
  return { context, page, errors, state };
}

async function gotoChat(page, target) {
  const query = new URLSearchParams({ app: APP, project: PROJECT_ID });
  await page.goto(`${target.baseUrl}/chat?${query.toString()}`, { waitUntil: "networkidle" });
}

function checkNoErrors(errors) {
  if (errors.length > 0) {
    report.consoleErrors.push(...errors);
    throw new Error(`console/page errors:\n${errors.join("\n")}`);
  }
}

function checkExpectedHttpError(errors, status) {
  const pattern = new RegExp(`Failed to load resource.*status of ${status}`);
  const unexpected = errors.filter((entry) => !pattern.test(entry));
  if (unexpected.length > 0) {
    report.consoleErrors.push(...unexpected);
    throw new Error(`console/page errors:\n${unexpected.join("\n")}`);
  }
}

async function openDrawer(page) {
  await page.evaluate(() => {
    const shell = document.getElementById("chat-shell");
    if (shell !== null) shell.dataset.chatContext = "open";
  });
  await wait(300);
}

async function waitForPreviewRows(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".chat-preview").length === expected,
    count,
    { timeout: 10_000 },
  );
}

async function railMetrics(page) {
  return page.evaluate(() => {
    const wrapper = document.getElementById("chat-previews");
    const list = document.getElementById("chat-previews-list");
    const rail = document.getElementById("chat-context");
    const documentOverflow =
      document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return {
      wrapperHidden: wrapper === null || wrapper.hidden,
      wrapperBox: wrapper === null ? 0 : wrapper.getBoundingClientRect().height,
      headingVisible:
        document.getElementById("context-previews-title")?.getBoundingClientRect().height ?? 0,
      count: document.querySelectorAll(".chat-preview").length,
      countText: document.getElementById("chat-previews-count")?.textContent ?? "",
      listClientHeight: list?.clientHeight ?? 0,
      listScrollHeight: list?.scrollHeight ?? 0,
      listClientWidth: list?.clientWidth ?? 0,
      listScrollWidth: list?.scrollWidth ?? 0,
      railClientWidth: rail?.clientWidth ?? 0,
      railScrollWidth: rail?.scrollWidth ?? 0,
      documentOverflow,
    };
  });
}

async function runEmpty(browser, target) {
  await scenario("empty rail", async () => {
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [] },
    });
    try {
      await gotoChat(page, target);
      const metrics = await railMetrics(page);
      check(metrics.wrapperHidden, "empty wrapper is hidden");
      assertEqual(metrics.count, 0, "empty row count");
      assertEqual(metrics.countText, "0 active", "empty count text");
      check(metrics.headingVisible === 0, "empty heading has no layout box");
      check(metrics.wrapperBox === 0, "empty wrapper has no layout box");
      check(!metrics.documentOverflow, "empty page has no horizontal overflow");
      const hrBox = await page.evaluate(
        () => document.querySelector("#chat-previews hr")?.getBoundingClientRect().height ?? 0,
      );
      check(hrBox === 0, "empty divider is not rendered");
      await shot(page, "previews-empty-1440");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("empty rail joins an empty JS refresh", async () => {
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [] },
      ssrPreviews: [preview("solo", "Solo")],
    });
    try {
      await gotoChat(page, target);
      await page.waitForFunction(() => document.getElementById("chat-previews")?.hidden === true, {
        timeout: 10_000,
      });
      const metrics = await railMetrics(page);
      check(metrics.wrapperHidden, "refresh empties the wrapper");
      assertEqual(metrics.count, 0, "refresh removes rows");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("empty rail at 390", async () => {
    const { context, page, errors } = await openPage(browser, target, {
      width: 390,
      api: { previews: [] },
    });
    try {
      await gotoChat(page, target);
      await openDrawer(page);
      const metrics = await railMetrics(page);
      check(metrics.wrapperHidden, "empty wrapper is hidden at 390");
      check(!metrics.documentOverflow, "empty page has no horizontal overflow at 390");
      await shot(page, "previews-empty-390");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

async function runRail(browser, target) {
  for (const [width, theme] of [
    [1440, "dark"],
    [1440, "light"],
    [390, "dark"],
    [390, "light"],
  ]) {
    await scenario(`three previews at ${width} ${theme}`, async () => {
      const previews = previewsOf(3);
      const { context, page, errors } = await openPage(browser, target, {
        width,
        theme,
        api: { previews },
      });
      try {
        await gotoChat(page, target);
        if (width < 768) await openDrawer(page);
        await waitForPreviewRows(page, 3);
        const metrics = await railMetrics(page);
        check(!metrics.wrapperHidden, "wrapper visible with rows");
        assertEqual(metrics.count, 3, "three rows");
        assertEqual(metrics.countText, "3 active", "three-row count");
        check(!metrics.documentOverflow, `no document overflow at ${width}`);
        check(
          metrics.railScrollWidth <= metrics.railClientWidth + 1,
          `no rail horizontal overflow at ${width}`,
        );
        const links = await page.$$eval(".chat-preview__link", (nodes) =>
          nodes.map((node) => ({
            target: node.getAttribute("target"),
            rel: node.getAttribute("rel"),
            suffix: node.textContent?.includes("(opens in a new tab)") ?? false,
          })),
        );
        for (const link of links) {
          assertEqual(link.target, "_blank", "link target");
          assertEqual(link.rel, "noopener noreferrer", "link rel");
          check(link.suffix, "link carries the new-tab suffix");
        }
        const closeHidden = await page.$$eval(".chat-preview__close", (nodes) =>
          nodes.some((node) => node.hidden),
        );
        check(!closeHidden, "hydrated close buttons are visible");
        await shot(page, `previews-${width}-${theme}`);
        checkNoErrors(errors);
      } finally {
        await context.close();
      }
    });
  }

  for (const theme of ["dark", "light"]) {
    await scenario(`eight previews at 1440 ${theme}`, async () => {
      const previews = previewsOf(8);
      const { context, page, errors } = await openPage(browser, target, {
        width: 1440,
        theme,
        api: { previews },
      });
      try {
        await gotoChat(page, target);
        await waitForPreviewRows(page, 8);
        const metrics = await railMetrics(page);
        assertEqual(metrics.count, 8, "eight rows");
        assertEqual(metrics.countText, "8 active", "eight-row count");
        check(
          metrics.listScrollHeight > metrics.listClientHeight,
          "eight rows scroll inside the cap",
        );
        check(metrics.listClientHeight <= 224, "list client height stays within 14rem");
        check(!metrics.documentOverflow, "eight-row page has no horizontal overflow");
        await shot(page, `previews-8-1440-${theme}`);
        checkNoErrors(errors);
      } finally {
        await context.close();
      }
    });
  }

  await scenario("long name and 32-character key at 390", async () => {
    const previews = [preview(LONG_KEY, LONG_NAME)];
    const { context, page, errors } = await openPage(browser, target, {
      width: 390,
      theme: "dark",
      api: { previews },
    });
    try {
      await gotoChat(page, target);
      await openDrawer(page);
      await waitForPreviewRows(page, 1);
      const link = await page.$eval(".chat-preview__link", (node) => ({
        title: node.getAttribute("title"),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
      assertEqual(link.title, LONG_NAME, "full name in the link title");
      check(link.scrollWidth <= link.clientWidth + 1, "long link does not overflow");
      const keyTitle = await page.$eval(".chat-preview__key", (node) => node.getAttribute("title"));
      assertEqual(keyTitle, LONG_KEY, "full key in the key title");
      const metrics = await railMetrics(page);
      check(!metrics.documentOverflow, "long-name page has no horizontal overflow");
      await shot(page, "previews-long-name-390-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("keyboard order and focus rings", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 2);
      const lastApplicationLink = page
        .locator("#context-app-title")
        .locator("xpath=ancestor::section[1]//a")
        .last();
      await lastApplicationLink.focus();
      await page.keyboard.press("Tab");
      let active = await page.evaluate(() => ({
        className:
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
        outline: getComputedStyle(document.activeElement).outlineWidth,
      }));
      check(active.className.includes("chat-preview__link"), "Tab lands on the first row link");
      assertEqual(active.outline, "2px", "link focus ring");
      await page.keyboard.press("Tab");
      active = await page.evaluate(() => ({
        className:
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
        outline: getComputedStyle(document.activeElement).outlineWidth,
      }));
      check(active.className.includes("chat-preview__close"), "Tab moves to the close control");
      assertEqual(active.outline, "2px", "close focus ring");
      await page.keyboard.press("Tab");
      active = await page.evaluate(() => ({
        className:
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
      }));
      check(active.className.includes("chat-preview__link"), "Tab reaches the next row link");
      await shot(page, "previews-focus-visible-1440-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

async function runClose(browser, target) {
  await scenario("close the last preview", async () => {
    const previews = [preview("only", "Only preview")];
    const { context, page, errors, state } = await openPage(browser, target, {
      width: 1440,
      api: { previews },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 1);
      await page.locator(".chat-preview__close").first().focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("chat-previews")?.hidden === true, {
        timeout: 10_000,
      });
      assertEqual(state.closeCalls[0]?.key, "only", "close request key");
      assertEqual(
        await page.evaluate(() => document.activeElement?.id),
        "context-usage-title",
        "focus moves to the Context heading",
      );
      await page.waitForFunction(
        () =>
          document.getElementById("chat-announcer")?.textContent ===
          "Preview closed: Only preview.",
        { timeout: 5_000 },
      );
      const hrBox = await page.evaluate(
        () => document.querySelector("#chat-previews hr")?.getBoundingClientRect().height ?? 0,
      );
      check(hrBox === 0, "close-last removes the divider");
      await shot(page, "previews-close-last-1440-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("close failure keeps the row and shows inline alert", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews, close: { status: 500, body: { error: "boom" } } },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 2);
      await page.locator(".chat-preview__close").first().click();
      await page.waitForSelector(".chat-preview__error", { state: "visible", timeout: 10_000 });
      assertEqual(await page.locator(".chat-preview").count(), 2, "failed close keeps the row");
      const buttonState = await page.$eval(".chat-preview__close", (node) => ({
        disabled: node.disabled,
        busy: node.getAttribute("aria-busy"),
      }));
      check(!buttonState.disabled, "failed close re-enables the button");
      check(buttonState.busy === null, "failed close clears aria-busy");
      assertEqual(await page.locator(".toast").count(), 0, "failed close uses no toast");
      await shot(page, "previews-close-error-1440-dark");
      checkExpectedHttpError(errors, 500);
    } finally {
      await context.close();
    }
  });

  await scenario("close 404 removes the row silently", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews, close: { status: 404, body: { error: "not found" } } },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 2);
      await page.locator(".chat-preview__close").first().click();
      await waitForPreviewRows(page, 1);
      assertEqual(await page.locator(".chat-preview__error").count(), 0, "404 shows no alert");
      await shot(page, "preview-close-404-1440-dark");
      checkExpectedHttpError(errors, 404);
    } finally {
      await context.close();
    }
  });

  await scenario("close closed:false removes the row", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews, close: { status: 200, body: { ok: true, closed: false } } },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 2);
      await page.locator(".chat-preview__close").first().click();
      await waitForPreviewRows(page, 1);
      assertEqual(
        await page.locator(".chat-preview__error").count(),
        0,
        "closed:false has no alert",
      );
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("close in flight shows a spinner", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews, close: { status: 200, body: { ok: true }, delayMs: 1_500 } },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 2);
      await page.locator(".chat-preview__close").first().click();
      await page.waitForFunction(
        () => document.querySelector(".chat-preview__close[aria-busy='true'] .spinner") !== null,
        { timeout: 5_000 },
      );
      await shot(page, "previews-close-busy-1440-dark");
      await waitForPreviewRows(page, 1);
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("focus follows the next close button", async () => {
    const previews = previewsOf(3);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews },
    });
    try {
      await gotoChat(page, target);
      await waitForPreviewRows(page, 3);
      await page.locator(".chat-preview__close").first().click();
      await waitForPreviewRows(page, 2);
      const focusedClass = await page.evaluate(() =>
        document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
      );
      check(focusedClass.includes("chat-preview__close"), "focus moves to the next close button");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

async function runCards(browser, target) {
  const item = preview("storefront", "Storefront");

  await scenario("completed preview card", async () => {
    const messages = [
      toolMessage("open", "hanse_preview_open", "completed", {
        input: { key: item.key, name: item.name, port: item.port },
        output: previewPayload(item),
      }),
    ];
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [item], messages },
    });
    try {
      await gotoChat(page, target);
      await page.waitForSelector("article.tool-call--preview", { timeout: 10_000 });
      const card = await page.$eval("article.tool-call--preview", (node) => ({
        messageId: node.getAttribute("data-message-id"),
        partId: node.getAttribute("data-part-id"),
        partType: node.getAttribute("data-part-type"),
        toolKey: node.getAttribute("data-tool-key"),
        previewKey: node.getAttribute("data-preview-key"),
        statusTabIndex: node.querySelector(".status")?.getAttribute("tabindex"),
        statusText: node.querySelector(".status")?.textContent ?? "",
        href: node.querySelector(".tool-call__preview .btn")?.getAttribute("href") ?? "",
        target: node.querySelector(".tool-call__preview .btn")?.getAttribute("target") ?? "",
        rel: node.querySelector(".tool-call__preview .btn")?.getAttribute("rel") ?? "",
        action: node.querySelector(".tool-call__preview .btn")?.textContent ?? "",
        hint: node.querySelector(".tool-call__note")?.textContent ?? "",
      }));
      check(card.messageId !== null, "card keeps data-message-id");
      check(card.partId !== null, "card keeps data-part-id");
      assertEqual(card.partType, "tool", "card keeps data-part-type");
      check(card.toolKey !== null, "card keeps data-tool-key");
      assertEqual(card.previewKey, "storefront", "card carries data-preview-key");
      assertEqual(card.statusTabIndex, "-1", "status text is focusable as fallback");
      check(card.statusText.includes("Completed"), "card shows the completed chip");
      assertEqual(card.href, item.url, "card action uses the server URL");
      assertEqual(card.target, "_blank", "card action opens a new tab");
      assertEqual(card.rel, "noopener noreferrer", "card action is noopener");
      check(card.action.includes("Open preview"), "card action text");
      assertEqual(card.hint, DEMO_HINT, "card demo hint");
      await shot(page, "preview-card-completed-1440-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  const negative = [
    [
      "running",
      toolMessage("running", "hanse_preview_open", "running", { input: { key: item.key } }),
    ],
    [
      "error",
      toolMessage("error", "hanse_preview_open", "error", {
        input: { key: item.key },
        error: "boom",
      }),
    ],
    [
      "unparseable",
      toolMessage("unparseable", "hanse_preview_open", "completed", {
        input: { key: item.key },
        output: "not json",
      }),
    ],
    [
      "ok-false",
      toolMessage("okfalse", "hanse_preview_open", "completed", {
        input: { key: item.key },
        output: JSON.stringify({ ok: false, code: "preview_limit" }),
      }),
    ],
    [
      "javascript-url",
      toolMessage("javascript", "hanse_preview_open", "completed", {
        input: { key: item.key },
        output: previewPayload({ ...item, url: "javascript:alert(1)" }),
      }),
    ],
    [
      "cross-origin-url",
      toolMessage("crossorigin", "hanse_preview_open", "completed", {
        input: { key: item.key },
        output: previewPayload({ ...item, url: "https://evil.example/preview/x/" }),
      }),
    ],
  ];

  for (const [name, message] of negative) {
    await scenario(`preview card ${name}`, async () => {
      const { context, page, errors } = await openPage(browser, target, {
        width: 1440,
        api: { previews: [item], messages: [message] },
      });
      try {
        await gotoChat(page, target);
        await page.waitForSelector("article.tool-call--preview", { timeout: 10_000 });
        assertEqual(
          await page.locator(".tool-call__preview .btn").count(),
          0,
          `${name} renders no action`,
        );
        const unsafe = await page.$$eval("a[href]", (nodes) =>
          nodes
            .map((node) => node.getAttribute("href") ?? "")
            .filter(
              (href) => href.startsWith("javascript:") || href.startsWith("https://evil.example"),
            ),
        );
        assertEqual(unsafe, [], `${name} renders no unsafe href`);
        if (["running", "error", "unparseable"].includes(name)) {
          await shot(page, `preview-card-${name}-1440-dark`);
        }
        checkNoErrors(errors);
      } finally {
        await context.close();
      }
    });
  }

  await scenario("card focus falls to the status text when the key leaves", async () => {
    const messages = [
      toolMessage("focus", "preview_open", "completed", {
        input: { key: item.key, name: item.name, port: item.port },
        output: previewPayload(item),
      }),
    ];
    const { context, page, errors, state } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [item], messages },
    });
    try {
      await gotoChat(page, target);
      await page.waitForSelector(".tool-call__preview .btn", { timeout: 10_000 });
      await page.locator(".tool-call__preview .btn").focus();
      state.previews = [];
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(
        () =>
          document.querySelector("article.tool-call--preview .caption")?.textContent === "Closed",
        { timeout: 10_000 },
      );
      const active = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? "",
        className:
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
        tabIndex:
          document.activeElement instanceof HTMLElement
            ? document.activeElement.getAttribute("tabindex")
            : null,
        text: document.activeElement?.textContent ?? "",
      }));
      assertEqual(active.tag, "SPAN", "focus moves off the removed link");
      check(active.className.includes("status"), "focus lands on the card status text");
      assertEqual(active.tabIndex, "-1", "status text is programmatically focusable");
      check(active.text.includes("Completed"), "status text keeps its label");
      await shot(page, "preview-card-closed-focus-1440-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

async function runUrlValidation(browser, target) {
  await scenario("rail drops unsafe preview URLs", async () => {
    const valid = preview("safe", "Safe");
    const unsafe = [
      preview("javascript", "Javascript", { url: "javascript:alert(1)" }),
      preview("cross-origin", "Cross origin", { url: "https://evil.example/preview/x/" }),
    ];
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [valid, ...unsafe] },
      ssrPreviews: [valid],
    });
    try {
      await gotoChat(page, target);
      await page.waitForFunction(
        () => document.getElementById("chat-previews-count")?.textContent === "1 active",
        { timeout: 10_000 },
      );
      assertEqual(await page.locator(".chat-preview").count(), 1, "only the safe row remains");
      const unsafeHref = await page.$$eval("a[href]", (nodes) =>
        nodes
          .map((node) => node.getAttribute("href") ?? "")
          .filter(
            (href) => href.startsWith("javascript:") || href.startsWith("https://evil.example"),
          ),
      );
      assertEqual(unsafeHref, [], "unsafe hrefs are never rendered");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("new rows announce their arrival", async () => {
    const first = preview("first", "First");
    const second = preview("second", "Second");
    const { context, page, errors, state } = await openPage(browser, target, {
      width: 1440,
      api: { previews: [first] },
    });
    try {
      await gotoChat(page, target);
      await page.waitForFunction(() => {
        const list = document.getElementById("chat-previews-list");
        return list !== null && list.children.length === 1;
      });
      for (let index = 0; index < 50 && state.previewGets === 0; index += 1) await wait(100);
      check(state.previewGets > 0, "initial preview refresh ran");
      await wait(50);
      state.previews = [first, second];
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitForPreviewRows(page, 2);
      await page.waitForFunction(
        () => document.getElementById("chat-announcer")?.textContent === "Preview opened: Second.",
        { timeout: 5_000 },
      );
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

async function runNoScript(browser, target) {
  await scenario("no-JS SSR with previews", async () => {
    const previews = previewsOf(2);
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      javaScript: false,
      ssrPreviews: previews,
    });
    try {
      await page.goto(`${target.baseUrl}/chat?app=${APP}&project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const state = await page.evaluate(() => ({
        wrapperHidden: document.getElementById("chat-previews")?.hidden === true,
        rows: document.querySelectorAll(".chat-preview").length,
        linkVisible:
          (document.querySelector(".chat-preview__link")?.getBoundingClientRect().height ?? 0) > 0,
        closeHidden: Array.from(document.querySelectorAll(".chat-preview__close")).every(
          (node) => node.hidden && getComputedStyle(node).display === "none",
        ),
      }));
      check(!state.wrapperHidden, "no-JS wrapper is visible with previews");
      assertEqual(state.rows, 2, "no-JS rows render");
      check(state.linkVisible, "no-JS link is visible");
      check(state.closeHidden, "no-JS close controls are hidden");
      await shot(page, "previews-nojs-1440-dark");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  await scenario("no-JS empty SSR", async () => {
    const { context, page, errors } = await openPage(browser, target, {
      width: 1440,
      javaScript: false,
    });
    try {
      await page.goto(`${target.baseUrl}/chat?app=${APP}&project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const state = await page.evaluate(() => ({
        wrapperHidden: document.getElementById("chat-previews")?.hidden === true,
        headingVisible:
          (document.getElementById("context-previews-title")?.getBoundingClientRect().height ?? 0) >
          0,
        rows: document.querySelectorAll(".chat-preview").length,
      }));
      check(state.wrapperHidden, "no-JS empty wrapper is hidden");
      check(!state.headingVisible, "no-JS empty heading is invisible");
      assertEqual(state.rows, 0, "no-JS empty has no rows");
      checkNoErrors(errors);
    } finally {
      await context.close();
    }
  });
}

function proxyErrorPage(kind) {
  const content =
    kind === "404"
      ? {
          title: "Preview not found",
          body: "This preview has expired or was closed. Open it again from the agent's message.",
          action: "",
        }
      : {
          title: "Preview unavailable",
          body: "The dev server is not responding. Start it in the agent, then reload.",
          action: '<a class="btn btn-secondary btn-sm" href="#">Reload</a>',
        };
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/assets/app.css" /></head>
  <body class="app-body"><main class="page"><header class="page-header"><p class="overline">Preview</p>
  <h1 class="page-header__title">${content.title}</h1>
  <p class="page-header__description">${content.body}</p>${content.action}</header></main></body></html>`;
}

async function runErrorPages(browser, target) {
  for (const kind of ["404", "502"]) {
    await scenario(`preview ${kind} page`, async () => {
      const { context, page, errors } = await openPage(browser, target, { width: 1440 });
      try {
        await page.route(`**/preview-fixture-${kind}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: proxyErrorPage(kind),
          }),
        );
        await page.goto(`${target.baseUrl}/preview-fixture-${kind}`, { waitUntil: "networkidle" });
        const title = await page.textContent("h1");
        assertEqual(
          title,
          kind === "404" ? "Preview not found" : "Preview unavailable",
          `${kind} title`,
        );
        await shot(page, `preview-${kind}-1440-dark`);
        checkNoErrors(errors);
      } finally {
        await context.close();
      }
    });
  }
}

async function resolveTarget() {
  const externalUrl = process.env.PREVIEW_QA_URL;
  const externalToken = process.env.PREVIEW_QA_TOKEN;
  if (externalUrl) {
    if (!externalToken) {
      throw new Error("preview-qa: PREVIEW_QA_URL is set but PREVIEW_QA_TOKEN is missing.");
    }
    return { baseUrl: externalUrl.replace(/\/$/, ""), token: externalToken, server: null };
  }
  return startServer();
}

let target = null;
let browser = null;

try {
  mkdirSync(ARTIFACTS, { recursive: true });
  target = await resolveTarget();
  report.baseUrl = target.baseUrl;
  const executablePath = findChromium();
  if (executablePath === undefined) {
    throw new Error(
      "preview-qa: Chromium not found. Set PLAYWRIGHT_CHROMIUM or run `npx playwright install chromium`.",
    );
  }
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });

  await runEmpty(browser, target);
  await runRail(browser, target);
  await runClose(browser, target);
  await runCards(browser, target);
  await runUrlValidation(browser, target);
  await runNoScript(browser, target);
  await runErrorPages(browser, target);

  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (browser !== null) await browser.close();
  if (target !== null && typeof target.stop === "function") await target.stop();
  report.finishedAt = new Date().toISOString();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const passed = report.scenarios.filter((item) => item.status === "PASS").length;
  console.log(
    `preview-qa: ${report.status} (${passed}/${report.scenarios.length} scenarios, ` +
      `${report.screenshots.length} screenshots) -> ${relative(REPORT_PATH)}`,
  );
  if (report.status === "FAIL") console.error(report.error);
}
