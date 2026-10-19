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
const LIVE = process.argv.includes("--live");

const EXTERNAL_URL = process.env.CHAT_QA_URL;
const EXTERNAL_TOKEN = process.env.CHAT_QA_TOKEN;

const THREADS = {
  main: "ses_main",
  questions: "ses_questions",
  send: "ses_send",
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
  mode: LIVE ? "live" : "deterministic",
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

async function emit(page, payload) {
  await page.evaluate((event) => {
    const source = window.__qaEventSource;
    if (!source) throw new Error("FakeEventSource is not installed");
    source.emit(event);
  }, payload);
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
      "name: Chat QA",
      "base_branch: main",
      "apps:",
      `  - path: ${APP}`,
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
      window.setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        this.emit({ type: "stream.ready", seq: 0, streamID: "qa-stream" });
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

async function newPage(browser, target, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: options.colorScheme ?? "dark",
    reducedMotion: options.reducedMotion ?? "no-preference",
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
  await page.goto(`${target.baseUrl}/chat?${query.toString()}`, { waitUntil });
}

async function installRoutes(page, config) {
  const state = {
    postCalls: 0,
    postBodies: [],
    replyBody: null,
    replyCount: 0,
    promptQuestions: config.promptQuestions ?? [],
    messageGets: [],
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
      return json(route, { sessions: sessions() });
    }
    if (pathname.endsWith("/sessions") && method === "POST") {
      return json(route, { id: config.sessionId, title: "Chat QA", time: { updated: Date.now() } });
    }
    if (pathname.endsWith("/prompts") && method === "GET") {
      return json(route, { questions: prompts(state), permissions: [] });
    }
    if (pathname.endsWith("/permissions/saved") && method === "GET") {
      return json(route, { permissions: [] });
    }
    if (pathname.endsWith("/todo") && method === "GET") {
      return json(route, { todos: config.todos ?? [], truncated: false });
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

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Live smoke (real managed app)
// ---------------------------------------------------------------------------

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
    await runScenario("main", () => scenarioMain(browser, target));
    await runScenario("questions", () => scenarioQuestions(browser, target));
    await runScenario("send", () => scenarioSend(browser, target));
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
