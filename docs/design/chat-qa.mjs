#!/usr/bin/env node
/*
 * Deterministic browser QA for the chat UX overhaul (plan 0005, phase 6).
 *
 * Usage:
 *   node docs/design/chat-qa.mjs            # self-start a throwaway server + fixtures
 *   CHAT_QA_URL=https://host CHAT_QA_TOKEN=... node docs/design/chat-qa.mjs
 *   node docs/design/chat-qa.mjs --live     # real managed app, no interception
 *
 * The deterministic mode starts `node dist/index.js serve` against a temporary
 * workspace/state, intercepts every `/api/apps/**` call with `page.route`, and
 * injects a fake `EventSource`. No product dependency is added: Playwright and
 * Chromium are resolved exactly like `docs/design/capture.mjs`.
 *
 * Screenshots and `report.json` are written to `docs/design/artifacts/chat/`.
 * The command exits 1 on the first failed assertion, console error, or page
 * error. Missing Playwright is a blocked gate, not a skip.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const ARTIFACTS = path.join(SCRIPT_DIR, "artifacts", "chat");
const REPORT_PATH = path.join(ARTIFACTS, "report.json");

const DEFAULT_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_APP = "web";
const PROJECT_ID = process.env.CHAT_QA_PROJECT ?? DEFAULT_PROJECT_ID;
const APP = path.basename(process.env.CHAT_QA_APP ?? DEFAULT_APP);
const CUSTOM_APP = "image-custom";
const LIVE = process.argv.includes("--live");
const CHAT_QA_ROUTE = "/chat";
/** The default SPA set at Stage 0; chat/terminal are added only by their cutover stages. */
const DEFAULT_SPA_ROUTE_IDS = [
  "projects",
  "overview",
  "handoffs",
  "ssh",
  "settings-global",
  "skills-global",
  "skills-new",
  "skills-detail",
  "settings-project",
  "settings-app",
  "skills-project",
  "skills-app",
  "app",
  "project",
];
const CHAT_QA_MODE = process.env.CHAT_QA_MODE === "spa" ? "spa" : "legacy";
const CHAT_QA_SPA_ROUTES = (
  process.env.CHAT_QA_SPA_ROUTES ?? [...DEFAULT_SPA_ROUTE_IDS, "chat"].join(",")
).trim();

function assertSpaRouteSet(value) {
  const ids = new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const required = [...DEFAULT_SPA_ROUTE_IDS, "chat"];
  const missing = required.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new Error(
      `chat-qa: CHAT_QA_SPA_ROUTES must contain the full default SPA set plus the chat route. ` +
        `Missing: ${missing.join(",")}`,
    );
  }
}

if (!LIVE && CHAT_QA_MODE === "spa") assertSpaRouteSet(CHAT_QA_SPA_ROUTES);
const CHAT_QA_ONLY = (process.env.CHAT_QA_ONLY ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const EXTERNAL_URL = process.env.CHAT_QA_URL;
const EXTERNAL_TOKEN = process.env.CHAT_QA_TOKEN;

const THREADS = {
  main: "ses_main",
  questions: "ses_questions",
  send: "ses_send",
  diffs: "ses_diffs",
};

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

// ---------------------------------------------------------------------------
// Playwright resolution (same optional-install resolver as capture.mjs)
// ---------------------------------------------------------------------------

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
    "chat-qa: Playwright not found. Run `npx playwright --version` once, set " +
      "PLAYWRIGHT_CHROMIUM to a Chromium binary, or install Playwright globally.",
  );
  process.exit(1);
}

const { chromium } = await import(`file://${modulePath}`);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const report = {
  tool: "chat-qa",
  mode: LIVE ? "live" : CHAT_QA_MODE,
  harness: LIVE ? "live" : "deterministic",
  route: CHAT_QA_ROUTE,
  spaRoutes: CHAT_QA_MODE === "spa" && !LIVE ? CHAT_QA_SPA_ROUTES : null,
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

function sessionIDFromPath(pathname, suffix) {
  const pattern = new RegExp(`/sessions/([^/]+)/${suffix}$`);
  const match = pattern.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]);
}

/**
 * D4 snapshot used by every scenario that does not override the context route. Existing scenarios
 * issue context GETs after `stream.ready` and session selection, so the fallback `{}` must never be
 * used for `/context`.
 */
function defaultContextSnapshot(sessionID) {
  return {
    sessionID,
    state: "ready",
    used: 124000,
    limit: 200000,
    percent: 62,
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    status: "idle",
    updatedAt: "2026-10-21T12:00:00.000Z",
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: true, percent: 80, source: "app", percentSource: "global" },
  };
}

async function emit(page, payload) {
  await page.evaluate(
    ({ event, normalizeSeq }) => {
      const source = window.__qaEventSource;
      if (!source) throw new Error("FakeEventSource is not installed");
      let next = event;
      // The harness scripts synthetic high sequence numbers for the legacy client. The SPA adapter
      // treats those as a real stream gap and reconciles from history, which would replace the
      // just-emitted fixture part. Normalize only the harness sequence; gap handling has dedicated
      // reducer/adapter tests.
      if (normalizeSeq && typeof event === "object" && event !== null) {
        if (event.type === "stream.ready") {
          window.__qaSpaSeq = typeof event.seq === "number" ? event.seq : 0;
        } else if (typeof event.seq === "number") {
          window.__qaSpaSeq = Number(window.__qaSpaSeq ?? 0) + 1;
          next = { ...event, seq: window.__qaSpaSeq };
        }
      }
      source.emit(next);
    },
    { event: payload, normalizeSeq: CHAT_QA_MODE === "spa" },
  );
}

async function emitMany(page, payloads) {
  for (const payload of payloads) await emit(page, payload);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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
        `chat-qa: server exited with code ${child.exitCode} before it was ready.\n${logs()}`,
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
      throw new Error(`chat-qa: server did not become ready at ${baseUrl}.\n${logs()}`);
    }
    await wait(100);
  }
}

async function startServer() {
  const dist = path.join(ROOT, "dist", "index.js");
  if (!existsSync(dist)) {
    throw new Error(
      [
        "chat-qa: dist/index.js is missing, so the harness cannot self-start a server.",
        "Fix: run `npm run build`, then re-run `node docs/design/chat-qa.mjs`.",
        "Or point the harness at an existing server with CHAT_QA_URL and CHAT_QA_TOKEN.",
      ].join("\n"),
    );
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "hanse-chat-qa-"));
  const workspace = path.join(tempRoot, "workspace");
  const stateHome = path.join(tempRoot, "state");
  const appRoot = path.join(workspace, APP);
  const customAppRoot = path.join(workspace, CUSTOM_APP);
  mkdirSync(path.join(workspace, ".hanse"), { recursive: true });
  mkdirSync(path.join(appRoot, ".hanse"), { recursive: true });
  mkdirSync(path.join(customAppRoot, ".hanse"), { recursive: true });
  mkdirSync(stateHome, { recursive: true });

  writeFileSync(
    path.join(appRoot, ".hanse", "app.yaml"),
    [`name: ${APP}`, "kind: web", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(customAppRoot, ".hanse", "app.yaml"),
    [`name: ${CUSTOM_APP}`, "kind: web", "build:", "  dockerfile: .hanse/Dockerfile", ""].join(
      "\n",
    ),
    "utf8",
  );
  writeFileSync(
    path.join(customAppRoot, ".hanse", "Dockerfile"),
    ["FROM hanse-agent-base:qa", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(workspace, ".hanse", "project.yaml"),
    [
      `id: ${PROJECT_ID}`,
      "name: Chat QA",
      "base_branch: main",
      "apps:",
      `  - path: ${APP}`,
      "    kind: web",
      `  - path: ${CUSTOM_APP}`,
      "    kind: web",
      "",
    ].join("\n"),
    "utf8",
  );

  const port = await freePort();
  const token = process.env.CHAT_QA_TOKEN ?? "qa-token";
  const env = {
    ...process.env,
    HANSE_OPERATOR_TOKEN: token,
    HANSE_RUNTIME_TOKEN: process.env.HANSE_RUNTIME_TOKEN ?? "qa-runtime-token",
    HANSE_IDE: "0",
    HANSE_ASSETS: path.join(ROOT, "assets"),
  };
  if (CHAT_QA_MODE === "spa") env.HANSE_UI_SPA_ROUTES = CHAT_QA_SPA_ROUTES;
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

async function resolveTarget() {
  if (LIVE) {
    if (!EXTERNAL_URL || !EXTERNAL_TOKEN) {
      throw new Error(
        [
          "chat-qa --live requires a real managed app:",
          "  CHAT_QA_URL=http://127.0.0.1:8787",
          "  CHAT_QA_TOKEN=<operator token>",
          "  CHAT_QA_LIVE_SESSION=<existing session id>",
          "  optional: CHAT_QA_APP=web CHAT_QA_PROJECT=<project id>",
          "  optional: CHAT_QA_LIVE_PROMPT='...' CHAT_QA_LIVE_TIMEOUT_MS=120000",
        ].join("\n"),
      );
    }
    return {
      baseUrl: EXTERNAL_URL.replace(/\/$/, ""),
      token: EXTERNAL_TOKEN,
      server: null,
    };
  }

  if (EXTERNAL_URL) {
    if (!EXTERNAL_TOKEN) {
      throw new Error(
        "chat-qa: CHAT_QA_URL is set but CHAT_QA_TOKEN is missing. Set both, or unset " +
          "CHAT_QA_URL to let the harness self-start a throwaway server.",
      );
    }
    return {
      baseUrl: EXTERNAL_URL.replace(/\/$/, ""),
      token: EXTERNAL_TOKEN,
      server: null,
    };
  }

  const server = await startServer();
  return { baseUrl: server.baseUrl, token: server.token, server };
}

// ---------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------

function installFakeEventSource() {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      window.__qaEventSource = this;
      window.__qaEventSourceCount = (window.__qaEventSourceCount || 0) + 1;
      window.setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        this.emit({ type: "stream.ready", seq: 0, streamID: "qa-stream" });
      }, 10);
    }

    emit(payload) {
      if (payload !== null && typeof payload === "object" && typeof payload.seq === "number") {
        window.__qaSpaSeq = Math.max(Number(window.__qaSpaSeq ?? 0), payload.seq);
      }
      if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    }

    fail() {
      this.readyState = 2;
      if (this.onerror) this.onerror({});
    }

    close() {
      this.readyState = 2;
      if (window.__qaEventSource === this) window.__qaEventSource = null;
    }
  }
  window.EventSource = FakeEventSource;
}

function installWorkerProbe() {
  const NativeWorker = window.Worker;
  const log = {
    created: 0,
    tokenize: 0,
    init: 0,
    terminated: 0,
    dispatches: [],
    responses: [],
    hung: 0,
  };
  window.__qaWorkerLog = log;
  window.__qaWorkerInstances = [];

  function ProbeWorker(url, options) {
    const instance = new NativeWorker(url, options);
    const entry = {
      posts: [],
      terminated: false,
      hung: 0,
      instance,
    };
    window.__qaWorkerInstances.push(entry);
    log.created += 1;

    const nativePost = instance.postMessage.bind(instance);
    instance.postMessage = function postMessage(message, transfer) {
      entry.posts.push(message);
      if (message !== null && typeof message === "object") {
        if (message.type === "init") log.init += 1;
        if (message.type === "tokenize") {
          if (String(message.text ?? "").includes("__QA_HANG__")) {
            entry.hung += 1;
            log.hung += 1;
            return;
          }
          log.tokenize += 1;
          log.dispatches.push({
            t: performance.now(),
            jobID: message.jobID,
            streamID: message.streamID,
            bytes: String(message.text ?? "").length,
          });
        }
      }
      return nativePost(message, transfer);
    };

    const nativeTerminate = instance.terminate.bind(instance);
    instance.terminate = function terminate() {
      entry.terminated = true;
      log.terminated += 1;
      return nativeTerminate();
    };

    instance.addEventListener("message", (event) => {
      const data = event !== null && typeof event === "object" ? event.data : null;
      if (data === null || typeof data !== "object") return;
      if (data.type !== "tokens" && data.type !== "plain" && data.type !== "error") return;
      log.responses.push({
        t: performance.now(),
        type: data.type,
        jobID: data.jobID,
        streamID: data.streamID,
      });
    });

    return instance;
  }
  ProbeWorker.prototype = NativeWorker.prototype;
  window.Worker = ProbeWorker;
}

async function newPage(browser, target, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: options.colorScheme ?? "dark",
    reducedMotion: options.reducedMotion ?? "no-preference",
    hasTouch: options.hasTouch === true,
    isMobile: options.isMobile === true,
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
  if (!options.live) await context.addInitScript(installFakeEventSource);
  if (!options.live && options.workerProbe) await context.addInitScript(installWorkerProbe);

  const errors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return { context, page, errors };
}

function checkNoErrors(errors) {
  if (errors.length > 0) {
    report.consoleErrors.push(...errors);
    throw new Error(`console/page errors:\n${errors.join("\n")}`);
  }
}

/**
 * A deliberate non-2xx API response makes Chromium log one resource error. Scenarios that assert a
 * fixed HTTP error still require every other console/page error to be absent.
 */
function checkExpectedHttpError(errors, status) {
  const pattern = new RegExp(`Failed to load resource.*status of ${status}`);
  const unexpected = errors.filter((entry) => !pattern.test(entry));
  if (unexpected.length > 0) {
    report.consoleErrors.push(...unexpected);
    throw new Error(`console/page errors:\n${unexpected.join("\n")}`);
  }
}

async function waitForStableMessageGets(routeState, quietMs = 1000, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const last = routeState.messageGets.at(-1) ?? 0;
    const idleFor = last === 0 ? Date.now() : Date.now() - last;
    if (idleFor >= quietMs) return;
    if (Date.now() > deadline) {
      throw new Error("chat hydration did not settle before the streaming fixture");
    }
    await wait(100);
  }
}

async function gotoChat(page, target, sessionId, waitUntil = "networkidle") {
  const query = new URLSearchParams({ app: APP, project: PROJECT_ID });
  if (sessionId) query.set("session", sessionId);
  await page.goto(`${target.baseUrl}${CHAT_QA_ROUTE}?${query.toString()}`, { waitUntil });
}

async function installRoutes(page, config) {
  const state = {
    postCalls: 0,
    postBodies: [],
    replyBody: null,
    replyCount: 0,
    promptQuestions: config.promptQuestions ?? [],
    messageGets: [],
    contextGets: [],
    compactCalls: [],
    commandGets: [],
    commandPosts: [],
    abortCalls: [],
    sessionGets: [],
    deleteCalls: [],
    imageGets: [],
    buildPosts: [],
    startPosts: [],
    restartPosts: [],
    runtimeGets: [],
    imageActions: [],
  };

  const messages = typeof config.messages === "function" ? config.messages : () => config.messages;
  const prompts =
    typeof config.prompts === "function"
      ? config.prompts
      : () => config.prompts ?? state.promptQuestions;
  const sessions =
    typeof config.sessions === "function"
      ? config.sessions
      : () =>
          config.sessions ?? [
            { id: config.sessionId, title: "Chat QA", time: { updated: Date.now() } },
          ];

  await page.route("**/api/apps/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (config.image !== undefined) {
      const imageAppKey = appKeyFromPath(pathname);
      if (imageAppKey !== null) {
        const endpoint = pathname.slice(pathname.lastIndexOf("/") + 1);
        const at = Date.now();
        if (endpoint === "image" && method === "GET") {
          const call = {
            appKey: imageAppKey,
            at,
            refresh: url.searchParams.get("refresh") === "1",
            index: state.imageGets.length + 1,
          };
          state.imageGets.push(call);
          const view =
            typeof config.image.view === "function"
              ? await config.image.view({ state, call, appKey: imageAppKey })
              : (config.image.view ?? imageStateView({ appKey: imageAppKey }));
          return fixtureResponse(route, view);
        }
        if (endpoint === "build" && method === "POST") {
          const call = {
            appKey: imageAppKey,
            at,
            body: request.postData(),
            index: state.buildPosts.length + 1,
          };
          state.buildPosts.push(call);
          state.imageActions.push({ kind: "build", at, appKey: imageAppKey });
          const result =
            typeof config.image.build === "function"
              ? await config.image.build({ state, call, appKey: imageAppKey })
              : config.image.build;
          return fixtureResponse(route, result ?? { accepted: true, buildId: "build_qa" }, 202);
        }
        if (endpoint === "start" && method === "POST") {
          const call = {
            appKey: imageAppKey,
            at,
            body: request.postData(),
            index: state.startPosts.length + 1,
          };
          state.startPosts.push(call);
          state.imageActions.push({ kind: "start", at, appKey: imageAppKey });
          const result =
            typeof config.image.start === "function"
              ? await config.image.start({ state, call, appKey: imageAppKey })
              : config.image.start;
          return fixtureResponse(route, result ?? { started: true });
        }
        if (endpoint === "restart" && method === "POST") {
          const call = {
            appKey: imageAppKey,
            at,
            body: request.postData(),
            index: state.restartPosts.length + 1,
          };
          state.restartPosts.push(call);
          state.imageActions.push({ kind: "restart", at, appKey: imageAppKey });
          const result =
            typeof config.image.restart === "function"
              ? await config.image.restart({ state, call, appKey: imageAppKey })
              : config.image.restart;
          return fixtureResponse(route, result ?? { restarted: true });
        }
        if (endpoint === "runtime" && method === "GET") {
          const call = { appKey: imageAppKey, at };
          state.runtimeGets.push(call);
          const result =
            typeof config.image.runtime === "function"
              ? await config.image.runtime({ state, call, appKey: imageAppKey })
              : (config.image.runtime ?? { state: "stopped" });
          return fixtureResponse(route, result);
        }
      }
    }

    if (pathname.includes("/questions/") && pathname.endsWith("/reply")) {
      state.replyCount += 1;
      try {
        state.replyBody = JSON.parse(request.postData() ?? "{}");
      } catch {
        state.replyBody = { invalid: request.postData() };
      }
      state.promptQuestions = [];
      if (config.onQuestionReply) config.onQuestionReply(state.replyBody);
      return json(route, { ok: true });
    }
    if (pathname.includes("/questions/") && pathname.endsWith("/reject")) {
      state.promptQuestions = [];
      return json(route, { ok: true });
    }
    if (pathname.endsWith("/sessions") && method === "GET") {
      const list = sessions();
      state.sessionGets.push({ at: Date.now(), ids: list.map((session) => String(session.id)) });
      return json(route, { sessions: list });
    }
    if (pathname.endsWith("/sessions") && method === "POST") {
      return json(route, { id: config.sessionId, title: "Chat QA", time: { updated: Date.now() } });
    }
    if (pathname.includes("/sessions/") && method === "DELETE") {
      const match = /\/sessions\/([^/]+)$/.exec(pathname);
      const sessionID = match === null ? null : decodeURIComponent(match[1]);
      state.deleteCalls.push({ at: Date.now(), sessionID });
      if (sessionID !== null && typeof config.onDeleteSession === "function") {
        config.onDeleteSession(sessionID, state);
      }
      return json(route, { deleted: true });
    }
    if (pathname.endsWith("/prompts") && method === "GET") {
      return json(route, { questions: prompts(state), permissions: [] });
    }
    if (pathname.endsWith("/permissions/saved") && method === "GET") {
      return json(route, { permissions: [] });
    }
    if (pathname.endsWith("/todo") && method === "GET") {
      const todos =
        typeof config.todos === "function"
          ? await config.todos({ state })
          : (config.todos ?? state.todos ?? []);
      return json(route, {
        todos: Array.isArray(todos) ? todos : [],
        truncated: false,
      });
    }
    if (pathname.endsWith("/context") && method === "GET") {
      const sessionID = sessionIDFromPath(pathname, "context");
      const call = {
        sessionID,
        at: Date.now(),
        callIndex: state.contextGets.length + 1,
        sessionCallIndex:
          state.contextGets.filter((entry) => entry.sessionID === sessionID).length + 1,
        status: 200,
        code: null,
      };
      state.contextGets.push(call);
      const override =
        typeof config.context === "function"
          ? await config.context({ sessionID, state, call })
          : config.context;
      if (
        override !== null &&
        typeof override === "object" &&
        typeof override.status === "number"
      ) {
        call.status = override.status;
        call.code = override.body?.code ?? null;
        if (override.delayMs) await wait(override.delayMs);
        return json(route, override.body ?? {}, override.status);
      }
      return json(route, override ?? defaultContextSnapshot(sessionID));
    }
    if (pathname.endsWith("/compact") && method === "POST") {
      const sessionID = sessionIDFromPath(pathname, "compact");
      const call = {
        sessionID,
        at: Date.now(),
        body: request.postData(),
        status: 202,
      };
      state.compactCalls.push(call);
      const override =
        typeof config.compact === "function"
          ? await config.compact({ sessionID, state, call })
          : config.compact;
      if (
        override !== null &&
        typeof override === "object" &&
        typeof override.status === "number"
      ) {
        call.status = override.status;
        if (override.delayMs) await wait(override.delayMs);
        return json(route, override.body ?? {}, override.status);
      }
      return json(route, override ?? { accepted: true, sessionID }, 202);
    }
    if (pathname.endsWith("/commands") && method === "GET") {
      state.commandGets.push(Date.now());
      const fixture =
        typeof config.commands === "function"
          ? await config.commands({ state })
          : (config.commands ?? commandsFixture());
      return json(route, fixture);
    }
    if (pathname.includes("/sessions/") && pathname.endsWith("/commands") && method === "POST") {
      const sessionID = sessionIDFromPath(pathname, "commands");
      let body = {};
      try {
        body = JSON.parse(request.postData() ?? "{}");
      } catch {
        body = { invalid: request.postData() };
      }
      const call = {
        sessionID,
        body,
        at: Date.now(),
        callIndex: state.commandPosts.length + 1,
        status: 202,
      };
      state.commandPosts.push(call);
      const result =
        typeof config.commandPost === "function"
          ? await config.commandPost({ state, body, call })
          : config.commandPost;
      if (result !== null && typeof result === "object" && typeof result.status === "number") {
        call.status = result.status;
        if (result.delayMs) await wait(result.delayMs);
        return json(route, result.body ?? {}, result.status);
      }
      return json(
        route,
        {
          accepted: true,
          sessionID,
          name: body.name,
          messageID: `msg_cmd_${call.callIndex}`,
        },
        202,
      );
    }
    if (pathname.includes("/sessions/") && pathname.endsWith("/abort") && method === "POST") {
      const sessionID = sessionIDFromPath(pathname, "abort");
      const call = {
        sessionID,
        at: Date.now(),
        body: request.postData(),
      };
      state.abortCalls.push(call);
      const configured =
        typeof config.abort === "function" ? await config.abort({ state, call }) : config.abort;
      const result = configured ?? { status: 200, body: { aborted: true } };
      if (typeof result.delayMs === "number" && result.delayMs > 0) {
        await wait(result.delayMs);
      }
      return json(route, result.body ?? { aborted: true }, result.status ?? 200);
    }
    if (pathname.includes("/messages") && method === "GET") {
      state.messageGets.push(Date.now());
      return json(route, { messages: messages() });
    }
    if (pathname.includes("/messages") && method === "POST") {
      state.postCalls += 1;
      state.postBodies.push({ url: request.url(), body: request.postData() });
      if (config.onPost) config.onPost(state);
      if (config.postDelayMs) await wait(config.postDelayMs);
      const messageID =
        config.messageIDs?.[state.postCalls - 1] ?? `msg_accepted_${state.postCalls}`;
      return json(route, { accepted: true, messageID, sessionID: config.sessionId }, 202);
    }
    return json(route, {});
  });

  return state;
}

function commandsFixture(options = {}) {
  const master = options.master === true;
  const masterReason = "Not available in the master chat";
  return {
    sources: { hanse: "ok", opencode: "ok" },
    warnings: [
      {
        code: "command_shadowed",
        command: "ide",
        message: "/ide is provided by the application.",
      },
    ],
    commands: [
      {
        name: "new",
        source: "hanse",
        action: "new",
        aliases: ["clear"],
        description: "Start a new session",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "help",
        source: "hanse",
        action: "help",
        aliases: [],
        description: "Show command help",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "editor",
        source: "hanse",
        action: "editor",
        aliases: [],
        description: "Open the web IDE",
        hints: [],
        shell: "none",
        available: !master,
        ...(master ? { unavailableReason: masterReason } : {}),
      },
      {
        name: "compact",
        source: "hanse",
        action: "compact",
        aliases: [],
        description: "Compact the current session",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "diff",
        source: "hanse",
        action: "diff",
        aliases: [],
        description: "Open the application changes",
        hints: [],
        shell: "none",
        available: !master,
        ...(master ? { unavailableReason: masterReason } : {}),
      },
      {
        name: "restart",
        source: "hanse",
        action: "restart",
        aliases: [],
        description: "Restart the application agent",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "deploy",
        source: "opencode",
        origin: "command",
        description: "Deploy the application",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "disabledcmd",
        source: "opencode",
        origin: "command",
        description: "A command disabled by the application",
        hints: [],
        shell: "none",
        available: false,
        unavailableReason: "Disabled by the application policy.",
      },
      {
        name: "ide",
        source: "opencode",
        origin: "command",
        description: "Application IDE command",
        hints: [],
        shell: "none",
        available: true,
      },
      {
        name: "mcp-unknown",
        source: "opencode",
        origin: "mcp",
        description: "MCP prompt with unknown shell usage",
        hints: [],
        shell: "unknown",
        available: true,
      },
      {
        name: "shellcheck",
        source: "opencode",
        origin: "command",
        description: "Runs a shell block on the server",
        hints: [],
        shell: "present",
        available: true,
      },
    ],
  };
}

function commandMessagesFixture() {
  return [];
}

async function paletteState(page) {
  return page.evaluate(() => {
    const palette = document.getElementById("chat-command-palette");
    const listbox = document.getElementById("chat-command-listbox");
    const prompt = document.getElementById("chat-prompt");
    const activeId = prompt?.getAttribute("aria-activedescendant") ?? null;
    const activeRow = activeId === null ? null : document.getElementById(activeId);
    const rows = Array.from(document.querySelectorAll("#chat-command-listbox [role='option']"));
    return {
      hidden: palette?.hidden ?? true,
      status: document.getElementById("chat-command-status")?.textContent ?? "",
      shadowHidden: document.getElementById("chat-command-shadow")?.hidden ?? true,
      shadowText: document.getElementById("chat-command-shadow")?.textContent ?? "",
      expanded: prompt?.getAttribute("aria-expanded") ?? null,
      role: prompt?.getAttribute("role") ?? null,
      listboxRole: listbox?.getAttribute("role") ?? null,
      groups: Array.from(
        document.querySelectorAll("#chat-command-listbox [role='group']"),
        (group) => group.getAttribute("aria-label"),
      ),
      rowCount: rows.length,
      rows: rows.map((row) => ({
        id: row.id,
        name: row.querySelector(".command-palette__name")?.textContent ?? "",
        disabled: row.getAttribute("aria-disabled") === "true",
        selected: row.getAttribute("aria-selected") === "true",
        reason: row.querySelector(".command-palette__reason")?.textContent ?? "",
        badges: Array.from(
          row.querySelectorAll(".command-palette__badge"),
          (badge) => badge.textContent,
        ),
      })),
      activeId,
      activeDisabled: activeRow?.getAttribute("aria-disabled") === "true",
      activeName: activeRow?.querySelector(".command-palette__name")?.textContent ?? null,
      announcer: document.getElementById("chat-announcer")?.textContent ?? "",
    };
  });
}

async function waitForPalette(page) {
  await page.waitForSelector("#chat-command-palette:not([hidden])");
  await page.waitForFunction(
    () => document.querySelectorAll("#chat-command-listbox [role='option']").length >= 6,
  );
  await wait(150);
}

async function fillComposer(page, value) {
  const prompt = page.locator("#chat-prompt");
  await prompt.fill(value);
}

// ---------------------------------------------------------------------------
// Image fixtures and UI probes
// ---------------------------------------------------------------------------

const QA_DIGEST_A = `sha256:${"a".repeat(64)}`;
const QA_DIGEST_B = `sha256:${"b".repeat(64)}`;
const QA_DIGEST_C = `sha256:${"c".repeat(64)}`;

/**
 * One deterministic `GET /api/apps/:app/image` view. Every field the chat gate and both
 * application panels read is present, so a scenario only names the values it is asserting.
 */
function imageStateView(overrides = {}) {
  return {
    appId: "app_image_qa",
    appKey: APP,
    status: "missing",
    imageRef: null,
    imageId: null,
    buildId: null,
    hash: null,
    currentHash: null,
    baseDigest: null,
    builtAt: null,
    error: null,
    updatedAt: null,
    previousImageRef: null,
    previousImageBuiltAt: null,
    runnerAvailable: true,
    buildConfigured: true,
    state: "not_ready",
    running: false,
    usableImageRef: null,
    targetImageId: null,
    appliedImageId: null,
    hashVersion: 2,
    currentBaseDigest: null,
    baseKind: null,
    baseRef: null,
    baseDrift: null,
    hashDrift: null,
    blocked: true,
    selectedImage: "missing",
    imageBuildId: null,
    latestBuildImageId: null,
    ...overrides,
  };
}

function appKeyFromPath(pathname) {
  const match = /^\/api\/apps\/([^/]+)\/(image|build|start|restart|runtime)$/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]);
}

/** Apply a fixture response (`{httpStatus, body, delayMs}`) or a plain JSON body. */
async function fixtureResponse(route, result, fallbackStatus = 200) {
  if (result !== null && typeof result === "object" && typeof result.httpStatus === "number") {
    if (typeof result.delayMs === "number" && result.delayMs > 0) await wait(result.delayMs);
    return json(route, result.body ?? {}, result.httpStatus);
  }
  return json(route, result ?? {}, fallbackStatus);
}

