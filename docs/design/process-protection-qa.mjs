#!/usr/bin/env node
/*
 * Deterministic browser QA for plan 0030 Phase C2 (process protection chat UI).
 *
 * Usage:
 *   node docs/design/process-protection-qa.mjs
 *
 * The harness starts the real coordinator (`node dist/index.js serve`) against a disposable
 * workspace/state, then serves the real chat page while every `/api/apps/**` call is fulfilled by
 * `page.route`. No real deployment state, token, project, app, session, or notice is touched.
 *
 * Playwright and Chromium are resolved like `docs/design/attachments-qa.mjs`. Missing
 * Playwright/Chromium or a missing `dist/index.js` is a blocked gate (exit 1), not a skip.
 *
 * Evidence is written to `docs/design/artifacts/process-protection/` as screenshots,
 * `report.json`, and `report.md`. The command exits 1 on the first failed assertion, unexpected
 * console error, page error, or failed network request.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const ARTIFACTS = path.join(SCRIPT_DIR, "artifacts", "process-protection");
const REPORT_JSON = path.join(ARTIFACTS, "report.json");
const REPORT_MD = path.join(ARTIFACTS, "report.md");
const APP = "processqa";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = process.env.PROCESS_PROTECTION_QA_TOKEN ?? "qa-token";

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
  if (existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
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
    "process-protection-qa: Playwright not found. Run `npx playwright --version` once, set " +
      "PLAYWRIGHT_CHROMIUM to a Chromium binary, or install Playwright globally.",
  );
  process.exit(1);
}

const chromiumPath = findChromium();
if (!chromiumPath) {
  console.error(
    "process-protection-qa: Chromium not found. Set PLAYWRIGHT_CHROMIUM=/usr/bin/chromium or " +
      "install the Playwright Chromium build.",
  );
  process.exit(1);
}

const { chromium } = await import(`file://${modulePath}`);

const report = {
  tool: "process-protection-qa",
  mode: "deterministic",
  startedAt: new Date().toISOString(),
  status: "PASS",
  baseUrl: null,
  app: APP,
  project: PROJECT_ID,
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
  networkFailures: [],
};

let activeChecks = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
  activeChecks.push(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relative(file) {
  return path.relative(ROOT, file);
}

function scrub(value) {
  return String(value)
    .replaceAll(`file://${ROOT}/`, "")
    .replaceAll(`${ROOT}/`, "")
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<ephemeral-test-port>");
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

function stoppedBody() {
  return { error: "agent is stopped", code: "agent_stopped" };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      probe.close(() => {
        if (port === null) reject(new Error("could not allocate a local port"));
        else resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `process-protection-qa: server exited with code ${child.exitCode} before ready.\n${logs()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`process-protection-qa: server did not become ready.\n${logs()}`);
    }
    await wait(100);
  }
}

async function startServer() {
  const dist = path.join(ROOT, "dist", "index.js");
  if (!existsSync(dist)) {
    throw new Error(
      [
        "process-protection-qa: dist/index.js is missing, so the harness cannot self-start a server.",
        "Prerequisite: run `npm run build`, then re-run `node docs/design/process-protection-qa.mjs`.",
      ].join("\n"),
    );
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), "hanse-process-qa-"));
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
      "name: Process Protection QA",
      "base_branch: main",
      "apps:",
      `  - path: ${APP}`,
      "    kind: web",
      "",
    ].join("\n"),
    "utf8",
  );
  const port = await freePort();
  const env = {
    ...process.env,
    HANSE_OPERATOR_TOKEN: TOKEN,
    HANSE_RUNTIME_TOKEN: process.env.HANSE_RUNTIME_TOKEN ?? "qa-runtime-token",
    HANSE_IDE: "0",
    HANSE_ASSETS: path.join(ROOT, "assets"),
  };
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
    token: TOKEN,
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
    constructor() {
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      window.__qaEventSource = this;
      if (window.__qaStreamReady !== false) {
        window.setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          if (this.onopen) this.onopen({});
          this.emit({ type: "stream.ready", seq: 0, streamID: "qa-stream" });
        }, 10);
      }
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
  window.__qaEmit = (payload) => {
    if (window.__qaEventSource) window.__qaEventSource.emit(payload);
  };
}

async function newPage(browser, target, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: options.colorScheme ?? "dark",
    reducedMotion: "reduce",
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
  await context.addInitScript(
    ({ theme, ready }) => {
      try {
        localStorage.setItem("hanse-theme", theme);
      } catch {
        // ignore storage restrictions
      }
      window.__qaStreamReady = ready;
    },
    { theme: options.colorScheme ?? "dark", ready: options.ready !== false },
  );
  await context.addInitScript(installFakeEventSource);
  const errors = [];
  const networkFailures = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
      if (process.env.QA_DEBUG === "1") console.error(`[console] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
    if (process.env.QA_DEBUG === "1") console.error(`[pageerror] ${error.stack ?? error.message}`);
  });
  page.on("requestfailed", (request) => {
    networkFailures.push(
      `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
  return { context, page, errors, networkFailures };
}

function assertClean(errors, networkFailures, allowedStatuses = []) {
  const allowed = allowedStatuses.map((status) => new RegExp(`status of ${status}\\b`));
  const unexpected = errors.filter((entry) => !allowed.some((pattern) => pattern.test(entry)));
  if (unexpected.length > 0) {
    report.consoleErrors.push(...unexpected.map(scrub));
    throw new Error(`console/page errors:\n${unexpected.join("\n")}`);
  }
  const failed = networkFailures.filter((entry) => !/net::ERR_ABORTED/.test(entry));
  if (failed.length > 0) {
    report.networkFailures.push(...failed.map(scrub));
    throw new Error(`failed network requests:\n${failed.join("\n")}`);
  }
}

const SESSION = "ses_process_qa";
const M = {
  first: "msg_process_1",
  second: "msg_process_2",
  resume: "msg_process_resume",
  assistant: "msg_process_a",
};
const N = {
  stopped: "notice_process_stopped",
  child: "notice_process_child",
  resume: "notice_process_resume",
};

function at(iso) {
  return Date.parse(iso) / 1000;
}

function notice(id, kind, reason, createdAt) {
  return {
    id,
    appId: APP,
    sessionId: SESSION,
    kind,
    reason,
    payload: {},
    createdAt,
  };
}

function textMessage(id, role, text, created) {
  const partID = `prt_${id}`;
  return {
    info: { id, sessionID: SESSION, role, time: { created } },
    parts: [{ id: partID, sessionID: SESSION, messageID: id, type: "text", text }],
  };
}

function resumeMessage(created) {
  return {
    info: { id: M.resume, sessionID: SESSION, role: "user", time: { created } },
    parts: [
      {
        id: "prt_process_resume",
        sessionID: SESSION,
        messageID: M.resume,
        type: "text",
        text: "The previous turn was interrupted because the agent process stopped and restarted.",
        synthetic: true,
        metadata: { hanse: "agent-resume" },
      },
    ],
  };
}

function createFixture(options = {}) {
  const now = Date.now();
  return {
    stopped: options.stopped === true,
    stopOnStart: options.stopOnStart === true,
    sessions: options.sessions ?? [{ id: SESSION, title: "Process protection QA" }],
    messages: options.messages ?? [],
    notices: options.notices ?? [],
    calls: { sessions: 0, messages: 0, notices: 0, start: 0 },
    now,
  };
}

function installRoutes(page, fixture) {
  return page.route("**/api/apps/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const prefix = `/api/apps/${APP}`;
    const rel = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const sessionFor = (suffix) => {
      const match = new RegExp(`^/sessions/([^/]+)/${suffix}$`).exec(rel);
      return match === null ? null : decodeURIComponent(match[1]);
    };

    if (rel === "/start" && method === "POST") {
      fixture.calls.start += 1;
      fixture.stopped = false;
      return json(route, { started: true });
    }

    if (rel === "/runtime" && method === "GET") {
      return json(route, { state: fixture.stopped ? "stopped" : "running" });
    }

    if (rel === "/sessions" && method === "GET") {
      fixture.calls.sessions += 1;
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, { sessions: fixture.sessions });
    }

    const noticeSession = sessionFor("notices");
    if (noticeSession !== null && method === "GET") {
      if (noticeSession !== SESSION) {
        return json(route, { error: "session not found", code: "session_not_found" }, 404);
      }
      fixture.calls.notices += 1;
      return json(route, {
        notices: [...fixture.notices].reverse(),
        nextCursor: null,
      });
    }

    const messageSession = sessionFor("messages");
    if (messageSession !== null && method === "GET") {
      fixture.calls.messages += 1;
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, { messages: fixture.messages, nextCursor: null });
    }

    const draftSession = sessionFor("draft");
    if (draftSession !== null) {
      if (fixture.stopped && method === "GET") return json(route, stoppedBody(), 503);
      if (method === "PUT") return json(route, { text: "", updatedAt: new Date().toISOString() });
      return json(route, { text: "", attachments: [], pendingSends: [], updatedAt: null });
    }

    const todoSession = sessionFor("todo");
    if (todoSession !== null && method === "GET") {
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, { todos: [], truncated: false });
    }

    const contextSession = sessionFor("context");
    if (contextSession !== null && method === "GET") {
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, {
        sessionID: contextSession,
        state: "ready",
        used: 1200,
        limit: 200000,
        percent: 1,
        model: { providerID: "deepseek", modelID: "deepseek-flash" },
        status: "idle",
        updatedAt: new Date().toISOString(),
        lastCompactedAt: null,
        lastError: null,
        autoCompact: { enabled: false, percent: 80, source: "global", percentSource: "global" },
      });
    }

    if (rel === "/prompts" && method === "GET") {
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, { questions: [], permissions: [], warnings: [] });
    }
    if (rel === "/permissions/saved" && method === "GET") {
      if (fixture.stopped) return json(route, stoppedBody(), 503);
      return json(route, { permissions: [] });
    }
    if (rel === "/commands" && method === "GET") {
      return json(route, {
        sources: { hanse: "ok", opencode: fixture.stopped ? "stopped" : "ok" },
        warnings: [],
        commands: [],
      });
    }
    if (rel === "/previews" && method === "GET") return json(route, { previews: [] });
    if (rel === "/image" && method === "GET") return json(route, {});
    if (rel === "/events" && method === "GET") {
      return json(route, fixture.stopped ? stoppedBody() : {});
    }
    if (rel === "/ssh/approvals" && method === "GET") return json(route, { approvals: [] });
    if (sessionFor("touch") !== null) return json(route, { touched: true });
    if (sessionFor("delete-if-empty") !== null) {
      return json(route, { deleted: false, reason: "has_history" });
    }
    return json(route, {});
  });
}