async function imageUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    const gate = document.getElementById("image-gate");
    const warning = document.getElementById("image-warning");
    const composer = document.getElementById("chat-composer");
    const viewport = document.querySelector(".chat-thread__viewport");
    const prompt = document.getElementById("chat-prompt");
    const send = document.getElementById("chat-send");
    return {
      gate: {
        hidden: gate?.hidden ?? null,
        role: gate?.getAttribute("role") ?? null,
        tone: gate?.dataset.tone ?? null,
        title: text(gate?.querySelector(".chat-image-gate__title")),
        body: text(gate?.querySelector(".chat-image-gate__body")),
        buttons: Array.from(gate?.querySelectorAll("button") ?? [], (node) => text(node)),
      },
      warning: {
        hidden: warning?.hidden ?? null,
        role: warning?.getAttribute("role") ?? null,
        tone: warning?.dataset.tone ?? null,
        title: text(warning?.querySelector(".chat-image-warning__title")),
        body: text(warning?.querySelector(".chat-image-warning__body")),
        buttons: Array.from(warning?.querySelectorAll("button") ?? [], (node) => text(node)),
      },
      composer: {
        hidden: composer?.hidden ?? null,
        promptDisabled: prompt?.disabled ?? null,
        sendDisabled: send?.disabled ?? null,
      },
      viewportHidden: viewport?.hidden ?? null,
      bodyText: text(document.body),
      eventSourceCount: window.__qaEventSourceCount ?? 0,
      toastText: text(document.getElementById("toast-region")),
    };
  });
}

async function waitForChatStream(page) {
  await page.waitForFunction(() => (window.__qaEventSourceCount ?? 0) > 0, undefined, {
    timeout: 5_000,
  });
}

async function imagePanelUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    const panel = document.getElementById("image-panel");
    const status = document.getElementById("image-status");
    const rollbackRow = document.getElementById("image-rollback-ref")?.closest(".summary-row");
    const rollbackBuiltRow = document
      .getElementById("image-rollback-built")
      ?.closest(".summary-row");
    return {
      present: panel !== null,
      appKey: panel?.dataset.appKey ?? null,
      panelStatus: panel?.dataset.status ?? null,
      state: panel?.dataset.state ?? null,
      statusText: text(status),
      statusState: status?.dataset.state ?? null,
      statusStatus: status?.dataset.status ?? null,
      ref: text(document.getElementById("image-ref")),
      hint: text(document.getElementById("image-hint")),
      live: text(document.getElementById("image-live")),
      baseKind: text(document.getElementById("image-base-kind")),
      baseRef: text(document.getElementById("image-base-ref")),
      baseDigest: text(document.getElementById("image-base-digest")),
      rollbackRef: text(document.getElementById("image-rollback-ref")),
      rollbackRowHidden: rollbackRow?.hidden ?? null,
      rollbackBuiltRowHidden: rollbackBuiltRow?.hidden ?? null,
      rollbackFormHidden: document.getElementById("image-rollback-form")?.hidden ?? null,
      hasBuild: document.getElementById("image-build") !== null,
      hasBuildForm: document.querySelector("#image-panel form[action*='/build']") !== null,
      hasCheck: document.getElementById("image-check") !== null,
      hasDetails: document.getElementById("image-details") !== null,
      hasLogs: document.getElementById("image-logs") !== null,
      errorText: text(document.getElementById("image-error")),
      bodyText: text(document.body),
    };
  });
}

/** Phone/desktop and light/dark captures used by the image scenarios. */
async function captureImageVariants(page, prefix, options = {}) {
  for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate((next) => {
      document.documentElement.dataset.theme = next;
    }, theme);
    await wait(80);
    await shot(page, `${prefix}-1440-${theme}`);
  }
  // A fresh mobile load initializes the off-canvas layout; resizing the desktop page leaves
  // stale side rails peeking into the 390 capture.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  if (typeof options.afterPhoneReload === "function") await options.afterPhoneReload(page);
  await wait(150);
  const overflow390 = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow390 === 0, `${prefix}: no horizontal overflow at 390 (${overflow390})`);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((next) => {
      document.documentElement.dataset.theme = next;
    }, theme);
    await wait(80);
    await shot(page, `${prefix}-390-${theme}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: "networkidle" });
  if (typeof options.afterDesktopReload === "function") await options.afterDesktopReload(page);
  await wait(150);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mainFixture() {
  const now = Date.now();
  const todo = [
    { content: "Run typecheck", status: "completed", priority: "high" },
    { content: "Run vitest", status: "in_progress", priority: "high" },
    { content: "Check build", status: "pending", priority: "medium" },
  ];
  const session = THREADS.main;
  const messages = [
    {
      info: { id: "msg_u1", sessionID: session, role: "user", time: { created: now - 60_000 } },
      parts: [
        {
          id: "prt_u1",
          sessionID: session,
          messageID: "msg_u1",
          type: "text",
          text: "Please run the test suite, show a table, and keep the working output visible.",
        },
      ],
    },
    {
      info: {
        id: "msg_a1",
        sessionID: session,
        role: "assistant",
        parentID: "msg_u1",
        time: { created: now - 50_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "prt_r1",
          sessionID: session,
          messageID: "msg_a1",
          type: "reasoning",
          text: "I should run the tests and inspect the output before summarizing. The table will make the result easy to scan.",
          time: { start: now - 49_000, end: now - 48_000 },
        },
        {
          id: "prt_t1",
          sessionID: session,
          messageID: "msg_a1",
          type: "text",
          text: [
            "I'll run the suite and then summarize.",
            "",
            "| Check | Result |",
            "| --- | --- |",
            "| typecheck | pass |",
            "| tests | 396 pass |",
            "| build | pass |",
            "",
            "The tool output is visible below.",
          ].join("\n"),
        },
        {
          id: "prt_bash1",
          sessionID: session,
          messageID: "msg_a1",
          type: "tool",
          callID: "call_bash",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "npm test" },
            metadata: { output: "✓ test/chat-core.test.ts (70 tests)\n" },
            title: "npm test",
            time: { start: now - 45_000 },
          },
        },
        {
          id: "prt_todo1",
          sessionID: session,
          messageID: "msg_a1",
          type: "tool",
          callID: "call_todo",
          tool: "todowrite",
          state: {
            status: "running",
            input: { todos: todo },
            metadata: { todos: todo },
            title: "3 todos",
            time: { start: now - 40_000 },
          },
        },
      ],
    },
    {
      info: { id: "msg_u2", sessionID: session, role: "user", time: { created: now - 30_000 } },
      parts: [
        {
          id: "prt_u2",
          sessionID: session,
          messageID: "msg_u2",
          type: "text",
          text: "Also check the build.",
        },
      ],
    },
    {
      info: { id: "msg_u3", sessionID: session, role: "user", time: { created: now - 20_000 } },
      parts: [
        {
          id: "prt_u3",
          sessionID: session,
          messageID: "msg_u3",
          type: "text",
          text: "And run lint after that.",
        },
      ],
    },
    {
      info: { id: "msg_sys", sessionID: session, role: "user", time: { created: now - 10_000 } },
      parts: [
        {
          id: "prt_sys",
          sessionID: session,
          messageID: "msg_sys",
          type: "text",
          text: [
            "<system-reminder>",
            "[BACKGROUND TASK RESULT READY]",
            "**ID:** `task_42`",
            "**Description:** inspect the chat layout",
            "**Duration:** 12s",
            "",
            "Background work finished; the result is ready.",
            "</system-reminder>",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
        },
      ],
    },
  ];
  return { messages, todo };
}

function sessionTreeFixture() {
  const now = Date.now();
  const sessions = [
    { id: "ses_parent", title: "Parent task", time: { updated: now - 1_000 } },
    {
      id: "ses_child1",
      title: "Explore child",
      parentID: "ses_parent",
      time: { updated: now - 2_000 },
    },
    {
      id: "ses_child2",
      title: "Review child",
      parentID: "ses_parent",
      time: { updated: now - 3_000 },
    },
    {
      id: "ses_grand",
      title: "Grandchild check",
      parentID: "ses_child1",
      time: { updated: now - 4_000 },
    },
    { id: "ses_leaf", title: "Leaf task", time: { updated: now - 5_000 } },
    {
      id: "ses_orphan",
      title: "Orphan child",
      parentID: "ses_missing",
      time: { updated: now - 6_000 },
    },
    { id: "ses_other", title: "Unrelated task", time: { updated: now - 7_000 } },
  ];
  const messages = [
    {
      info: {
        id: "msg_tree_user",
        sessionID: "ses_parent",
        role: "user",
        time: { created: now - 500 },
      },
      parts: [
        {
          id: "prt_tree_user",
          sessionID: "ses_parent",
          messageID: "msg_tree_user",
          type: "text",
          text: "Show the session tree fixture.",
        },
      ],
    },
    {
      info: {
        id: "msg_tree_assistant",
        sessionID: "ses_parent",
        role: "assistant",
        parentID: "msg_tree_user",
        time: { created: now - 400 },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_tree_assistant",
          sessionID: "ses_parent",
          messageID: "msg_tree_assistant",
          type: "text",
          text: "The session tree fixture is loaded.",
        },
      ],
    },
  ];
  const childQuestion = {
    key: "v1:que_tree_child1",
    id: "que_tree_child1",
    sessionID: "ses_child1",
    source: "v1",
    tooLarge: false,
    questions: [
      {
        header: "Child check",
        question: "A hidden child is waiting",
        options: [{ label: "Continue", description: "Continue the child session" }],
        multiple: false,
        custom: false,
      },
    ],
    tool: { messageID: "msg_tree_assistant", callID: "call_tree_question" },
  };
  return { sessions, messages, childQuestion };
}

function questionFixture() {
  const now = Date.now();
  const session = THREADS.questions;
  const questions = [
    {
      header: "Color",
      question: "Pick a color",
      options: [
        { label: "Red", description: "Choose red" },
        { label: "Blue", description: "Choose blue" },
      ],
      multiple: false,
      custom: true,
    },
    {
      header: "Checks",
      question: "Pick checks",
      options: [
        { label: "Unit", description: "Unit tests" },
        { label: "E2E", description: "End-to-end tests" },
      ],
      multiple: true,
      custom: false,
    },
  ];
  const messages = [
    {
      info: { id: "msg_qu", sessionID: session, role: "user", time: { created: now - 5_000 } },
      parts: [
        {
          id: "prt_qu",
          sessionID: session,
          messageID: "msg_qu",
          type: "text",
          text: "Ask me the setup questions.",
        },
      ],
    },
    {
      info: {
        id: "msg_qa",
        sessionID: session,
        role: "assistant",
        parentID: "msg_qu",
        time: { created: now - 4_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "prt_q",
          sessionID: session,
          messageID: "msg_qa",
          type: "tool",
          callID: "call_q",
          tool: "question",
          state: { status: "running", input: { questions }, time: { start: now - 3_500 } },
        },
      ],
    },
  ];
  const promptQuestions = [
    {
      key: "v1:que_1",
      id: "que_1",
      sessionID: session,
      source: "v1",
      tooLarge: false,
      questions,
      tool: { messageID: "msg_qa", callID: "call_q" },
    },
  ];
  return { questions, messages, promptQuestions };
}

function customQuestionFixture() {
  const now = Date.now();
  const session = THREADS.questions;
  const questions = [
    { header: "Color", question: "Pick a color", options: [], multiple: false, custom: true },
  ];
  const messages = [
    {
      info: { id: "msg_qu", sessionID: session, role: "user", time: { created: now - 5_000 } },
      parts: [
        {
          id: "prt_qu",
          sessionID: session,
          messageID: "msg_qu",
          type: "text",
          text: "Ask me the setup question.",
        },
      ],
    },
    {
      info: {
        id: "msg_qa",
        sessionID: session,
        role: "assistant",
        parentID: "msg_qu",
        time: { created: now - 4_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "prt_q",
          sessionID: session,
          messageID: "msg_qa",
          type: "tool",
          callID: "call_q",
          tool: "question",
          state: { status: "running", input: { questions }, time: { start: now - 3_500 } },
        },
      ],
    },
  ];
  const promptQuestions = [
    {
      key: "v1:que_1",
      id: "que_1",
      sessionID: session,
      source: "v1",
      tooLarge: false,
      questions,
      tool: { messageID: "msg_qa", callID: "call_q" },
    },
  ];
  return { questions, messages, promptQuestions };
}

function sendFixture() {
  const now = Date.now();
  const session = THREADS.send;
  const messages = [
    {
      info: { id: "msg_su", sessionID: session, role: "user", time: { created: now - 5_000 } },
      parts: [
        {
          id: "prt_su",
          sessionID: session,
          messageID: "msg_su",
          type: "text",
          text: "Summarize the last run.",
        },
      ],
    },
    {
      info: {
        id: "msg_sa",
        sessionID: session,
        role: "assistant",
        parentID: "msg_su",
        time: { created: now - 4_000, completed: now - 3_000 },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_sa",
          sessionID: session,
          messageID: "msg_sa",
          type: "text",
          text: "The last run passed.",
        },
      ],
    },
  ];
  return { messages };
}

function diffToolPart(id, tool, options = {}) {
  const part = {
    id,
    sessionID: THREADS.diffs,
    messageID: "msg_diff_a",
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: {
      status: options.status ?? "completed",
      input: options.input ?? {},
      metadata: options.metadata ?? {},
      title: options.title ?? tool,
      time: { start: Date.now() - 2_000, end: Date.now() - 1_000 },
    },
  };
  if (options.output !== undefined) part.state.output = options.output;
  if (options.error !== undefined) part.state.error = options.error;
  return part;
}

function diffDetailPart(id, type, data) {
  return {
    id,
    sessionID: THREADS.diffs,
    messageID: "msg_diff_a",
    type,
    ...data,
  };
}

function diffMessage(parts) {
  const now = Date.now();
  return [
    {
      info: {
        id: "msg_diff_u",
        sessionID: THREADS.diffs,
        role: "user",
        time: { created: now - 10_000 },
      },
      parts: [
        {
          id: "prt_diff_u",
          sessionID: THREADS.diffs,
          messageID: "msg_diff_u",
          type: "text",
          text: "Show every diff shape and the written files.",
        },
      ],
    },
    {
      info: {
        id: "msg_diff_a",
        sessionID: THREADS.diffs,
        role: "assistant",
        parentID: "msg_diff_u",
        time: { created: now - 9_000, completed: now - 1_000 },
        finish: "stop",
      },
      parts,
    },
  ];
}

function tsSample(lineCount = 40) {
  const lines = [
    'import { readFile } from "node:fs/promises";',
    "",
    "export interface Config {",
    "  readonly path: string;",
    "  readonly retries: number;",
    "}",
    "",
    "export async function load(config: Config) {",
    "  for (let attempt = 0; attempt < config.retries; attempt += 1) {",
    "    try {",
    '      const text = await readFile(config.path, "utf8");',
    "      return text.trim();",
    "    } catch (error) {",
    "      if (attempt === config.retries - 1) throw error;",
    "    }",
    "  }",
    '  return "";',
    "}",
  ];
  while (lines.length < lineCount) {
    lines.push(`export const value${lines.length} = ${lines.length};`);
  }
  return `${lines.slice(0, lineCount).join("\n")}\n`;
}

function bigCode(bytes = 64 * 1024) {
  const lines = [];
  let size = 0;
  let index = 0;
  while (size < bytes) {
    let line = `export const value${index} = "${"x".repeat(32)}";\n`;
    if (size + line.length > bytes) line = line.slice(0, bytes - size);
    lines.push(line);
    size += line.length;
    index += 1;
  }
  return lines.join("");
}

function addFilePatch(filePath, content, extraHeaders = []) {
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    ...extraHeaders,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function longDiffPatch(filePath, lineCount, marker = "line") {
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -1,${lineCount} +1,${lineCount} @@`];
  for (let index = 1; index <= lineCount; index += 1) {
    lines.push(`+export const ${marker}${index} = "value-${index}-${"y".repeat(60)}";`);
  }
  return lines.join("\n");
}

const STANDARD_EDIT_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,6 @@",
  " export function greet(name: string) {",
  '-  const message = "Hello " + name;',
  "-  return message;",
  "+  const message = 'Hello ' + name;",
  "+  const shout = message.toUpperCase();",
  "+  return shout;",
  " }",
].join("\n");

const HASHLINE_EDIT_PATCH = [
  "--- a/src/hash.ts",
  "+++ b/src/hash.ts",
  "@@ -1,2 +1,2 @@",
  '-export const hash = "old";',
  '+export const hash = "new";',
  " export const keep = true;",
].join("\n");

function applyPatchFixture() {
  const files = [
    {
      type: "add",
      filePath: "src/added.ts",
      relativePath: "src/added.ts",
      patch: [
        "@@ -0,0 +1,3 @@",
        "+export const added = 1;",
        "+export const extra = 2;",
        "+export const more = 3;",
      ].join("\n"),
      additions: 3,
      deletions: 0,
    },
    {
      type: "update",
      filePath: "src/updated.ts",
      relativePath: "src/updated.ts",
      patch: [
        "@@ -1,2 +1,2 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        " export const keep = true;",
      ].join("\n"),
      additions: 1,
      deletions: 1,
    },
    {
      type: "delete",
      filePath: "src/deleted.ts",
      relativePath: "src/deleted.ts",
      patch: [
        "@@ -1,2 +0,0 @@",
        "-export const gone = true;",
        "-export const alsoGone = false;",
      ].join("\n"),
      additions: 0,
      deletions: 2,
    },
    {
      type: "move",
      filePath: "src/old-name.ts",
      relativePath: "src/new-name.ts",
      movePath: "src/new-name.ts",
      patch: ["@@ -1 +1 @@", '-export const moved = "old";', '+export const moved = "new";'].join(
        "\n",
      ),
      additions: 1,
      deletions: 1,
    },
  ];
  return files;
}

function manyFileDiff(count = 55) {
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const filePath = `src/generated/f${index}.ts`;
    blocks.push(
      [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        "@@ -1 +1 @@",
        `-export const f${index} = ${index};`,
        `+export const f${index} = ${index + 1};`,
      ].join("\n"),
    );
  }
  return blocks.join("\n");
}

function bigPatchFixture() {
  const standardPatch = STANDARD_EDIT_PATCH;
  const hashPatch = HASHLINE_EDIT_PATCH;
  const parts = [
    diffToolPart("prt_std_edit", "edit", {
      input: { filePath: "src/app.ts" },
      metadata: { filediff: { file: "src/app.ts", patch: standardPatch } },
    }),
    diffToolPart("prt_hash_edit", "edit", {
      input: { filePath: "src/hash.ts" },
      metadata: {
        diff: hashPatch,
        filediff: { file: "src/hash.ts", additions: 1, deletions: 1 },
      },
    }),
    diffToolPart("prt_apply", "apply_patch", {
      input: { patchText: "*** Begin Patch\n*** End Patch" },
      metadata: { files: applyPatchFixture() },
      title: "Apply 4 patches",
    }),
    diffToolPart("prt_write40", "write", {
      input: { filePath: "src/sample.ts", content: tsSample(40) },
      metadata: { exists: false },
      title: "Wrote src/sample.ts",
    }),
    diffToolPart("prt_write_empty", "write", {
      input: { filePath: "src/empty.ts", content: "" },
      metadata: { exists: false },
      title: "Wrote src/empty.ts",
    }),
    diffToolPart("prt_write_big", "write", {
      input: { filePath: "src/generated.ts", content: bigCode() },
      metadata: { exists: false },
      title: "Wrote src/generated.ts",
    }),
    diffDetailPart("prt_patch_files", "patch", {
      title: "patch",
      files: ["src/app.ts", "docs/notes.md"],
    }),
    diffDetailPart("prt_patch_string", "patch", {
      title: "patch",
      patch: standardPatch,
    }),
    diffDetailPart("prt_patch_text", "patch", {
      title: "patch",
      text: standardPatch,
    }),
    diffToolPart("prt_unknown", "edit", {
      input: { filePath: "assets/notes.unknownext" },
      metadata: {
        filediff: {
          file: "assets/notes.unknownext",
          patch: [
            "--- a/assets/notes.unknownext",
            "+++ b/assets/notes.unknownext",
            "@@ -1 +1 @@",
            "-alpha beta",
            "+alpha gamma",
          ].join("\n"),
        },
      },
    }),
    diffToolPart("prt_binary", "edit", {
      input: { filePath: "assets/logo.png" },
      metadata: {
        filediff: {
          file: "assets/logo.png",
          patch: [
            "diff --git a/assets/logo.png b/assets/logo.png",
            "index 1111111..2222222 100644",
            "Binary files a/assets/logo.png and b/assets/logo.png differ",
          ].join("\n"),
        },
      },
    }),
    diffToolPart("prt_trunc", "edit", {
      input: { filePath: "src/truncated.ts" },
      metadata: { filediff: { file: "src/truncated.ts", patch: standardPatch } },
    }),
    diffToolPart("prt_omit", "edit", {
      input: { filePath: "src/omitted.ts" },
      metadata: { filediff: { file: "src/omitted.ts", patch: standardPatch } },
    }),
    diffToolPart("prt_many", "apply_patch", {
      input: { patchText: "" },
      metadata: { diff: manyFileDiff(55), files: [] },
      title: "Apply 55 patches",
    }),
  ];
  return {
    messages: diffMessage(parts),
    parts,
    truncatedPart: parts.find((part) => part.id === "prt_trunc"),
  };
}

function readFixture() {
  const start = 1418;
  const source = [
    "def summarize_items(items, skip_index, limit=2.0):",
    '    """Return the summarized items."""',
    "    if not items:",
    "        return []",
    "",
    "    result = []",
    "    for index, item in enumerate(items):",
    "        if index == skip_index:",
    "            continue",
    "        result.append(item)",
    "    return result",
  ];
  const end = start + source.length - 1;
  const path = "/workspace/example/apps/demo-app/tools/analyzer/webui.py";
  const statusLine = `Showing lines ${start}-${end} of 5169. Use offset=${end + 1} to continue.`;
  const output = [
    `<path>${path}</path>`,
    "<type>file</type>",
    "<content>",
    ...source.map((text, index) => `${start + index}: ${text}`),
    "",
    `(${statusLine})`,
    "</content>",
  ].join("\n");
  const part = diffToolPart("prt_read", "read", {
    input: { filePath: path, offset: start, limit: source.length },
    output,
    title: "Read webui.py",
  });
  return { messages: diffMessage([part]), path, start, end, statusLine, lineCount: source.length };
}

function errorFixture() {
  return diffMessage([
    diffToolPart("prt_error", "edit", {
      status: "error",
      input: { filePath: "src/broken.ts" },
      metadata: { filediff: { file: "src/broken.ts", patch: STANDARD_EDIT_PATCH } },
      error: "Invalid patch: hunk header mismatch.",
      title: "edit src/broken.ts",
    }),
  ]);
}

function lazyFixture() {
  const now = Date.now();
  const openPatch = longDiffPatch("src/open.ts", 220, "open");
  const closedPatch = longDiffPatch("src/closed.ts", 160, "closed");
  const parts = [
    diffToolPart("prt_lazy_open", "edit", {
      status: "running",
      input: { filePath: "src/open.ts" },
      metadata: { filediff: { file: "src/open.ts", patch: openPatch } },
      title: "edit src/open.ts",
    }),
    diffToolPart("prt_lazy_closed", "edit", {
      input: { filePath: "src/closed.ts" },
      metadata: { filediff: { file: "src/closed.ts", patch: closedPatch } },
      title: "edit src/closed.ts",
    }),
  ];
  const message = diffMessage(parts);
  message[1].info.time = { created: now - 9_000 };
  return { messages: message, openPatch, closedPatch };
}

function streamingFixture() {
  const now = Date.now();
  const livePatch = longDiffPatch("src/live.ts", 120, "live");
  const closedPatch = longDiffPatch("src/idle.ts", 80, "idle");
  const livePart = diffToolPart("prt_stream_live", "edit", {
    status: "running",
    input: { filePath: "src/live.ts" },
    metadata: { filediff: { file: "src/live.ts", patch: livePatch } },
    title: "edit src/live.ts",
  });
  const closedPart = diffToolPart("prt_stream_closed", "edit", {
    status: "running",
    input: { filePath: "src/idle.ts" },
    metadata: { filediff: { file: "src/idle.ts", patch: closedPatch } },
    title: "edit src/idle.ts",
  });
  const message = diffMessage([livePart, closedPart]);
  message[1].info.time = { created: now - 9_000 };
  const messages = [...message];
  return {
    messages,
    livePart,
    closedPart,
    livePatch,
    closedPatch,
    completedLivePart: {
      ...livePart,
      state: {
        ...livePart.state,
        status: "completed",
        time: { start: now - 9_000, end: now - 1_000 },
      },
    },
  };
}

function adversarialFixture() {
  const markdown = Array.from({ length: 40 }, () => "[".repeat(190)).join("\n");
  const markup = Array.from(
    { length: 90 },
    (_value, index) => `<section data-i="${index}"><a href="#x">link ${index}</a></section>`,
  ).join("\n");
  const bash = Array.from(
    { length: 90 },
    (_value, index) => `if [ -n "$value_${index}" ]; then echo "\${value_${index}//a/b}"; fi`,
  ).join("\n");
  const parts = [
    diffToolPart("prt_adv_md", "edit", {
      input: { filePath: "docs/pathological.md" },
      metadata: {
        filediff: {
          file: "docs/pathological.md",
          patch: addFilePatch("docs/pathological.md", markdown),
        },
      },
    }),
    diffToolPart("prt_adv_markup", "edit", {
      input: { filePath: "docs/pathological.html" },
      metadata: {
        filediff: {
          file: "docs/pathological.html",
          patch: addFilePatch("docs/pathological.html", markup),
        },
      },
    }),
    diffToolPart("prt_adv_bash", "edit", {
      input: { filePath: "scripts/pathological.sh" },
      metadata: {
        filediff: {
          file: "scripts/pathological.sh",
          patch: addFilePatch("scripts/pathological.sh", bash),
        },
      },
    }),
    diffToolPart("prt_adv_write", "write", {
      input: { filePath: "src/generated.ts", content: bigCode() },
      metadata: { exists: false },
      title: "Wrote src/generated.ts",
    }),
  ];
  return { messages: diffMessage(parts), markdown, markup, bash };
}

function timeoutFixture() {
  const markdown = [
    "--- a/docs/hang.md",
    "+++ b/docs/hang.md",
    "@@ -0,0 +1,6 @@",
    "+# Hang",
    "+__QA_HANG__",
    "+[",
    "+[[[",
    "+normal",
    "+tail",
  ].join("\n");
  return diffMessage([
    diffToolPart("prt_timeout", "edit", {
      input: { filePath: "docs/hang.md" },
      metadata: { filediff: { file: "docs/hang.md", patch: markdown } },
    }),
  ]);
}

function contextMessages(sessionID) {
  const now = Date.now();
  return [
    {
      info: { id: "msg_ctx_u", sessionID, role: "user", time: { created: now - 5_000 } },
      parts: [
        {
          id: "prt_ctx_u",
          sessionID,
          messageID: "msg_ctx_u",
          type: "text",
          text: "Show the context usage for this session.",
        },
      ],
    },
    {
      info: {
        id: "msg_ctx_a",
        sessionID,
        role: "assistant",
        parentID: "msg_ctx_u",
        time: { created: now - 4_000, completed: now - 3_000 },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_ctx_a",
          sessionID,
          messageID: "msg_ctx_a",
          type: "text",
          text: "The context rail is ready.",
        },
      ],
    },
  ];
}

async function waitForChipLabel(page, label, timeout = 5_000) {
  await page.waitForFunction(
    (expected) => document.getElementById("chat-context-chip-label")?.textContent === expected,
    label,
    { timeout },
  );
}

async function openContextRail(page) {
  await page.locator("#chat-context-chip").click();
  await page.waitForFunction(
    () => document.getElementById("chat-shell")?.dataset.chatContext === "open",
    undefined,
    { timeout: 2_000 },
  );
  await wait(300);
}

async function clickSession(page, id) {
  await page.evaluate((sessionID) => {
    const button = Array.from(document.querySelectorAll(".session-item")).find(
      (node) => node.dataset.sessionId === sessionID,
    );
    if (!(button instanceof HTMLElement)) throw new Error(`session ${sessionID} is not rendered`);
    button.click();
  }, id);
}

async function contextUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    const chip = document.getElementById("chat-context-chip");
    const chipMeter = chip?.querySelector(".chat-context-chip__meter") ?? null;
    const meter = document.getElementById("chat-context-meter");
    const compact = document.getElementById("chat-context-compact");
    const reason = document.getElementById("chat-context-compact-reason");
    const confirm = document.getElementById("chat-context-confirm");
    const error = document.getElementById("chat-context-error");
    const settings = document.getElementById("chat-context-settings");
    return {
      session: text(document.getElementById("chat-session-id")),
      title: text(document.getElementById("chat-session-title")),
      chip: {
        hidden: chip?.hidden ?? null,
        label: text(document.getElementById("chat-context-chip-label")),
        exact: text(document.getElementById("chat-context-chip-exact")),
        state: chip?.dataset.state ?? null,
        title: chip?.getAttribute("title") ?? null,
        meterHidden: chipMeter?.hidden ?? null,
        meterRole: chipMeter?.getAttribute("role") ?? null,
        meterNow: chipMeter?.getAttribute("aria-valuenow") ?? null,
        meterText: chipMeter?.getAttribute("aria-valuetext") ?? null,
      },
      rail: {
        open: document.getElementById("chat-shell")?.dataset.chatContext ?? null,
        usageHidden: document.getElementById("chat-context-usage")?.hidden ?? null,
        state: document.getElementById("chat-context-usage")?.dataset.state ?? null,
        summary: text(document.getElementById("chat-context-summary")),
        detail: text(document.getElementById("chat-context-detail")),
        auto: text(document.getElementById("chat-context-auto")),
        autoTitle: document.getElementById("chat-context-auto")?.getAttribute("title") ?? null,
        settingsHref: settings?.getAttribute("href") ?? null,
        meterHidden: meter?.hidden ?? null,
        meterRole: meter?.getAttribute("role") ?? null,
        meterMin: meter?.getAttribute("aria-valuemin") ?? null,
        meterMax: meter?.getAttribute("aria-valuemax") ?? null,
        meterNow: meter?.getAttribute("aria-valuenow") ?? null,
        meterText: meter?.getAttribute("aria-valuetext") ?? null,
      },
      compact: {
        disabled: compact?.disabled ?? null,
        state: compact?.dataset.state ?? null,
        busy: compact?.getAttribute("aria-busy") ?? null,
        reason: text(reason),
        reasonHidden: reason?.hidden ?? null,
      },
      confirm: {
        hidden: confirm?.hidden ?? null,
        text: text(confirm),
        active: document.activeElement?.id ?? null,
      },
      error: {
        hidden: error?.hidden ?? null,
        text: text(error),
        role: error?.getAttribute("role") ?? null,
      },
      toasts: Array.from(document.querySelectorAll("#toast-region .toast")).map((node) => ({
        text: text(node.querySelector(".toast__copy")),
        tone: node.dataset.tone ?? null,
        role: node.getAttribute("role"),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioContextStates(browser, target) {
  const readySession = THREADS.main;
  const tokensSession = "ses_context_tokens";
  const unknownSession = "ses_context_unknown";
  const ineffectiveSession = "ses_context_ineffective";
  const snapshots = {
    [readySession]: defaultContextSnapshot(readySession),
    [tokensSession]: {
      ...defaultContextSnapshot(tokensSession),
      used: 124000,
      limit: null,
      percent: null,
      autoCompact: { enabled: true, percent: 70, source: "project", percentSource: "project" },
    },
    [unknownSession]: {
      ...defaultContextSnapshot(unknownSession),
      state: "unknown",
      used: null,
      limit: null,
      percent: null,
      model: null,
      autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
    },
    [ineffectiveSession]: {
      ...defaultContextSnapshot(ineffectiveSession),
      used: 190000,
      percent: 95,
      lastError: "compaction_failed",
    },
  };
  const sessionIDs = [readySession, tokensSession, unknownSession, ineffectiveSession];
  const titles = ["Ready", "Tokens only", "Unknown", "Ineffective"];
  const { context, page, errors } = await newPage(browser, target);
  try {
    await installRoutes(page, {
      sessionId: readySession,
      messages: contextMessages(readySession),
      sessions: () =>
        sessionIDs.map((id, index) => ({
          id,
          title: titles[index],
          time: { updated: Date.now() - index * 1_000 },
        })),
      context: ({ sessionID }) => snapshots[sessionID] ?? snapshots[readySession],
    });
    await gotoChat(page, target, readySession);
    await waitForChipLabel(page, "Context 62%");
    await openContextRail(page);

    const ready = await contextUi(page);
    check(ready.chip.hidden === false, "ready context chip is visible");
    assertEqual(ready.chip.label, "Context 62%", "ready chip label");
    assertEqual(
      ready.chip.exact,
      "124,000 / 200,000 tokens · deepseek/deepseek-flash",
      "ready chip accessible detail",
    );
    assertEqual(ready.chip.state, "ok", "ready chip state");
    check(
      ready.chip.title === "124,000 / 200,000 tokens · deepseek/deepseek-flash",
      `ready chip title carries the detail (${ready.chip.title})`,
    );
    check(
      ready.chip.meterHidden === false &&
        ready.chip.meterRole === "meter" &&
        ready.chip.meterNow === "62" &&
        ready.chip.meterText === "62%; 124,000 / 200,000 tokens · deepseek/deepseek-flash",
      "ready chip meter exposes the true percentage and detail",
    );
    check(ready.rail.open === "open", "the context chip opens the context rail");
    check(ready.rail.usageHidden === false, "the context rail section is visible");
    assertEqual(ready.rail.state, "ok", "ready rail state");
    assertEqual(ready.rail.summary, "62% of 200k", "ready rail summary");
    assertEqual(
      ready.rail.detail,
      "124,000 / 200,000 tokens · deepseek/deepseek-flash",
      "ready rail detail",
    );
    assertEqual(ready.rail.auto, "Auto-compact at 80%", "ready auto-compact line");
    assertEqual(
      ready.rail.autoTitle,
      "Enabled by application; threshold from global.",
      "ready auto-compact source title",
    );
    check(
      ready.rail.settingsHref?.includes("/settings"),
      `the context settings link points at settings (${ready.rail.settingsHref})`,
    );
    check(
      ready.rail.meterHidden === false &&
        ready.rail.meterRole === "meter" &&
        ready.rail.meterMin === "0" &&
        ready.rail.meterMax === "100" &&
        ready.rail.meterNow === "62" &&
        ready.rail.meterText === "62%; 124,000 / 200,000 tokens · deepseek/deepseek-flash",
      "ready rail meter has role/meter ARIA and the true percentage",
    );
    check(ready.compact.disabled === false, "Compact now is enabled for a ready session");
    assertEqual(ready.compact.state, "ready", "ready compact button state");
    check(
      ready.compact.reasonHidden === true && ready.compact.reason === "",
      `ready compact button has no disabled reason (${ready.compact.reason})`,
    );
    check(ready.confirm.hidden === true, "the inline confirm starts hidden");
    check(ready.error.hidden === true, "no context error is shown for a ready session");

    await shot(page, "context-ready-1440-dark");

    await page.setViewportSize({ width: 390, height: 844 });
    await wait(350);
    const mobile = await contextUi(page);
    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(mobileOverflow === 0, `no horizontal page overflow at 390 (${mobileOverflow}px)`);
    check(
      mobile.chip.label === "Context 62%" && mobile.rail.open === "open",
      "the context chip and rail survive the 390 layout",
    );
    await shot(page, "context-ready-390-dark");

    await page.setViewportSize({ width: 768, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await wait(350);
    const light = await contextUi(page);
    check(light.rail.summary === "62% of 200k", "the context rail renders in light theme");
    await shot(page, "context-ready-768-light");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await wait(300);

    await clickSession(page, tokensSession);
    await waitForChipLabel(page, "Context 124k");
    await openContextRail(page);
    const tokens = await contextUi(page);
    assertEqual(tokens.chip.label, "Context 124k", "tokens-only chip label");
    assertEqual(
      tokens.chip.exact,
      "124,000 tokens · deepseek/deepseek-flash",
      "tokens-only accessible detail",
    );
    assertEqual(tokens.chip.state, "unknown", "tokens-only chip state");
    check(
      tokens.chip.meterHidden === false &&
        tokens.chip.meterNow === "0" &&
        tokens.chip.meterText === "124,000 tokens · deepseek/deepseek-flash",
      "tokens-only chip meter stays visible with a 0% fill and token text",
    );
    assertEqual(tokens.rail.summary, "124k tokens", "tokens-only rail summary");
    assertEqual(
      tokens.rail.detail,
      "124,000 tokens · deepseek/deepseek-flash",
      "tokens-only rail detail",
    );
    assertEqual(tokens.rail.auto, "Auto-compact at 70%", "tokens-only auto-compact line");
    assertEqual(tokens.rail.autoTitle, "Enabled by project.", "tokens-only auto-compact source");
    check(tokens.compact.disabled === false, "manual compaction works without a known limit");
    await shot(page, "context-tokens-only-1440-dark");

    await clickSession(page, unknownSession);
    await waitForChipLabel(page, "Context —");
    await openContextRail(page);
    const unknown = await contextUi(page);
    assertEqual(unknown.chip.label, "Context —", "unknown chip label");
    assertEqual(unknown.chip.state, "unknown", "unknown chip state");
    check(unknown.chip.meterHidden === true, "unknown chip hides the meter");
    assertEqual(unknown.rail.summary, "—", "unknown rail summary");
    assertEqual(unknown.rail.detail, "—", "unknown rail detail");
    assertEqual(unknown.rail.auto, "Auto-compact off", "unknown auto-compact line");
    assertEqual(unknown.rail.autoTitle, "Auto-compact is off.", "unknown auto-compact title");
    check(
      unknown.compact.disabled === true &&
        unknown.compact.reason === "No model is known for this session." &&
        unknown.compact.reasonHidden === false,
      `unknown snapshot disables Compact now with a reason (${unknown.compact.reason})`,
    );
    await shot(page, "context-unknown-1440-dark");

    await clickSession(page, ineffectiveSession);
    await waitForChipLabel(page, "Context 95%");
    await openContextRail(page);
    const ineffective = await contextUi(page);
    assertEqual(ineffective.chip.label, "Context 95%", "ineffective chip label");
    assertEqual(ineffective.chip.state, "danger", "ineffective chip state");
    assertEqual(ineffective.rail.state, "danger", "ineffective rail state");
    assertEqual(ineffective.rail.summary, "95% of 200k", "ineffective rail summary");
    check(
      ineffective.error.hidden === false &&
        ineffective.error.text === "Compaction failed. Try again." &&
        ineffective.error.role === "alert",
      `ineffective compaction surfaces the fixed error (${ineffective.error.text})`,
    );
    assertEqual(ineffective.rail.auto, "Auto-compact at 80%", "ineffective auto-compact line");
    check(
      ineffective.compact.disabled === false,
      "a recorded compaction failure does not block a manual retry",
    );
    await shot(page, "context-ineffective-1440-dark");

    checkNoErrors(errors);
    return { ready, mobile, light, tokens, unknown, ineffective };
  } finally {
    await context.close();
  }
}

async function scenarioContextLive(browser, target) {
  const sessionID = THREADS.main;
  const initial = { ...defaultContextSnapshot(sessionID), status: "busy" };
  const live = {
    ...initial,
    used: 150000,
    percent: 75,
    topLevel: true,
    activeChildren: false,
    pendingTask: false,
  };
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionID,
      messages: contextMessages(sessionID),
      context: () => initial,
    });
    await gotoChat(page, target, sessionID);
    await waitForChipLabel(page, "Context 62%");
    const getsBefore = routeState.contextGets.length;

    await page.evaluate((snapshot) => {
      window.__qaEventSource.emit({
        type: "context.updated",
        sessionID: snapshot.sessionID,
        seq: 1,
        streamID: "qa-stream",
        context: snapshot,
      });
    }, live);

    await waitForChipLabel(page, "Context 75%");
    const ui = await contextUi(page);
    assertEqual(ui.chip.label, "Context 75%", "live chip label");
    assertEqual(
      ui.chip.exact,
      "150,000 / 200,000 tokens · deepseek/deepseek-flash",
      "live chip detail",
    );
    assertEqual(ui.rail.summary, "75% of 200k", "live rail summary");
    check(
      routeState.contextGets.length === getsBefore,
      "a pushed context frame does not trigger a context GET",
    );
    await shot(page, "context-live-1440-dark");
    checkNoErrors(errors);
    return ui;
  } finally {
    await context.close();
  }
}

async function scenarioContextCompact(browser, target) {
  const sessionID = THREADS.main;
  const ready = defaultContextSnapshot(sessionID);
  const compacting = { ...ready, state: "compacting" };
  const compacted = { ...ready, used: 12000, percent: 6 };
  let phase = "ready";
  const { context, page, errors } = await newPage(browser, target);
  let first;
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionID,
      messages: contextMessages(sessionID),
      context: () => {
        if (phase === "compacting") return compacting;
        if (phase === "compacted") return compacted;
        return ready;
      },
      compact: () => {
        phase = "compacting";
        return { accepted: true, sessionID };
      },
    });
    await gotoChat(page, target, sessionID);
    await waitForChipLabel(page, "Context 62%");
    await openContextRail(page);
    await page.locator("#chat-context-compact").click();
    await page.waitForFunction(
      () => document.getElementById("chat-context-confirm")?.hidden === false,
      undefined,
      { timeout: 2_000 },
    );
    const confirm = await contextUi(page);
    check(confirm.confirm.hidden === false, "Compact now opens the inline confirm");
    check(
      confirm.confirm.text.includes("Summarization replaces the session history"),
      `the inline confirm explains the risk (${confirm.confirm.text})`,
    );
    assertEqual(
      confirm.confirm.active,
      "chat-context-confirm-compact",
      "focus moves to the confirm action",
    );
    await shot(page, "context-confirm-1440-dark");

    await page.locator("#chat-context-confirm-compact").click();
    await waitForChipLabel(page, "Compacting");
    const compactingUi = await contextUi(page);
    assertEqual(routeState.compactCalls.length, 1, "exactly one compact POST for one confirm");
    assertEqual(
      routeState.compactCalls[0]?.sessionID,
      sessionID,
      "compact POST targets the session",
    );
    assertEqual(routeState.compactCalls[0]?.status, 202, "compact POST returns 202");
    assertEqual(routeState.compactCalls[0]?.body, "{}", "compact POST sends an empty body");
    assertEqual(compactingUi.chip.label, "Compacting", "compacting chip label");
    assertEqual(compactingUi.chip.state, "compacting", "compacting chip state");
    check(
      compactingUi.compact.disabled === true &&
        compactingUi.compact.reason === "Compaction in progress.",
      `Compact now is disabled while compacting (${compactingUi.compact.reason})`,
    );
    check(compactingUi.confirm.hidden === true, "the confirm closes after acceptance");
    check(
      compactingUi.toasts.some(
        (toast) => toast.text === "Compaction started." && toast.tone === "success",
      ),
      `acceptance shows the started toast (${compactingUi.toasts.map((toast) => toast.text).join(" | ")})`,
    );
    await shot(page, "context-compacting-1440-dark");

    await wait(400);
    const settledGets = routeState.contextGets.length;
    const pollDeadline = Date.now() + 4_500;
    while (routeState.contextGets.length <= settledGets && Date.now() < pollDeadline) {
      await wait(100);
    }
    check(
      routeState.contextGets.length > settledGets,
      `a compacting snapshot starts the 2s context poll (${settledGets} -> ${routeState.contextGets.length})`,
    );

    phase = "compacted";
    await emit(page, {
      type: "session.compacted",
      seq: 1,
      streamID: "qa-stream",
      sessionID,
    });
    await waitForChipLabel(page, "Context 6%");
    const compactedUi = await contextUi(page);
    check(
      compactedUi.toasts.some(
        (toast) => toast.text === "Session compacted." && toast.tone === "success",
      ),
      `session.compacted shows the compacted toast (${compactedUi.toasts.map((toast) => toast.text).join(" | ")})`,
    );
    assertEqual(compactedUi.chip.state, "ok", "the refreshed snapshot returns to ready");
    assertEqual(compactedUi.rail.summary, "6% of 200k", "the refreshed usage is rendered");
    check(compactedUi.compact.disabled === false, "Compact now is enabled again when ready");
    check(compactedUi.error.hidden === true, "the compacted snapshot clears the error line");
    assertEqual(
      routeState.compactCalls.length,
      1,
      "session.compacted never POSTs a second compaction",
    );
    await shot(page, "context-compacted-1440-dark");
    checkNoErrors(errors);
    first = { confirm, compactingUi, compactedUi, routeState };
  } finally {
    await context.close();
  }

  const conflict = await newPage(browser, target);
  try {
    const conflictState = await installRoutes(conflict.page, {
      sessionId: sessionID,
      messages: contextMessages(sessionID),
      context: () => defaultContextSnapshot(sessionID),
      compact: () => ({
        status: 409,
        body: { error: "Compaction is already in progress.", code: "compact_in_progress" },
      }),
    });
    await gotoChat(conflict.page, target, sessionID);
    await waitForChipLabel(conflict.page, "Context 62%");
    await openContextRail(conflict.page);
    await conflict.page.locator("#chat-context-compact").click();
    await conflict.page.waitForFunction(
      () => document.getElementById("chat-context-confirm")?.hidden === false,
      undefined,
      { timeout: 2_000 },
    );
    await conflict.page.locator("#chat-context-confirm-compact").click();
    await conflict.page.waitForFunction(
      () => {
        const error = document.getElementById("chat-context-error");
        return error !== null && error.hidden === false && error.textContent.length > 0;
      },
      undefined,
      { timeout: 3_000 },
    );
    const conflictUi = await contextUi(conflict.page);
    assertEqual(conflictState.compactCalls.length, 1, "the 409 path still issues one compact POST");
    assertEqual(conflictState.compactCalls[0]?.status, 409, "the compact POST returns 409");
    assertEqual(
      conflictUi.error.text,
      "Compaction is already in progress.",
      "the fixed 409 message is shown inline",
    );
    assertEqual(conflictUi.error.role, "alert", "the inline error is an alert");
    check(
      conflictUi.toasts.some(
        (toast) => toast.text === "Compaction is already in progress." && toast.tone === "error",
      ),
      `the 409 path shows an error toast (${conflictUi.toasts.map((toast) => toast.text).join(" | ")})`,
    );
    check(
      conflictUi.compact.disabled === false && conflictUi.compact.state === "ready",
      "a rejected compaction re-enables the button",
    );
    check(conflictUi.confirm.hidden === true, "the confirm stays closed after a 409");
    assertEqual(conflictUi.chip.label, "Context 62%", "a 409 never renders a compacting chip");
    await shot(conflict.page, "context-compact-409-1440-dark");
    checkExpectedHttpError(conflict.errors, 409);
    return { first, conflict: conflictUi, conflictState };
  } finally {
    await conflict.context.close();
  }
}

async function scenarioContextSwitchRace(browser, target) {
  const sessionA = THREADS.main;
  const sessionB = "ses_context_other";
  const snapshotA = defaultContextSnapshot(sessionA);
  const snapshotB = {
    ...defaultContextSnapshot(sessionB),
    used: 60000,
    percent: 30,
  };
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionA,
      messages: contextMessages(sessionA),
      sessions: () => [
        { id: sessionB, title: "Other", time: { updated: Date.now() } },
        { id: sessionA, title: "Main", time: { updated: Date.now() - 1_000 } },
      ],
      context: async ({ sessionID, call }) => {
        if (sessionID === sessionB) return snapshotB;
        if (call.sessionCallIndex >= 2) await wait(900);
        return snapshotA;
      },
    });
    await gotoChat(page, target, sessionA);
    await waitForChipLabel(page, "Context 62%");

    await clickSession(page, sessionB);
    await waitForChipLabel(page, "Context 30%");
    await wait(150);

    await clickSession(page, sessionA);
    const started = Date.now();
    while (
      !routeState.contextGets.some(
        (entry) => entry.sessionID === sessionA && entry.sessionCallIndex >= 2,
      ) &&
      Date.now() - started < 1_000
    ) {
      await wait(20);
    }
    await clickSession(page, sessionB);
    await waitForChipLabel(page, "Context 30%");

    const samples = [];
    for (let index = 0; index < 15; index += 1) {
      samples.push(
        await page.evaluate(
          () => document.getElementById("chat-context-chip-label")?.textContent ?? null,
        ),
      );
      await wait(100);
    }
    const late = await contextUi(page);
    const aCalls = routeState.contextGets.filter((entry) => entry.sessionID === sessionA);
    check(
      aCalls.length >= 2,
      `the delayed session A context request was issued (${aCalls.length})`,
    );
    check(
      aCalls.some((entry) => entry.sessionCallIndex >= 2 && entry.status === 200),
      "the delayed session A response was delivered",
    );
    check(
      samples.every((label) => label === "Context 30%"),
      `session A never overwrites session B after the switch (${samples.join(" | ")})`,
    );
    assertEqual(late.chip.label, "Context 30%", "the selected session keeps its own chip");
    assertEqual(late.rail.state, "ok", "the selected session keeps its own rail state");
    assertEqual(late.session, sessionB.slice(0, 8), "the selected session id stays on B");
    await shot(page, "context-switch-race-1440-dark");
    checkNoErrors(errors);
    return { samples, late, aCalls };
  } finally {
    await context.close();
  }
}

async function scenarioContextRetry(browser, target) {
  const sessionID = THREADS.main;
  const snapshot = defaultContextSnapshot(sessionID);
  let failNext = 0;
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionID,
      messages: contextMessages(sessionID),
      context: ({ sessionID: requested }) => {
        if (requested !== sessionID || failNext === 0) return snapshot;
        failNext -= 1;
        return {
          status: 503,
          body: { error: "Agent is not running.", code: "agent_not_running" },
        };
      },
    });
    await gotoChat(page, target, sessionID);
    await waitForChipLabel(page, "Context 62%");
    const before = routeState.contextGets.length;
    failNext = 1;

    await emit(page, { type: "stream.ready", seq: 0, streamID: "qa-retry" });
    await page.waitForFunction(
      () => document.getElementById("chat-context-chip")?.hidden === true,
      undefined,
      { timeout: 2_000 },
    );
    const unavailable = await contextUi(page);
    check(unavailable.chip.hidden === true, "the 503 hides the chip until recovery");
    assertEqual(
      await page.evaluate(() => document.getElementById("chat-context-detail")?.textContent),
      "Context unavailable",
      "the 503 shows the context-unavailable detail",
    );

    await waitForChipLabel(page, "Context 62%", 4_000);
    const retryCalls = routeState.contextGets.slice(before);
    const recovered = await contextUi(page);
    check(
      retryCalls.length >= 2,
      `the 503 retry issued a second context GET (${retryCalls.length})`,
    );
    assertEqual(
      retryCalls.slice(0, 2).map((entry) => entry.status),
      [503, 200],
      "the retry sequence is 503 then 200",
    );
    assertEqual(
      retryCalls[0]?.code,
      "agent_not_running",
      "the first 503 carries agent_not_running",
    );
    check(
      retryCalls[1].at - retryCalls[0].at >= 700,
      `the retry waits for the 750ms backoff (${retryCalls[1].at - retryCalls[0].at}ms)`,
    );
    check(recovered.chip.hidden === false, "the chip appears after the retry succeeds");
    assertEqual(recovered.chip.label, "Context 62%", "the retried snapshot renders");
    await shot(page, "context-retry-1440-dark");
    checkExpectedHttpError(errors, 503);
    return { unavailable, recovered, retryCalls };
  } finally {
    await context.close();
  }
}

async function scenarioMain(browser, target) {
  const { messages, todo } = mainFixture();
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages,
      todos: todo,
    });
    await gotoChat(page, target);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);

    await emit(page, {
      type: "message.part.delta",
      seq: 1,
      streamID: "qa-stream",
      sessionID: THREADS.main,
      messageID: "msg_a1",
      partID: "prt_t1",
      field: "text",
      delta: "\n\nLint is queued next.",
      partType: "text",
    });
    await page.waitForFunction(
      (needle) =>
        Array.from(
          document.querySelectorAll(
            ".message:not(.message--user):not(.message--system) .message__body",
          ),
        ).some((node) => (node.textContent ?? "").includes(needle)),
      "Lint is queued next.",
      { timeout: 3_000 },
    );

    // Keep later snapshots consistent with the already-applied delta/tool output.
    const nextBashOutput =
      "✓ test/chat-core.test.ts (70 tests)\n✓ test/chat-page.test.ts (25 tests)\n";
    messages[1].parts[1].text += "\n\nLint is queued next.";
    messages[1].parts[2].state.metadata.output = nextBashOutput;

    await emit(page, {
      type: "message.part.updated",
      seq: 2,
      streamID: "qa-stream",
      sessionID: THREADS.main,
      messageID: "msg_a1",
      partID: "prt_bash1",
      partType: "tool",
      part: {
        id: "prt_bash1",
        sessionID: THREADS.main,
        messageID: "msg_a1",
        type: "tool",
        callID: "call_bash",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "npm test" },
          metadata: { output: nextBashOutput },
          title: "npm test",
          time: { start: Date.now() - 45_000 },
        },
      },
    });
    await wait(500);

    const metrics = await page.evaluate(() => {
      const feed = document.querySelector(".chat-thread__inner");
      const scroll = document.getElementById("chat-scroll");
      const composer = document.querySelector(".composer__row");
      const scrollStyle = scroll ? getComputedStyle(scroll) : null;
      const padding = scrollStyle
        ? Number.parseFloat(scrollStyle.paddingLeft) + Number.parseFloat(scrollStyle.paddingRight)
        : 0;
      const width = (node) => (node ? Math.round(node.getBoundingClientRect().width) : null);
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        feedWidth: width(feed),
        scrollClient: scroll ? scroll.clientWidth : null,
        contentWidth: scroll ? Math.round(scroll.clientWidth - padding) : null,
        composerWidth: width(composer),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        status: {
          hidden: document.getElementById("chat-working")?.hidden ?? null,
          label: text(document.getElementById("chat-working-label")),
          elapsed: text(document.getElementById("chat-working-elapsed")),
          queued: text(document.getElementById("chat-working-queued")),
        },
        queue: {
          hidden: document.getElementById("chat-queue-strip")?.hidden ?? null,
          count: text(document.getElementById("chat-queue-strip-count")),
          rows: Array.from(document.querySelectorAll(".chat-queue-strip__item")).map((node) => ({
            text: text(node),
            state: text(node.querySelector(".chat-queue-strip__state")),
          })),
        },
        tables: document.querySelectorAll(".message__table").length,
        tableHeaders: document.querySelectorAll(".message__table th").length,
        tableRows: document.querySelectorAll(".message__table tbody tr").length,
        systems: document.querySelectorAll(".message--system").length,
        omo: document.querySelectorAll(".omo-card").length,
        todos: document.querySelectorAll(".tool-todo__item").length,
        systemText: Array.from(document.querySelectorAll(".message--system")).map(text).join(" "),
        assistantText: Array.from(
          document.querySelectorAll(
            ".message:not(.message--user):not(.message--system) .message__body",
          ),
        )
          .map(text)
          .join(" "),
        bodyText: text(document.getElementById("chat-messages")),
      };
    });

    check(metrics.feedWidth !== null, "feed is rendered");
    check(metrics.composerWidth !== null, "composer row is rendered");
    check(
      Math.abs(metrics.feedWidth - metrics.composerWidth) <= 1,
      `feed and composer share one width (${metrics.feedWidth} vs ${metrics.composerWidth})`,
    );
    const scrollRatio = metrics.feedWidth / metrics.scrollClient;
    const contentRatio = metrics.feedWidth / metrics.contentWidth;
    check(
      scrollRatio >= 0.78 && scrollRatio <= 0.82,
      `feed is ~80% of the scroll client at 1440 (${Math.round(scrollRatio * 100)}%)`,
    );
    check(
      contentRatio >= 0.85 && contentRatio <= 0.89,
      `feed is ~87% of the padded content box at 1440 (${Math.round(contentRatio * 100)}%)`,
    );
    check(metrics.overflowX === 0, `no horizontal page overflow at 1440 (${metrics.overflowX}px)`);
    check(metrics.queue.hidden === false, "queue strip is visible");
    check(
      metrics.queue.rows.length === 2,
      `queue strip shows 2 rows (${metrics.queue.rows.length})`,
    );
    check(
      metrics.queue.count.includes("2 messages queued"),
      `queue count reads 2 messages queued (${metrics.queue.count})`,
    );
    check(
      metrics.queue.rows.every((row) => row.state === "Queued"),
      "both queued rows carry the Queued state",
    );
    check(metrics.tables === 1, `GFM table rendered (${metrics.tables})`);
    check(metrics.tableHeaders === 2, `table has 2 headers (${metrics.tableHeaders})`);
    check(metrics.tableRows === 3, `table has 3 body rows (${metrics.tableRows})`);
    check(metrics.systems === 1, `OMO system card rendered (${metrics.systems})`);
    check(metrics.omo === 1, `OMO card class rendered (${metrics.omo})`);
    check(metrics.todos === 3, `todowrite checklist has 3 items (${metrics.todos})`);
    check(
      metrics.assistantText.includes("I'll run the suite and then summarize."),
      "assistant text is rendered",
    );
    const deltaCount = metrics.assistantText.split("Lint is queued next.").length - 1;
    check(
      deltaCount === 1,
      `streamed text delta is rendered exactly once (count=${deltaCount}, snapshots=${routeState.messageGets.length})`,
    );
    check(
      !metrics.systemText.includes("OMO_INTERNAL_INITIATOR") &&
        !metrics.systemText.includes("<system-reminder>"),
      "OMO markers are hidden from the system card",
    );
    check(metrics.status.hidden === false, "status label is visible");
    check(
      /^Running (bash|plan)$/.test(metrics.status.label),
      `status label is a Running label (${metrics.status.label})`,
    );
    check(
      metrics.status.queued.includes("2 queued"),
      `status carries the queued suffix (${metrics.status.queued})`,
    );
    check(
      metrics.status.elapsed.length > 0,
      `status shows elapsed time (${metrics.status.elapsed})`,
    );

    await shot(page, "main-1440-dark");

    const toolCount = await page.locator(".tool-call").count();
    check(toolCount >= 3, `tool disclosures rendered (${toolCount})`);
    for (let index = 0; index < toolCount; index += 1) {
      const summary = page.locator(".tool-call").nth(index).locator("summary");
      if ((await summary.count()) > 0) await summary.first().click();
    }
    await wait(300);

    const tools = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        details: Array.from(document.querySelectorAll(".tool-call")).map((node) => ({
          open: node.open,
          text: text(node).slice(0, 240),
          output: text(node.querySelector(".tool-call__output")),
          todoItems: node.querySelectorAll(".tool-todo__item").length,
        })),
        todoStatuses: Array.from(document.querySelectorAll(".tool-todo__status")).map(text),
        ariaCurrent: document.querySelectorAll('.tool-todo__item[aria-current="step"]').length,
      };
    });
    check(
      tools.details.every((item) => item.open),
      "all tool disclosures expand",
    );
    const bash = tools.details.find((item) => item.text.includes("npm test"));
    check(bash !== undefined, "bash tool disclosure is present");
    check(
      bash.output.includes("✓ test/chat-core.test.ts (70 tests)") &&
        bash.output.includes("✓ test/chat-page.test.ts (25 tests)"),
      `running bash output is visible (${bash.output})`,
    );
    check(
      tools.details.some((item) => item.text.startsWith("Thinking")),
      "reasoning disclosure is labelled Thinking",
    );
    check(
      tools.details.some((item) => item.todoItems === 3),
      "todowrite checklist is rendered",
    );
    check(
      tools.todoStatuses.includes("Done") &&
        tools.todoStatuses.includes("Now") &&
        tools.todoStatuses.includes("Pending"),
      "todowrite statuses are Done/Now/Pending",
    );
    check(
      tools.ariaCurrent === 1,
      `exactly one in-progress todo is aria-current (${tools.ariaCurrent})`,
    );

    await shot(page, "main-1440-tools");

    await page.setViewportSize({ width: 390, height: 844 });
    await wait(400);
    await page.evaluate(() => {
      const scroll = document.getElementById("chat-scroll");
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
    await wait(400);

    const mobile = await page.evaluate(() => {
      const feed = document.querySelector(".chat-thread__inner");
      const list = document.querySelector(".chat-queue-strip__list");
      const table = document.querySelector(".message__table-wrap");
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        feedWidth: feed ? Math.round(feed.getBoundingClientRect().width) : null,
        tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
        queueList: list ? { client: list.clientWidth, scroll: list.scrollWidth } : null,
        systems: document.querySelectorAll(".message--system").length,
        todos: document.querySelectorAll(".tool-todo__item").length,
      };
    });
    check(mobile.overflowX === 0, `no horizontal page overflow at 390 (${mobile.overflowX}px)`);
    check(mobile.feedWidth !== null, "feed is rendered at 390");
    check(
      mobile.tableWidth !== null && mobile.tableWidth <= mobile.feedWidth + 1,
      `table wrapper stays inside the feed at 390 (${mobile.tableWidth} <= ${mobile.feedWidth})`,
    );
    check(
      mobile.queueList !== null && mobile.queueList.scroll >= mobile.queueList.client,
      "queue strip scrolls horizontally on mobile",
    );
    check(mobile.systems === 1, "OMO system card survives the mobile layout");
    check(mobile.todos === 3, "todowrite checklist survives the mobile layout");

    await shot(page, "main-390-dark");
    checkNoErrors(errors);

    return { metrics, tools, mobile };
  } finally {
    await context.close();
  }
}