async function gotoChat(page, target, sessionId) {
  const query = new URLSearchParams({ app: APP, project: PROJECT_ID });
  if (sessionId) query.set("session", sessionId);
  await page.goto(`${target.baseUrl}/chat?${query.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#chat-prompt", { state: "attached", timeout: 15_000 });
}

async function feedSnapshot(page) {
  return page.evaluate(() => {
    const children = Array.from(document.querySelectorAll("#chat-messages > *")).filter(
      (node) =>
        node.classList.contains("message") ||
        node.classList.contains("feed-notice") ||
        node.classList.contains("chat-stopped"),
    );
    return children.map((node) => {
      if (node.classList.contains("feed-notice")) return `notice:${node.dataset.noticeId}`;
      if (node.classList.contains("chat-stopped")) return "stopped";
      return `message:${node.dataset.messageId}`;
    });
  });
}

async function scenarioReloadStopped(browser, target) {
  const fixture = createFixture({
    stopped: true,
    stopOnStart: true,
    notices: [notice(N.stopped, "agent_stopped", "operator_restart", "2026-10-27T10:00:00.000Z")],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target, {
    ready: false,
  });
  try {
    await installRoutes(page, fixture);
    await gotoChat(page, target, SESSION);
    await page.waitForSelector("#chat-messages .chat-stopped", {
      state: "attached",
      timeout: 8_000,
    });
    await page.waitForSelector("#chat-messages .feed-notice", {
      state: "attached",
      timeout: 8_000,
    });
    const before = await page.evaluate(() => ({
      shell: document.querySelector("#chat-messages .chat-stopped") !== null,
      startButtons: document.querySelectorAll("[data-chat-start-agent]").length,
      noticeText: document.querySelector("#chat-messages .feed-notice")?.textContent ?? "",
      messages: document.querySelectorAll("#chat-messages .message").length,
      emptyState: document.querySelector("#chat-messages .empty-state") !== null,
      startCalls: 0,
    }));
    check(before.shell, "stopped reload renders the shell");
    check(before.startButtons === 1, "stopped reload renders one Start action");
    check(before.noticeText.includes("Agent was restarted here"), "notice label is visible");
    check(before.noticeText.includes("Operator restart"), "notice reason is visible");
    check(before.messages === 0, "stopped reload does not fake an empty running feed");
    check(!before.emptyState, "stopped reload does not show the running empty state");
    check(fixture.calls.start === 0, "boot never auto-starts the stopped app");
    await shot(page, "stopped-reload-1440-dark");

    await page.evaluate(() => {
      window.__qaStreamReady = true;
    });
    await page.click("[data-chat-start-agent]");
    await page.waitForFunction(
      () =>
        document.querySelector("#chat-messages .chat-stopped") === null &&
        document.querySelectorAll("#chat-messages .message").length === 0,
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#chat-messages .feed-notice").length === 1,
      undefined,
      { timeout: 8_000 },
    );
    check(fixture.calls.start === 1, "Start posts the existing /start path once");
    check(fixture.calls.sessions > 0, "Start refreshes sessions");
    check(fixture.calls.notices > 1, "Start refreshes notices");
    assertClean(errors, networkFailures, [503]);
    return { calls: fixture.calls };
  } finally {
    await context.close();
  }
}

async function scenarioInterleaved(browser, target) {
  const fixture = createFixture({
    messages: [
      textMessage(M.first, "user", "First question", at("2026-10-27T10:00:01.000Z")),
      textMessage(M.second, "assistant", "Second answer", at("2026-10-27T10:00:03.000Z")),
    ],
    notices: [
      notice(N.stopped, "agent_stopped", "unknown_restart", "2026-10-27T10:00:02.000Z"),
      notice(N.child, "subagent_interrupted", "subagent_abort", "2026-10-27T10:00:04.000Z"),
    ],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installRoutes(page, fixture);
    await gotoChat(page, target, SESSION);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#chat-messages .message").length === 2 &&
        document.querySelectorAll("#chat-messages .feed-notice").length === 2,
      undefined,
      { timeout: 10_000 },
    );
    const order = await feedSnapshot(page);
    check(
      JSON.stringify(order) ===
        JSON.stringify([
          `message:${M.first}`,
          `notice:${N.stopped}`,
          `message:${M.second}`,
          `notice:${N.child}`,
        ]),
      `notices interleave above and below messages: ${JSON.stringify(order)}`,
    );
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#chat-messages .feed-notice")).map(
        (node) => node.textContent ?? "",
      ),
    );
    check(labels[0].includes("Agent was restarted here"), "first notice label");
    check(labels[0].includes("Restart detected"), "first notice reason");
    check(labels[1].includes("Subagent interrupted"), "child notice label");
    check(labels[1].includes("Subagent stop"), "child notice reason");
    const count = await page.textContent("#chat-message-count");
    check(count === "2 messages", `message count excludes notices (got ${count})`);

    await page.evaluate(() => {
      window.__qaEmit({
        type: "notice.created",
        seq: 1,
        streamID: "qa-stream",
        notice: {
          id: "notice_process_live",
          appId: "processqa",
          sessionId: "ses_process_qa",
          kind: "resume_completed",
          reason: "unknown_restart",
          payload: {},
          createdAt: "2026-10-27T10:00:05.000Z",
        },
      });
    });
    await page.waitForSelector("#chat-messages [data-notice-id='notice_process_live']", {
      state: "attached",
      timeout: 5_000,
    });
    const liveOrder = await feedSnapshot(page);
    check(
      liveOrder[liveOrder.length - 1] === "notice:notice_process_live",
      "live notice.created appends in order",
    );
    const liveText = await page.textContent(
      "#chat-messages [data-notice-id='notice_process_live']",
    );
    check(liveText.includes("Agent resumed and finished"), "live notice label renders");
    assertClean(errors, networkFailures);
    return { order, count, liveOrder };
  } finally {
    await context.close();
  }
}

async function scenarioNoticeOnly(browser, target) {
  const fixture = createFixture({
    messages: [],
    notices: [
      notice(N.stopped, "agent_stopped", "process_exit", "2026-10-27T10:00:00.000Z"),
      notice(N.resume, "resume_failed", "unknown", "2026-10-27T10:00:05.000Z"),
    ],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installRoutes(page, fixture);
    await gotoChat(page, target, SESSION);
    await page.waitForFunction(
      () => document.querySelectorAll("#chat-messages .feed-notice").length === 2,
      undefined,
      { timeout: 10_000 },
    );
    const state = await page.evaluate(() => ({
      notices: document.querySelectorAll("#chat-messages .feed-notice").length,
      empty: document.querySelector("#chat-messages .empty-state") !== null,
      count: document.querySelector("#chat-message-count")?.textContent ?? "",
    }));
    check(state.notices === 2, "notice-only session renders its notices");
    check(!state.empty, "notice-only session is not treated as empty");
    check(state.count === "0 messages", `notice-only count is messages only (got ${state.count})`);
    assertClean(errors, networkFailures);
    return state;
  } finally {
    await context.close();
  }
}

async function scenarioResume(browser, target) {
  const fixture = createFixture({
    messages: [
      textMessage(M.first, "user", "First question", at("2026-10-27T10:00:01.000Z")),
      resumeMessage(at("2026-10-27T10:00:02.500Z")),
      textMessage(M.assistant, "assistant", "Continuing the task.", at("2026-10-27T10:00:03.000Z")),
    ],
    notices: [notice(N.resume, "resume_started", "operator_restart", "2026-10-27T10:00:02.000Z")],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installRoutes(page, fixture);
    await gotoChat(page, target, SESSION);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#chat-messages .message").length === 2 &&
        document.querySelectorAll("#chat-messages .feed-notice").length === 1,
      undefined,
      { timeout: 10_000 },
    );
    const state = await page.evaluate(() => ({
      systemCards: document.querySelectorAll("#chat-messages .message--system").length,
      messageIDs: Array.from(document.querySelectorAll("#chat-messages .message")).map(
        (node) => node.dataset.messageId ?? "",
      ),
      feedText: document.querySelector("#chat-messages")?.textContent ?? "",
      noticeText: document.querySelector("#chat-messages .feed-notice")?.textContent ?? "",
    }));
    check(state.systemCards === 0, "resume prompt is not rendered as an OMO/system card");
    check(!state.messageIDs.includes(M.resume), "resume synthetic message is hidden");
    check(
      !state.feedText.includes("The previous turn was interrupted"),
      "resume prompt text is not in the visible feed",
    );
    check(state.noticeText.includes("Agent resumed here"), "resume_started notice is visible");
    check(state.noticeText.includes("Operator restart"), "resume_started reason is visible");
    assertClean(errors, networkFailures);
    return state;
  } finally {
    await context.close();
  }
}

async function scenarioVisual(browser, target) {
  const views = [
    { width: 1440, height: 900, colorScheme: "dark" },
    { width: 1440, height: 900, colorScheme: "light" },
    { width: 768, height: 900, colorScheme: "dark" },
    { width: 768, height: 900, colorScheme: "light" },
  ];
  const evidence = [];
  for (const view of views) {
    const fixture = createFixture({
      messages: [
        textMessage(M.first, "user", "First question", at("2026-10-27T10:00:01.000Z")),
        textMessage(M.second, "assistant", "Second answer", at("2026-10-27T10:00:03.000Z")),
      ],
      notices: [
        notice(N.stopped, "agent_stopped", "operator_restart", "2026-10-27T10:00:02.000Z"),
        notice(N.child, "subagent_interrupted", "subagent_abort", "2026-10-27T10:00:04.000Z"),
      ],
    });
    const { context, page, errors, networkFailures } = await newPage(browser, target, view);
    try {
      await installRoutes(page, fixture);
      await gotoChat(page, target, SESSION);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#chat-messages .message").length === 2 &&
          document.querySelectorAll("#chat-messages .feed-notice").length === 2,
        undefined,
        { timeout: 10_000 },
      );
      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        const inner = document.getElementById("chat-messages");
        const noticeNode = document.querySelector("#chat-messages .feed-notice");
        const box = (node) => {
          if (node === null) return null;
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        };
        return {
          theme: document.documentElement.dataset.theme ?? null,
          overflowX: doc.scrollWidth - doc.clientWidth,
          inner: box(inner),
          notice: box(noticeNode),
          height: noticeNode === null ? 0 : noticeNode.getBoundingClientRect().height,
        };
      });
      check(layout.theme === view.colorScheme, `${view.width}/${view.colorScheme}: theme`);
      check(layout.overflowX <= 0, `${view.width}/${view.colorScheme}: no horizontal overflow`);
      check(
        layout.inner !== null &&
          layout.notice !== null &&
          layout.notice.width >= layout.inner.width - 2,
        `${view.width}/${view.colorScheme}: notice spans the feed width`,
      );
      check(layout.height > 0, `${view.width}/${view.colorScheme}: notice row has height`);
      const noticeBackground = await page.evaluate(() => {
        const node = document.querySelector("#chat-messages .feed-notice");
        return node === null ? null : getComputedStyle(node).color;
      });
      check(
        typeof noticeBackground === "string",
        `${view.width}/${view.colorScheme}: notice color`,
      );
      await shot(page, `interleaved-${view.width}-${view.colorScheme}`);
      assertClean(errors, networkFailures);
      evidence.push({ ...view, layout });
    } finally {
      await context.close();
    }
  }
  return { views: evidence };
}

async function runScenario(name, fn) {
  const started = Date.now();
  const entry = { name, status: "PASS", ms: 0, checks: [], data: null };
  activeChecks = entry.checks;
  try {
    entry.data = await fn();
  } catch (error) {
    entry.status = "FAIL";
    entry.error = scrub(error instanceof Error ? (error.stack ?? error.message) : String(error));
    report.status = "FAIL";
    throw error;
  } finally {
    entry.ms = Date.now() - started;
    report.scenarios.push(entry);
  }
}

function writeReports() {
  report.finishedAt = new Date().toISOString();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const rows = report.scenarios.map(
    (entry, index) =>
      `| ${index + 1} | \`${entry.name}\` | ${entry.status} | ${entry.checks.length} | ${
        entry.error === undefined ? "" : entry.error.split("\n")[0].replaceAll("|", "\\|")
      } |`,
  );
  const failures = report.scenarios.filter((entry) => entry.status === "FAIL");
  const lines = [
    "# Process protection C2 browser QA",
    "",
    `- Status: **${report.status}**`,
    `- Mode: \`${report.mode}\` (real page/assets, deterministic \`/api/apps/**\` fixtures)`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    "- Command: `node docs/design/process-protection-qa.mjs`",
    "",
    "## Scenarios",
    "",
    "| # | Scenario | Result | Assertions | Failure |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Screenshots",
    "",
    ...(report.screenshots.length > 0
      ? report.screenshots.map((file) => `- \`${file}\``)
      : ["_none_"]),
    "",
    "## Failures",
    "",
    ...(failures.length > 0
      ? failures.flatMap((entry) => [`### ${entry.name}`, "", "```", entry.error, "```", ""])
      : ["_none_", ""]),
    "## Unexpected console/page errors",
    "",
    ...(report.consoleErrors.length > 0
      ? report.consoleErrors.map((line) => `- ${line}`)
      : ["_none_"]),
    "",
    "## Failed network requests",
    "",
    ...(report.networkFailures.length > 0
      ? report.networkFailures.map((line) => `- ${line}`)
      : ["_none_"]),
    "",
  ];
  writeFileSync(REPORT_MD, lines.join("\n"), "utf8");
}