async function scenarioSessionTree(browser, target) {
  const fixture = sessionTreeFixture();
  const sessions = fixture.sessions;
  const promptQuestions = [fixture.childQuestion];

  const removeLoadedSubtree = (rootID) => {
    const childrenByParent = new Map();
    for (const session of sessions) {
      const parentID = typeof session.parentID === "string" ? session.parentID : null;
      if (parentID === null) continue;
      const bucket = childrenByParent.get(parentID) ?? [];
      bucket.push(String(session.id));
      childrenByParent.set(parentID, bucket);
    }
    const removed = new Set([rootID]);
    const stack = [rootID];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const childID of childrenByParent.get(id) ?? []) {
        if (removed.has(childID)) continue;
        removed.add(childID);
        stack.push(childID);
      }
    }
    const kept = sessions.filter((session) => !removed.has(String(session.id)));
    sessions.splice(0, sessions.length, ...kept);
    return removed;
  };

  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: "ses_parent",
      sessions: () => sessions,
      messages: fixture.messages,
      prompts: () => promptQuestions,
      onDeleteSession: (sessionID) => {
        removeLoadedSubtree(sessionID);
      },
    });
    page.on("dialog", (dialog) => {
      dialog.accept().catch(() => {});
    });

    const treeState = () =>
      page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll("#session-list .session-node"));
        const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
        const isVisible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
        const entries = {};
        for (const node of nodes) {
          const id = node.dataset.sessionId;
          if (typeof id !== "string") continue;
          const row =
            Array.from(node.children).find((child) => child.classList.contains("session-row")) ??
            null;
          const children =
            Array.from(node.children).find((child) =>
              child.classList.contains("session-children"),
            ) ?? null;
          const chevron = row?.querySelector(".session-chevron") ?? null;
          const item = row?.querySelector(".session-item") ?? null;
          entries[id] = {
            depth: Number(node.dataset.depth),
            visible: isVisible(node),
            chevron:
              chevron === null
                ? null
                : {
                    expanded: chevron.getAttribute("aria-expanded"),
                    disabled: chevron.getAttribute("aria-disabled"),
                    controls: chevron.getAttribute("aria-controls"),
                  },
            spacer: node.querySelector(".session-chevron__spacer") !== null,
            childrenHidden: children === null ? null : children.hidden,
            active: item?.getAttribute("aria-current") === "true",
            waitText: text(row?.querySelector(".session-item__flag")),
          };
        }
        const activeItem = Array.from(document.querySelectorAll(".session-item")).find(
          (node) => node.getAttribute("aria-current") === "true",
        );
        return {
          ids: Object.keys(entries),
          visibleIds: Object.keys(entries).filter((id) => entries[id].visible),
          entries,
          active: activeItem?.dataset.sessionId ?? null,
        };
      });

    const waitForVisible = async (sessionID, want = true) => {
      await page.waitForFunction(
        ({ id, expect }) => {
          const node = document.querySelector(`.session-node[data-session-id="${id}"]`);
          const visible = node instanceof HTMLElement && node.getClientRects().length > 0;
          return expect ? visible : !visible;
        },
        { id: sessionID, expect: want },
        { timeout: 3_000 },
      );
    };

    await gotoChat(page, target);
    await page.waitForSelector("#session-list .session-node");
    await page.waitForSelector('.session-item[aria-current="true"]');
    let state = await treeState();
    check(
      ["ses_parent", "ses_leaf", "ses_orphan", "ses_other"].includes(state.active),
      `default selection is a root (${state.active})`,
    );
    assertEqual(state.active, "ses_parent", "default selection is the first root");
    check(state.entries.ses_parent?.chevron !== null, "the parent row has a chevron");
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "false",
      "the parent starts collapsed",
    );
    assertEqual(
      state.entries.ses_parent?.childrenHidden,
      true,
      "the parent's children container starts hidden",
    );
    check(state.entries.ses_child1?.visible === false, "child1 is hidden initially");
    await shot(page, "session-tree-initial-1440-dark");

    await page
      .locator('.session-node[data-session-id="ses_parent"] > .session-row > .session-chevron')
      .click();
    await waitForVisible("ses_child1");
    state = await treeState();
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "true",
      "the parent chevron reports expanded",
    );
    assertEqual(
      state.entries.ses_parent?.childrenHidden,
      false,
      "the parent's children container is revealed",
    );
    check(state.entries.ses_child1?.visible === true, "child1 is visible after expanding");
    check(state.entries.ses_child2?.visible === true, "child2 is visible after expanding");

    const parentControls = state.entries.ses_parent?.chevron?.controls;
    check(
      typeof parentControls === "string" && parentControls.length > 0,
      `the parent chevron has aria-controls (${parentControls})`,
    );
    check(
      await page.evaluate((id) => document.getElementById(id) !== null, parentControls),
      "the parent aria-controls target exists",
    );

    await page
      .locator('.session-node[data-session-id="ses_child1"] > .session-row > .session-chevron')
      .click();
    await waitForVisible("ses_grand");
    state = await treeState();
    assertEqual(state.entries.ses_grand?.depth, 2, "the grandchild renders at depth 2");
    assertEqual(
      state.entries.ses_child1?.chevron?.expanded,
      "true",
      "child1 reports expanded for its grandchild",
    );

    await page
      .locator('.session-node[data-session-id="ses_child1"] > .session-row > .session-chevron')
      .click();
    await waitForVisible("ses_grand", false);
    state = await treeState();
    assertEqual(
      state.entries.ses_child1?.chevron?.expanded,
      "false",
      "collapsing child1 flips aria-expanded",
    );
    check(state.entries.ses_grand?.visible === false, "the grandchild is hidden after collapsing");
    assertEqual(state.entries.ses_orphan?.depth, 0, "the orphan renders as a root");
    check(state.entries.ses_orphan?.chevron === null, "the orphan root has no chevron");
    check(state.entries.ses_orphan?.spacer === true, "the orphan root keeps the spacer");
    assertEqual(state.entries.ses_leaf?.depth, 0, "the leaf renders as a root");
    check(state.entries.ses_leaf?.chevron === null, "the leaf has no chevron");
    check(state.entries.ses_leaf?.spacer === true, "the leaf keeps the spacer");

    await gotoChat(page, target, "ses_grand");
    await page.waitForSelector('#session-list .session-node[data-session-id="ses_grand"]');
    await waitForVisible("ses_grand");
    state = await treeState();
    assertEqual(state.active, "ses_grand", "the deep link selects the grandchild");
    check(state.entries.ses_grand?.active === true, "the active grandchild row has aria-current");
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "true",
      "the parent ancestor is expanded for the deep link",
    );
    assertEqual(
      state.entries.ses_child1?.chevron?.expanded,
      "true",
      "the immediate ancestor is expanded for the deep link",
    );
    check(state.entries.ses_grand?.visible === true, "the deep-linked grandchild is visible");

    await page.locator("#session-search").fill("Grandchild");
    await page.waitForFunction(
      () => {
        const other = document.querySelector('.session-node[data-session-id="ses_other"]');
        return other === null || other.getClientRects().length === 0;
      },
      undefined,
      { timeout: 3_000 },
    );
    await wait(100);
    state = await treeState();
    check(state.entries.ses_grand?.visible === true, "the search match stays visible");
    check(state.entries.ses_parent?.visible === true, "the match's parent is visible");
    check(state.entries.ses_child1?.visible === true, "the match's immediate ancestor is visible");
    check(!state.visibleIds.includes("ses_child2"), "the sibling of the match is hidden");
    check(!state.visibleIds.includes("ses_other"), "the unrelated root is hidden by search");
    assertEqual(
      state.entries.ses_parent?.chevron?.disabled,
      "true",
      "the forced-open parent chevron is aria-disabled",
    );
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "true",
      "the forced-open parent chevron stays expanded",
    );
    assertEqual(
      state.entries.ses_child1?.chevron?.disabled,
      "true",
      "the forced-open ancestor chevron is aria-disabled",
    );
    assertEqual(
      state.entries.ses_child1?.chevron?.expanded,
      "true",
      "the forced-open ancestor chevron stays expanded",
    );
    await shot(page, "session-tree-search-1440-dark");

    await page.locator("#session-search").fill("");
    await waitForVisible("ses_child2");
    state = await treeState();
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "true",
      "clearing the search restores the parent expansion",
    );
    assertEqual(
      state.entries.ses_child1?.chevron?.expanded,
      "true",
      "clearing the search restores the ancestor expansion",
    );
    check(
      state.entries.ses_grand?.visible === true,
      "the grandchild returns after clearing search",
    );
    check(state.entries.ses_child2?.visible === true, "the sibling returns after clearing search");
    assertEqual(
      state.entries.ses_parent?.chevron?.disabled,
      null,
      "clearing the search removes aria-disabled from the parent chevron",
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "session-tree-1440-dark");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await wait(100);
    await shot(page, "session-tree-1440-light");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("[data-chat-sessions-toggle]").click();
    await wait(350);
    await shot(page, "session-tree-390-dark");
    await page.setViewportSize({ width: 320, height: 844 });
    await wait(350);
    await shot(page, "session-tree-320-dark");
    await page.setViewportSize({ width: 1440, height: 900 });
    await wait(350);

    const badControls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#session-list .session-chevron"))
        .filter((chevron) => chevron.getClientRects().length > 0)
        .map((chevron) => {
          const controls = chevron.getAttribute("aria-controls");
          return {
            controls,
            exists: controls !== null && document.getElementById(controls) !== null,
          };
        })
        .filter((entry) => !entry.exists),
    );
    assertEqual(badControls, [], "every visible chevron points at an existing children group");

    await page.locator('.session-item[data-session-id="ses_leaf"]').focus();
    const leafIndex = sessions.findIndex((session) => String(session.id) === "ses_leaf");
    sessions[leafIndex].title = "Leaf task refreshed";
    const getsBeforeFocusRefresh = routeState.sessionGets.length;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(
      () =>
        (document.querySelector('.session-item[data-session-id="ses_leaf"] .session-item__title')
          ?.textContent ?? "") === "Leaf task refreshed",
      undefined,
      { timeout: 3_000 },
    );
    const focusState = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? null,
        className: typeof active?.className === "string" ? active.className : "",
        sessionID: active?.closest?.(".session-node")?.dataset.sessionId ?? null,
        itemID: active?.dataset?.sessionId ?? null,
      };
    });
    check(
      routeState.sessionGets.length > getsBeforeFocusRefresh,
      "the focus refresh fetched the sessions list",
    );
    assertEqual(focusState.sessionID, "ses_leaf", "keyboard focus stays on the focused row");
    check(
      focusState.className.includes("session-item"),
      `keyboard focus is restored to the session button (${focusState.className})`,
    );

    await page
      .locator('.session-node[data-session-id="ses_parent"] > .session-row > .session-chevron')
      .click();
    await waitForVisible("ses_child1", false);
    await page.waitForFunction(
      () => {
        const row = document.querySelector(
          '.session-node[data-session-id="ses_parent"] > .session-row',
        );
        return (row?.querySelector(".session-item__flag")?.textContent ?? "").includes("1 waiting");
      },
      undefined,
      { timeout: 5_000 },
    );
    state = await treeState();
    assertEqual(
      state.entries.ses_parent?.chevron?.expanded,
      "false",
      "the parent stays collapsed while its child waits",
    );
    check(!state.visibleIds.includes("ses_child1"), "the waiting child is hidden under the parent");
    assertEqual(
      state.entries.ses_parent?.waitText,
      "1 waiting",
      "the parent shows the aggregate wait",
    );
    assertEqual(
      await page.evaluate(
        () =>
          document
            .querySelector(
              '.session-node[data-session-id="ses_parent"] > .session-row > .session-item .session-item__flag',
            )
            ?.getAttribute("aria-label") ?? null,
      ),
      "1 requests need input",
      "the aggregate wait flag has an accessible label",
    );
    await shot(page, "session-tree-waiting-1440-dark");

    const deleteCountBefore = routeState.deleteCalls.length;
    const getsBeforeDelete = routeState.sessionGets.length;
    await page
      .locator('.session-node[data-session-id="ses_parent"] > .session-row > .session-delete')
      .click();
    await page.waitForFunction(
      () => {
        const ids = Array.from(document.querySelectorAll("#session-list .session-node")).map(
          (node) => node.dataset.sessionId,
        );
        return ["ses_parent", "ses_child1", "ses_child2", "ses_grand"].every(
          (id) => !ids.includes(id),
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    const deleteDeadline = Date.now() + 5_000;
    while (routeState.sessionGets.length <= getsBeforeDelete && Date.now() < deleteDeadline) {
      await wait(50);
    }
    await wait(300);
    state = await treeState();
    assertEqual(
      routeState.deleteCalls.length,
      deleteCountBefore + 1,
      "the delete confirmation issued one DELETE",
    );
    assertEqual(
      routeState.deleteCalls.at(-1)?.sessionID,
      "ses_parent",
      "the DELETE targets the parent session",
    );
    for (const removedID of ["ses_parent", "ses_child1", "ses_child2", "ses_grand"]) {
      check(!state.ids.includes(removedID), `${removedID} is removed from the tree`);
      check(!state.visibleIds.includes(removedID), `${removedID} is no longer visible`);
    }
    for (const survivor of ["ses_leaf", "ses_orphan", "ses_other"]) {
      check(state.ids.includes(survivor), `${survivor} survives the subtree delete`);
      check(state.visibleIds.includes(survivor), `${survivor} stays visible`);
    }
    assertEqual(state.active, "ses_leaf", "the first remaining root is selected");
    check(state.entries.ses_leaf?.active === true, "the new active row has aria-current");
    const lastSessionGet = routeState.sessionGets.at(-1);
    check(
      lastSessionGet !== undefined &&
        !lastSessionGet.ids.includes("ses_parent") &&
        !lastSessionGet.ids.includes("ses_child1") &&
        lastSessionGet.ids.includes("ses_leaf"),
      "the post-delete sessions refresh does not resurrect the subtree",
    );
    await shot(page, "session-tree-after-delete-1440-dark");

    checkNoErrors(errors);
    return {
      activeAfterDelete: state.active,
      sessionsAfterDelete: state.ids,
      deleteCalls: routeState.deleteCalls.length,
      focus: focusState,
    };
  } finally {
    await context.close();
  }
}

async function scenarioQuestions(browser, target) {
  const fixture = questionFixture();
  const { context, page, errors } = await newPage(browser, target);
  let replyState;
  let answeredResult;
  try {
    replyState = await installRoutes(page, {
      sessionId: THREADS.questions,
      messages: fixture.messages,
      promptQuestions: fixture.promptQuestions,
    });
    await gotoChat(page, target, THREADS.questions);
    await page.waitForSelector(".chat-question");
    await wait(300);

    const initial = await page.evaluate(() => {
      const card = document.querySelector(".chat-question");
      return {
        questionCount: document.querySelectorAll(".chat-question").length,
        state: card?.dataset.state ?? null,
        dockHidden: document.getElementById("chat-prompt-dock")?.hidden ?? null,
        composerDisabled: document.getElementById("chat-send")?.disabled ?? null,
        workingHidden: document.getElementById("chat-working")?.hidden ?? null,
        heading: document
          .querySelector(".chat-question [data-question-heading]")
          ?.textContent?.trim(),
      };
    });
    check(initial.questionCount === 1, `one inline question card (${initial.questionCount})`);
    check(initial.state === "pending", `inline question is pending (${initial.state})`);
    check(initial.dockHidden === true, "the prompt dock is hidden for a correlated question");
    check(
      initial.composerDisabled === true,
      "the composer is disabled while a question is pending",
    );
    check(initial.workingHidden === true, "the inline question hides the working status");
    check(initial.heading === "Question", `inline card heading is Question (${initial.heading})`);

    await shot(page, "question-pending-1440-dark");

    await page.locator('.chat-question input[value="Red"]').click();
    await wait(200);
    const afterAdvance = await page.evaluate(() => {
      const active = document.activeElement;
      const field = active?.closest?.(".prompt-question");
      return {
        stepLabel: document
          .querySelector(".chat-question .prompt-dock__step-label")
          ?.textContent?.trim(),
        activeTag: active?.tagName ?? null,
        activeType: active?.type ?? null,
        activeValue: active?.value ?? null,
        activeQuestion: field
          ? (field.querySelector(".prompt-question__text")?.textContent ?? "").trim()
          : null,
      };
    });
    check(
      afterAdvance.stepLabel === "Question 2 of 2",
      `single-select advances to Question 2 of 2 (${afterAdvance.stepLabel})`,
    );
    check(
      afterAdvance.activeType === "checkbox" && afterAdvance.activeValue === "Unit",
      `focus moves to Q2's first input (${afterAdvance.activeType}:${afterAdvance.activeValue})`,
    );
    check(
      afterAdvance.activeQuestion === "Pick checks",
      `focused input belongs to Q2 (${afterAdvance.activeQuestion})`,
    );
    await shot(page, "question-q2-1440-dark");

    await page.locator('.chat-question input[value="Unit"]').click();
    await wait(200);
    const afterMulti = await page.evaluate(() => {
      const field = document.activeElement?.closest?.(".prompt-question");
      return {
        stepLabel: document
          .querySelector(".chat-question .prompt-dock__step-label")
          ?.textContent?.trim(),
        question: field
          ? (field.querySelector(".prompt-question__text")?.textContent ?? "").trim()
          : null,
        checked: Array.from(document.querySelectorAll(".chat-question input:checked")).map(
          (input) => input.value,
        ),
      };
    });
    check(afterMulti.stepLabel === "Question 2 of 2", "multi-select does not auto-advance");
    check(afterMulti.checked.includes("Unit"), "multi-select Unit remains checked");

    await page.locator(".chat-question [data-prompt-review-tab]").click();
    await wait(150);
    await page.locator('.chat-question [data-prompt-primary="true"]').click();
    await wait(400);

    check(
      replyState.replyCount === 1,
      `question reply is submitted once (${replyState.replyCount})`,
    );
    assertEqual(replyState.replyBody?.answers, [["Red"], ["Unit"]], "question reply body");

    const base = "qa-stream";
    await emitMany(page, [
      {
        type: "question.replied",
        seq: 1,
        streamID: base,
        sessionID: THREADS.questions,
        requestID: "que_1",
        source: "v1",
      },
      {
        type: "message.part.updated",
        seq: 2,
        streamID: base,
        sessionID: THREADS.questions,
        messageID: "msg_qa",
        partID: "prt_q",
        partType: "tool",
        part: {
          id: "prt_q",
          sessionID: THREADS.questions,
          messageID: "msg_qa",
          type: "tool",
          callID: "call_q",
          tool: "question",
          state: {
            status: "completed",
            input: { questions: fixture.questions },
            metadata: { answers: [["Red"], ["Unit"]] },
            output: "User has answered your questions.",
            title: "Asked 2 questions",
            time: { start: Date.now() - 3_500, end: Date.now() },
          },
        },
      },
    ]);
    await wait(400);

    const answered = await page.evaluate(() => {
      const card = document.querySelector(".chat-question");
      return {
        state: card?.dataset.state ?? null,
        answers: Array.from(document.querySelectorAll(".chat-question__answer-value")).map(
          (node) => node.textContent,
        ),
        cardCount: document.querySelectorAll(".chat-question").length,
        text: (card?.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    });
    check(
      answered.state === "answered",
      `completed part renders an answered card (${answered.state})`,
    );
    check(answered.cardCount === 1, "the answered card replaces the pending card in place");
    assertEqual(answered.answers, ["Red", "Unit"], "answered Q&A values");
    answeredResult = answered;

    await shot(page, "question-answered-1440-dark");
    checkNoErrors(errors);
  } finally {
    await context.close();
  }

  const custom = customQuestionFixture();
  const customPage = await newPage(browser, target);
  let customReply;
  try {
    customReply = await installRoutes(customPage.page, {
      sessionId: THREADS.questions,
      messages: custom.messages,
      promptQuestions: custom.promptQuestions,
    });
    await gotoChat(customPage.page, target, THREADS.questions);
    await customPage.page.waitForSelector(".chat-question");
    await wait(300);

    const customInput = customPage.page.locator('.chat-question input[data-prompt-custom="0"]');
    await customInput.fill("Green");
    await customInput.press("Enter");
    await wait(500);

    check(customReply.replyCount === 1, "custom-answer Enter submits exactly once");
    assertEqual(customReply.replyBody?.answers, [["Green"]], "custom-answer reply body");

    const afterEnter = await customPage.page.evaluate(() => {
      const card = document.querySelector(".chat-question");
      return {
        state: card?.dataset.state ?? null,
        text: (card?.textContent ?? "").replace(/\s+/g, " ").trim(),
        activeId: document.activeElement?.id ?? null,
      };
    });
    check(
      afterEnter.state === "answered",
      `custom answer becomes an answered card (${afterEnter.state})`,
    );
    check(afterEnter.text.includes("Green"), "custom answer is shown in the Q&A card");
    check(
      afterEnter.activeId === "chat-prompt",
      `focus returns to the composer after submit (${afterEnter.activeId})`,
    );

    await shot(customPage.page, "question-custom-1440-dark");
    checkNoErrors(customPage.errors);

    return { reply: replyState.replyBody, answered: answeredResult, custom: customReply.replyBody };
  } finally {
    await customPage.context.close();
  }
}

async function scenarioSend(browser, target) {
  const fixture = sendFixture();
  // A slow 202 makes the optimistic row observable before acceptance.
  const { context, page, errors } = await newPage(browser, target);
  const postDelayMs = 700;
  let routeState;
  try {
    routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: fixture.messages,
      postDelayMs,
      messageIDs: ["msg_new", "msg_new2"],
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector(".message");
    await wait(600);

    const prompt = page.locator("#chat-prompt");
    await prompt.fill("Please stream the answer.");
    await prompt.press("Enter");
    await wait(100);

    const sending = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        optimistic: Array.from(document.querySelectorAll(".message--optimistic")).map((node) => ({
          id: node.dataset.messageId,
          state: node.dataset.state,
          text: text(node),
        })),
        composer: document.getElementById("chat-prompt")?.value ?? null,
      };
    });
    check(sending.optimistic.length === 1, "one optimistic row appears before the 202");
    check(
      sending.optimistic[0].state === "sending" && sending.optimistic[0].id.startsWith("local_"),
      `optimistic row is local and sending (${sending.optimistic[0].id}:${sending.optimistic[0].state})`,
    );
    check(
      sending.optimistic[0].text.includes("Please stream the answer."),
      "optimistic row shows the submitted text",
    );
    check(sending.composer === "", "composer clears optimistically");
    await shot(page, "send-sending-1440-dark");

    await wait(900);
    const after202 = await page.evaluate(() => ({
      optimistic: Array.from(document.querySelectorAll(".message--optimistic")).map((node) => ({
        id: node.dataset.messageId,
        state: node.dataset.state,
      })),
      users: Array.from(document.querySelectorAll(".message--user")).map(
        (node) => node.dataset.messageId,
      ),
      promptOccurrences: document.body.textContent.split("Please stream the answer.").length - 1,
    }));
    check(after202.optimistic.length === 1, "the optimistic row is rekeyed, not duplicated");
    check(
      after202.optimistic[0].id === "msg_new" && after202.optimistic[0].state === "accepted",
      `optimistic row adopts the server ID (${after202.optimistic[0].id}:${after202.optimistic[0].state})`,
    );
    check(
      after202.users.filter((id) => id === "msg_new").length === 1,
      "exactly one user row carries the server ID",
    );
    check(
      after202.users.every((id) => !id.startsWith("local_")),
      "no local row remains after rekey",
    );
    check(
      after202.promptOccurrences === 1,
      `the prompt text appears once (${after202.promptOccurrences})`,
    );

    await emitMany(page, [
      {
        type: "message.updated",
        seq: 1,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_new",
        role: "user",
        time: { created: Date.now() },
      },
      {
        type: "message.part.updated",
        seq: 2,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_new",
        partID: "prt_new",
        partType: "text",
        part: {
          id: "prt_new",
          sessionID: THREADS.send,
          messageID: "msg_new",
          type: "text",
          text: "Please stream the answer.",
        },
      },
      {
        type: "message.updated",
        seq: 3,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans",
        role: "assistant",
        parentID: "msg_new",
        time: { created: Date.now() },
      },
      {
        type: "message.part.updated",
        seq: 4,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans",
        partID: "prt_ans",
        partType: "text",
        part: {
          id: "prt_ans",
          sessionID: THREADS.send,
          messageID: "msg_ans",
          type: "text",
          text: "",
          time: { start: Date.now() },
        },
      },
      {
        type: "message.part.delta",
        seq: 5,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans",
        partID: "prt_ans",
        field: "text",
        delta: "Streaming ",
        partType: "text",
      },
      {
        type: "message.part.delta",
        seq: 6,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans",
        partID: "prt_ans",
        field: "text",
        delta: "works.",
        partType: "text",
      },
      {
        type: "session.status",
        seq: 7,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        status: { type: "busy" },
      },
    ]);
    await wait(500);

    const streamed = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        users: Array.from(document.querySelectorAll(".message--user")).map((node) => ({
          id: node.dataset.messageId,
          text: text(node),
        })),
        assistants: Array.from(
          document.querySelectorAll(
            ".message:not(.message--user):not(.message--system) .message__body",
          ),
        ).map(text),
        promptOccurrences: document.body.textContent.split("Please stream the answer.").length - 1,
        status: text(document.getElementById("chat-working-label")),
      };
    });
    check(
      streamed.assistants.includes("Streaming works."),
      `assistant text deltas render (${streamed.assistants.join(" | ")})`,
    );
    check(
      streamed.promptOccurrences === 1,
      `no duplicate user text after the server echo (${streamed.promptOccurrences})`,
    );
    check(
      streamed.status !== "Ready",
      `status is not Ready while the turn is active (${streamed.status})`,
    );
    await shot(page, "send-streaming-1440-dark");

    await prompt.fill("Second queued message.");
    await prompt.press("Enter");
    await wait(900);

    const queued = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        queue: {
          hidden: document.getElementById("chat-queue-strip")?.hidden ?? null,
          count: text(document.getElementById("chat-queue-strip-count")),
          rows: Array.from(document.querySelectorAll(".chat-queue-strip__item")).map(text),
        },
        optimistic: Array.from(document.querySelectorAll(".message--optimistic")).map((node) => ({
          id: node.dataset.messageId,
          state: node.dataset.state,
        })),
        status: text(document.getElementById("chat-working-label")),
        queuedSuffix: text(document.getElementById("chat-working-queued")),
      };
    });
    check(routeState.postCalls === 2, `two async sends were accepted (${routeState.postCalls})`);
    check(
      routeState.postBodies.every((entry) => entry.url.includes("async=1")),
      "both sends use the async flag",
    );
    check(queued.queue.hidden === false, "queue strip is visible for the busy send");
    check(
      queued.queue.rows.length === 1,
      `queue strip shows one queued row (${queued.queue.rows.length})`,
    );
    check(
      queued.queue.count.includes("1 message queued"),
      `queue count reads 1 message queued (${queued.queue.count})`,
    );
    check(
      queued.optimistic.some((row) => row.id === "msg_new2" && row.state === "queued"),
      "the second send is presented as queued",
    );
    check(
      queued.queuedSuffix.includes("1 queued"),
      `status carries the queued suffix (${queued.queuedSuffix})`,
    );
    await shot(page, "send-queued-1440-dark");

    await emitMany(page, [
      {
        type: "message.updated",
        seq: 8,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_new2",
        role: "user",
        time: { created: Date.now() },
      },
      {
        type: "message.part.updated",
        seq: 9,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_new2",
        partID: "prt_new2",
        partType: "text",
        part: {
          id: "prt_new2",
          sessionID: THREADS.send,
          messageID: "msg_new2",
          type: "text",
          text: "Second queued message.",
        },
      },
      {
        type: "message.updated",
        seq: 10,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans2",
        role: "assistant",
        parentID: "msg_new2",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      },
      {
        type: "message.part.updated",
        seq: 11,
        streamID: "qa-stream",
        sessionID: THREADS.send,
        messageID: "msg_ans2",
        partID: "prt_ans2",
        partType: "text",
        part: {
          id: "prt_ans2",
          sessionID: THREADS.send,
          messageID: "msg_ans2",
          type: "text",
          text: "Queued answer.",
        },
      },
    ]);
    await wait(500);

    const consumed = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      return {
        queueHidden: document.getElementById("chat-queue-strip")?.hidden ?? null,
        queueRows: document.querySelectorAll(".chat-queue-strip__item").length,
        users: Array.from(document.querySelectorAll(".message--user")).map(
          (node) => node.dataset.messageId,
        ),
        assistants: Array.from(
          document.querySelectorAll(
            ".message:not(.message--user):not(.message--system) .message__body",
          ),
        ).map(text),
      };
    });
    check(consumed.queueHidden === true, "a completed assistant with parentID clears the queue");
    check(consumed.queueRows === 0, "no queued row remains after consumption");
    assertEqual(
      consumed.users,
      ["msg_su", "msg_new", "msg_new2"],
      "user rows contain no duplicate after consumption",
    );
    check(consumed.assistants.includes("Queued answer."), "the queued assistant reply is rendered");

    checkNoErrors(errors);
    return { sending, after202, streamed, queued, consumed };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsPalette(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "/");
    await waitForPalette(page);
    let state = await paletteState(page);
    check(state.hidden === false, "typing / opens the palette");
    check(state.role === "combobox", "the composer carries the combobox role");
    check(state.listboxRole === "listbox", "the palette list is a listbox");
    check(state.expanded === "true", "aria-expanded is true while open");
    check(
      state.groups.includes("Hanse") && state.groups.includes("Application commands"),
      `both groups render (${state.groups.join(", ")})`,
    );
    check(state.rowCount >= 11, `both sources are listed (${state.rowCount} rows)`);
    check(
      state.rows.some((row) => row.name === "/deploy"),
      "an application command row renders",
    );
    check(
      state.rows.some((row) => row.name === "/shellcheck" && row.badges.includes("Shell")),
      "a shell command carries the Shell badge",
    );
    check(
      state.rows.some((row) => row.name === "/mcp-unknown" && row.badges.includes("Shell unknown")),
      "an unknown-shell command carries the Shell unknown badge",
    );
    const disabled = state.rows.find((row) => row.name === "/disabledcmd");
    check(
      disabled?.disabled && disabled.reason.includes("Disabled"),
      "a disabled row stays visible with its reason",
    );
    check(
      state.shadowHidden === false && state.shadowText.includes("/ide"),
      "the shadow footer names the shadowed command",
    );
    check(routeState.commandGets.length >= 1, "the palette fetches GET /commands");

    await fillComposer(page, "/deploy");
    await wait(400);
    state = await paletteState(page);
    check(state.rowCount === 1 && state.rows[0].name === "/deploy", "filtering narrows the rows");
    check(state.status.includes("1 command"), `the status counts one result (${state.status})`);
    check(
      state.announcer.includes("1 command"),
      `the announcer reports one result (${state.announcer})`,
    );

    await fillComposer(page, "/zzz");
    await wait(400);
    state = await paletteState(page);
    check(state.rowCount === 0, "an unmatched filter renders no rows");
    check(state.status === "No matching commands", `the empty state is exact (${state.status})`);
    check(
      state.announcer === "No matching commands",
      `the announcer says no matching commands (${state.announcer})`,
    );

    await fillComposer(page, "/deploy");
    await wait(200);
    await prompt.press("Enter");
    await wait(200);
    const inserted = await page.inputValue("#chat-prompt");
    state = await paletteState(page);
    check(inserted === "/deploy ", `Enter inserts the canonical line (${inserted})`);
    check(state.hidden === true && state.expanded === "false", "inserting closes the palette");
    check(
      routeState.postCalls === 0 && routeState.commandPosts.length === 0,
      "Enter in the palette never executes or submits",
    );

    await fillComposer(page, "/");
    await waitForPalette(page);
    await page.evaluate(() => document.getElementById("chat-composer")?.requestSubmit());
    await wait(200);
    const submitted = await page.inputValue("#chat-prompt");
    check(submitted === "/new ", `a form submit while open inserts the active row (${submitted})`);
    check(
      routeState.postCalls === 0 && routeState.commandPosts.length === 0,
      "a form submit while open never executes",
    );

    await fillComposer(page, "");
    await page.click("#chat-commands-button");
    await waitForPalette(page);
    state = await paletteState(page);
    check(state.hidden === false, "the Commands button opens the palette");

    const seen = new Set();
    for (let index = 0; index < 18; index += 1) {
      await prompt.press("ArrowDown");
      const current = await paletteState(page);
      check(!current.activeDisabled, "ArrowDown never selects a disabled row");
      if (current.activeId !== null) seen.add(current.activeId);
    }
    check(seen.size > 4, `ArrowDown moves through the enabled rows (${seen.size})`);
    await prompt.press("End");
    const atEnd = await paletteState(page);
    check(!atEnd.activeDisabled, "End lands on an enabled row");
    check(atEnd.activeName !== "/disabledcmd", "End skips the disabled row");
    await prompt.press("Home");
    const atHome = await paletteState(page);
    check(atHome.activeName === "/new", `Home lands on the first row (${atHome.activeName})`);

    await prompt.press("Escape");
    const closed = await paletteState(page);
    check(closed.hidden === true, "Escape closes the palette");
    const focused = await page.evaluate(() => document.activeElement?.id ?? null);
    check(focused === "chat-prompt", `Escape returns focus to the composer (${focused})`);
    await page.click("#chat-commands-button");
    await waitForPalette(page);
    state = await paletteState(page);
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    await shot(page, "commands-palette-1440-dark");
    return { rows: state.rowCount, groups: state.groups };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsShellConfirm(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  let routeState;
  try {
    routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
      commandPost: () => ({
        status: 202,
        body: {
          accepted: true,
          sessionID: THREADS.send,
          name: "shellcheck",
          messageID: "msg_cmd_shell",
        },
      }),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "/");
    await waitForPalette(page);
    await fillComposer(page, "/shellcheck");
    await wait(250);
    await prompt.press("Enter");
    await wait(150);
    await prompt.pressSequentially("--dry-run");
    await prompt.press("Enter");
    await page.waitForSelector("#chat-command-confirm[open]");
    const dialog = await page.evaluate(() => ({
      title: document.getElementById("chat-command-confirm-title")?.textContent ?? "",
      body: document.getElementById("chat-command-confirm-body")?.textContent ?? "",
      modal: document.getElementById("chat-command-confirm")?.getAttribute("aria-modal"),
    }));
    check(
      dialog.title === "Run /shellcheck?",
      `the dialog title names the command (${dialog.title})`,
    );
    check(
      dialog.body.includes("runs on the server outside the agent permission flow"),
      "the shell warning explains the risk",
    );
    check(dialog.modal === "true", "the dialog is modal");
    check(routeState.commandPosts.length === 0, "no POST happens before confirmation");
    await wait(250);
    await shot(page, "commands-shell-confirm-1440-dark");

    await page.click("#chat-command-confirm-cancel");
    await wait(200);
    const cancelled = await page.evaluate(() => ({
      open: document.getElementById("chat-command-confirm")?.open ?? false,
      value: document.getElementById("chat-prompt")?.value ?? null,
    }));
    check(cancelled.open === false, "cancel closes the dialog");
    check(
      cancelled.value === "/shellcheck --dry-run",
      `cancel restores the draft (${cancelled.value})`,
    );
    check(routeState.commandPosts.length === 0, "cancel sends nothing");

    await prompt.press("Enter");
    await page.waitForSelector("#chat-command-confirm[open]");
    await page.click("#chat-command-confirm-accept");
    const deadline = Date.now() + 5000;
    while (routeState.commandPosts.length === 0 && Date.now() < deadline) await wait(50);
    check(routeState.commandPosts.length === 1, "accept posts exactly once");
    const body = routeState.commandPosts[0].body;
    assertEqual(
      { name: body.name, arguments: body.arguments, confirmShell: body.confirmShell },
      { name: "shellcheck", arguments: "--dry-run", confirmShell: true },
      "the shell command body",
    );
    await page.waitForFunction(
      () => {
        const row = document.querySelector(".message--optimistic");
        return row?.dataset.messageId === "msg_cmd_shell" && row?.dataset.state === "accepted";
      },
      undefined,
      { timeout: 5000 },
    );
    const optimistic = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".message--optimistic")).map((node) => ({
        id: node.dataset.messageId,
        state: node.dataset.state,
        text: node.textContent ?? "",
      })),
    );
    check(optimistic.length === 1, `exactly one optimistic row remains (${optimistic.length})`);
    check(
      optimistic[0].id === "msg_cmd_shell" && optimistic[0].text.includes("/shellcheck --dry-run"),
      "the optimistic row is rekeyed by the 202 messageID",
    );
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    return { body, optimistic };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsShellUnknown(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  let routeState;
  try {
    routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
      commandPost: () => ({
        status: 202,
        body: {
          accepted: true,
          sessionID: THREADS.send,
          name: "mcp-unknown",
          messageID: "msg_cmd_unknown",
        },
      }),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "/");
    await waitForPalette(page);
    const palette = await paletteState(page);
    const row = palette.rows.find((candidate) => candidate.name === "/mcp-unknown");
    check(row?.badges.includes("Shell unknown"), "the row carries Shell unknown");
    await fillComposer(page, "/mcp-unknown");
    await wait(250);
    await prompt.press("Enter");
    await wait(150);
    await prompt.press("Enter");
    await page.waitForSelector("#chat-command-confirm[open]");
    check(
      routeState.commandPosts.length === 0,
      "an unknown-shell command requires confirmation before the POST",
    );
    await wait(250);
    await shot(page, "commands-shell-unknown-1440-dark");
    await page.click("#chat-command-confirm-accept");
    const deadline = Date.now() + 5000;
    while (routeState.commandPosts.length === 0 && Date.now() < deadline) await wait(50);
    check(routeState.commandPosts.length === 1, "the unknown-shell command posts once");
    check(
      routeState.commandPosts[0].body.confirmShell === true,
      "the unknown-shell POST confirms the shell usage",
    );
    await wait(300);
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    return { body: routeState.commandPosts[0].body };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsStale400(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  let routeState;
  try {
    routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
      commandPost: ({ call }) =>
        call.callIndex === 1
          ? {
              status: 400,
              body: {
                error: "Confirm the shell command before running it.",
                code: "shell_confirmation_required",
                outcome: "not_sent",
              },
            }
          : {
              status: 202,
              body: {
                accepted: true,
                sessionID: THREADS.send,
                name: "deploy",
                messageID: "msg_cmd_stale",
              },
            },
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "/");
    await waitForPalette(page);
    await fillComposer(page, "/deploy");
    await wait(250);
    await prompt.press("Enter");
    await wait(150);
    await prompt.press("Enter");
    await page.waitForSelector("#chat-command-confirm[open]");
    check(routeState.commandPosts.length === 1, "the stale list causes one rejected POST first");
    const beforeRetry = await page.evaluate(
      () => document.querySelectorAll(".message--optimistic").length,
    );
    check(beforeRetry === 1, `the optimistic row exists before the retry (${beforeRetry})`);
    await wait(250);
    await shot(page, "commands-stale-400-1440-dark");
    await page.click("#chat-command-confirm-accept");
    const deadline = Date.now() + 5000;
    while (routeState.commandPosts.length < 2 && Date.now() < deadline) await wait(50);
    check(routeState.commandPosts.length === 2, "the client retries exactly once");
    check(
      routeState.commandPosts[0].body.confirmShell === false &&
        routeState.commandPosts[1].body.confirmShell === true,
      "the retry adds confirmShell:true",
    );
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll(".message--optimistic");
        const row = rows[0];
        return rows.length === 1 && row?.dataset.messageId === "msg_cmd_stale";
      },
      undefined,
      { timeout: 5000 },
    );
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".message--optimistic")).map((node) => ({
        id: node.dataset.messageId,
        state: node.dataset.state,
      })),
    );
    check(rows.length === 1, `the retry reuses the single row (${rows.length})`);
    check(rows[0].id === "msg_cmd_stale", "the reused row adopts the retry messageID");
    checkExpectedHttpError(errors, 400);
    return { posts: routeState.commandPosts.length, rows };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsUnknownLiteral(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  let routeState;
  try {
    routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
      messageIDs: ["msg_lit1", "msg_lit2"],
      commandPost: () => ({
        status: 202,
        body: {
          accepted: true,
          sessionID: THREADS.send,
          name: "ide",
          messageID: "msg_cmd_ide",
        },
      }),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "//foo");
    await prompt.press("Enter");
    await wait(500);
    check(routeState.postCalls === 1, "//foo is sent through the text path");
    assertEqual(JSON.parse(routeState.postBodies[0].body).text, "//foo", "//foo is sent verbatim");
    const firstHint = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".toast__copy strong"), (node) => node.textContent),
    );
    check(
      firstHint.some((text) => text.includes("Unknown command; sent as a message.")),
      "//foo shows the non-blocking unknown hint",
    );

    await wait(400);
    await fillComposer(page, "/nope");
    await prompt.press("Enter");
    await wait(500);
    check(routeState.postCalls === 2, "an unknown slash is sent through the text path");
    assertEqual(
      JSON.parse(routeState.postBodies[1].body).text,
      "/nope",
      "an unknown slash is sent verbatim",
    );

    await wait(400);
    await fillComposer(page, "/ide ");
    await prompt.press("Enter");
    const deadline = Date.now() + 5000;
    while (routeState.commandPosts.length === 0 && Date.now() < deadline) await wait(50);
    check(
      routeState.commandPosts.length === 1,
      "a directly typed shadow posts the opencode command",
    );
    check(
      routeState.commandPosts[0].body.name === "ide",
      `the opencode entry wins the token (${routeState.commandPosts[0].body.name})`,
    );
    const shadowHint = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".toast__copy strong"), (node) => node.textContent),
    );
    check(
      shadowHint.some((text) => text.includes("/ide is provided by the application.")),
      "a direct-typed shadow shows the shadow hint",
    );
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    await shot(page, "commands-unknown-literal-1440-dark");
    return { sent: routeState.postBodies.map((entry) => JSON.parse(entry.body).text) };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsMaster(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    await page.addInitScript(() => {
      window.__qaOpened = [];
      window.open = (url) => {
        window.__qaOpened.push(String(url));
        return null;
      };
      const apply = () => {
        const shell = document.getElementById("chat-shell");
        if (shell === null) return false;
        shell.dataset.master = "1";
        return true;
      };
      if (!apply()) {
        const observer = new MutationObserver(() => {
          if (apply()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    });
    await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
      commands: commandsFixture({ master: true }),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    await page.click("#chat-commands-button");
    await waitForPalette(page);
    const state = await paletteState(page);
    const editor = state.rows.find((row) => row.name === "/editor");
    const diff = state.rows.find((row) => row.name === "/diff");
    const restart = state.rows.find((row) => row.name === "/restart");
    check(editor?.disabled, "/editor is disabled for the master");
    check(
      editor.reason.includes("Not available in the master chat"),
      `the editor row carries the reason (${editor.reason})`,
    );
    check(diff?.disabled, "/diff is disabled for the master");
    check(restart !== undefined && !restart.disabled, "/restart stays available for the master");

    await fillComposer(page, "/editor");
    await wait(200);
    const prompt = page.locator("#chat-prompt");
    await prompt.press("Escape");
    await prompt.press("Enter");
    await wait(250);
    const afterDisabled = await page.evaluate(() => ({
      value: document.getElementById("chat-prompt")?.value ?? null,
      opened: window.__qaOpened ?? [],
      error: document.getElementById("chat-send-error")?.textContent ?? "",
      expanded: document.getElementById("chat-prompt")?.getAttribute("aria-expanded"),
    }));
    check(afterDisabled.value === "/editor", "a disabled row is not inserted by Enter");
    check(afterDisabled.opened.length === 0, "a disabled command opens no tab");
    check(
      afterDisabled.error.includes("Not available in the master chat"),
      `the disabled reason is explained inline (${afterDisabled.error})`,
    );
    await shot(page, "commands-master-1440-dark");
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    return { editor: editor.reason, diff: diff.reason };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsPopup(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    await page.addInitScript(() => {
      window.__qaOpened = [];
      window.__qaAssigned = [];
      window.open = (url) => {
        window.__qaOpened.push(String(url));
        try {
          sessionStorage.setItem("qaOpenedCount", String(window.__qaOpened.length));
          sessionStorage.setItem("qaOpenedUrl", String(url));
        } catch {
          // Storage may be unavailable in the throwaway browser context.
        }
        return null;
      };
      const record = () => {
        const toast = document.querySelector(".toast__copy strong");
        if (toast !== null && /popup was blocked/.test(toast.textContent ?? "")) {
          try {
            sessionStorage.setItem("qaPopupNotice", toast.textContent ?? "");
          } catch {
            // Storage may be unavailable in the throwaway browser context.
          }
        }
      };
      new MutationObserver(record).observe(document, {
        childList: true,
        subtree: true,
      });
      try {
        window.location.assign = (url) => {
          window.__qaAssigned.push(String(url));
        };
      } catch {
        // Navigation is the fallback when the engine blocks the method assignment.
      }
    });
    await page.route("**/ide/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>QA IDE</title>",
      }),
    );
    await installRoutes(page, {
      sessionId: THREADS.send,
      messages: commandMessagesFixture(),
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");
    const prompt = page.locator("#chat-prompt");

    await fillComposer(page, "/editor ");
    await shot(page, "commands-popup-1440-dark");
    await prompt.press("Enter");
    await wait(400);
    const popup = await page.evaluate(() => ({
      opened: window.__qaOpened ?? [],
      assigned: window.__qaAssigned ?? [],
      toasts: Array.from(
        document.querySelectorAll(".toast__copy strong"),
        (node) => node.textContent,
      ),
      notice: sessionStorage.getItem("qaPopupNotice"),
      openCount: Number(sessionStorage.getItem("qaOpenedCount") ?? "0"),
      openUrl: sessionStorage.getItem("qaOpenedUrl"),
    }));
    if (popup.assigned.length > 0) {
      check(
        popup.assigned[0].includes("/ide/"),
        `the same-tab fallback targets the IDE (${popup.assigned[0]})`,
      );
      check(
        popup.toasts.some((text) =>
          text.includes("Opened in this tab because the popup was blocked."),
        ),
        "the popup-blocked notice is shown",
      );
    } else {
      await page.waitForURL(/\/ide\//, { timeout: 5000 });
      check(
        typeof popup.notice === "string" &&
          popup.notice.includes("Opened in this tab because the popup was blocked."),
        "the popup-blocked notice survives the same-tab navigation",
      );
    }
    check(popup.openCount === 1, `window.open was attempted once (${popup.openCount})`);
    check(errors.length === 0, `no console or page errors (${errors.join("; ")})`);
    return { assigned: popup.assigned, opened: popup.opened };
  } finally {
    await context.close();
  }
}

async function scenarioCommandsWidths(browser, target) {
  const results = [];
  for (const width of [390, 768, 1440]) {
    for (const colorScheme of ["dark", "light"]) {
      const { context, page, errors } = await newPage(browser, target, {
        width,
        colorScheme,
      });
      try {
        await installRoutes(page, {
          sessionId: THREADS.send,
          messages: commandMessagesFixture(),
        });
        await gotoChat(page, target, THREADS.send);
        if (colorScheme === "light") {
          await page.evaluate(() => {
            document.documentElement.dataset.theme = "light";
          });
        }
        await page.waitForSelector("#chat-prompt");
        await page.click("#chat-commands-button");
        await waitForPalette(page);
        const layout = await page.evaluate(() => {
          const palette = document.getElementById("chat-command-palette");
          const composer = document.getElementById("chat-composer");
          const listbox = document.getElementById("chat-command-listbox");
          const row = document.querySelector("#chat-command-listbox [role='option']");
          const paletteRect = palette?.getBoundingClientRect();
          const composerRect = composer?.getBoundingClientRect();
          const rowRect = row?.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            paletteBottom: paletteRect?.bottom ?? null,
            composerTop: composerRect?.top ?? null,
            paletteHeight: paletteRect?.height ?? 0,
            listboxScroll: listbox === null ? 0 : listbox.scrollHeight,
            listboxClient: listbox === null ? 0 : listbox.clientHeight,
            rowHeight: rowRect?.height ?? 0,
            promptVisible:
              (document.getElementById("chat-prompt")?.getBoundingClientRect().height ?? 0) > 0,
          };
        });
        check(
          layout.overflow <= 1,
          `${width} ${colorScheme}: no horizontal overflow (${layout.overflow})`,
        );
        check(
          layout.paletteBottom !== null &&
            layout.composerTop !== null &&
            layout.paletteBottom <= layout.composerTop + 1,
          `${width} ${colorScheme}: the palette sits above the composer`,
        );
        check(
          layout.paletteHeight <= Math.max(320, windowHeight(width) * 0.5) + 8,
          `${width} ${colorScheme}: the palette is capped (${layout.paletteHeight})`,
        );
        check(layout.promptVisible, `${width} ${colorScheme}: the draft stays visible`);
        if (width === 390) {
          check(
            layout.rowHeight >= 44,
            `${width} ${colorScheme}: touch rows are at least 44px (${layout.rowHeight})`,
          );
        }
        if (layout.listboxScroll > layout.listboxClient) {
          check(layout.listboxClient > 0, `${width} ${colorScheme}: the list scrolls internally`);
        }
        await shot(page, `commands-widths-${width}-${colorScheme}`);
        check(errors.length === 0, `${width} ${colorScheme}: no console/page errors`);
        results.push({ width, colorScheme, ...layout });
      } finally {
        await context.close();
      }
    }
  }
  return results;
}

function windowHeight(width) {
  return width <= 390 ? 844 : width <= 768 ? 1024 : 900;
}

async function scenarioDiffs(browser, target) {
  const fixture = bigPatchFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.diffs,
      messages: fixture.messages,
    });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);

    const closed = await page.evaluate(() => {
      const log = window.__qaWorkerLog;
      return {
        workerCreated: log.created,
        tokenize: log.tokenize,
        tokenCount: document.querySelectorAll(".tool-diff .token, .tool-code .token").length,
        diffCount: document.querySelectorAll(".tool-diff").length,
        codeCount: document.querySelectorAll(".tool-code").length,
        truncations: Array.from(document.querySelectorAll(".tool-call__truncated")).map(
          (node) => node.textContent,
        ),
      };
    });
    check(closed.diffCount > 0 && closed.codeCount > 0, "diff and write skeletons render closed");
    check(closed.tokenCount === 0, `closed diffs have no token spans (${closed.tokenCount})`);
    check(
      closed.workerCreated === 0 && closed.tokenize === 0,
      `closed diffs schedule no worker work (${closed.workerCreated}/${closed.tokenize})`,
    );

    const toolCount = await page.locator(".tool-call").count();
    for (let index = 0; index < toolCount; index += 1) {
      const summary = page.locator(".tool-call").nth(index).locator("summary");
      if ((await summary.count()) > 0) await summary.first().click();
    }
    await page.waitForFunction(
      () => {
        const nodes = Array.from(document.querySelectorAll(".tool-diff, .tool-code"));
        return (
          nodes.length > 0 &&
          nodes.every((node) => node.dataset.highlight && node.dataset.highlight !== "pending")
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    await wait(300);

    const metrics = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      const part = (id) => document.querySelector(`.tool-call[data-part-id="${id}"]`);
      const diff = (id) => part(id)?.querySelector(".tool-diff") ?? null;
      const code = (id) => part(id)?.querySelector(".tool-code") ?? null;
      const lines = (node) =>
        node === null
          ? []
          : Array.from(node.querySelectorAll(".diff-line")).map((row) => {
              const numbers = row.querySelectorAll(".diff-line__num");
              return {
                kind: row.dataset.kind,
                old: text(numbers[0]),
                next: text(numbers[1]),
              };
            });
      const diffSummary = (id) => {
        const node = diff(id);
        if (node === null) return null;
        const scroller = node.querySelector(".tool-diff__scroll");
        return {
          files: node.querySelectorAll(".tool-diff__file").length,
          mode: node.dataset.mode ?? null,
          highlight: node.dataset.highlight ?? null,
          tokens: node.querySelectorAll(".token").length,
          keyword: node.querySelectorAll(".token.keyword").length,
          string: node.querySelectorAll(".token.string").length,
          paths: Array.from(node.querySelectorAll(".tool-diff__path")).map(text),
          types: Array.from(node.querySelectorAll(".tool-diff__type")).map(text),
          notes: Array.from(node.querySelectorAll(".tool-diff__note")).map(text),
          stats: Array.from(node.querySelectorAll(".tool-diff__stat")).map(text),
          hunks: node.querySelectorAll(".tool-diff__hunk").length,
          fileItems: Array.from(node.querySelectorAll(".tool-diff__file-list-item")).map(text),
          add: node.querySelectorAll('.diff-line[data-kind="add"]').length,
          del: node.querySelectorAll('.diff-line[data-kind="del"]').length,
          context: node.querySelectorAll('.diff-line[data-kind="context"]').length,
          lines: lines(node),
          ariaHidden: Array.from(node.querySelectorAll(".diff-line__num")).every(
            (number) => number.getAttribute("aria-hidden") === "true",
          ),
          tabIndex: scroller === null ? null : scroller.tabIndex,
          ariaLabel: scroller === null ? null : scroller.getAttribute("aria-label"),
          liveRegions: node.querySelectorAll('[aria-live], [role="status"], [role="alert"]').length,
          codeText: Array.from(node.querySelectorAll(".diff-line__code"))
            .map((line) => line.textContent ?? "")
            .join("\n"),
        };
      };
      const codeSummary = (id) => {
        const node = code(id);
        if (node === null) return null;
        const scroller = node.querySelector(".tool-code__scroll");
        const rows = Array.from(node.querySelectorAll(".code-line"));
        return {
          lines: rows.length,
          firstNumber: text(rows[0]?.querySelector(".code-line__num")),
          lastNumber: text(rows.at(-1)?.querySelector(".code-line__num")),
          meta: text(node.querySelector(".tool-code__meta")),
          language: text(node.querySelector(".tool-code__lang")),
          highlight: node.dataset.highlight ?? null,
          tokens: node.querySelectorAll(".token").length,
          keyword: node.querySelectorAll(".token.keyword").length,
          string: node.querySelectorAll(".token.string").length,
          ariaHidden: rows.every(
            (row) => row.querySelector(".code-line__num")?.getAttribute("aria-hidden") === "true",
          ),
          tabIndex: scroller === null ? null : scroller.tabIndex,
          ariaLabel: scroller === null ? null : scroller.getAttribute("aria-label"),
          liveRegions: node.querySelectorAll('[aria-live], [role="status"], [role="alert"]').length,
          contentLength: rows.reduce((total, row) => total + (row.textContent ?? "").length, 0),
        };
      };
      return {
        std: diffSummary("prt_std_edit"),
        hash: diffSummary("prt_hash_edit"),
        apply: diffSummary("prt_apply"),
        write40: codeSummary("prt_write40"),
        writeEmpty: codeSummary("prt_write_empty"),
        writeBig: codeSummary("prt_write_big"),
        patchFiles: diffSummary("prt_patch_files"),
        patchString: diffSummary("prt_patch_string"),
        patchText: diffSummary("prt_patch_text"),
        unknown: diffSummary("prt_unknown"),
        binary: diffSummary("prt_binary"),
        many: diffSummary("prt_many"),
        notices: Array.from(document.querySelectorAll(".tool-call__truncated")).map(text),
        worker: { ...window.__qaWorkerLog },
      };
    });

    check(metrics.std?.files === 1, `standard edit renders one file (${metrics.std?.files})`);
    check(
      metrics.std?.paths.some((value) => value.includes("src/app.ts")),
      `standard edit path is rendered (${metrics.std?.paths.join(" | ")})`,
    );
    check(
      metrics.std?.stats.includes("+3") && metrics.std?.stats.includes("-2"),
      `standard edit shows +3/-2 (${metrics.std?.stats.join(" ")})`,
    );
    check(
      metrics.std?.add > 0 && metrics.std?.del > 0 && metrics.std?.context > 0,
      `standard edit marks add/del/context lines (${metrics.std?.add}/${metrics.std?.del}/${metrics.std?.context})`,
    );
    const addLine = metrics.std?.lines.find((line) => line.kind === "add");
    const delLine = metrics.std?.lines.find((line) => line.kind === "del");
    check(
      addLine !== undefined && addLine.old === "" && addLine.next.length > 0,
      `add lines carry only a new number (${JSON.stringify(addLine)})`,
    );
    check(
      delLine !== undefined && delLine.old.length > 0 && delLine.next === "",
      `del lines carry only an old number (${JSON.stringify(delLine)})`,
    );
    check(metrics.std?.ariaHidden === true, "diff line numbers are aria-hidden");
    check(metrics.std?.tabIndex === 0, `diff scroller is tabbable (${metrics.std?.tabIndex})`);
    check(
      typeof metrics.std?.ariaLabel === "string" &&
        metrics.std.ariaLabel.includes("scrollable") &&
        metrics.std.ariaLabel.includes("src/app.ts"),
      `diff scroller has a descriptive aria-label (${metrics.std?.ariaLabel})`,
    );
    check(metrics.std?.liveRegions === 0, "diff adds no live region");
    check(
      (metrics.std?.keyword ?? 0) > 0 && (metrics.std?.string ?? 0) > 0,
      `TypeScript edit highlights keywords and strings (${metrics.std?.keyword}/${metrics.std?.string})`,
    );

    check(metrics.hash?.files === 1, `hashline edit renders one file (${metrics.hash?.files})`);
    check(
      metrics.hash?.paths.some((value) => value.includes("src/hash.ts")) &&
        metrics.hash?.stats.includes("+1") &&
        metrics.hash?.stats.includes("-1"),
      `hashline metadata.diff renders its path and +1/-1 (${metrics.hash?.paths.join(" | ")})`,
    );
    check(
      metrics.hash?.highlight === "tokens" && metrics.hash?.tokens > 0,
      `hashline diff tokenizes (${metrics.hash?.highlight}/${metrics.hash?.tokens})`,
    );

    check(
      metrics.apply?.files === 4,
      `apply_patch renders four file sections (${metrics.apply?.files})`,
    );
    assertEqual(
      metrics.apply?.types,
      ["Added", "Updated", "Deleted", "Moved"],
      "apply_patch file type labels",
    );
    check(
      metrics.apply?.paths.includes("src/old-name.ts -> src/new-name.ts"),
      `move renders old -> new (${metrics.apply?.paths.join(" | ")})`,
    );
    check(
      metrics.apply?.stats.filter((value) => value.startsWith("+")).length >= 4 &&
        metrics.apply?.stats.filter((value) => value.startsWith("-")).length >= 4,
      `every apply_patch file carries +N/-N (${metrics.apply?.stats.join(" ")})`,
    );
    check(
      metrics.apply?.highlight === "tokens" && metrics.apply?.tokens > 0,
      `multi-file diff tokenizes (${metrics.apply?.highlight}/${metrics.apply?.tokens})`,
    );

    check(metrics.write40?.lines === 40, `write renders 40 lines (${metrics.write40?.lines})`);
    check(
      metrics.write40?.firstNumber === "1" && metrics.write40?.lastNumber === "40",
      `write line numbers run 1..40 (${metrics.write40?.firstNumber}..${metrics.write40?.lastNumber})`,
    );
    check(
      metrics.write40?.meta.startsWith("40 lines") && metrics.write40?.language === "typescript",
      `write head reports 40 lines and typescript (${metrics.write40?.meta}/${metrics.write40?.language})`,
    );
    check(
      (metrics.write40?.keyword ?? 0) > 0 && (metrics.write40?.string ?? 0) > 0,
      `write highlights keywords and strings (${metrics.write40?.keyword}/${metrics.write40?.string})`,
    );
    check(metrics.write40?.ariaHidden === true, "write line numbers are aria-hidden");
    check(
      metrics.write40?.tabIndex === 0 &&
        typeof metrics.write40?.ariaLabel === "string" &&
        metrics.write40.ariaLabel.includes("scrollable"),
      `write scroller is tabbable with an aria-label (${metrics.write40?.ariaLabel})`,
    );
    check(metrics.write40?.liveRegions === 0, "write adds no live region");

    check(
      metrics.writeEmpty?.lines === 0,
      `empty write renders zero lines (${metrics.writeEmpty?.lines})`,
    );
    check(
      metrics.writeEmpty?.meta.startsWith("0 lines") && metrics.writeEmpty?.highlight === "plain",
      `empty write is a plain 0-line body (${metrics.writeEmpty?.meta}/${metrics.writeEmpty?.highlight})`,
    );
    check(metrics.writeEmpty?.tokens === 0, "empty write creates no tokens");

    check(
      (metrics.writeBig?.lines ?? 0) > 500,
      `64 KiB write renders its lines (${metrics.writeBig?.lines})`,
    );
    check(
      ["tokens", "plain", "budget"].includes(metrics.writeBig?.highlight),
      `64 KiB write finishes as tokens/plain/budget (${metrics.writeBig?.highlight})`,
    );
    check(
      metrics.writeBig?.contentLength > 60_000,
      `64 KiB write keeps its content on screen (${metrics.writeBig?.contentLength})`,
    );

    check(
      metrics.patchFiles?.mode === "files" && metrics.patchFiles?.fileItems.length === 2,
      `patch files-only mode renders a 2-path file list (${metrics.patchFiles?.fileItems.join(" | ")})`,
    );
    check(
      metrics.patchFiles?.highlight === "plain" && metrics.patchFiles?.tokens === 0,
      "patch file-list mode never tokenizes",
    );
    check(
      metrics.patchString?.files === 1 && metrics.patchString?.tokens > 0,
      `legacy patch string renders through the diff renderer (${metrics.patchString?.files}/${metrics.patchString?.tokens})`,
    );
    check(
      metrics.patchText?.files === 1 && metrics.patchText?.tokens > 0,
      `legacy patch text renders through the diff renderer (${metrics.patchText?.files}/${metrics.patchText?.tokens})`,
    );

    check(
      metrics.unknown?.highlight === "plain" && metrics.unknown?.tokens === 0,
      `unknown extension falls back to plain (${metrics.unknown?.highlight}/${metrics.unknown?.tokens})`,
    );
    check(
      metrics.unknown?.files === 1 && metrics.unknown?.codeText.includes("alpha gamma"),
      "unknown extension still shows its diff text",
    );

    check(
      metrics.binary?.types.includes("Binary") &&
        metrics.binary?.notes.includes("Binary file changed") &&
        metrics.binary?.hunks === 0,
      `binary diff shows the Binary label and no hunks (${metrics.binary?.types.join(" | ")})`,
    );
    check(
      metrics.binary?.highlight === "plain" && metrics.binary?.tokens === 0,
      "binary diff never tokenizes",
    );

    check(
      metrics.many?.files === 50,
      `combined diff keeps at most 50 files (${metrics.many?.files})`,
    );
    check(
      metrics.notices.includes("Additional files omitted from the view."),
      `>50-file diff shows the file-cap notice (${metrics.notices.join(" | ")})`,
    );
    check(
      metrics.many?.highlight !== "pending",
      `>50-file diff settles instead of waiting forever (${metrics.many?.highlight})`,
    );

    await page.evaluate(() => {
      document.querySelector('[data-part-id="prt_apply"]')?.scrollIntoView({ block: "center" });
    });
    await wait(150);
    await shot(page, "main-1440-diff");

    const layout1440 = await page.evaluate(() => {
      const scrollers = Array.from(document.querySelectorAll("#chat-messages *"))
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.overflowX === "auto" || style.overflowX === "scroll";
        })
        .map((node) => node.className);
      const line = document.querySelector(".diff-line");
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollers,
        columns: line === null ? null : getComputedStyle(line).gridTemplateColumns,
      };
    });
    check(
      layout1440.overflowX === 0,
      `no horizontal page overflow at 1440 (${layout1440.overflowX}px)`,
    );
    check(layout1440.scrollers.length > 0, "the diff scroller is present at 1440");
    check(
      layout1440.scrollers.every(
        (value) =>
          value.includes("tool-diff__scroll") ||
          value.includes("tool-code__scroll") ||
          value.includes("tool-diff__file-list"),
      ),
      `diff scrollers are the only horizontal scrollers (${layout1440.scrollers.join(" | ")})`,
    );
    check(layout1440.columns !== null, "diff grid columns resolve at 1440");

    const darkKeyword = await page.evaluate(() => {
      const token = document.querySelector('[data-part-id="prt_write40"] .token.keyword');
      return token === null ? null : getComputedStyle(token).color;
    });
    check(darkKeyword !== null, "a keyword token is rendered for the theme check");

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await wait(150);
    const theme = await page.evaluate(() => {
      const token = document.querySelector('[data-part-id="prt_write40"] .token.keyword');
      const addLine = document.querySelector(
        '[data-part-id="prt_std_edit"] .diff-line[data-kind="add"]',
      );
      const probe = document.createElement("div");
      probe.style.background = "color-mix(in oklab, var(--success) 9%, transparent)";
      document.body.append(probe);
      const result = {
        keyword: token === null ? null : getComputedStyle(token).color,
        addBackground: addLine === null ? null : getComputedStyle(addLine).backgroundColor,
        successMix: getComputedStyle(probe).backgroundColor,
        success: getComputedStyle(document.documentElement).getPropertyValue("--success").trim(),
      };
      probe.remove();
      return result;
    });
    check(
      theme.keyword !== null && theme.keyword !== darkKeyword,
      `light theme changes a keyword token color (${darkKeyword} -> ${theme.keyword})`,
    );
    check(
      theme.addBackground !== null && theme.addBackground === theme.successMix,
      `add-line background derives from --success (${theme.addBackground} vs ${theme.successMix})`,
    );
    check(theme.success.length > 0, "the success token resolves in light theme");
    await shot(page, "main-1440-diff-light");

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(350);
    await page.evaluate(() => {
      document.querySelector('[data-part-id="prt_apply"]')?.scrollIntoView({ block: "center" });
    });
    await wait(250);

    const layout390 = await page.evaluate(() => {
      const scrollers = Array.from(document.querySelectorAll("#chat-messages *"))
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.overflowX === "auto" || style.overflowX === "scroll";
        })
        .map((node) => node.className);
      const line = document.querySelector(".diff-line");
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollers,
        columns: line === null ? null : getComputedStyle(line).gridTemplateColumns,
      };
    });
    check(
      layout390.overflowX === 0,
      `no horizontal page overflow at 390 (${layout390.overflowX}px)`,
    );
    check(
      layout390.scrollers.every(
        (value) =>
          value.includes("tool-diff__scroll") ||
          value.includes("tool-code__scroll") ||
          value.includes("tool-diff__file-list"),
      ),
      `diff scrollers remain the only horizontal scrollers at 390 (${layout390.scrollers.join(" | ")})`,
    );
    const desktopFirst = Number.parseFloat(layout1440.columns?.split(" ")[0] ?? "0");
    const mobileFirst = Number.parseFloat(layout390.columns?.split(" ")[0] ?? "0");
    check(
      mobileFirst > 0 && mobileFirst < desktopFirst,
      `390 diff columns are narrower (${mobileFirst} < ${desktopFirst})`,
    );
    await shot(page, "main-390-diff");

    await emit(page, {
      type: "message.part.updated",
      seq: 100,
      streamID: "qa-stream",
      sessionID: THREADS.diffs,
      messageID: "msg_diff_a",
      partID: "prt_trunc",
      partType: "tool",
      part: fixture.truncatedPart,
      truncated: { fields: ["state.metadata.diff"], limit: "per-file" },
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-part-id="prt_trunc"] .tool-call__truncated')?.textContent ===
        "Diff truncated at 64 KiB per file.",
      undefined,
      { timeout: 3_000 },
    );

    await emit(page, {
      type: "message.part.omitted",
      seq: 101,
      streamID: "qa-stream",
      sessionID: THREADS.diffs,
      messageID: "msg_diff_a",
      partID: "prt_omit",
      partType: "tool",
    });
    await page.waitForFunction(
      () => {
        const part = document.querySelector('[data-part-id="prt_omit"]');
        return (
          part?.querySelector(".tool-call__truncated")?.textContent ===
            "Result omitted; it exceeded the 256 KiB stream budget." &&
          part.querySelector(".tool-diff") === null &&
          !(part.textContent ?? "").includes("No output")
        );
      },
      undefined,
      { timeout: 3_000 },
    );

    const notices = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      const part = document.querySelector('[data-part-id="prt_omit"]');
      return {
        truncated: text(document.querySelector('[data-part-id="prt_trunc"] .tool-call__truncated')),
        omitted: text(part?.querySelector(".tool-call__truncated")),
        omittedBody: part?.querySelector(".tool-diff, .tool-code, pre") !== null,
        omittedText: text(part),
      };
    });
    assertEqual(notices.truncated, "Diff truncated at 64 KiB per file.", "truncated diff notice");
    assertEqual(
      notices.omitted,
      "Result omitted; it exceeded the 256 KiB stream budget.",
      "omitted part notice",
    );
    check(notices.omittedBody === false, "omitted part renders no body");
    check(!notices.omittedText.includes("No output"), "omitted part never falls back to No output");

    checkNoErrors(errors);
    return { metrics, layout1440, layout390, theme, notices };
  } finally {
    await context.close();
  }
}

async function scenarioRead(browser, target) {
  const fixture = readFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    await installRoutes(page, { sessionId: THREADS.diffs, messages: fixture.messages });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector('.tool-call[data-part-id="prt_read"] .tool-code', {
      state: "attached",
    });

    await page.locator('.tool-call[data-part-id="prt_read"] summary').click();
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-part-id="prt_read"] .tool-code');
        return (
          node !== null &&
          node.dataset.highlight !== undefined &&
          node.dataset.highlight !== "pending"
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    await wait(300);

    const rendered = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      const node = document.querySelector('[data-part-id="prt_read"] .tool-code');
      const scroller = node?.querySelector(".tool-code__scroll") ?? null;
      const rows = node === null ? [] : Array.from(node.querySelectorAll(".code-line"));
      return {
        exists: node !== null,
        path: text(node?.querySelector(".tool-code__path")),
        meta: text(node?.querySelector(".tool-code__meta")),
        language: text(node?.querySelector(".tool-code__lang")),
        foot: text(node?.querySelector(".tool-code__foot")),
        lines: rows.length,
        firstNumber: text(rows[0]?.querySelector(".code-line__num")),
        lastNumber: text(rows.at(-1)?.querySelector(".code-line__num")),
        bodyText: text(node),
        tokens: node === null ? 0 : node.querySelectorAll(".token").length,
        keyword: node === null ? 0 : node.querySelectorAll(".token.keyword").length,
        tabIndex: scroller === null ? null : scroller.tabIndex,
        ariaLabel: scroller === null ? null : scroller.getAttribute("aria-label"),
        rawXml:
          node === null
            ? false
            : (node.textContent ?? "").includes("<path>") ||
              (node.textContent ?? "").includes("<content>"),
      };
    });

    check(rendered.exists, "completed read renders a .tool-code block");
    check(rendered.path.includes("webui.py"), `read head shows the file path (${rendered.path})`);
    check(
      rendered.meta.includes(`${fixture.start}–${fixture.end} of 5169`),
      `read head shows the XML line range and total (${rendered.meta})`,
    );
    check(rendered.language === "python", `read head shows the language (${rendered.language})`);
    check(
      rendered.lines === fixture.lineCount &&
        rendered.firstNumber === String(fixture.start) &&
        rendered.lastNumber === String(fixture.end),
      `read preserves XML line numbers ${fixture.start}..${fixture.end} (${rendered.firstNumber}..${rendered.lastNumber}, ${rendered.lines})`,
    );
    check(
      rendered.foot === fixture.statusLine,
      `read footer renders the status line (${rendered.foot})`,
    );
    check(!rendered.rawXml, "read body never contains raw <path>/<content> XML");
    check(
      rendered.bodyText.includes("def summarize_items"),
      "read body renders the parsed source text",
    );
    check(
      rendered.tokens > 0 && rendered.keyword > 0,
      `read source is syntax highlighted (${rendered.tokens}/${rendered.keyword})`,
    );
    check(
      rendered.tabIndex === 0 &&
        typeof rendered.ariaLabel === "string" &&
        rendered.ariaLabel.includes("File content") &&
        rendered.ariaLabel.includes("scrollable"),
      `read scroller is tabbable with a descriptive aria-label (${rendered.ariaLabel})`,
    );

    await shot(page, "read-1440");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.querySelector('[data-part-id="prt_read"]')?.scrollIntoView({ block: "center" });
    });
    await wait(250);
    const mobile = await page.evaluate(() => {
      const node = document.querySelector('[data-part-id="prt_read"] .tool-code');
      const foot = node?.querySelector(".tool-code__foot") ?? null;
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        foot: foot === null ? "" : (foot.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    });
    check(
      mobile.overflowX === 0,
      `read has no horizontal page overflow at 390 (${mobile.overflowX}px)`,
    );
    check(
      mobile.foot === fixture.statusLine,
      `read footer wraps without losing text at 390 (${mobile.foot})`,
    );
    await shot(page, "read-390");

    checkNoErrors(errors);
    return rendered;
  } finally {
    await context.close();
  }
}