let browser;
let server;
try {
  mkdirSync(ARTIFACTS, { recursive: true });
  server = await startServer();
  report.baseUrl = "http://127.0.0.1:<ephemeral-test-port>";
  browser = await chromium.launch({ executablePath: chromiumPath });
  const definitions = [
    ["reload-stopped", scenarioReloadStopped],
    ["interleaved-notices", scenarioInterleaved],
    ["notice-only", scenarioNoticeOnly],
    ["resume-not-omo", scenarioResume],
    ["visual-1440-768", scenarioVisual],
  ];
  for (const [name, scenario] of definitions) {
    await runScenario(name, () => scenario(browser, server));
  }
} catch (error) {
  report.status = "FAIL";
  report.error = scrub(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error("\nFAIL deterministic process-protection QA");
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
  writeReports();
}

if (report.status !== "PASS") process.exitCode = 1;

if (report.status === "PASS") {
  const assertions = report.scenarios.reduce((total, entry) => total + entry.checks.length, 0);
  console.log("\nPASS deterministic process-protection QA");
  console.log(
    `  ${report.scenarios.length} scenario(s), ${assertions} assertion(s), ` +
      `${report.screenshots.length} screenshot(s), zero unexpected console/page errors`,
  );
  console.log(`  report: ${relative(REPORT_JSON)}`);
} else {
  console.error(`\nreport: ${relative(REPORT_JSON)}`);
}