async function scenarioDiffError(browser, target) {
  const messages = errorFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, { sessionId: THREADS.diffs, messages });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await page.waitForFunction(
      () => document.querySelector('[data-part-id="prt_error"]')?.open === true,
      undefined,
      { timeout: 3_000 },
    );
    const state = await page.evaluate(() => {
      const part = document.querySelector('[data-part-id="prt_error"]');
      const pre = part?.querySelector("pre");
      return {
        open: part?.open ?? null,
        hasDiff: part?.querySelector(".tool-diff, .tool-code") !== null,
        preText: (pre?.textContent ?? "").trim(),
        workerCreated: window.__qaWorkerLog.created,
        tokenize: window.__qaWorkerLog.tokenize,
        tokens: part?.querySelectorAll(".token").length ?? 0,
        notice: (part?.querySelector(".tool-call__truncated")?.textContent ?? "").trim(),
      };
    });
    check(state.open === true, "an error part auto-opens");
    check(state.hasDiff === false, "an error part renders no diff body");
    check(
      state.preText.includes("Invalid patch"),
      `the error text is in a <pre> (${state.preText})`,
    );
    check(
      state.workerCreated === 0 && state.tokenize === 0,
      `an error part makes zero highlight requests (${state.workerCreated}/${state.tokenize})`,
    );
    check(state.tokens === 0, "an error part has no token spans");
    check(state.notice.length === 0, "an error part has no truncation notice");
    await shot(page, "diff-error-1440-dark");
    checkNoErrors(errors);
    return state;
  } finally {
    await context.close();
  }
}

async function scenarioDiffLazy(browser, target) {
  const fixture = lazyFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.diffs,
      messages: fixture.messages,
    });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await wait(200);

    const before = await page.evaluate(() => ({
      openTokens: document.querySelectorAll('[data-part-id="prt_lazy_open"] .token').length,
      closedTokens: document.querySelectorAll('[data-part-id="prt_lazy_closed"] .token').length,
      log: { ...window.__qaWorkerLog },
    }));
    check(before.openTokens === 0 && before.closedTokens === 0, "both diffs start plain");
    check(
      before.log.created === 0 && before.log.tokenize === 0,
      "closed diffs start no worker and post no tokenize request",
    );

    await page.locator('[data-part-id="prt_lazy_open"] summary').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff')?.dataset.highlight ===
        "tokens",
      undefined,
      { timeout: 5_000 },
    );
    await wait(150);

    const opened = await page.evaluate(() => ({
      openTokens: document.querySelectorAll('[data-part-id="prt_lazy_open"] .token').length,
      closedTokens: document.querySelectorAll('[data-part-id="prt_lazy_closed"] .token').length,
      streams: window.__qaWorkerLog.dispatches.map((entry) => entry.streamID),
      created: window.__qaWorkerLog.created,
      tokenize: window.__qaWorkerLog.tokenize,
    }));
    check(opened.openTokens > 0, `opening a diff tokenizes it (${opened.openTokens})`);
    check(opened.closedTokens === 0, "the closed diff stays plain");
    check(opened.created >= 1 && opened.tokenize > 0, "opening starts the worker");
    check(
      opened.streams.every((stream) => !String(stream).startsWith("s1:")),
      `the closed file submitted no streams (${opened.streams.join(",")})`,
    );

    const focusBefore = await page.evaluate(() => {
      const scroller = document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff__scroll');
      scroller.scrollTop = 140;
      scroller.scrollLeft = 50;
      scroller.focus();
      return {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        active: document.activeElement === scroller,
        tag: document.activeElement?.tagName ?? null,
        className: document.activeElement?.className ?? null,
      };
    });
    check(focusBefore.active === true, "the diff scroller can take focus");

    const updatedPatch = longDiffPatch("src/open.ts", 230, "open");
    const updatedPart = {
      ...fixture.messages[1].parts[0],
      state: {
        ...fixture.messages[1].parts[0].state,
        status: "completed",
        metadata: { filediff: { file: "src/open.ts", patch: updatedPatch } },
        time: { start: Date.now() - 5_000, end: Date.now() },
      },
    };
    await emit(page, {
      type: "message.part.updated",
      seq: 2,
      streamID: "qa-stream",
      sessionID: THREADS.diffs,
      messageID: "msg_diff_a",
      partID: "prt_lazy_open",
      partType: "tool",
      part: updatedPart,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff')?.dataset.highlight ===
        "tokens",
      undefined,
      { timeout: 5_000 },
    );
    await wait(200);

    const focusAfter = await page.evaluate(() => {
      const part = document.querySelector('[data-part-id="prt_lazy_open"]');
      const scroller = part.querySelector(".tool-diff__scroll");
      return {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        active: document.activeElement === scroller,
        inside: part.contains(document.activeElement),
        tag: document.activeElement?.tagName ?? null,
        className: document.activeElement?.className ?? null,
        tokens: part.querySelectorAll(".token").length,
        highlight: part.querySelector(".tool-diff")?.dataset.highlight ?? null,
      };
    });
    check(
      focusAfter.active === true,
      `focus stays on the scroller after an update (${focusAfter.tag}.${focusAfter.className})`,
    );
    check(
      focusAfter.top === focusBefore.top && focusAfter.left === focusBefore.left,
      `scroll offsets survive the update (${focusAfter.top}/${focusAfter.left} vs ${focusBefore.top}/${focusBefore.left})`,
    );
    check(
      focusAfter.tokens > 0 && focusAfter.highlight === "tokens",
      `the updated diff is highlighted again (${focusAfter.highlight}/${focusAfter.tokens})`,
    );

    await page.locator('[data-part-id="prt_lazy_open"] summary').first().click();
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff');
        return node?.dataset.highlight === "plain" && node.querySelectorAll(".token").length === 0;
      },
      undefined,
      { timeout: 3_000 },
    );
    const closedAgain = await page.evaluate(async () => ({
      openTokens: document.querySelectorAll('[data-part-id="prt_lazy_open"] .token').length,
      closedTokens: document.querySelectorAll('[data-part-id="prt_lazy_closed"] .token').length,
      highlight: document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff')?.dataset
        .highlight,
      stats: (await import("/assets/chat-highlight.js")).getHighlightStats(),
    }));
    check(closedAgain.openTokens === 0, "closing clears token spans");
    check(
      closedAgain.highlight === "plain",
      `closing returns the diff to plain (${closedAgain.highlight})`,
    );
    check(closedAgain.closedTokens === 0, "the other closed diff still has no tokens");

    await page.locator('[data-part-id="prt_lazy_open"] summary').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-part-id="prt_lazy_open"] .tool-diff')?.dataset.highlight ===
        "tokens",
      undefined,
      { timeout: 5_000 },
    );
    await wait(120);
    const reopened = await page.evaluate(
      () => document.querySelectorAll('[data-part-id="prt_lazy_open"] .token').length,
    );
    check(reopened > 0, `reopening highlights again (${reopened})`);
    await shot(page, "diff-lazy-1440-dark");

    checkNoErrors(errors);
    return { before, opened, focusBefore, focusAfter, closedAgain, reopened };
  } finally {
    await context.close();
  }
}

async function scenarioDiffStreaming(browser, target) {
  const fixture = streamingFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.diffs,
      messages: () => fixture.messages,
    });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await wait(200);

    await page.locator('[data-part-id="prt_stream_live"] summary').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-part-id="prt_stream_live"] .tool-diff')?.dataset.highlight ===
        "tokens",
      undefined,
      { timeout: 5_000 },
    );
    await wait(150);

    const before = await page.evaluate(() => ({
      liveTokens: document.querySelectorAll('[data-part-id="prt_stream_live"] .token').length,
      closedTokens: document.querySelectorAll('[data-part-id="prt_stream_closed"] .token').length,
      streams: window.__qaWorkerLog.dispatches.map((entry) => entry.streamID),
      tokenize: window.__qaWorkerLog.tokenize,
      gets: null,
    }));
    check(before.liveTokens > 0, "the open streaming diff tokenizes");
    check(before.closedTokens === 0, "the closed streaming diff stays plain");
    check(
      before.streams.every((stream) => !String(stream).startsWith("s1:")),
      `only the open file submitted streams (${before.streams.join(",")})`,
    );

    await page.evaluate(() => {
      const node = document.querySelector('[data-part-id="prt_stream_live"] .tool-diff');
      window.__qaFlash = { stop: false, samples: [] };
      const record = () => {
        if (window.__qaFlash.stop) return;
        window.__qaFlash.samples.push({
          t: performance.now(),
          tokens: node.querySelectorAll(".token").length,
          highlight: node.dataset.highlight ?? null,
        });
      };
      const observer = new MutationObserver(record);
      observer.observe(node, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      window.__qaFlash.stopObserver = () => observer.disconnect();
      const tick = () => {
        if (window.__qaFlash.stop) return;
        record();
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
    const getsBefore = routeState.messageGets.length;

    await emit(page, {
      type: "message.part.updated",
      seq: 10,
      streamID: "qa-stream",
      sessionID: THREADS.diffs,
      messageID: "msg_diff_a",
      partID: "prt_stream_live",
      partType: "tool",
      part: fixture.completedLivePart,
    });
    await wait(350);

    fixture.messages[1].parts[0] = fixture.completedLivePart;
    fixture.messages[1].info.finish = "stop";
    fixture.messages[1].info.time = { created: Date.now() - 9_000, completed: Date.now() };
    await emit(page, {
      type: "session.status",
      seq: 11,
      streamID: "qa-stream",
      sessionID: THREADS.diffs,
      status: { type: "idle" },
    });

    const deadline = Date.now() + 10_000;
    while (routeState.messageGets.length <= getsBefore && Date.now() < deadline) {
      await wait(100);
    }
    check(routeState.messageGets.length > getsBefore, "session idle triggers a snapshot hydration");
    await wait(700);

    const after = await page.evaluate(() => {
      window.__qaFlash.stop = true;
      window.__qaFlash.stopObserver();
      const node = document.querySelector('[data-part-id="prt_stream_live"] .tool-diff');
      const samples = window.__qaFlash.samples;
      let first = -1;
      for (let index = 0; index < samples.length; index += 1) {
        if (samples[index].tokens > 0) {
          first = index;
          break;
        }
      }
      const flashed = first >= 0 && samples.slice(first).some((sample) => sample.tokens === 0);
      return {
        liveTokens: node.querySelectorAll(".token").length,
        liveHighlight: node.dataset.highlight ?? null,
        closedTokens: document.querySelectorAll('[data-part-id="prt_stream_closed"] .token').length,
        closedHighlight: document.querySelector('[data-part-id="prt_stream_closed"] .tool-diff')
          ?.dataset.highlight,
        tokenize: window.__qaWorkerLog.tokenize,
        dispatches: window.__qaWorkerLog.dispatches.length,
        samples: samples.length,
        firstTokens: first,
        flashed,
        warningSamples: samples
          .slice(Math.max(0, first))
          .filter((sample) => sample.tokens === 0 || sample.highlight === "pending")
          .slice(0, 8),
      };
    });
    check(after.liveTokens > 0, "the open diff keeps its tokens after hydration");
    check(
      after.liveHighlight === "tokens",
      `the open diff ends highlighted (${after.liveHighlight})`,
    );
    check(after.firstTokens >= 0, "the flash probe observed a tokenized frame");
    check(
      after.flashed === false,
      `hydration never flashes colored -> plain -> colored (${JSON.stringify(after.warningSamples)})`,
    );
    check(after.closedTokens === 0, "hydration leaves the closed diff plain");
    check(after.closedHighlight === "plain", `closed diff stays plain (${after.closedHighlight})`);
    check(
      after.tokenize === before.tokenize,
      `hydration does not re-tokenize unchanged open diffs (${before.tokenize} -> ${after.tokenize})`,
    );
    await shot(page, "diff-streaming-1440-dark");

    checkNoErrors(errors);
    return { before, after };
  } finally {
    await context.close();
  }
}

async function scenarioDiffAdversarial(browser, target) {
  const fixture = adversarialFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.diffs,
      messages: fixture.messages,
    });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await wait(150);

    const toolCount = await page.locator(".tool-call").count();
    for (let index = 0; index < toolCount; index += 1) {
      const summary = page.locator(".tool-call").nth(index).locator("summary");
      if ((await summary.count()) > 0) await summary.first().click();
    }
    const started = Date.now();
    await page.waitForFunction(
      () => {
        const nodes = Array.from(document.querySelectorAll(".tool-diff, .tool-code"));
        return (
          nodes.length > 0 &&
          nodes.every((node) => node.dataset.highlight && node.dataset.highlight !== "pending")
        );
      },
      undefined,
      { timeout: 6_000 },
    );
    const elapsed = Date.now() - started;
    await wait(250);

    const result = await page.evaluate(() => {
      const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
      const parts = {};
      for (const id of ["prt_adv_md", "prt_adv_markup", "prt_adv_bash", "prt_adv_write"]) {
        const part = document.querySelector(`[data-part-id="${id}"]`);
        const node = part?.querySelector(".tool-diff, .tool-code");
        parts[id] = node
          ? {
              highlight: node.dataset.highlight ?? null,
              tokens: node.querySelectorAll(".token").length,
              text: text(node),
            }
          : null;
      }
      const byKey = new Map();
      for (const dispatch of window.__qaWorkerLog.dispatches) {
        byKey.set(`${dispatch.jobID}:${dispatch.streamID}`, dispatch.t);
      }
      const timings = window.__qaWorkerLog.responses.map((response) => {
        const dispatched = byKey.get(`${response.jobID}:${response.streamID}`) ?? response.t;
        return { type: response.type, ms: Math.round(response.t - dispatched) };
      });
      return { parts, timings, log: { ...window.__qaWorkerLog } };
    });

    for (const [id, part] of Object.entries(result.parts)) {
      check(part !== null, `${id} renders a diff/code body`);
      check(
        ["tokens", "plain", "budget", "error"].includes(part.highlight),
        `${id} finishes within budget (${part.highlight})`,
      );
      check(
        part.tokens > 0 || part.text.length > 0,
        `${id} keeps readable text after highlighting (${part.tokens} tokens)`,
      );
      check(part.highlight !== "pending", `${id} never stays pending`);
    }
    check(
      result.log.dispatches.length >= 3,
      `adversarial fixtures actually submitted worker streams (${result.log.dispatches.length})`,
    );
    const overBudget = result.timings.filter((timing) => timing.ms > 400);
    check(
      overBudget.length === 0,
      `worker responses stay inside the 250 ms budget plus paint (${JSON.stringify(overBudget)})`,
    );
    check(
      elapsed <= 4_000,
      `adversarial page settles in the worker budget plus paint (${elapsed}ms)`,
    );
    await shot(page, "diff-adversarial-1440-dark");
    checkNoErrors(errors);
    return { result, elapsed };
  } finally {
    await context.close();
  }
}

async function scenarioDiffTimeout(browser, target) {
  const messages = timeoutFixture();
  const { context, page, errors } = await newPage(browser, target, { workerProbe: true });
  try {
    const routeState = await installRoutes(page, { sessionId: THREADS.diffs, messages });
    await gotoChat(page, target, THREADS.diffs);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await wait(150);

    const started = Date.now();
    await page.locator('[data-part-id="prt_timeout"] summary').first().click();
    await page.waitForFunction(() => window.__qaWorkerLog.hung >= 1, undefined, {
      timeout: 2_000,
    });
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-part-id="prt_timeout"] .tool-diff');
        return (
          window.__qaWorkerLog.terminated >= 1 &&
          node !== null &&
          node.dataset.highlight !== "pending"
        );
      },
      undefined,
      { timeout: 3_000 },
    );
    const elapsed = Date.now() - started;
    await wait(150);

    const result = await page.evaluate(() => {
      const node = document.querySelector('[data-part-id="prt_timeout"] .tool-diff');
      return {
        highlight: node?.dataset.highlight ?? null,
        tokens: node?.querySelectorAll(".token").length ?? 0,
        text: (node?.textContent ?? "").trim(),
        hung: window.__qaWorkerLog.hung,
        terminated: window.__qaWorkerLog.terminated,
        dispatches: window.__qaWorkerLog.dispatches.length,
        responsive: 1 + 1,
      };
    });
    check(result.hung >= 1, "the timeout fixture withheld a worker response");
    check(result.terminated >= 1, `a timed-out worker is terminated (${result.terminated})`);
    check(
      ["error", "plain"].includes(result.highlight),
      `the timed-out diff falls back to plain text (${result.highlight})`,
    );
    check(result.tokens === 0, "the timed-out diff has no token spans");
    check(result.text.includes("__QA_HANG__"), "the plain fallback keeps the code text");
    check(result.responsive === 2, "the page stays responsive after worker termination");
    check(elapsed <= 2_000, `the timeout is enforced without hanging (${elapsed}ms)`);
    await shot(page, "diff-timeout-1440-dark");
    checkNoErrors(errors);
    return { result, elapsed };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Mobile polish, plan visibility, reasoning, and Stop
// ---------------------------------------------------------------------------

async function composerUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    const send = document.getElementById("chat-send");
    const prompt = document.getElementById("chat-prompt");
    return {
      label: text(send?.querySelector(".btn__label")),
      type: send?.getAttribute("type") ?? null,
      disabled: send?.disabled ?? null,
      promptValue: prompt?.value ?? null,
      promptDisabled: prompt?.disabled ?? null,
      dockHidden: document.getElementById("chat-prompt-dock")?.hidden ?? null,
      sendError: text(document.getElementById("chat-send-error")),
      sendErrorHidden: document.getElementById("chat-send-error")?.hidden ?? null,
      agentErrors: Array.from(document.querySelectorAll(".message")).filter((node) =>
        text(node).includes("Agent error"),
      ).length,
      errorToasts: Array.from(document.querySelectorAll("#toast-region .toast")).filter(
        (node) => node.dataset.tone === "error",
      ).length,
      toasts: Array.from(document.querySelectorAll("#toast-region .toast")).map((node) => ({
        text: text(node.querySelector(".toast__copy")),
        tone: node.dataset.tone ?? null,
      })),
      announcer: text(document.getElementById("chat-announcer")),
    };
  });
}

async function scenarioMobileComposer(browser, target) {
  const fixture = sendFixture();
  const { context, page, errors } = await newPage(browser, target, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const routeState = await installRoutes(page, {
      sessionId: THREADS.send,
      messages: fixture.messages,
    });
    await gotoChat(page, target, THREADS.send);
    await page.waitForSelector("#chat-prompt");

    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    check(
      coarse,
      "BLOCKED: Playwright hasTouch/isMobile did not make (pointer: coarse) match in this Chromium",
    );

    const prompt = page.locator("#chat-prompt");
    await prompt.focus();
    await prompt.pressSequentially("Mobile line");
    await prompt.press("Enter");
    await wait(250);

    const afterEnter = await composerUi(page);
    check(
      typeof afterEnter.promptValue === "string" && afterEnter.promptValue.includes("\n"),
      `coarse Enter inserts a newline (${JSON.stringify(afterEnter.promptValue)})`,
    );
    assertEqual(routeState.postCalls, 0, "coarse Enter never POSTs");
    assertEqual(
      await page.evaluate(
        () => document.getElementById("chat-composer-hint-text")?.textContent ?? "",
      ),
      "Enter for a new line · Send button to send",
      "coarse hint text",
    );
    check(
      afterEnter.label === "Send" && afterEnter.type === "submit",
      `the idle composer keeps Send (${afterEnter.label}/${afterEnter.type})`,
    );
    await shot(page, "mobile-composer-newline-390-dark");

    await page.locator("#chat-send").click();
    const postDeadline = Date.now() + 3_000;
    while (routeState.postCalls === 0 && Date.now() < postDeadline) await wait(50);
    await page.waitForFunction(
      () => {
        const button = document.getElementById("chat-send");
        return (
          button?.type === "submit" &&
          (button.textContent ?? "").includes("Send") &&
          button.disabled === false
        );
      },
      undefined,
      { timeout: 3_000 },
    );
    const afterSend = await composerUi(page);
    assertEqual(routeState.postCalls, 1, "tapping Send POSTs exactly once");
    assertEqual(afterSend.label, "Send", "the button returns to Send when idle");
    assertEqual(afterSend.type, "submit", "the idle button is a submit control");
    check(
      afterSend.promptValue === "",
      `the composer clears after a send (${JSON.stringify(afterSend.promptValue)})`,
    );
    await shot(page, "mobile-composer-sent-390-dark");
    checkNoErrors(errors);
    return { afterEnter, afterSend, postCalls: routeState.postCalls };
  } finally {
    await context.close();
  }
}

async function planUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    return {
      sectionHidden: document.getElementById("chat-plan-section")?.hidden ?? null,
      dividerHidden: document.getElementById("chat-plan-divider")?.hidden ?? null,
      chipHidden: document.getElementById("chat-plan-chip")?.hidden ?? null,
      chipLabel: text(document.getElementById("chat-plan-chip-label")),
      summary: text(document.getElementById("chat-plan-summary")),
      items: document.querySelectorAll(".chat-plan__item").length,
    };
  });
}

async function scenarioPlanVisibility(browser, target) {
  const sessionID = THREADS.main;
  const { context, page, errors } = await newPage(browser, target);
  try {
    await installRoutes(page, {
      sessionId: sessionID,
      messages: [],
      todos: [],
    });
    await gotoChat(page, target, sessionID);
    await page.waitForSelector("#chat-plan-section");
    await wait(300);

    const hidden = await planUi(page);
    check(hidden.sectionHidden === true, "the plan section starts hidden without Todos");
    check(hidden.dividerHidden === true, "the plan divider starts hidden without Todos");
    check(hidden.chipHidden === true, "the plan chip starts hidden without Todos");
    await shot(page, "plan-hidden-1440-dark");

    await emit(page, {
      type: "todo.updated",
      seq: 1,
      streamID: "qa-stream",
      sessionID,
      todos: [{ content: "Ship the plan", status: "in_progress", priority: "high" }],
    });
    await page.waitForFunction(
      () => document.getElementById("chat-plan-section")?.hidden === false,
      undefined,
      { timeout: 2_000 },
    );
    const visible = await planUi(page);
    check(visible.sectionHidden === false, "one in-progress Todo reveals the plan section");
    check(visible.dividerHidden === false, "one in-progress Todo reveals the plan divider");
    check(visible.chipHidden === false, "one in-progress Todo reveals the plan chip");
    check(
      visible.chipLabel.startsWith("Plan 0/1"),
      `the plan chip starts at Plan 0/1 (${visible.chipLabel})`,
    );
    assertEqual(visible.items, 1, "the plan list renders one Todo");
    await shot(page, "plan-visible-1440-dark");

    await emit(page, {
      type: "todo.updated",
      seq: 2,
      streamID: "qa-stream",
      sessionID,
      todos: [],
    });
    await page.waitForFunction(
      () => document.getElementById("chat-plan-section")?.hidden === true,
      undefined,
      { timeout: 2_000 },
    );
    const emptied = await planUi(page);
    check(emptied.sectionHidden === true, "an empty Todo list hides the plan section");
    check(emptied.dividerHidden === true, "an empty Todo list hides the plan divider");
    check(emptied.chipHidden === true, "an empty Todo list hides the plan chip");
    await shot(page, "plan-emptied-1440-dark");

    await emit(page, {
      type: "todo.updated",
      seq: 3,
      streamID: "qa-stream",
      sessionID,
      todos: [{ content: "Recovered plan", status: "completed", priority: "medium" }],
    });
    await page.waitForFunction(
      () => document.getElementById("chat-plan-section")?.hidden === false,
      undefined,
      { timeout: 2_000 },
    );
    const recovered = await planUi(page);
    check(recovered.sectionHidden === false, "a later Todo recovers the plan section");
    check(recovered.dividerHidden === false, "a later Todo recovers the plan divider");
    check(recovered.chipHidden === false, "a later Todo recovers the plan chip");
    check(
      recovered.chipLabel.startsWith("Plan 1/1"),
      `the recovered chip counts the completed Todo (${recovered.chipLabel})`,
    );
    await shot(page, "plan-recovered-1440-dark");

    checkNoErrors(errors);
    return { hidden, visible, emptied, recovered };
  } finally {
    await context.close();
  }
}

async function reasoningUi(page) {
  return page.evaluate(() => {
    const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
    const detail = document.querySelector('.tool-call[data-part-id="prt_reason_live"]');
    return {
      assistantBodies: Array.from(
        document.querySelectorAll(
          ".message:not(.message--user):not(.message--system) .message__body",
        ),
      )
        .map(text)
        .join(" "),
      detailExists: detail !== null,
      detailType: detail?.dataset.partType ?? null,
      elapsedText: text(detail?.querySelector(".tool-call__elapsed")),
      elapsedExists: detail !== null && detail.querySelector(".tool-call__elapsed") !== null,
    };
  });
}

async function scenarioReasoning(browser, target) {
  const sessionID = THREADS.send;
  const fixture = sendFixture();
  const marker = "QA_REASONING_DELTA_MARKER";
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionID,
      messages: fixture.messages,
    });
    await gotoChat(page, target, sessionID);
    await page.waitForSelector(".message");
    await waitForStableMessageGets(routeState);
    await wait(300);

    const reasoningStart = Date.now() - 2_000;
    const syncAfterDelta = await page.evaluate(
      (event) => {
        const source = window.__qaEventSource;
        if (!source) throw new Error("FakeEventSource is not installed");
        source.emit(event);
        const text = (node) => (node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "");
        return {
          assistantBodies: Array.from(
            document.querySelectorAll(
              ".message:not(.message--user):not(.message--system) .message__body",
            ),
          )
            .map(text)
            .join(" "),
          reasoningDetails: document.querySelectorAll('.tool-call[data-part-id="prt_reason_live"]')
            .length,
        };
      },
      {
        type: "message.part.delta",
        seq: 1,
        streamID: "qa-stream",
        sessionID,
        messageID: "msg_sa",
        partID: "prt_reason_live",
        field: "text",
        delta: marker,
        partType: "reasoning",
      },
    );
    check(
      !syncAfterDelta.assistantBodies.includes(marker),
      "a reasoning delta is never written into assistant prose",
    );
    check(
      syncAfterDelta.reasoningDetails === 0,
      `no reasoning details exists before the snapshot flush (${syncAfterDelta.reasoningDetails})`,
    );
    await wait(250);

    // D8 creates a provisional reasoning part, so the invariant is that the delta never
    // renders as assistant prose and that there is no elapsed timer until time.start exists.
    const before = await reasoningUi(page);
    check(
      !before.assistantBodies.includes(marker),
      "a reasoning delta never renders in an assistant .message__body",
    );
    check(!before.elapsedExists, "no reasoning elapsed span exists before a time.start snapshot");
    check(
      before.detailType === null || before.detailType === "reasoning",
      `the provisional part is reasoning, not text (${before.detailType})`,
    );

    await emit(page, {
      type: "message.part.updated",
      seq: 2,
      streamID: "qa-stream",
      sessionID,
      messageID: "msg_sa",
      partID: "prt_reason_live",
      partType: "reasoning",
      part: {
        id: "prt_reason_live",
        sessionID,
        messageID: "msg_sa",
        type: "reasoning",
        text: "Working through the QA reasoning state.",
        time: { start: reasoningStart },
      },
    });
    await page.waitForFunction(
      () => {
        const elapsed = document.querySelector(
          '.tool-call[data-part-id="prt_reason_live"] .tool-call__elapsed',
        );
        return elapsed !== null && (elapsed.textContent ?? "").trim().length > 0;
      },
      undefined,
      { timeout: 3_000 },
    );
    const liveFirst = (await reasoningUi(page)).elapsedText;
    await wait(1_200);
    const liveSecond = (await reasoningUi(page)).elapsedText;
    check(liveFirst.length > 0, `the live reasoning timer starts from time.start (${liveFirst})`);
    check(
      liveSecond.length > 0 && liveSecond !== liveFirst,
      `the live reasoning timer advances (${liveFirst} -> ${liveSecond})`,
    );
    await shot(page, "reasoning-live-1440-dark");

    const reasoningEnd = Date.now();
    await emit(page, {
      type: "message.part.updated",
      seq: 3,
      streamID: "qa-stream",
      sessionID,
      messageID: "msg_sa",
      partID: "prt_reason_live",
      partType: "reasoning",
      part: {
        id: "prt_reason_live",
        sessionID,
        messageID: "msg_sa",
        type: "reasoning",
        text: "Working through the QA reasoning state.",
        time: { start: reasoningStart, end: reasoningEnd },
      },
    });
    await page.waitForFunction(
      () => {
        const elapsed = document.querySelector(
          '.tool-call[data-part-id="prt_reason_live"] .tool-call__elapsed',
        );
        return elapsed !== null && (elapsed.textContent ?? "").trim().length > 0;
      },
      undefined,
      { timeout: 3_000 },
    );
    const frozen = (await reasoningUi(page)).elapsedText;
    await wait(1_200);
    const frozenLater = (await reasoningUi(page)).elapsedText;
    check(frozen.length > 0, `the completed reasoning timer keeps its final value (${frozen})`);
    assertEqual(frozenLater, frozen, "the completed reasoning timer freezes");
    await shot(page, "reasoning-frozen-1440-dark");

    const after = await reasoningUi(page);
    check(
      !after.assistantBodies.includes(marker),
      "the reasoning marker never leaks into assistant prose",
    );
    checkNoErrors(errors);
    return { before, liveFirst, liveSecond, frozen, frozenLater };
  } finally {
    await context.close();
  }
}

async function scenarioReconnect(browser, target) {
  const sessionID = THREADS.main;
  const { context, page, errors } = await newPage(browser, target);
  try {
    await installRoutes(page, { sessionId: sessionID, messages: [] });
    await gotoChat(page, target, sessionID);
    await page.waitForFunction(
      () =>
        window.__qaEventSourceCount >= 1 &&
        document.getElementById("chat-live")?.textContent === "Live",
      undefined,
      { timeout: 3_000 },
    );
    const before = await page.evaluate(() => ({
      count: window.__qaEventSourceCount,
      live: document.getElementById("chat-live")?.textContent ?? "",
    }));

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const source = window.__qaEventSource;
      if (!source) throw new Error("FakeEventSource is not installed");
      source.fail();
      source.fail();
      source.fail();
    });

    const hidden = await page.evaluate(() => ({
      count: window.__qaEventSourceCount,
      live: document.getElementById("chat-live")?.textContent ?? "",
      retryHidden: document.getElementById("chat-stream-retry")?.hidden ?? null,
    }));
    check(hidden.count === before.count, "background errors do not open a replacement stream");
    check(
      hidden.retryHidden === true,
      `background errors do not expose the paused Retry control (${hidden.live})`,
    );

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(
      (count) =>
        window.__qaEventSourceCount === count + 1 &&
        document.getElementById("chat-live")?.textContent === "Live",
      before.count,
      { timeout: 3_000 },
    );
    const after = await page.evaluate(() => ({
      count: window.__qaEventSourceCount,
      live: document.getElementById("chat-live")?.textContent ?? "",
      retryHidden: document.getElementById("chat-stream-retry")?.hidden ?? null,
    }));
    check(after.count === before.count + 1, "returning to the page opens one replacement stream");
    check(after.live === "Live", `the replacement stream returns to Live (${after.live})`);
    check(after.retryHidden === true, "the Retry control stays hidden after recovery");
    await shot(page, "reconnect-after-background-1440-dark");

    checkNoErrors(errors);
    return { before, hidden, after };
  } finally {
    await context.close();
  }
}

async function scenarioStop(browser, target) {
  const sessionID = THREADS.send;
  const fixture = sendFixture();
  const dockQuestion = {
    key: "v1:que_stop",
    id: "que_stop",
    sessionID,
    source: "v1",
    tooLarge: false,
    questions: [
      {
        header: "Stop",
        question: "Stop the current turn?",
        options: [{ label: "Yes", description: "Stop it" }],
        multiple: false,
        custom: false,
      },
    ],
  };
  let aborted = false;
  const { context, page, errors } = await newPage(browser, target);
  try {
    const routeState = await installRoutes(page, {
      sessionId: sessionID,
      messages: fixture.messages,
      prompts: () => (aborted ? [] : [dockQuestion]),
      abort: () => {
        aborted = true;
        return { status: 200, body: { aborted: true } };
      },
    });
    await gotoChat(page, target, sessionID);
    await page.waitForSelector("#chat-prompt-dock:not([hidden])");
    const docked = await composerUi(page);
    check(docked.dockHidden === false, "the question dock is visible before Stop");
    check(
      docked.label === "Send" && docked.type === "submit" && docked.disabled === true,
      `Send waits behind the dock (${docked.label}/${docked.type}/${docked.disabled})`,
    );

    await emit(page, {
      type: "session.status",
      seq: 1,
      streamID: "qa-stream",
      sessionID,
      status: { type: "busy" },
    });
    await page.waitForFunction(
      () => {
        const button = document.getElementById("chat-send");
        return (button?.textContent ?? "").includes("Stop") && button.type === "button";
      },
      undefined,
      { timeout: 2_000 },
    );
    const stopping = await composerUi(page);
    check(
      stopping.label === "Stop",
      `a busy turn with an empty composer shows Stop (${stopping.label})`,
    );
    assertEqual(stopping.type, "button", "Stop is a button, not a submit control");
    check(stopping.disabled === false, "Stop is enabled while the turn is active");
    check(stopping.promptValue === "", "Stop only appears with an empty composer");
    await shot(page, "stop-busy-dock-1440-dark");

    await page.locator("#chat-send").click();
    const abortDeadline = Date.now() + 3_000;
    while (routeState.abortCalls.length === 0 && Date.now() < abortDeadline) await wait(50);
    assertEqual(routeState.abortCalls.length, 1, "clicking Stop calls the abort route once");
    assertEqual(
      routeState.abortCalls[0]?.sessionID,
      sessionID,
      "the abort route targets the active session",
    );
    const abortBody = routeState.abortCalls[0]?.body ?? null;
    check(
      abortBody === null || abortBody === "",
      `the abort route is called without a relevant request body (${JSON.stringify(abortBody)})`,
    );
    await page.waitForFunction(
      () => document.getElementById("chat-prompt-dock")?.hidden === true,
      undefined,
      { timeout: 3_000 },
    );

    await emitMany(page, [
      {
        type: "session.error",
        seq: 2,
        streamID: "qa-stream",
        sessionID,
        name: "MessageAbortedError",
        message: "Aborted",
      },
      {
        type: "session.status",
        seq: 3,
        streamID: "qa-stream",
        sessionID,
        status: { type: "idle" },
      },
    ]);
    await page.waitForFunction(
      () => {
        const button = document.getElementById("chat-send");
        return (
          button?.type === "submit" &&
          (button.textContent ?? "").includes("Send") &&
          button.disabled === false &&
          document.getElementById("chat-prompt-dock")?.hidden === true
        );
      },
      undefined,
      { timeout: 4_000 },
    );
    const settled = await composerUi(page);
    check(settled.agentErrors === 0, "an intentional abort inserts no Agent error card");
    assertEqual(settled.errorToasts, 0, "an intentional abort shows no error toast");
    check(
      !settled.sendError.includes("Could not stop the turn") &&
        !settled.sendError.includes("Agent error"),
      `the abort adds no failure text (${settled.sendError})`,
    );
    assertEqual(settled.label, "Send", "Send returns after the abort settles");
    assertEqual(settled.type, "submit", "Send is restored as a submit control");
    check(settled.disabled === false, "Send is enabled after the abort settles");
    check(settled.promptDisabled === false, "the composer stays enabled after the abort settles");
    check(settled.dockHidden === true, "the pending dock is gone after the abort");
    assertEqual(routeState.abortCalls.length, 1, "the abort route was never called again");
    await shot(page, "stop-idle-after-abort-1440-dark");

    checkNoErrors(errors);
    return { docked, stopping, settled, abortCalls: routeState.abortCalls.length };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Live smoke (real managed app)
// ---------------------------------------------------------------------------

async function scenarioImageNotReady(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    let phase = "not_ready";
    const ready = () =>
      imageStateView({
        state: "current",
        status: "ready",
        imageRef: "hanse-agent-custom:qa",
        usableImageRef: "hanse-agent-custom:qa",
        running: true,
        blocked: false,
        selectedImage: "present",
        imageId: QA_DIGEST_B,
        targetImageId: QA_DIGEST_B,
        appliedImageId: QA_DIGEST_B,
      });
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages: [],
      image: {
        view: () =>
          phase === "ready"
            ? ready()
            : imageStateView({
                state: "not_ready",
                status: "missing",
                buildConfigured: true,
                usableImageRef: null,
                running: false,
                blocked: true,
                selectedImage: "missing",
              }),
        build: () => {
          phase = "ready";
          return { httpStatus: 202, body: { accepted: true, buildId: "build_qa" } };
        },
        runtime: () => ({ state: phase === "ready" ? "running" : "stopped" }),
      },
    });
    await gotoChat(page, target);
    await page.waitForSelector("#image-gate:not([hidden])");

    const blocked = await imageUi(page);
    assertEqual(blocked.gate.hidden, false, "not-ready shows the card");
    assertEqual(blocked.gate.role, "region", "the card is an app-level region");
    assertEqual(blocked.gate.title, "Image not built", "not-ready card title");
    assertEqual(blocked.gate.body, "Build the image to start the agent.", "not-ready card body");
    assertEqual(blocked.gate.buttons, ["Build and start"], "not-ready card action");
    assertEqual(blocked.warning.hidden, true, "not-ready hides the warning");
    assertEqual(blocked.composer.hidden, true, "not-ready hides the composer");
    assertEqual(blocked.composer.promptDisabled, true, "not-ready disables the prompt");
    assertEqual(blocked.viewportHidden, true, "not-ready hides the thread viewport");
    assertEqual(routeState.sessionGets.length, 0, "not-ready never boots sessions");
    assertEqual(blocked.eventSourceCount, 0, "not-ready never opens SSE");
    await wait(250);
    assertEqual(routeState.sessionGets.length, 0, "not-ready keeps sessions unrequested");
    assertEqual(blocked.eventSourceCount, 0, "not-ready keeps SSE closed");
    await captureImageVariants(page, "image-not-ready");

    await page.locator("#image-gate button").click();
    const deadline = Date.now() + 5_000;
    while (routeState.startPosts.length === 0 && Date.now() < deadline) await wait(50);
    await page.waitForFunction(
      () => document.getElementById("chat-composer")?.hidden === false,
      undefined,
      {
        timeout: 5_000,
      },
    );
    await waitForChatStream(page);
    const after = await imageUi(page);
    assertEqual(routeState.buildPosts.length, 1, "build-and-start POSTs build once");
    assertEqual(routeState.startPosts.length, 1, "build-and-start POSTs start once");
    const buildIndex = routeState.imageActions.findIndex((entry) => entry.kind === "build");
    const startIndex = routeState.imageActions.findIndex((entry) => entry.kind === "start");
    check(
      buildIndex >= 0 && startIndex > buildIndex,
      `build precedes start (${JSON.stringify(routeState.imageActions.map((entry) => entry.kind))})`,
    );
    check(
      routeState.imageGets.some((call) => call.refresh === true),
      "the build poll uses ?refresh=1",
    );
    assertEqual(after.gate.hidden, true, "ready removes the card");
    assertEqual(after.composer.hidden, false, "ready reveals the composer");
    assertEqual(after.composer.promptDisabled, false, "ready enables the prompt");
    assertEqual(after.eventSourceCount, 1, "ready subscribes to SSE once");
    check(routeState.sessionGets.length >= 1, "ready boots sessions");
    checkNoErrors(errors);
    return {
      buildPosts: routeState.buildPosts.length,
      startPosts: routeState.startPosts.length,
      imageActions: routeState.imageActions.map((entry) => entry.kind),
    };
  } finally {
    await context.close();
  }
}

async function scenarioImageBuilding(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    let phase = "building";
    const ready = () =>
      imageStateView({
        state: "current",
        status: "ready",
        imageRef: "hanse-agent-custom:qa",
        usableImageRef: "hanse-agent-custom:qa",
        running: true,
        blocked: false,
        selectedImage: "present",
        imageId: QA_DIGEST_B,
        targetImageId: QA_DIGEST_B,
        appliedImageId: QA_DIGEST_B,
      });
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages: [],
      image: {
        view: () => {
          if (phase === "ready") return ready();
          return imageStateView({
            state: "building",
            status: "building",
            buildConfigured: true,
            usableImageRef: null,
            running: false,
            blocked: true,
            selectedImage: "missing",
            buildId: "build_qa",
            imageBuildId: "build_qa",
          });
        },
        build: () => ({ httpStatus: 202, body: { accepted: true, buildId: "build_qa" } }),
        runtime: () => ({ state: phase === "ready" ? "running" : "stopped" }),
      },
    });
    await gotoChat(page, target);
    await page.waitForSelector("#image-gate:not([hidden])");

    const building = await imageUi(page);
    assertEqual(building.gate.title, "Building image", "building card title");
    assertEqual(
      building.gate.body,
      "The image is being built. This page updates when the build finishes.",
      "building card body",
    );
    assertEqual(building.gate.buttons, [], "building card has no duplicate action");
    assertEqual(building.composer.hidden, true, "building hides the composer");
    assertEqual(building.viewportHidden, true, "building hides the thread viewport");
    assertEqual(routeState.sessionGets.length, 0, "building never boots sessions");
    assertEqual(building.eventSourceCount, 0, "building never opens SSE");
    assertEqual(routeState.buildPosts.length, 0, "a durable build is not re-posted");
    await captureImageVariants(page, "image-building");

    const refreshPollsBefore = routeState.imageGets.filter((call) => call.refresh === true).length;
    await page.evaluate(
      ({ key }) => {
        window.sessionStorage.setItem(
          key,
          JSON.stringify({ action: "build_start", startedAt: Date.now() }),
        );
      },
      { key: `hanse.chat.imageIntent:${PROJECT_ID}:${APP}` },
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#image-gate:not([hidden])");

    const pollDeadline = Date.now() + 6_000;
    while (
      routeState.imageGets.filter((call) => call.refresh === true).length <
        refreshPollsBefore + 2 &&
      Date.now() < pollDeadline
    ) {
      await wait(50);
    }
    check(
      routeState.imageGets.filter((call) => call.refresh === true).length >= refreshPollsBefore + 2,
      `reload attaches to the durable build and keeps polling (${
        routeState.imageGets.filter((call) => call.refresh === true).length - refreshPollsBefore
      } refresh polls)`,
    );
    const resumed = await imageUi(page);
    assertEqual(resumed.gate.title, "Building image", "attached polling keeps the building card");
    assertEqual(routeState.buildPosts.length, 0, "resume attaches without a second build POST");
    assertEqual(routeState.startPosts.length, 0, "resume does not start before the image is ready");

    phase = "ready";
    await page.waitForFunction(
      () => document.getElementById("chat-composer")?.hidden === false,
      undefined,
      {
        timeout: 8_000,
      },
    );
    const startDeadline = Date.now() + 4_000;
    while (routeState.startPosts.length === 0 && Date.now() < startDeadline) await wait(50);
    await waitForChatStream(page);
    const after = await imageUi(page);
    assertEqual(routeState.startPosts.length, 1, "the resumed build starts once it is ready");
    assertEqual(after.gate.hidden, true, "the building card clears when ready");
    assertEqual(after.eventSourceCount, 1, "the resumed flow subscribes once");
    check(routeState.sessionGets.length >= 1, "the resumed flow boots sessions");
    checkNoErrors(errors);
    return {
      refreshPolls: routeState.imageGets.filter((call) => call.refresh === true).length,
      startPosts: routeState.startPosts.length,
    };
  } finally {
    await context.close();
  }
}

async function scenarioImageBuildError(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    let phase = "error";
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages: [],
      image: {
        view: () =>
          phase === "ready"
            ? imageStateView({
                state: "current",
                status: "ready",
                imageRef: "hanse-agent-custom:qa",
                usableImageRef: "hanse-agent-custom:qa",
                running: true,
                blocked: false,
                selectedImage: "present",
                imageId: QA_DIGEST_B,
                targetImageId: QA_DIGEST_B,
                appliedImageId: QA_DIGEST_B,
              })
            : imageStateView({
                state: "build_error",
                status: "error",
                error: "Dockerfile build failed: exit status 1",
                buildConfigured: true,
                usableImageRef: null,
                running: false,
                blocked: true,
                selectedImage: "missing",
              }),
        build: () => {
          phase = "ready";
          return { httpStatus: 202, body: { accepted: true, buildId: "build_qa" } };
        },
        runtime: () => ({ state: phase === "ready" ? "running" : "stopped" }),
      },
    });
    await gotoChat(page, target);
    await page.waitForSelector("#image-gate:not([hidden])");

    const failed = await imageUi(page);
    assertEqual(failed.gate.title, "Image build failed", "build-error card title");
    assertEqual(
      failed.gate.body,
      "Dockerfile build failed: exit status 1",
      "build-error card shows the bounded error",
    );
    assertEqual(failed.gate.buttons, ["Retry build and start"], "build-error card action");
    assertEqual(failed.composer.hidden, true, "build-error hides the composer");
    assertEqual(failed.viewportHidden, true, "build-error hides the thread viewport");
    assertEqual(routeState.sessionGets.length, 0, "build-error never boots sessions");
    check(
      !failed.bodyText.includes("502") && !failed.bodyText.includes("Bad Gateway"),
      "build-error renders bounded copy, not a raw 502",
    );
    await captureImageVariants(page, "image-build-error");

    await page.locator("#image-gate button").click();
    await page.waitForFunction(
      () => document.getElementById("chat-composer")?.hidden === false,
      undefined,
      {
        timeout: 6_000,
      },
    );
    await waitForChatStream(page);
    assertEqual(routeState.buildPosts.length, 1, "retry POSTs build once");
    assertEqual(routeState.startPosts.length, 1, "retry starts after the image is ready");
    checkNoErrors(errors);
    return {
      buildPosts: routeState.buildPosts.length,
      startPosts: routeState.startPosts.length,
    };
  } finally {
    await context.close();
  }
}

async function scenarioImageWarning(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    let phase = "rebuild";
    const view = () => {
      if (phase === "rebuild") {
        return imageStateView({
          state: "rebuild_required",
          status: "stale",
          imageRef: "hanse-agent-custom:qa",
          usableImageRef: "hanse-agent-custom:qa",
          running: true,
          blocked: false,
          selectedImage: "present",
          imageId: QA_DIGEST_B,
          targetImageId: QA_DIGEST_B,
          appliedImageId: QA_DIGEST_A,
          baseKind: "base",
          baseRef: "hanse-agent-base:qa",
          baseDigest: QA_DIGEST_A,
          currentBaseDigest: QA_DIGEST_B,
          baseDrift: true,
          hashDrift: false,
        });
      }
      if (phase === "restart") {
        return imageStateView({
          state: "restart_required",
          status: "ready",
          imageRef: "hanse-agent-custom:qa",
          usableImageRef: "hanse-agent-custom:qa",
          running: true,
          blocked: false,
          selectedImage: "present",
          imageId: QA_DIGEST_B,
          targetImageId: QA_DIGEST_B,
          appliedImageId: QA_DIGEST_C,
          baseKind: "base",
          baseRef: "hanse-agent-base:qa",
          baseDigest: QA_DIGEST_A,
          currentBaseDigest: QA_DIGEST_A,
          baseDrift: false,
          hashDrift: false,
        });
      }
      return imageStateView({
        state: "current",
        status: "ready",
        imageRef: "hanse-agent-custom:qa",
        usableImageRef: "hanse-agent-custom:qa",
        running: true,
        blocked: false,
        selectedImage: "present",
        imageId: QA_DIGEST_B,
        targetImageId: QA_DIGEST_B,
        appliedImageId: QA_DIGEST_B,
        baseKind: "base",
        baseRef: "hanse-agent-base:qa",
        baseDigest: QA_DIGEST_A,
        currentBaseDigest: QA_DIGEST_A,
        baseDrift: false,
        hashDrift: false,
      });
    };
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages: [],
      image: {
        view,
        build: () => {
          phase = "restart";
          return { httpStatus: 202, body: { accepted: true, buildId: "build_qa" } };
        },
        restart: () => {
          phase = "current";
          return { httpStatus: 200, body: { restarted: true } };
        },
        runtime: () => ({ state: "running", imageRef: "hanse-agent-custom:qa" }),
      },
    });
    await gotoChat(page, target);
    await page.waitForSelector("#image-warning:not([hidden])");

    const rebuild = await imageUi(page);
    assertEqual(rebuild.warning.hidden, false, "rebuild-required shows the warning");
    assertEqual(rebuild.warning.role, "status", "the warning is an app-level status");
    assertEqual(rebuild.warning.title, "Image out of date", "rebuild warning title");
    assertEqual(
      rebuild.warning.body,
      "Rebuild and restart the agent to use the new image.",
      "rebuild warning body",
    );
    assertEqual(rebuild.warning.buttons, ["Rebuild & restart"], "rebuild warning action");
    assertEqual(rebuild.gate.hidden, true, "a running app never shows the blocked card");
    assertEqual(rebuild.composer.hidden, false, "the warning keeps the composer usable");
    assertEqual(rebuild.composer.promptDisabled, false, "the warning keeps the prompt enabled");
    check(routeState.sessionGets.length >= 1, "a warned running app boots sessions");
    assertEqual(rebuild.eventSourceCount, 1, "a warned running app subscribes to SSE");
    await captureImageVariants(page, "image-warning-rebuild");

    await page.locator("#image-warning button").click();
    const restartDeadline = Date.now() + 6_000;
    while (routeState.restartPosts.length === 0 && Date.now() < restartDeadline) await wait(50);
    await page.waitForFunction(
      () => document.getElementById("image-warning")?.hidden === true,
      undefined,
      {
        timeout: 6_000,
      },
    );
    const warningGone = await imageUi(page);
    assertEqual(routeState.buildPosts.length, 1, "rebuild & restart POSTs build once");
    assertEqual(routeState.restartPosts.length, 1, "rebuild & restart POSTs restart once");
    assertEqual(routeState.startPosts.length, 0, "rebuild & restart never POSTs start");
    const rebuildBuild = routeState.imageActions.findIndex((entry) => entry.kind === "build");
    const rebuildRestart = routeState.imageActions.findIndex((entry) => entry.kind === "restart");
    check(
      rebuildBuild >= 0 && rebuildRestart > rebuildBuild,
      `rebuild precedes restart (${JSON.stringify(routeState.imageActions.map((entry) => entry.kind))})`,
    );
    assertEqual(warningGone.warning.hidden, true, "the rebuild warning clears when current");
    assertEqual(warningGone.composer.hidden, false, "the composer stays usable after rebuild");

    phase = "restart";
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#image-warning:not([hidden])");
    const restart = await imageUi(page);
    assertEqual(restart.warning.title, "Image updated", "restart-required warning title");
    assertEqual(
      restart.warning.body,
      "Restart the agent to use the new image.",
      "restart-required warning body",
    );
    assertEqual(restart.warning.buttons, ["Restart"], "restart-required warning action");
    assertEqual(restart.composer.hidden, false, "restart-required keeps the composer usable");
    await captureImageVariants(page, "image-warning-restart");

    await page.locator("#image-warning button").click();
    const secondDeadline = Date.now() + 5_000;
    while (routeState.restartPosts.length < 2 && Date.now() < secondDeadline) await wait(50);
    await page.waitForFunction(
      () => document.getElementById("image-warning")?.hidden === true,
      undefined,
      {
        timeout: 5_000,
      },
    );
    assertEqual(routeState.restartPosts.length, 2, "restart-required POSTs restart once");
    assertEqual(routeState.buildPosts.length, 1, "restart-required never POSTs build");
    assertEqual(routeState.startPosts.length, 0, "restart-required never POSTs start");
    checkNoErrors(errors);
    return {
      buildPosts: routeState.buildPosts.length,
      restartPosts: routeState.restartPosts.length,
      startPosts: routeState.startPosts.length,
    };
  } finally {
    await context.close();
  }
}

async function scenarioImageActions(browser, target) {
  const notReady = () =>
    imageStateView({
      state: "not_ready",
      status: "missing",
      buildConfigured: true,
      usableImageRef: null,
      running: false,
      blocked: true,
      selectedImage: "missing",
    });
  const ready = () =>
    imageStateView({
      state: "current",
      status: "ready",
      imageRef: "hanse-agent-custom:qa",
      usableImageRef: "hanse-agent-custom:qa",
      running: true,
      blocked: false,
      selectedImage: "present",
      imageId: QA_DIGEST_B,
      targetImageId: QA_DIGEST_B,
      appliedImageId: QA_DIGEST_B,
    });

  // 1. 409 build_in_progress plus a durable build: attach and finish without a retry toast.
  {
    const { context, page, errors } = await newPage(browser, target);
    try {
      let phase = "not_ready";
      const routeState = await installRoutes(page, {
        sessionId: THREADS.main,
        messages: [],
        image: {
          view: ({ state }) => {
            if (phase === "not_ready") return notReady();
            if (phase === "building") {
              if (state.imageGets.length >= 3) {
                phase = "ready";
                return ready();
              }
              return imageStateView({
                state: "building",
                status: "building",
                buildConfigured: true,
                usableImageRef: null,
                running: false,
                blocked: true,
                selectedImage: "missing",
                imageBuildId: "build_qa",
                buildId: "build_qa",
              });
            }
            return ready();
          },
          build: () => {
            phase = "building";
            return {
              httpStatus: 409,
              body: { error: "image build already in progress", code: "build_in_progress" },
            };
          },
          runtime: () => ({ state: phase === "ready" ? "running" : "stopped" }),
        },
      });
      await gotoChat(page, target);
      await page.waitForSelector("#image-gate:not([hidden])");
      await page.locator("#image-gate button").click();
      await page.waitForFunction(
        () => document.getElementById("chat-composer")?.hidden === false,
        undefined,
        { timeout: 6_000 },
      );
      const ui = await imageUi(page);
      assertEqual(routeState.buildPosts.length, 1, "the attach path POSTs build once");
      assertEqual(
        routeState.startPosts.length,
        1,
        "the attach path starts after the durable build",
      );
      check(
        routeState.imageGets.filter((call) => call.refresh === true).length >= 1,
        "the 409 checks GET /image?refresh=1 before attaching",
      );
      check(
        !ui.toastText.includes("Another image build is running"),
        "a durable build attaches without the retry toast",
      );
      assertEqual(ui.gate.hidden, true, "the attached build clears the card");
      checkExpectedHttpError(errors, 409);
    } finally {
      await context.close();
    }
  }

  // 2. 409 while the view is building but has no durable build id: bounded retry, no polling.
  {
    const { context, page, errors } = await newPage(browser, target);
    try {
      let phase = "not_ready";
      const routeState = await installRoutes(page, {
        sessionId: THREADS.main,
        messages: [],
        image: {
          view: () => {
            if (phase === "not_ready") return notReady();
            return imageStateView({
              state: "building",
              status: "building",
              buildConfigured: true,
              usableImageRef: null,
              running: false,
              blocked: true,
              selectedImage: "missing",
              imageBuildId: null,
            });
          },
          build: () => {
            phase = "other";
            return {
              httpStatus: 409,
              body: { error: "image build already in progress", code: "build_in_progress" },
            };
          },
          runtime: () => ({ state: "stopped" }),
        },
      });
      await gotoChat(page, target);
      await page.waitForSelector("#image-gate:not([hidden])");
      await page.locator("#image-gate button").click();
      await page.waitForFunction(
        () =>
          (document.getElementById("toast-region")?.textContent ?? "").includes(
            "Another image build is running",
          ),
        undefined,
        { timeout: 3_000 },
      );
      const ui = await imageUi(page);
      assertEqual(
        ui.toastText,
        "Another image build is running. Retry when it finishes.",
        "the other-build toast is bounded",
      );
      assertEqual(ui.gate.title, "Building image", "the other build still shows a progress card");
      await captureImageVariants(page, "image-actions-other-build");
      const getsAfterToast = routeState.imageGets.length;
      await wait(2_400);
      assertEqual(routeState.imageGets.length, getsAfterToast, "another app's build is not polled");
      assertEqual(routeState.startPosts.length, 0, "another app's build never starts this app");
      assertEqual(routeState.buildPosts.length, 1, "the retry does not POST build again");
      checkExpectedHttpError(errors, 409);
    } finally {
      await context.close();
    }
  }

  // 3. 409 while the view is not building but carries an id: still no attach.
  {
    const { context, page, errors } = await newPage(browser, target);
    try {
      let phase = "not_ready";
      const routeState = await installRoutes(page, {
        sessionId: THREADS.main,
        messages: [],
        image: {
          view: () => {
            if (phase === "not_ready") return notReady();
            return imageStateView({
              state: "not_ready",
              status: "missing",
              buildConfigured: true,
              usableImageRef: null,
              running: false,
              blocked: true,
              selectedImage: "missing",
              imageBuildId: "build_other",
            });
          },
          build: () => {
            phase = "stale_id";
            return {
              httpStatus: 409,
              body: { error: "image build already in progress", code: "build_in_progress" },
            };
          },
          runtime: () => ({ state: "stopped" }),
        },
      });
      await gotoChat(page, target);
      await page.waitForSelector("#image-gate:not([hidden])");
      await page.locator("#image-gate button").click();
      await page.waitForFunction(
        () =>
          (document.getElementById("toast-region")?.textContent ?? "").includes(
            "Another image build is running",
          ),
        undefined,
        { timeout: 3_000 },
      );
      const getsAfterToast = routeState.imageGets.length;
      await wait(2_400);
      assertEqual(
        routeState.imageGets.length,
        getsAfterToast,
        "an id outside building is not polled",
      );
      assertEqual(routeState.startPosts.length, 0, "an id outside building never starts this app");
      assertEqual(routeState.buildPosts.length, 1, "the stale-id retry does not POST build again");
      const ui = await imageUi(page);
      assertEqual(ui.gate.title, "Image not built", "the stale id keeps the not-ready card");
      checkExpectedHttpError(errors, 409);
    } finally {
      await context.close();
    }
  }

  // 4. A typed 409 from start re-enters the card and refreshes the image, with no raw status copy.
  {
    const { context, page, errors } = await newPage(browser, target);
    try {
      let phase = "not_ready";
      const routeState = await installRoutes(page, {
        sessionId: THREADS.main,
        messages: [],
        image: {
          view: () => (phase === "not_ready" ? notReady() : ready()),
          build: () => {
            phase = "ready";
            return { httpStatus: 202, body: { accepted: true, buildId: "build_qa" } };
          },
          start: () => {
            phase = "not_ready";
            return {
              httpStatus: 409,
              body: { error: "application image is not ready", code: "image_not_ready" },
            };
          },
          runtime: () => ({ state: phase === "ready" ? "running" : "stopped" }),
        },
      });
      await gotoChat(page, target);
      await page.waitForSelector("#image-gate:not([hidden])");
      const before = routeState.imageGets.length;
      await page.locator("#image-gate button").click();
      await page.waitForFunction(
        () =>
          (document.getElementById("toast-region")?.textContent ?? "").includes(
            "The image is not ready yet",
          ),
        undefined,
        { timeout: 5_000 },
      );
      const ui = await imageUi(page);
      assertEqual(routeState.startPosts.length, 1, "the typed 409 comes from the start action");
      check(
        routeState.imageGets.length > before + 1,
        `a typed 409 refreshes the image view (${before} -> ${routeState.imageGets.length})`,
      );
      assertEqual(
        ui.toastText,
        "The image is not ready yet. Retry from the card.",
        "the typed 409 toast is bounded",
      );
      assertEqual(ui.gate.hidden, false, "a typed 409 re-enters the blocked card");
      assertEqual(ui.gate.title, "Image not built", "the typed 409 shows the current image state");
      check(!ui.bodyText.includes("409"), "the typed 409 never leaks the raw status");
      checkExpectedHttpError(errors, 409);
    } finally {
      await context.close();
    }
  }

  // 5. A typed 503 from restart refreshes and keeps the running warning.
  {
    const { context, page, errors } = await newPage(browser, target);
    try {
      const restartView = () =>
        imageStateView({
          state: "restart_required",
          status: "ready",
          imageRef: "hanse-agent-custom:qa",
          usableImageRef: "hanse-agent-custom:qa",
          running: true,
          blocked: false,
          selectedImage: "present",
          imageId: QA_DIGEST_B,
          targetImageId: QA_DIGEST_B,
          appliedImageId: QA_DIGEST_C,
        });
      const routeState = await installRoutes(page, {
        sessionId: THREADS.main,
        messages: [],
        image: {
          view: () => restartView(),
          restart: () => ({
            httpStatus: 503,
            body: { error: "default agent image unavailable", code: "default_image_unavailable" },
          }),
          runtime: () => ({ state: "running", imageRef: "hanse-agent-custom:qa" }),
        },
      });
      await gotoChat(page, target);
      await page.waitForSelector("#image-warning:not([hidden])");
      const before = routeState.imageGets.length;
      await page.locator("#image-warning button").click();
      await page.waitForFunction(
        () =>
          (document.getElementById("toast-region")?.textContent ?? "").includes(
            "The new image is not ready",
          ),
        undefined,
        { timeout: 4_000 },
      );
      const ui = await imageUi(page);
      assertEqual(routeState.restartPosts.length, 1, "the typed 503 comes from restart");
      check(
        routeState.imageGets.length > before,
        `a typed 503 refreshes the image view (${before} -> ${routeState.imageGets.length})`,
      );
      assertEqual(
        ui.toastText,
        "The new image is not ready. The agent keeps its current container.",
        "the typed 503 toast is bounded",
      );
      assertEqual(ui.warning.hidden, false, "a typed 503 keeps the running warning");
      assertEqual(ui.composer.hidden, false, "a typed 503 keeps the composer usable");
      check(!ui.bodyText.includes("503"), "the typed 503 never leaks the raw status");
      checkExpectedHttpError(errors, 503);
    } finally {
      await context.close();
    }
  }
}

async function scenarioImagePanels(browser, target) {
  const { context, page, errors } = await newPage(browser, target);
  try {
    let defaultPhase = "restart";
    const customRef = "hanse-agent-custom:qa";
    const customView = () =>
      imageStateView({
        appKey: CUSTOM_APP,
        state: "restart_required",
        status: "ready",
        imageRef: customRef,
        imageId: QA_DIGEST_B,
        targetImageId: QA_DIGEST_B,
        appliedImageId: QA_DIGEST_A,
        usableImageRef: customRef,
        running: true,
        blocked: false,
        selectedImage: "present",
        builtAt: "2026-10-21T12:00:00.000Z",
        baseKind: "base",
        baseRef: "hanse-agent-base:qa",
        baseDigest: QA_DIGEST_A,
        currentBaseDigest: QA_DIGEST_A,
        baseDrift: false,
        hashDrift: false,
        previousImageRef: "hanse-agent-custom:previous",
        previousImageBuiltAt: "2026-10-20T12:00:00.000Z",
      });
    const defaultView = () =>
      defaultPhase === "building"
        ? imageStateView({
            appKey: APP,
            buildConfigured: false,
            state: "building",
            status: "building",
            running: false,
            usableImageRef: null,
            blocked: false,
          })
        : imageStateView({
            appKey: APP,
            buildConfigured: false,
            state: "restart_required",
            status: "missing",
            running: true,
            usableImageRef: null,
            blocked: false,
            targetImageId: QA_DIGEST_B,
            appliedImageId: QA_DIGEST_A,
            selectedImage: "missing",
          });
    const routeState = await installRoutes(page, {
      sessionId: THREADS.main,
      messages: [],
      image: {
        view: ({ appKey }) => (appKey === CUSTOM_APP ? customView() : defaultView()),
        runtime: ({ appKey }) => ({
          state: "running",
          imageRef: appKey === CUSTOM_APP ? customRef : null,
        }),
      },
    });

    await page.goto(
      `${target.baseUrl}/projects/${encodeURIComponent(PROJECT_ID)}/apps/${encodeURIComponent(CUSTOM_APP)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      (expected) => document.getElementById("image-panel")?.dataset.state === expected,
      "restart_required",
      { timeout: 5_000 },
    );
    const custom = await imagePanelUi(page);
    assertEqual(custom.present, true, "the custom application panel renders");
    assertEqual(custom.appKey, CUSTOM_APP, "the custom panel belongs to the custom app");
    assertEqual(custom.panelStatus, "missing", "the custom panel starts from persisted status");
    assertEqual(custom.state, "restart_required", "the custom panel renders the derived state");
    assertEqual(custom.statusText, "Restart required", "the custom panel status label");
    assertEqual(custom.ref, customRef, "the custom panel shows the created ref");
    assertEqual(custom.baseKind, "Base", "the custom panel shows the base kind");
    assertEqual(custom.baseRef, "hanse-agent-base:qa", "the custom panel shows the base ref");
    assertEqual(custom.baseDigest, QA_DIGEST_A, "the custom panel shows the base digest");
    assertEqual(
      custom.rollbackRef,
      "hanse-agent-custom:previous",
      "the custom panel shows the rollback ref",
    );
    assertEqual(custom.rollbackRowHidden, false, "the rollback row is visible");
    assertEqual(custom.rollbackBuiltRowHidden, false, "the rollback built row is visible");
    assertEqual(custom.rollbackFormHidden, false, "the rollback action is visible");
    assertEqual(custom.hasBuild, true, "the custom panel has a build action");
    assertEqual(custom.hasCheck, false, "the custom panel has no default check action");
    assertEqual(custom.hasDetails, true, "the custom panel has details");
    check(
      routeState.imageGets.some((call) => call.appKey === CUSTOM_APP),
      "the custom panel fetched GET /image on load",
    );
    await page.locator("#image-details > summary").click();
    await captureImageVariants(page, "image-panels-custom", {
      afterPhoneReload: async (phone) => {
        await phone.locator("#image-details > summary").click();
        await phone.locator("#image-panel").scrollIntoViewIfNeeded();
      },
    });

    await page.goto(
      `${target.baseUrl}/projects/${encodeURIComponent(PROJECT_ID)}/apps/${encodeURIComponent(APP)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      (expected) => document.getElementById("image-panel")?.dataset.state === expected,
      "restart_required",
      { timeout: 5_000 },
    );
    const fallback = await imagePanelUi(page);
    assertEqual(fallback.present, true, "the default application panel renders");
    assertEqual(fallback.appKey, APP, "the default panel belongs to the default app");
    assertEqual(fallback.panelStatus, "default", "the default panel is the no-build panel");
    assertEqual(fallback.state, "restart_required", "the default panel renders the derived state");
    assertEqual(
      fallback.statusText,
      "Restart required",
      "the default panel shows restart-required",
    );
    assertEqual(fallback.hasBuild, false, "the default panel has no build action");
    assertEqual(fallback.hasBuildForm, false, "the default panel has no build form");
    assertEqual(fallback.hasCheck, true, "the default panel keeps the check action");
    assertEqual(fallback.hasDetails, false, "the default panel has no custom build details");
    assertEqual(fallback.hasLogs, false, "the default panel has no build logs");
    check(
      routeState.imageGets.some((call) => call.appKey === APP),
      "the default panel fetched GET /image on load",
    );
    await captureImageVariants(page, "image-panels-default", {
      afterPhoneReload: async (phone) => {
        await phone.locator("#image-panel").scrollIntoViewIfNeeded();
      },
    });

    defaultPhase = "building";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (expected) => document.getElementById("image-panel")?.dataset.state === expected,
      "building",
      { timeout: 5_000 },
    );
    const defaultBuilding = await imagePanelUi(page);
    assertEqual(
      defaultBuilding.statusText,
      "Unknown",
      "the default panel never renders a build state",
    );
    assertEqual(defaultBuilding.hasBuild, false, "the default panel never grows a build action");
    check(
      !defaultBuilding.bodyText.includes("Building image") &&
        !defaultBuilding.bodyText.includes("Build image"),
      "the default panel never shows build-state copy",
    );
    checkNoErrors(errors);
    return {
      custom: {
        state: custom.state,
        status: custom.statusText,
        baseKind: custom.baseKind,
        rollback: custom.rollbackRef,
      },
      default: { state: fallback.state, status: fallback.statusText, build: fallback.hasBuild },
      defaultBuilding: { status: defaultBuilding.statusText, build: defaultBuilding.hasBuild },
    };
  } finally {
    await context.close();
  }
}

async function scenarioLive(browser, target) {
  const session = process.env.CHAT_QA_LIVE_SESSION;
  if (!session) {
    throw new Error(
      "chat-qa --live needs CHAT_QA_LIVE_SESSION=<existing session id>; no real agent was probed.",
    );
  }
  const promptText =
    process.env.CHAT_QA_LIVE_PROMPT ??
    "Reply with a short markdown table titled Live QA with two rows, then stop.";
  const timeout = Number(process.env.CHAT_QA_LIVE_TIMEOUT_MS ?? 120_000);
  const { context, page, errors } = await newPage(browser, target, { live: true });
  try {
    await gotoChat(page, target, session, "domcontentloaded");
    await page.waitForSelector("#chat-shell", { timeout: 15_000 });
    await wait(800);

    const before = await page.evaluate(() => document.querySelectorAll(".message").length);
    const beforeAssistants = await page.evaluate(
      () => document.querySelectorAll(".message:not(.message--user):not(.message--system)").length,
    );
    const prompt = page.locator("#chat-prompt");
    await prompt.fill(promptText);
    await prompt.press("Enter");
    await page.waitForFunction(
      (previous) =>
        document.querySelectorAll(".message").length > previous ||
        document.querySelector(".message--optimistic") !== null,
      before,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      (previous) =>
        document.querySelectorAll(".message:not(.message--user):not(.message--system)").length >
        previous,
      beforeAssistants,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => {
        const label = document.getElementById("chat-working-label");
        return label !== null && label.textContent === "Ready";
      },
      undefined,
      { timeout },
    );
    await wait(500);

    const summary = await page.evaluate(() => ({
      status: document.getElementById("chat-working-label")?.textContent ?? null,
      assistantLength: Array.from(
        document.querySelectorAll(
          ".message:not(.message--user):not(.message--system) .message__body",
        ),
      ).reduce((total, node) => total + (node.textContent ?? "").length, 0),
      tables: document.querySelectorAll(".message__table").length,
    }));
    check(summary.assistantLength > 0, "live assistant text rendered");
    check(summary.tables > 0, "live markdown table rendered");
    await shot(page, `live-${Date.now()}`);
    checkNoErrors(errors);
    return { prompt: promptText, summary, session };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runScenario(name, fn) {
  const started = Date.now();
  const entry = { name, status: "PASS", ms: 0, checks: [], data: null };
  activeChecks = entry.checks;
  try {
    entry.data = await fn();
  } catch (error) {
    entry.status = "FAIL";
    entry.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report.status = "FAIL";
    throw error;
  } finally {
    entry.ms = Date.now() - started;
    report.scenarios.push(entry);
  }
}

function writeReport() {
  report.finishedAt = new Date().toISOString();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

let browser;
let server;
try {
  mkdirSync(ARTIFACTS, { recursive: true });
  const target = await resolveTarget();
  report.baseUrl = target.baseUrl;
  server = target.server;
  browser = await chromium.launch(findChromium() ? { executablePath: findChromium() } : {});

  if (LIVE) {
    await runScenario("live-smoke", () => scenarioLive(browser, target));
  } else {
    const run = (name, fn) =>
      CHAT_QA_ONLY.length === 0 || CHAT_QA_ONLY.includes(name)
        ? runScenario(name, fn)
        : Promise.resolve();
    await run("main", () => scenarioMain(browser, target));
    await run("questions", () => scenarioQuestions(browser, target));
    await run("send", () => scenarioSend(browser, target));
    await run("commands-palette", () => scenarioCommandsPalette(browser, target));
    await run("commands-shell-confirm", () => scenarioCommandsShellConfirm(browser, target));
    await run("commands-shell-unknown", () => scenarioCommandsShellUnknown(browser, target));
    await run("commands-stale-400", () => scenarioCommandsStale400(browser, target));
    await run("commands-unknown-literal", () => scenarioCommandsUnknownLiteral(browser, target));
    await run("commands-master", () => scenarioCommandsMaster(browser, target));
    await run("commands-popup", () => scenarioCommandsPopup(browser, target));
    await run("commands-widths", () => scenarioCommandsWidths(browser, target));
    await run("context-states", () => scenarioContextStates(browser, target));
    await run("context-live", () => scenarioContextLive(browser, target));
    await run("context-compact", () => scenarioContextCompact(browser, target));
    await run("context-switch-race", () => scenarioContextSwitchRace(browser, target));
    await run("context-retry", () => scenarioContextRetry(browser, target));
    await run("diffs", () => scenarioDiffs(browser, target));
    await run("read", () => scenarioRead(browser, target));
    await run("diff-error", () => scenarioDiffError(browser, target));
    await run("diff-lazy", () => scenarioDiffLazy(browser, target));
    await run("diff-streaming", () => scenarioDiffStreaming(browser, target));
    await run("diff-adversarial", () => scenarioDiffAdversarial(browser, target));
    await run("diff-timeout", () => scenarioDiffTimeout(browser, target));
    await run("mobile-composer", () => scenarioMobileComposer(browser, target));
    await run("plan-visibility", () => scenarioPlanVisibility(browser, target));
    await run("reasoning", () => scenarioReasoning(browser, target));
    await run("stop", () => scenarioStop(browser, target));
    await run("reconnect", () => scenarioReconnect(browser, target));
    await run("session-tree", () => scenarioSessionTree(browser, target));
    await run("image-not-ready", () => scenarioImageNotReady(browser, target));
    await run("image-building", () => scenarioImageBuilding(browser, target));
    await run("image-build-error", () => scenarioImageBuildError(browser, target));
    await run("image-warning", () => scenarioImageWarning(browser, target));
    await run("image-actions", () => scenarioImageActions(browser, target));
    await run("image-panels", () => scenarioImagePanels(browser, target));
  }
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`\nFAIL ${report.mode} chat QA`);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
  writeReport();
}

if (report.status === "PASS") {
  const assertions = report.scenarios.reduce((total, entry) => total + entry.checks.length, 0);
  console.log(`\nPASS ${report.mode} chat QA`);
  console.log(
    `  ${report.scenarios.length} scenario(s), ${assertions} assertion(s), ` +
      `${report.screenshots.length} screenshot(s), zero console/page errors`,
  );
  console.log(`  report: ${relative(REPORT_PATH)}`);
} else {
  console.error(`\nreport: ${relative(REPORT_PATH)}`);
}
