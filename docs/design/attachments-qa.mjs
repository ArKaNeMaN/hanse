#!/usr/bin/env node
/*
 * Deterministic browser QA for Stage C inline/projected chat attachments (plan 0026).
 *
 * Usage:
 *   node docs/design/attachments-qa.mjs
 *
 * The harness starts the real coordinator (`node dist/index.js serve`) against a
 * temporary workspace/state, then serves the real chat page while every
 * `/api/apps/**` call is deterministically fulfilled by `page.route`. No real
 * deployment state, token, project, app, or attachment is touched.
 *
 * Playwright and Chromium are resolved exactly like `docs/design/chat-qa.mjs`.
 * Missing Playwright/Chromium is a blocked gate (exit 1), not a skip.
 *
 * Evidence is written to `docs/design/artifacts/attachments/` as screenshots,
 * `report.json`, and `report.md`. The command exits 1 on the first failed
 * assertion, unexpected console error, page error, or failed network request.
 *
 * Set ATTACHMENTS_QA_COLLECT=1 to keep running the remaining scenarios after a
 * failure (the QA evidence run). The process still exits 1 at the end.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const ARTIFACTS = path.join(SCRIPT_DIR, "artifacts", "attachments");
const REPORT_JSON = path.join(ARTIFACTS, "report.json");
const REPORT_MD = path.join(ARTIFACTS, "report.md");

const APP = "storefront";
// Fake fixture project id (UUID so the real page renders the temp manifest), never a real project.
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = process.env.ATTACHMENTS_QA_TOKEN ?? "qa-token";
const COLLECT = process.env.ATTACHMENTS_QA_COLLECT === "1";

// 1x1 transparent PNG used for both upload fixtures and the download route.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");
const CSV = Buffer.from("name,value\nalpha,1\nbeta,2\n", "utf8");
const PDF = Buffer.from("%PDF-1.4\n% attachment qa fixture\n", "utf8");

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

// ---------------------------------------------------------------------------
// Playwright resolution (same optional-install resolver as chat-qa.mjs)
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
    "attachments-qa: Playwright not found. Run `npx playwright --version` once, set " +
      "PLAYWRIGHT_CHROMIUM to a Chromium binary, or install Playwright globally.",
  );
  process.exit(1);
}

const chromiumPath = findChromium();
if (!chromiumPath) {
  console.error(
    "attachments-qa: Chromium not found. Set PLAYWRIGHT_CHROMIUM=/usr/bin/chromium or install " +
      "the Playwright Chromium build.",
  );
  process.exit(1);
}

const { chromium } = await import(`file://${modulePath}`);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const report = {
  tool: "attachments-qa",
  mode: "deterministic",
  collect: COLLECT,
  startedAt: new Date().toISOString(),
  status: "PASS",
  baseUrl: null,
  app: APP,
  project: PROJECT_ID,
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
  networkFailures: [],
  expectedHttpErrors: [],
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

async function waitFor(predicate, label, timeout = 5_000, interval = 50) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(interval);
  }
}

function relative(file) {
  return path.relative(ROOT, file);
}

/** Keep QA evidence free of absolute workspace paths and ephemeral test ports. */
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

function errorBody(error, code) {
  return { error, code };
}

function assertClean(errors, networkFailures, allowedStatuses = []) {
  const allowed = allowedStatuses.map((status) => new RegExp(`status of ${status}\\b`));
  const unexpected = errors.filter((entry) => !allowed.some((pattern) => pattern.test(entry)));
  const expected = errors.filter((entry) => allowed.some((pattern) => pattern.test(entry)));
  report.expectedHttpErrors.push(...expected);
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

// ---------------------------------------------------------------------------
// Server lifecycle (real page/assets, deterministic API)
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

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `attachments-qa: server exited with code ${child.exitCode} before it was ready.\n${logs()}`,
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
      throw new Error(`attachments-qa: server did not become ready at ${baseUrl}.\n${logs()}`);
    }
    await wait(100);
  }
}

async function startServer() {
  const dist = path.join(ROOT, "dist", "index.js");
  if (!existsSync(dist)) {
    throw new Error(
      [
        "attachments-qa: dist/index.js is missing, so the harness cannot self-start a server.",
        "Fix: run `npm run build`, then re-run `node docs/design/attachments-qa.mjs`.",
      ].join("\n"),
    );
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "hanse-attachments-qa-"));
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
      "name: Attachments QA",
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

// ---------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------

function installFakeEventSource() {
  class FakeEventSource {
    constructor() {
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
  await context.addInitScript(installFakeEventSource);

  const errors = [];
  const networkFailures = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    networkFailures.push(
      `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
  return { context, page, errors, networkFailures };
}

async function gotoChat(page, target, sessionId, waitUntil = "domcontentloaded") {
  const query = new URLSearchParams({ app: APP, project: PROJECT_ID });
  if (sessionId) query.set("session", sessionId);
  await page.goto(`${target.baseUrl}/chat?${query.toString()}`, { waitUntil });
  await page.waitForSelector("#chat-attach-input", { state: "attached", timeout: 15_000 });
}

async function chipState(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#chat-attachments .chat-attachment")).map((node) => {
      const progress = node.querySelector(".chat-attachment__progress");
      const mode = node.querySelector("select.chat-attachment__mode-select");
      const remove = node.querySelector(".chat-attachment__remove");
      return {
        name: node.querySelector(".chat-attachment__name")?.textContent ?? "",
        status: node.dataset.status ?? "",
        kind: node.dataset.kind ?? "",
        mode: mode === null ? null : mode.value,
        removeDisabled: remove === null ? null : remove.disabled,
        removeTitle: remove === null ? null : remove.title,
        progress:
          progress === null
            ? null
            : {
                role: progress.getAttribute("role"),
                now: progress.getAttribute("aria-valuenow"),
                min: progress.getAttribute("aria-valuemin"),
                max: progress.getAttribute("aria-valuemax"),
                label: progress.getAttribute("aria-label"),
              },
      };
    }),
  );
}

async function waitForChip(page, name) {
  await page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll("#chat-attachments .chat-attachment")).some(
        (node) =>
          node.dataset.status === "ready" &&
          (node.querySelector(".chat-attachment__name")?.textContent ?? "") === needle,
      ),
    name,
    { timeout: 8_000 },
  );
}

const FILE_FIXTURES = {
  "design.png": { mimeType: "image/png", buffer: PNG },
  "notes.csv": { mimeType: "text/csv", buffer: CSV },
  "brief.pdf": { mimeType: "application/pdf", buffer: PDF },
};

async function attachViaInput(page, name) {
  const fixture = FILE_FIXTURES[name];
  await page.setInputFiles("#chat-attach-input", {
    name,
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
}

async function attachViaDrop(page, name) {
  const fixture = FILE_FIXTURES[name];
  await page.evaluate(
    ({ fileName, mimeType, base64 }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: mimeType }));
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      const composer = document.getElementById("chat-composer");
      if (composer === null) throw new Error("composer missing");
      composer.dispatchEvent(event);
    },
    { fileName: name, mimeType: fixture.mimeType, base64: fixture.buffer.toString("base64") },
  );
}

async function attachViaPaste(page, name) {
  const fixture = FILE_FIXTURES[name];
  await page.evaluate(
    ({ fileName, mimeType, base64 }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: mimeType }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      const prompt = document.getElementById("chat-prompt");
      if (prompt === null) throw new Error("prompt missing");
      prompt.dispatchEvent(event);
    },
    { fileName: name, mimeType: fixture.mimeType, base64: fixture.buffer.toString("base64") },
  );
}

// ---------------------------------------------------------------------------
// Deterministic API fixture
// ---------------------------------------------------------------------------

// These fixture ids are QA-only; they never touch a real project or session.
const S = {
  main: "ses_qa",
  send: "ses_send",
  fileOnly: "ses_fileonly",
  remove: "ses_remove",
  uploading: "ses_uploading",
  foreign: "ses_foreign",
  missing: "ses_missing",
  title: "ses_title",
  raceA: "ses_race_a",
  raceB: "ses_race_b",
  visual: "ses_visual",
  inline: "ses_inline",
  downgrade: "ses_downgrade",
  redeliver: "ses_redeliver",
  stream: "ses_stream",
  limit: "ses_stream_limit",
};

function emptyDraft() {
  return { text: "", attachments: [], pendingSends: [] };
}

function createFixture(options = {}) {
  const fixture = {
    sessions: (options.sessions ?? [{ id: S.main, title: "Attachment QA" }]).map((session) => ({
      ...session,
    })),
    drafts: new Map(),
    messages: new Map(),
    attachments: new Map(),
    seq: { attachment: 0, session: 0, message: 0, delivery: 0 },
    config: {
      uploadDelayMs: 0,
      titleRequired: false,
      sendError: null,
      deleteIfEmptyResult: null,
      // Stage C: warnings returned by the async 202 send and whether the fake
      // backend downgrades an inline request to a file-only delivery.
      sendWarnings: [],
      forceDeliveryFile: false,
      // Stage C: `/events` answers 429 stream_limit (the ninth browser stream).
      streamLimit: false,
      ...(options.config ?? {}),
    },
    calls: {
      sessionGets: 0,
      sessionResponses: [],
      sessionPosts: [],
      messageGets: [],
      messagePosts: [],
      draftGets: [],
      draftPuts: [],
      patches: [],
      deletes: [],
      deleteIfEmpty: [],
      uploads: [],
      downloads: [],
      touches: 0,
      eventGets: 0,
    },
  };
  for (const session of fixture.sessions) {
    fixture.drafts.set(session.id, emptyDraft());
    fixture.messages.set(session.id, []);
  }
  for (const [sessionId, text] of Object.entries(options.texts ?? {})) {
    ensureDraft(fixture, sessionId).text = text;
  }
  return fixture;
}

function ensureDraft(fixture, sessionId) {
  let draft = fixture.drafts.get(sessionId);
  if (draft === undefined) {
    draft = emptyDraft();
    fixture.drafts.set(sessionId, draft);
  }
  return draft;
}

function ensureMessages(fixture, sessionId) {
  let messages = fixture.messages.get(sessionId);
  if (messages === undefined) {
    messages = [];
    fixture.messages.set(sessionId, messages);
  }
  return messages;
}

function nextAttachmentID(fixture) {
  fixture.seq.attachment += 1;
  return fixture.seq.attachment === 1 ? "att_qa" : `att_qa_${fixture.seq.attachment}`;
}

function kindForMime(mime) {
  const value = typeof mime === "string" ? mime.toLowerCase() : "";
  if (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/gif" ||
    value === "image/webp"
  ) {
    return "image";
  }
  if (value.startsWith("video/")) return "video";
  if (value === "application/pdf") return "pdf";
  return "file";
}

function attachmentView(record) {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    kind: record.kind,
    mode: record.mode,
    state: record.missing ? "missing" : record.state,
    downloadURL: `/api/apps/${APP}/attachments/${record.id}?project=${PROJECT_ID}`,
    inline: record.inline === true || record.mode === "inline",
  };
}

function seedAttachment(fixture, sessionId, options) {
  const id = nextAttachmentID(fixture);
  const mime = options.mime;
  const record = {
    id,
    sessionID: sessionId,
    name: options.name,
    mime,
    size: options.size ?? 1,
    kind: kindForMime(mime),
    mode: options.mode ?? "auto",
    state: options.state ?? "draft",
    missing: options.missing === true,
    inline: options.inline === true,
  };
  fixture.attachments.set(id, record);
  ensureDraft(fixture, sessionId).attachments.push(record);
  return record;
}

function draftPayload(fixture, sessionId) {
  const draft = ensureDraft(fixture, sessionId);
  return {
    text: draft.text,
    attachments: draft.attachments.map(attachmentView),
    pendingSends: draft.pendingSends,
    quota: { percent: 1 },
    updatedAt: new Date().toISOString(),
  };
}

function sessionsPayload(fixture) {
  const sessions = fixture.sessions.map((session) => {
    const draft = ensureDraft(fixture, session.id);
    const history = fixture.messages.get(session.id) ?? [];
    const hasText = draft.text.trim().length > 0;
    const attachmentCount = draft.attachments.length;
    const present = hasText || attachmentCount > 0;
    return {
      ...session,
      draft: {
        hasText,
        attachmentCount,
        emptyDraft: present && history.length === 0,
        updatedAt: new Date().toISOString(),
      },
    };
  });
  return { sessions };
}

function attachmentFilename(headers) {
  const disposition = headers["content-disposition"] ?? "";
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1]);
    } catch (error) {
      void error;
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition) ?? /filename=([^;]+)/i.exec(disposition);
  return plain === null ? "attachment" : plain[1].trim();
}

function manifestText(sessionId, deliveries) {
  const lines = deliveries.map(
    ({ record, mode }) =>
      `- <model-visible-root>/attachments/${sessionId}/${record.id}-${record.name} ` +
      `(${record.mime}, ${record.size} B, ${mode})`,
  );
  return [
    'Attached files (use these paths with your tools; "inline" files were also sent to you):',
    ...lines,
  ].join("\n");
}

/**
 * Append one operator message for a completed send. Each delivery carries its effective mode and
 * whether the backend projected an inline `file` part. Inline parts use the short download URL
 * only; no `data:` URL ever enters the fixture history.
 */
function appendSentHistory(fixture, sessionId, messageID, text, deliveries) {
  const views = [];
  const parts = [];
  if (typeof text === "string" && text.length > 0) {
    parts.push({
      id: `prt_${messageID}_text`,
      sessionID: sessionId,
      messageID,
      type: "text",
      text,
    });
  }
  for (const delivery of deliveries) {
    const { record, mode, inline } = delivery;
    const view = { ...attachmentView(record), state: "sent", mode, inline };
    views.push(view);
    if (inline === true) {
      fixture.seq.delivery += 1;
      parts.push({
        id: `prt_att_${record.id}_${fixture.seq.delivery}`,
        sessionID: sessionId,
        messageID,
        type: "file",
        mime: record.mime,
        filename: record.name,
        url: view.downloadURL,
        attachment: {
          id: record.id,
          size: record.size,
          mode: "inline",
          kind: record.kind,
          inline: true,
        },
      });
    }
  }
  parts.push({
    id: `prt_${messageID}_manifest`,
    sessionID: sessionId,
    messageID,
    type: "text",
    synthetic: true,
    metadata: { hanse: "attachment-manifest" },
    text: manifestText(sessionId, deliveries),
  });
  const message = {
    info: {
      id: messageID,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      hanse: { attachments: views },
    },
    parts,
  };
  ensureMessages(fixture, sessionId).push(message);
  return message;
}

/** Seed a sent (non-draft) attachment plus its projected history message. */
function seedSentHistory(fixture, sessionId, options) {
  const record = {
    id: nextAttachmentID(fixture),
    sessionID: sessionId,
    name: options.name,
    mime: options.mime,
    size: options.size ?? 1,
    kind: kindForMime(options.mime),
    mode: options.mode ?? "inline",
    state: "sent",
    missing: false,
    inline: options.mode !== "file",
  };
  fixture.attachments.set(record.id, record);
  fixture.seq.message += 1;
  const messageID = `msg_seed_${fixture.seq.message}`;
  const message = appendSentHistory(fixture, sessionId, messageID, options.text ?? "", [
    { record, mode: record.mode, inline: record.inline },
  ]);
  return { record, messageID, message };
}

/** Seed one plain history message (used by the stream-recovery scenarios). */
function seedHistoryMessage(fixture, sessionId, options) {
  const id = options.id;
  const partID = options.partID ?? `prt_${id}_text`;
  const message = {
    info: {
      id,
      sessionID: sessionId,
      role: options.role ?? "assistant",
      time: { created: Date.now() },
    },
    parts: [
      {
        id: partID,
        sessionID: sessionId,
        messageID: id,
        type: "text",
        text: options.text ?? "",
      },
    ],
  };
  ensureMessages(fixture, sessionId).push(message);
  return { messageID: id, partID, message };
}

function contextSnapshot(sessionId) {
  return {
    sessionID: sessionId,
    state: "ready",
    used: 12000,
    limit: 200000,
    percent: 6,
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    status: "idle",
    updatedAt: new Date().toISOString(),
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: true, percent: 80, source: "app", percentSource: "global" },
  };
}

async function installFixtureRoutes(page, fixture) {
  await page.route("**/api/apps/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const prefix = `/api/apps/${APP}`;
    const rel = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;

    const sessionFor = (suffix) => {
      const match = new RegExp(`^/sessions/([^/]+)/${suffix}$`).exec(rel);
      return match === null ? null : decodeURIComponent(match[1]);
    };

    // Upload (raw body, Content-Disposition filename, 201 attachment + quota).
    if (rel === "/attachments" && method === "POST") {
      const sessionID = url.searchParams.get("session") ?? "";
      const headers = request.headers();
      const name = attachmentFilename(headers);
      const mime = headers["content-type"] ?? "application/octet-stream";
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const delay = fixture.config.uploadDelayMs;
      if (delay > 0) await wait(delay);
      const id = nextAttachmentID(fixture);
      const record = {
        id,
        sessionID,
        name,
        mime,
        size: body.length,
        kind: kindForMime(mime),
        mode: "auto",
        state: "draft",
        missing: false,
        inline: false,
      };
      fixture.attachments.set(id, record);
      ensureDraft(fixture, sessionID).attachments.push(record);
      fixture.calls.uploads.push({ sessionID, name, mime, size: body.length, id });
      return json(route, { attachment: attachmentView(record), quota: { percent: 1 } }, 201);
    }

    // Download / PATCH / DELETE one attachment.
    if (rel.startsWith("/attachments/") && method !== "POST") {
      const id = decodeURIComponent(rel.slice("/attachments/".length));
      const record = fixture.attachments.get(id);
      if (record === undefined) {
        return json(route, errorBody("Attachment not found.", "attachment_not_found"), 404);
      }
      if (method === "GET") {
        fixture.calls.downloads.push(id);
        const body =
          record.kind === "image"
            ? PNG
            : record.mime === "application/pdf"
              ? PDF
              : Buffer.from("fixture");
        return route.fulfill({ status: 200, contentType: record.mime, body });
      }
      if (method === "PATCH") {
        let body = {};
        try {
          body = JSON.parse(request.postData() ?? "{}");
        } catch (error) {
          void error;
        }
        record.mode = body.mode === "file" || body.mode === "inline" ? body.mode : "auto";
        fixture.calls.patches.push({ id, mode: record.mode, body });
        return json(route, attachmentView(record));
      }
      if (method === "DELETE") {
        for (const draft of fixture.drafts.values()) {
          draft.attachments = draft.attachments.filter((candidate) => candidate.id !== id);
        }
        fixture.calls.deletes.push(id);
        return json(route, { deleted: true });
      }
    }

    if (rel === "/events" && method === "GET") {
      fixture.calls.eventGets += 1;
      if (fixture.config.streamLimit) {
        return json(route, errorBody("Too many live streams.", "stream_limit"), 429);
      }
      // The harness injects a FakeEventSource, so only the limit probe reaches this route.
      return json(route, {});
    }

    if (rel === "/sessions" && method === "GET") {
      const payload = sessionsPayload(fixture);
      fixture.calls.sessionGets += 1;
      fixture.calls.sessionResponses.push(payload);
      return json(route, payload);
    }

    if (rel === "/sessions" && method === "POST") {
      const raw = request.postData() ?? "{}";
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch (error) {
        void error;
      }
      fixture.seq.session += 1;
      const id = `ses_new_${fixture.seq.session}`;
      const session = {
        id,
        title: typeof body.title === "string" && body.title.length > 0 ? body.title : "Generated",
        time: { updated: Date.now() },
      };
      fixture.sessions.push(session);
      fixture.drafts.set(id, emptyDraft());
      fixture.messages.set(id, []);
      fixture.calls.sessionPosts.push({ body, raw });
      return json(route, session);
    }

    const draftSession = sessionFor("draft");
    if (draftSession !== null) {
      if (method === "GET") {
        fixture.calls.draftGets.push(draftSession);
        return json(route, draftPayload(fixture, draftSession));
      }
      if (method === "PUT") {
        let body = {};
        try {
          body = JSON.parse(request.postData() ?? "{}");
        } catch (error) {
          void error;
        }
        const draft = ensureDraft(fixture, draftSession);
        draft.text = typeof body.text === "string" ? body.text : "";
        fixture.calls.draftPuts.push({ sessionID: draftSession, text: draft.text, body });
        return json(route, { text: draft.text, updatedAt: new Date().toISOString() });
      }
    }

    const messageSession = sessionFor("messages");
    if (messageSession !== null) {
      if (method === "GET") {
        fixture.calls.messageGets.push(messageSession);
        return json(route, { messages: ensureMessages(fixture, messageSession) });
      }
      if (method === "POST") {
        let body = {};
        try {
          body = JSON.parse(request.postData() ?? "{}");
        } catch (error) {
          void error;
        }
        fixture.calls.messagePosts.push({ sessionID: messageSession, body });

        if (fixture.config.sendError !== null) {
          return json(route, fixture.config.sendError.body, fixture.config.sendError.status);
        }
        if (fixture.config.titleRequired) {
          return json(
            route,
            errorBody("A title is required before sending attachments.", "title_required"),
            409,
          );
        }

        const refs = Array.isArray(body.attachments) ? body.attachments : [];
        const draft = ensureDraft(fixture, messageSession);
        const records = [];
        const requestedModes = [];
        for (const ref of refs) {
          const id = ref !== null && typeof ref === "object" ? ref.id : null;
          const requested = ref !== null && typeof ref === "object" ? ref.mode : undefined;
          let record = draft.attachments.find((candidate) => candidate.id === id);
          if (record === undefined) {
            // Sent attachments can be redelivered without touching the old message.
            const sent = fixture.attachments.get(id);
            if (sent !== undefined && sent.sessionID === messageSession && sent.state === "sent") {
              record = sent;
            }
          }
          if (record === undefined) {
            return json(route, errorBody("Attachment not found.", "attachment_not_found"), 404);
          }
          if (record.missing) {
            return json(
              route,
              errorBody("The attachment file is missing.", "attachment_missing"),
              409,
            );
          }
          if (record.state === "in_flight") {
            return json(
              route,
              errorBody("The attachment is still sending.", "attachment_in_flight"),
              409,
            );
          }
          records.push(record);
          requestedModes.push(requested === "inline" || requested === "file" ? requested : "auto");
        }

        fixture.seq.message += 1;
        const messageID = `msg_qa_${fixture.seq.message}`;
        const text = typeof body.text === "string" ? body.text : "";
        const deliveries = records.map((record, index) => {
          const requested = requestedModes[index];
          // `auto` is file-only in this deterministic Stage B-compatible fixture; explicit
          // `inline` is only honoured when the scenario does not force a downgrade.
          const mode =
            fixture.config.forceDeliveryFile || requested !== "inline" ? "file" : "inline";
          return { record, mode, inline: mode === "inline" };
        });
        draft.text = "";
        draft.attachments = draft.attachments.filter(
          (candidate) => !records.some((record) => record.id === candidate.id),
        );
        const sentMessage = appendSentHistory(fixture, messageSession, messageID, text, deliveries);
        const warnings =
          typeof fixture.config.sendWarnings === "function"
            ? fixture.config.sendWarnings({ body, deliveries, message: sentMessage })
            : fixture.config.sendWarnings;
        return json(
          route,
          {
            accepted: true,
            messageID,
            sessionID: messageSession,
            ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
          },
          202,
        );
      }
    }

    if (sessionFor("touch") !== null && method === "POST") {
      fixture.calls.touches += 1;
      return json(route, { touched: true });
    }

    const deleteEmptySession = sessionFor("delete-if-empty");
    if (deleteEmptySession !== null && method === "POST") {
      fixture.calls.deleteIfEmpty.push(deleteEmptySession);
      const configured = fixture.config.deleteIfEmptyResult;
      const result = configured ?? { deleted: false, reason: "has_draft" };
      if (result.deleted === true) {
        fixture.sessions = fixture.sessions.filter((session) => session.id !== deleteEmptySession);
        fixture.drafts.delete(deleteEmptySession);
        fixture.messages.delete(deleteEmptySession);
      }
      return json(route, result);
    }

    const pendingSession = sessionFor("pending");
    if (pendingSession !== null) {
      return json(route, { ok: true });
    }

    const contextSession = sessionFor("context");
    if (contextSession !== null && method === "GET") {
      return json(route, contextSnapshot(contextSession));
    }
    const todoSession = sessionFor("todo");
    if (todoSession !== null && method === "GET") {
      return json(route, { todos: [], truncated: false });
    }
    const compactSession = sessionFor("compact");
    if (compactSession !== null && method === "POST") {
      return json(route, { accepted: true, sessionID: compactSession }, 202);
    }
    const commandSession = sessionFor("commands");
    if (commandSession !== null && method === "POST") {
      return json(route, { accepted: true, sessionID: commandSession }, 202);
    }
    const abortSession = sessionFor("abort");
    if (abortSession !== null && method === "POST") {
      return json(route, { aborted: true });
    }
    const deleteSession = /^\/sessions\/([^/]+)$/.exec(rel);
    if (deleteSession !== null && method === "DELETE") {
      return json(route, { deleted: true });
    }

    if (rel === "/prompts" && method === "GET") {
      return json(route, { questions: [], permissions: [] });
    }
    if (rel === "/permissions/saved" && method === "GET") {
      return json(route, { permissions: [] });
    }
    if (rel === "/previews" && method === "GET") {
      return json(route, { previews: [] });
    }
    if (rel === "/runtime" && method === "GET") {
      return json(route, { state: "running" });
    }
    if (rel === "/commands" && method === "GET") {
      return json(route, { sources: { hanse: "ok", opencode: "ok" }, warnings: [], commands: [] });
    }
    if (rel === "/ssh/approvals" && method === "GET") {
      return json(route, { approvals: [] });
    }

    return json(route, {});
  });

  return fixture;
}

// ---------------------------------------------------------------------------
// Scenario 1: attach controls, upload progress/aria, chips survive reload
// ---------------------------------------------------------------------------

async function scenarioAttachControls(browser, target) {
  const fixture = createFixture({ sessions: [{ id: S.main, title: "Attachments" }] });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.main);
    await page.waitForSelector("#chat-sessions .session-item");

    fixture.config.uploadDelayMs = 700;
    await attachViaInput(page, "design.png");
    await page.waitForSelector('#chat-attachments .chat-attachment[data-status="uploading"]', {
      timeout: 3_000,
    });
    const uploading = await chipState(page);
    const progress = uploading[0]?.progress;
    check(progress !== null, "uploading chip exposes a progressbar");
    assertEqual(progress.role, "progressbar", "progressbar role");
    assertEqual(progress.min, "0", "progressbar minimum");
    assertEqual(progress.max, "100", "progressbar maximum");
    check(
      progress.now !== null && Number.isFinite(Number(progress.now)),
      `progressbar has a numeric aria-valuenow (${progress.now})`,
    );
    check(
      typeof progress.label === "string" && progress.label.startsWith("Uploading"),
      "progressbar has an accessible uploading label",
    );
    check(
      uploading[0].removeDisabled === true && uploading[0].removeTitle.includes("Wait"),
      "an uploading chip cannot be removed",
    );
    await shot(page, "attachments-uploading-1440-dark");
    await waitForChip(page, "design.png");
    fixture.config.uploadDelayMs = 0;

    await attachViaDrop(page, "notes.csv");
    await waitForChip(page, "notes.csv");
    await attachViaPaste(page, "brief.pdf");
    await waitForChip(page, "brief.pdf");

    // The visible attach button opens the hidden input's file chooser.
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 });
    await page.click("#chat-attach");
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "button.pdf", mimeType: "application/pdf", buffer: PDF });
    await waitForChip(page, "button.pdf");

    let chips = await chipState(page);
    assertEqual(
      chips.map((chip) => chip.name),
      ["design.png", "notes.csv", "brief.pdf", "button.pdf"],
      "attach button, input, drag/drop, and paste each created a chip",
    );
    check(
      chips.every((chip) => chip.status === "ready"),
      "every chip completed its upload",
    );

    // Stage B PATCH returns the attachment view directly.
    const modeSelect = page
      .locator('#chat-attachments .chat-attachment[data-kind="image"] select')
      .first();
    await modeSelect.selectOption("file");
    await waitFor(() => fixture.calls.patches.length === 1, "attachment PATCH");
    assertEqual(fixture.calls.patches[0].id, "att_qa", "PATCH targets the image attachment");
    assertEqual(fixture.calls.patches[0].mode, "file", "PATCH sends the selected mode");
    chips = await chipState(page);
    assertEqual(chips[0].mode, "file", "chip reflects the patched mode");

    // GET /sessions carries draft.attachmentCount and the rail shows Draft.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => {
      const last = fixture.calls.sessionResponses.at(-1);
      return last?.sessions?.[0]?.draft?.attachmentCount === 4;
    }, "GET /sessions draft.attachmentCount");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#chat-sessions .session-item__flag")).some(
          (node) => (node.textContent ?? "").trim() === "Draft",
        ),
      undefined,
      { timeout: 5_000 },
    );

    const draftGetsBeforeReload = fixture.calls.draftGets.length;
    await gotoChat(page, target, S.main);
    await waitFor(
      () => fixture.calls.draftGets.length > draftGetsBeforeReload,
      "GET /draft after reload",
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#chat-attachments .chat-attachment[data-status='ready']")
          .length === 4,
      undefined,
      { timeout: 8_000 },
    );
    chips = await chipState(page);
    assertEqual(
      chips.map((chip) => chip.name),
      ["design.png", "notes.csv", "brief.pdf", "button.pdf"],
      "chips survive reload from GET /draft",
    );
    await shot(page, "attachments-chips-1440-dark");

    assertClean(errors, networkFailures);
    return {
      uploads: fixture.calls.uploads,
      patches: fixture.calls.patches,
      draftGets: fixture.calls.draftGets.length,
      sessionDraft: fixture.calls.sessionResponses.at(-1)?.sessions?.[0]?.draft ?? null,
      progress,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: text+attachment and attachment-only send, cards, manifest hidden
// ---------------------------------------------------------------------------

async function scenarioSend(browser, target) {
  const fixture = createFixture({
    sessions: [
      { id: S.send, title: "Send QA" },
      { id: S.fileOnly, title: "File-only QA" },
    ],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.send);
    await page.waitForSelector("#chat-sessions .session-item");

    await attachViaInput(page, "design.png");
    await waitForChip(page, "design.png");
    await page.fill("#chat-prompt", "Look at this");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => {
      const last = fixture.calls.sessionResponses.at(-1);
      return last?.sessions?.[0]?.draft?.attachmentCount === 1;
    }, "GET /sessions draft attachment count before send");

    await page.click("#chat-send");
    await waitFor(() => fixture.calls.messagePosts.length === 1, "text+attachment send");
    const textSend = fixture.calls.messagePosts[0];
    assertEqual(textSend.body.text, "Look at this", "text send keeps the text");
    assertEqual(
      textSend.body.attachments,
      [{ id: "att_qa" }],
      "auto image send omits mode (Stage C server resolves it)",
    );
    await page.waitForSelector(".message--optimistic .message__attachments .attachment-card", {
      timeout: 5_000,
    });
    await page.waitForFunction(
      () => {
        const image = document.querySelector(".message--optimistic .attachment-card__thumb");
        return image?.complete === true && image.naturalWidth > 0;
      },
      undefined,
      { timeout: 5_000 },
    );
    const optimisticText = await page.evaluate(() => ({
      cards: document.querySelectorAll(".message--optimistic .attachment-card").length,
      name:
        document.querySelector(".message--optimistic .attachment-card__name")?.textContent ?? "",
      download:
        document
          .querySelector(".message--optimistic .attachment-card__download")
          ?.getAttribute("href") ?? null,
      text: document.querySelector(".message--optimistic .message__body")?.textContent ?? "",
    }));
    assertEqual(optimisticText.cards, 1, "optimistic row shows one attachment card");
    assertEqual(optimisticText.name, "design.png", "optimistic card name");
    check(
      typeof optimisticText.download === "string" &&
        optimisticText.download.includes("/attachments/att_qa"),
      "optimistic card has a download link",
    );
    check(optimisticText.text.includes("Look at this"), "optimistic row keeps the operator text");
    await shot(page, "attachments-send-text-1440-dark");

    // Reload from history: info.hanse.attachments renders; the manifest is hidden.
    await gotoChat(page, target, S.send);
    await page.waitForSelector(".message__attachments .attachment-card", { timeout: 8_000 });
    await page.waitForFunction(
      () => {
        const image = document.querySelector(".message__attachments .attachment-card__thumb");
        return image?.complete === true && image.naturalWidth > 0;
      },
      undefined,
      { timeout: 5_000 },
    );
    const history = await page.evaluate(() => ({
      cards: document.querySelectorAll(".message__attachments .attachment-card").length,
      name:
        document.querySelector(".message__attachments .attachment-card__name")?.textContent ?? "",
      download:
        document
          .querySelector(".message__attachments .attachment-card__download")
          ?.getAttribute("href") ?? null,
      manifestVisible: (document.getElementById("chat-messages")?.textContent ?? "").includes(
        "Attached files",
      ),
      thumb: (() => {
        const image = document.querySelector(".message__attachments .attachment-card__thumb");
        return image === null ? null : image.naturalWidth;
      })(),
    }));
    assertEqual(history.cards, 1, "history shows the attachment card");
    assertEqual(history.name, "design.png", "history card name");
    check(
      typeof history.download === "string" &&
        history.download.includes("/attachments/att_qa") &&
        history.download.includes(`project=${PROJECT_ID}`),
      "history card download link points at the download route",
    );
    check(history.thumb !== null && history.thumb > 0, "history image thumbnail loaded");
    check(history.manifestVisible === false, "synthetic attachment-manifest text is hidden");

    // Attachment-only send.
    await page.click(`#chat-sessions .session-item[data-session-id='${S.fileOnly}']`);
    await page.waitForFunction(
      (id) => document.getElementById("chat-session-id")?.title === id,
      S.fileOnly,
      { timeout: 8_000 },
    );
    await attachViaInput(page, "notes.csv");
    await waitForChip(page, "notes.csv");
    assertEqual(await page.inputValue("#chat-prompt"), "", "attachment-only composer is empty");
    await page.evaluate(() => {
      window.__qaSubmit = 0;
      document.getElementById("chat-composer")?.addEventListener(
        "submit",
        () => {
          window.__qaSubmit += 1;
        },
        true,
      );
    });
    // Expected: the Send button submits an attachment-only draft. The empty
    // `#chat-prompt` is `required`, so native form validation currently blocks
    // the submit event; record that observable failure and continue with Enter.
    await page.click("#chat-send");
    await wait(700);
    const buttonSubmitCount = await page.evaluate(() => window.__qaSubmit ?? -1);
    if (buttonSubmitCount === 0) {
      await page.focus("#chat-prompt");
      await page.keyboard.press("Enter");
    }
    await waitFor(() => fixture.calls.messagePosts.length === 2, "attachment-only send");
    const fileSend = fixture.calls.messagePosts[1];
    assertEqual(fileSend.body.text, "", "attachment-only send has empty text");
    assertEqual(
      fileSend.body.attachments,
      [{ id: "att_qa_2", mode: "file" }],
      "file-only kind send forces mode file",
    );
    await page.waitForSelector(".message--optimistic .message__attachments .attachment-card", {
      timeout: 5_000,
    });
    const optimisticFile = await page.evaluate(() => ({
      cards: document.querySelectorAll(".message--optimistic .attachment-card").length,
      name:
        document.querySelector(".message--optimistic .attachment-card__name")?.textContent ?? "",
      kind:
        document
          .querySelector(".message--optimistic .attachment-card")
          ?.getAttribute("data-kind") ?? null,
      download:
        document
          .querySelector(".message--optimistic .attachment-card__download")
          ?.getAttribute("href") ?? null,
    }));
    assertEqual(optimisticFile.cards, 1, "attachment-only optimistic card");
    assertEqual(optimisticFile.name, "notes.csv", "attachment-only card name");
    assertEqual(optimisticFile.kind, "file", "CSV renders as a file card");
    check(
      typeof optimisticFile.download === "string" &&
        optimisticFile.download.includes("/attachments/att_qa_2"),
      "attachment-only card has a download link",
    );
    await shot(page, "attachments-file-only-1440-dark");

    await gotoChat(page, target, S.fileOnly);
    await page.waitForSelector(".message__attachments .attachment-card", { timeout: 8_000 });
    const fileHistory = await page.evaluate(() => ({
      cards: document.querySelectorAll(".message__attachments .attachment-card").length,
      name:
        document.querySelector(".message__attachments .attachment-card__name")?.textContent ?? "",
      manifestVisible: (document.getElementById("chat-messages")?.textContent ?? "").includes(
        "Attached files",
      ),
      thumbs: document.querySelectorAll(".message__attachments .attachment-card__thumb").length,
    }));
    assertEqual(fileHistory.cards, 1, "file-only history strip renders");
    assertEqual(fileHistory.name, "notes.csv", "file-only history card name");
    assertEqual(fileHistory.thumbs, 0, "file-only card has no image thumbnail");
    check(fileHistory.manifestVisible === false, "file-only manifest is hidden");

    assertClean(errors, networkFailures);
    if (buttonSubmitCount === 0) {
      const failure = new Error(
        "Send button does not submit an attachment-only draft: the empty `#chat-prompt` " +
          "is `required`, so native form validation blocks the submit event " +
          `(observed ${buttonSubmitCount} submit events). Enter sends correctly; the ` +
          "attachment-only card path itself works.",
      );
      failure.details = {
        buttonSubmitCount,
        textSend: textSend.body,
        fileSend: fileSend.body,
        optimisticText,
        history,
        fileHistory,
      };
      throw failure;
    }
    return {
      textSend: textSend.body,
      fileSend: fileSend.body,
      optimisticText,
      history,
      fileHistory,
      buttonSubmitCount,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: remove chip, last-chip delete-if-empty, uploading blocks actions
// ---------------------------------------------------------------------------

async function scenarioRemoveAndBlocking(browser, target) {
  // Last-chip removal clears the draft and lets the server delete the empty session.
  const fixture = createFixture({
    sessions: [{ id: S.remove, title: "Remove QA" }],
    config: { deleteIfEmptyResult: { deleted: true } },
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.remove);
    await page.waitForSelector("#chat-sessions .session-item");

    await attachViaInput(page, "notes.csv");
    await waitForChip(page, "notes.csv");
    const remove = page.locator("#chat-attachments .chat-attachment__remove").first();
    await remove.click();
    await waitFor(() => fixture.calls.deletes.length === 1, "attachment DELETE");
    assertEqual(fixture.calls.deletes[0], "att_qa", "DELETE uses the attachment id");
    await page.waitForFunction(
      () => document.querySelectorAll("#chat-attachments .chat-attachment").length === 0,
      undefined,
      { timeout: 5_000 },
    );
    await shot(page, "attachments-remove-1440-dark");

    // Empty text + last chip removed: PUT draft "" then POST delete-if-empty.
    await waitFor(() => fixture.calls.draftPuts.some((call) => call.text === ""), "draft clear");
    await waitFor(
      () => fixture.calls.deleteIfEmpty.length === 1,
      "delete-if-empty after the last chip",
      6_000,
    );
    assertEqual(fixture.calls.deleteIfEmpty[0], S.remove, "delete-if-empty targets the session");
    await page.waitForFunction(
      () => document.getElementById("chat-session-id")?.textContent === "-",
      undefined,
      { timeout: 5_000 },
    );
    assertEqual(
      await page.textContent("#chat-session-title"),
      "New session",
      "clearing a draft session returns to the empty state",
    );
    assertClean(errors, networkFailures);
  } finally {
    await context.close();
  }

  // Uploading chip: remove is disabled, Send is blocked, and no message is posted.
  const uploadFixture = createFixture({
    sessions: [{ id: S.uploading, title: "Uploading QA" }],
    config: { uploadDelayMs: 2_000 },
  });
  const uploadPage = await newPage(browser, target);
  try {
    await installFixtureRoutes(uploadPage.page, uploadFixture);
    await gotoChat(uploadPage.page, target, S.uploading);
    await uploadPage.page.waitForSelector("#chat-sessions .session-item");
    await attachViaInput(uploadPage.page, "brief.pdf");
    await uploadPage.page.waitForSelector(
      '#chat-attachments .chat-attachment[data-status="uploading"]',
      { timeout: 3_000 },
    );
    const uploading = await chipState(uploadPage.page);
    check(uploading[0].removeDisabled === true, "uploading chip remove button is disabled");
    check(
      uploading[0].removeTitle.includes("Wait for the upload"),
      "uploading chip remove tooltip explains the wait",
    );
    await uploadPage.page.focus("#chat-prompt");
    await uploadPage.page.keyboard.press("Enter");
    await uploadPage.page.waitForFunction(
      () => {
        const error = document.getElementById("chat-send-error");
        return error !== null && error.hidden === false;
      },
      undefined,
      { timeout: 5_000 },
    );
    const sendError = (await uploadPage.page.textContent("#chat-send-error")) ?? "";
    check(
      sendError.includes("Wait for the attachments to finish uploading"),
      `uploading chip blocks Send (error: ${sendError})`,
    );
    assertEqual(uploadFixture.calls.messagePosts.length, 0, "uploading chip prevented the send");
    const sendDisabled = await uploadPage.page.evaluate(() => {
      const button = document.getElementById("chat-send");
      return button instanceof HTMLButtonElement
        ? { disabled: button.disabled, title: button.title }
        : null;
    });
    check(sendDisabled?.disabled === true, "Send button is disabled while uploading");
    check(
      (sendDisabled?.title ?? "").includes("Resolve the attachments"),
      "Send button explains the blocking attachment",
    );
    await shot(uploadPage.page, "attachments-uploading-block-1440-dark");
    await waitForChip(uploadPage.page, "brief.pdf");
    assertClean(uploadPage.errors, uploadPage.networkFailures);

    return {
      deletes: fixture.calls.deletes,
      draftPuts: fixture.calls.draftPuts,
      deleteIfEmpty: fixture.calls.deleteIfEmpty,
      sendError,
      sendDisabled,
      uploading,
    };
  } finally {
    await uploadPage.context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: foreign id 404 and missing file 409 surface on the client
// ---------------------------------------------------------------------------

async function scenarioForeignAndMissing(browser, target) {
  const fixture = createFixture({
    sessions: [
      { id: S.foreign, title: "Foreign QA" },
      { id: S.missing, title: "Missing QA" },
    ],
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.foreign);
    await page.waitForSelector("#chat-sessions .session-item");

    await attachViaInput(page, "notes.csv");
    await waitForChip(page, "notes.csv");
    const foreignRecord = fixture.attachments.get("att_qa");
    // Simulate the attachment belonging to another session: remove it from this draft.
    fixture.drafts.get(S.foreign).attachments = [];
    fixture.drafts.set("ses_other", emptyDraft());
    fixture.drafts.get("ses_other").attachments.push(foreignRecord);
    foreignRecord.sessionID = "ses_other";
    await page.focus("#chat-prompt");
    await page.keyboard.press("Enter");
    await waitFor(() => fixture.calls.messagePosts.length === 1, "foreign-id send");
    await page.waitForFunction(
      () => {
        const error = document.getElementById("chat-send-error");
        return error !== null && error.hidden === false;
      },
      undefined,
      { timeout: 5_000 },
    );
    const foreignError = (await page.textContent("#chat-send-error")) ?? "";
    check(
      foreignError.includes("attachment_not_found"),
      `foreign attachment id surfaces 404 attachment_not_found (${foreignError})`,
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#chat-attachments .chat-attachment").length === 1,
      undefined,
      { timeout: 5_000 },
    );
    check((await chipState(page)).length === 1, "foreign attachment 404 restores the chip");
    assertEqual(
      fixture.calls.messagePosts[0].body.attachments,
      [{ id: "att_qa", mode: "file" }],
      "foreign id was sent in the request body (file-only kind forces file)",
    );
    await shot(page, "attachments-foreign-404-1440-dark");

    // Missing file: the server reports attachment_missing before dispatch.
    await gotoChat(page, target, S.missing);
    await attachViaInput(page, "notes.csv");
    await waitForChip(page, "notes.csv");
    const missingRecord = fixture.attachments.get("att_qa_2");
    missingRecord.missing = true;
    await page.focus("#chat-prompt");
    await page.keyboard.press("Enter");
    await waitFor(() => fixture.calls.messagePosts.length === 2, "missing-file send");
    await page.waitForFunction(
      () => {
        const error = document.getElementById("chat-send-error");
        return error !== null && error.hidden === false;
      },
      undefined,
      { timeout: 5_000 },
    );
    const missingError = (await page.textContent("#chat-send-error")) ?? "";
    check(
      missingError.includes("attachment_missing"),
      `missing file surfaces attachment_missing (${missingError})`,
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#chat-attachments .chat-attachment").length === 1,
      undefined,
      { timeout: 5_000 },
    );
    check((await chipState(page)).length === 1, "attachment_missing 409 restores the chip");
    assertEqual(
      fixture.calls.messagePosts[1].body.attachments,
      [{ id: "att_qa_2", mode: "file" }],
      "missing file id was sent in the request body (file-only kind forces file)",
    );
    await shot(page, "attachments-missing-409-1440-dark");

    assertClean(errors, networkFailures, [404, 409]);
    return {
      foreignError,
      missingError,
      sends: fixture.calls.messagePosts.map((call) => call.body),
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: title contract (attachment-first, text-only, title_required)
// ---------------------------------------------------------------------------

async function scenarioTitle(browser, target) {
  let attachmentFirstBody = null;
  let textOnlyBody = null;
  // Attachment-first create sends {title:"Attachment"}.
  const attachmentFirst = createFixture({ sessions: [] });
  const first = await newPage(browser, target);
  try {
    await installFixtureRoutes(first.page, attachmentFirst);
    await gotoChat(first.page, target);
    await first.page.waitForFunction(
      () => document.getElementById("chat-session-id")?.textContent === "-",
      undefined,
      { timeout: 8_000 },
    );
    await attachViaInput(first.page, "design.png");
    await waitFor(
      () => attachmentFirst.calls.sessionPosts.length === 1,
      "attachment-first POST /sessions",
    );
    attachmentFirstBody = attachmentFirst.calls.sessionPosts[0].body;
    assertEqual(
      attachmentFirstBody,
      { title: "Attachment" },
      "attachment-first create sends the neutral title",
    );
    await waitForChip(first.page, "design.png");
    const created = await first.page.evaluate(() => ({
      id: document.getElementById("chat-session-id")?.title ?? "",
      text: document.getElementById("chat-session-id")?.textContent ?? "",
    }));
    check(created.id.startsWith("ses_new_"), "attachment-first upload used the created session");
    await shot(first.page, "attachments-title-create-1440-dark");
    assertClean(first.errors, first.networkFailures);
  } finally {
    await first.context.close();
  }

  // Text-only create still omits the title.
  const textOnly = createFixture({ sessions: [] });
  const second = await newPage(browser, target);
  try {
    await installFixtureRoutes(second.page, textOnly);
    await gotoChat(second.page, target);
    await second.page.fill("#chat-prompt", "Hello");
    await waitFor(
      () => textOnly.calls.sessionPosts.length === 1,
      "text-only POST /sessions",
      6_000,
    );
    textOnlyBody = textOnly.calls.sessionPosts[0].body;
    check(
      !("title" in textOnlyBody),
      `text-only create omits title (${JSON.stringify(textOnlyBody)})`,
    );
    await shot(second.page, "attachments-title-text-only-1440-dark");
    assertClean(second.errors, second.networkFailures);
  } finally {
    await second.context.close();
  }

  // 409 title_required is surfaced without losing the chip or draft text.
  const titleFixture = createFixture({
    sessions: [{ id: S.title, title: "Title QA" }],
    texts: { [S.title]: "keep me" },
  });
  seedAttachment(titleFixture, S.title, { name: "keep.png", mime: "image/png", size: PNG.length });
  titleFixture.config.titleRequired = true;
  const third = await newPage(browser, target);
  try {
    await installFixtureRoutes(third.page, titleFixture);
    await gotoChat(third.page, target, S.title);
    await waitForChip(third.page, "keep.png");
    assertEqual(await third.page.inputValue("#chat-prompt"), "keep me", "draft text restored");
    await third.page.click("#chat-send");
    await waitFor(() => titleFixture.calls.messagePosts.length === 1, "title_required send");
    await third.page.waitForFunction(
      () => {
        const error = document.getElementById("chat-send-error");
        return error !== null && error.hidden === false;
      },
      undefined,
      { timeout: 5_000 },
    );
    const titleError = (await third.page.textContent("#chat-send-error")) ?? "";
    check(titleError.includes("title_required"), `title_required is surfaced (${titleError})`);
    assertEqual(
      await third.page.inputValue("#chat-prompt"),
      "keep me",
      "failed send restored the draft text",
    );
    const restored = await chipState(third.page);
    assertEqual(restored.length, 1, "failed send restored the attachment chip");
    assertEqual(restored[0].name, "keep.png", "restored chip name");
    await shot(third.page, "attachments-title-required-1440-dark");
    assertClean(third.errors, third.networkFailures, [409]);
    return {
      attachmentFirst: attachmentFirstBody,
      textOnly: textOnlyBody,
      titleError,
      restored,
    };
  } finally {
    await third.context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 6: clear/auto-delete race with attach and upload
// ---------------------------------------------------------------------------

async function scenarioClearRace(browser, target) {
  const fixture = createFixture({
    sessions: [{ id: S.raceA, title: "Race A" }],
    texts: { [S.raceA]: "hello" },
  });
  const first = await newPage(browser, target);
  try {
    await installFixtureRoutes(first.page, fixture);
    await gotoChat(first.page, target, S.raceA);
    await first.page.waitForFunction(
      () => document.getElementById("chat-prompt")?.value === "hello",
      undefined,
      { timeout: 8_000 },
    );
    await first.page.fill("#chat-prompt", "");
    // Attach inside the 1 s delete-if-empty window.
    await attachViaInput(first.page, "notes.csv");
    await waitForChip(first.page, "notes.csv");
    await wait(1_400);
    assertEqual(
      fixture.calls.deleteIfEmpty.length,
      0,
      "attaching inside the window cancels delete-if-empty",
    );
    assertEqual(fixture.calls.uploads.length, 1, "the upload still ran");
    const stillOpen = await first.page.evaluate(() => ({
      id: document.getElementById("chat-session-id")?.title ?? "",
      short: document.getElementById("chat-session-id")?.textContent ?? "",
    }));
    assertEqual(stillOpen.id, S.raceA, "the session survived the race");
    check(stillOpen.short !== "-", "the composer did not reset to a new session");
    await shot(first.page, "attachments-clear-race-1440-dark");
    assertClean(first.errors, first.networkFailures);
  } finally {
    await first.context.close();
  }

  // Upload already in flight while the composer is cleared: no delete-if-empty.
  const fixtureB = createFixture({
    sessions: [{ id: S.raceB, title: "Race B" }],
    texts: { [S.raceB]: "hello" },
    config: { uploadDelayMs: 1_800 },
  });
  const second = await newPage(browser, target);
  try {
    await installFixtureRoutes(second.page, fixtureB);
    await gotoChat(second.page, target, S.raceB);
    await second.page.waitForFunction(
      () => document.getElementById("chat-prompt")?.value === "hello",
      undefined,
      { timeout: 8_000 },
    );
    await attachViaInput(second.page, "brief.pdf");
    await second.page.waitForSelector(
      '#chat-attachments .chat-attachment[data-status="uploading"]',
      { timeout: 3_000 },
    );
    await second.page.fill("#chat-prompt", "");
    await wait(1_400);
    assertEqual(
      fixtureB.calls.deleteIfEmpty.length,
      0,
      "upload-during-clear does not delete the session",
    );
    await waitForChip(second.page, "brief.pdf");
    assertEqual(
      await second.page.evaluate(() => document.getElementById("chat-session-id")?.title ?? ""),
      S.raceB,
      "session remains selected after upload-during-clear",
    );
    await shot(second.page, "attachments-upload-during-clear-1440-dark");
    assertClean(second.errors, second.networkFailures);
    return {
      raceA: { deleteIfEmpty: fixture.calls.deleteIfEmpty.length, uploads: fixture.calls.uploads },
      raceB: { deleteIfEmpty: fixtureB.calls.deleteIfEmpty.length },
    };
  } finally {
    await second.context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: responsive/visual, keyboard attach, reduced motion
// ---------------------------------------------------------------------------

async function visualFixture() {
  const fixture = createFixture({ sessions: [{ id: S.visual, title: "Visual QA" }] });
  seedAttachment(fixture, S.visual, {
    name: "design.png",
    mime: "image/png",
    size: PNG.length,
  });
  seedAttachment(fixture, S.visual, { name: "notes.csv", mime: "text/csv", size: CSV.length });
  return fixture;
}

async function scenarioResponsiveVisual(browser, target) {
  const views = [
    { width: 1440, height: 900, colorScheme: "dark" },
    { width: 1440, height: 900, colorScheme: "light" },
    { width: 390, height: 844, colorScheme: "dark" },
    { width: 390, height: 844, colorScheme: "light" },
  ];
  const evidence = [];
  for (const view of views) {
    const fixture = await visualFixture();
    const { context, page, errors, networkFailures } = await newPage(browser, target, {
      width: view.width,
      height: view.height,
      colorScheme: view.colorScheme,
    });
    try {
      await installFixtureRoutes(page, fixture);
      await gotoChat(page, target, S.visual);
      // The real app stores the theme in localStorage and exposes a toggle; drive the
      // actual theme rather than assuming the OS color scheme maps to it.
      const initialTheme = await page.getAttribute("html", "data-theme");
      if (initialTheme !== view.colorScheme) {
        await page.evaluate(() => {
          const toggle = document.querySelector("[data-theme-toggle]");
          if (toggle instanceof HTMLElement) toggle.click();
        });
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          view.colorScheme,
          { timeout: 5_000 },
        );
      }
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#chat-attachments .chat-attachment[data-status='ready']")
            .length === 2,
        undefined,
        { timeout: 8_000 },
      );
      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        const composer = document.getElementById("chat-composer");
        const attachments = document.getElementById("chat-attachments");
        const rect = (node) => {
          if (node === null) return null;
          const box = node.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            width: box.width,
            top: box.top,
            bottom: box.bottom,
            height: box.height,
          };
        };
        return {
          clientWidth: doc.clientWidth,
          clientHeight: doc.clientHeight,
          scrollHeight: doc.scrollHeight,
          innerHeight: window.innerHeight,
          overflowX: doc.scrollWidth - doc.clientWidth,
          composer: rect(composer),
          attachments: rect(attachments),
          chipOverflow: Array.from(document.querySelectorAll("#chat-attachments .chat-attachment"))
            .map((node) => node.scrollWidth - node.clientWidth)
            .filter((value) => value > 0),
          theme: document.documentElement.dataset.theme ?? null,
        };
      });
      check(layout.overflowX <= 0, `${view.width}/${view.colorScheme}: no horizontal overflow`);
      check(
        layout.composer !== null &&
          layout.composer.left >= 0 &&
          layout.composer.right <= layout.clientWidth + 1,
        `${view.width}/${view.colorScheme}: composer stays in the viewport`,
      );
      check(
        layout.attachments !== null &&
          layout.attachments.right <= layout.clientWidth + 1 &&
          layout.attachments.width <= layout.composer.width + 1,
        `${view.width}/${view.colorScheme}: attachment stack fits the composer`,
      );
      assertEqual(
        layout.chipOverflow,
        [],
        `${view.width}/${view.colorScheme}: chips do not overflow`,
      );
      assertEqual(
        layout.theme,
        view.colorScheme,
        `${view.width}/${view.colorScheme}: color scheme`,
      );
      await shot(page, `attachments-${view.width}-${view.colorScheme}`);

      if (view.width === 390 && view.colorScheme === "dark") {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 });
        await page.focus("#chat-attach");
        await page.keyboard.press("Enter");
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: "keyboard.pdf",
          mimeType: "application/pdf",
          buffer: PDF,
        });
        await page.waitForFunction(
          () =>
            document.querySelectorAll("#chat-attachments .chat-attachment[data-status='ready']")
              .length === 3,
          undefined,
          { timeout: 8_000 },
        );
        check(
          (await chipState(page)).some((chip) => chip.name === "keyboard.pdf"),
          "keyboard-operable attach added a chip",
        );
        await shot(page, "attachments-keyboard-390-dark");
      }
      assertClean(errors, networkFailures);
      evidence.push({ ...view, layout });
    } finally {
      await context.close();
    }
  }

  // Reduced motion: the progress fill transition is disabled.
  const fixture = createFixture({
    sessions: [{ id: S.visual, title: "Motion QA" }],
    config: { uploadDelayMs: 1_500 },
  });
  const reduced = await newPage(browser, target, { reducedMotion: "reduce" });
  try {
    await installFixtureRoutes(reduced.page, fixture);
    await gotoChat(reduced.page, target, S.visual);
    await attachViaInput(reduced.page, "design.png");
    await reduced.page.waitForSelector(
      '#chat-attachments .chat-attachment[data-status="uploading"]',
      { timeout: 3_000 },
    );
    const motion = await reduced.page.evaluate(() => {
      const fill = document.querySelector(".chat-attachment__progress-fill");
      const style = fill === null ? null : getComputedStyle(fill);
      return {
        matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        transitionProperty: style === null ? null : style.transitionProperty,
        transitionDuration: style === null ? null : style.transitionDuration,
        animationName: style === null ? null : style.animationName,
      };
    });
    check(motion.matches === true, "reduced motion media query is active");
    check(
      motion.transitionProperty === "none" || motion.transitionDuration === "0s",
      `progress fill transition is removed under reduced motion (${JSON.stringify(motion)})`,
    );
    check(
      motion.animationName === "none" || motion.animationName === null,
      "progress fill has no animation under reduced motion",
    );
    await reduced.page.waitForFunction(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      undefined,
      { timeout: 3_000 },
    );
    await shot(reduced.page, "attachments-reduced-motion-1440-dark");
    await waitForChip(reduced.page, "design.png");
    assertClean(reduced.errors, reduced.networkFailures);
    evidence.push({ reducedMotion: motion });
  } finally {
    await reduced.context.close();
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Stage C helpers: fake SSE injection, warning strip, projected attachment cards
// ---------------------------------------------------------------------------

async function emitSse(page, payloads) {
  await page.evaluate((events) => {
    const source = window.__qaEventSource;
    if (source === null || source === undefined) {
      throw new Error("the fake EventSource is not open");
    }
    for (const payload of events) source.emit(payload);
  }, payloads);
}

async function emitSentMessage(page, sessionId, message) {
  const events = [
    {
      type: "message.updated",
      sessionID: sessionId,
      messageID: message.info.id,
      role: message.info.role,
      attachments: message.info.hanse?.attachments ?? [],
    },
  ];
  for (const part of message.parts) {
    if (part.synthetic === true) continue;
    events.push({
      type: "message.part.updated",
      sessionID: sessionId,
      messageID: message.info.id,
      partID: part.id,
      partType: part.type,
      part,
    });
  }
  await emitSse(page, events);
}

async function attachmentWarningState(page) {
  return page.evaluate(() => {
    const host = document.getElementById("chat-attachment-warning");
    if (host === null) return { visible: false, items: [] };
    return {
      visible: host.hidden === false,
      items: Array.from(host.querySelectorAll(".chat-attachment-warning__item")).map((node) => ({
        code: node.dataset.code ?? null,
        downgrade: node.dataset.downgrade === "true",
        text: node.querySelector(".chat-attachment-warning__text")?.textContent ?? "",
      })),
    };
  });
}

async function attachmentCards(page) {
  return page.evaluate(() => {
    const feed = document.getElementById("chat-messages");
    const cards = Array.from(feed?.querySelectorAll(".attachment-card") ?? []).map((card) => {
      const thumb = card.querySelector(".attachment-card__thumb");
      return {
        id: card.dataset.attachmentId ?? null,
        inline: card.dataset.inline === "true",
        state: card.dataset.state ?? null,
        kind: card.dataset.kind ?? null,
        meta: card.querySelector(".attachment-card__meta")?.textContent ?? "",
        name: card.querySelector(".attachment-card__name")?.textContent ?? "",
        download: card.querySelector(".attachment-card__download")?.getAttribute("href") ?? null,
        thumb: thumb === null ? null : thumb.naturalWidth,
        thumbSrc: thumb === null ? null : thumb.getAttribute("src"),
        redeliver: card.querySelector(".attachment-card__redeliver") !== null,
      };
    });
    const html = feed?.innerHTML ?? "";
    return {
      cards,
      dataUrls: html.match(/data:[^"'\s>]+/g) ?? [],
      text: feed?.textContent ?? "",
    };
  });
}

async function streamNoticeState(page) {
  return page.evaluate(() => {
    const notice = document.querySelector(".chat-stream-notice");
    if (notice === null) return { visible: false, text: "", buttons: [] };
    return {
      visible: notice.hidden === false,
      text: notice.textContent ?? "",
      buttons: Array.from(notice.querySelectorAll("button")).map(
        (button) => button.textContent ?? "",
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Scenario 8: explicit inline delivery (Auto omitted, Send to model inline part)
// ---------------------------------------------------------------------------

async function scenarioInline(browser, target) {
  const fixture = createFixture({
    sessions: [{ id: S.inline, title: "Inline QA" }],
    config: {
      sendWarnings: [{ code: "attachment_context_large" }],
    },
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.inline);
    await page.waitForSelector("#chat-sessions .session-item");

    await attachViaInput(page, "design.png");
    await waitForChip(page, "design.png");
    const options = await page.$$eval(
      "#chat-attachments .chat-attachment[data-kind='image'] select option",
      (nodes) => nodes.map((node) => node.textContent ?? ""),
    );
    assertEqual(
      options,
      ["Auto", "Send to model", "File only"],
      "inline-capable image offers Auto / Send to model / File only",
    );

    await page
      .locator("#chat-attachments .chat-attachment[data-kind='image'] select")
      .first()
      .selectOption("inline");
    await waitFor(() => fixture.calls.patches.length === 1, "inline mode PATCH");
    assertEqual(fixture.calls.patches[0].mode, "inline", "Send to model PATCHes mode inline");

    await page.click("#chat-send");
    await waitFor(() => fixture.calls.messagePosts.length === 1, "inline send");
    const send = fixture.calls.messagePosts[0];
    assertEqual(
      send.body.attachments,
      [{ id: "att_qa", mode: "inline" }],
      "explicit inline send carries mode inline",
    );
    await page.waitForSelector('#chat-messages [data-message-id="msg_qa_1"]', {
      timeout: 5_000,
    });

    const warning = await attachmentWarningState(page);
    check(warning.visible === true, "inline send renders the attachment warning strip");
    assertEqual(
      warning.items.map((item) => item.code),
      ["attachment_context_large"],
      "context advisory warning is visible",
    );
    check(
      (warning.items[0]?.text ?? "").includes("large for the model context"),
      "context advisory explains the large message",
    );

    const sent = fixture.messages.get(S.inline).at(-1);
    await emitSentMessage(page, S.inline, sent);
    await page.waitForSelector('#chat-messages .attachment-card[data-inline="true"]', {
      timeout: 5_000,
    });
    const live = await attachmentCards(page);
    const inlineCard = live.cards.find((card) => card.inline === true);
    check(inlineCard !== undefined, "the projected inline file part renders an inline card");
    assertEqual(inlineCard?.meta.includes("Inline"), true, "inline card meta says Inline");
    check(
      typeof inlineCard?.download === "string" &&
        inlineCard.download === `/api/apps/${APP}/attachments/att_qa?project=${PROJECT_ID}`,
      "inline card uses the short download URL",
    );
    check(
      inlineCard?.thumbSrc === inlineCard?.download,
      "inline image thumbnail streams the short download URL",
    );
    check((inlineCard?.thumb ?? 0) > 0, "inline image thumbnail loaded through the download route");
    check(
      live.dataUrls.length === 0,
      `no data: URL reaches the feed (${JSON.stringify(live.dataUrls)})`,
    );
    check(
      await page.evaluate(
        () => document.querySelectorAll("#chat-attachments .chat-attachment").length === 0,
      ),
      "the sent attachment is removed from the composer",
    );
    await shot(page, "attachments-inline-1440-dark");

    // Reload: history projection keeps the short URL and hides the manifest.
    await gotoChat(page, target, S.inline);
    await page.waitForSelector('#chat-messages .attachment-card[data-inline="true"]', {
      timeout: 8_000,
    });
    const history = await attachmentCards(page);
    const historyInline = history.cards.find((card) => card.inline === true);
    check(historyInline !== undefined, "history shows the inline projected card");
    check(
      typeof historyInline?.download === "string" &&
        historyInline.download.includes(`/attachments/att_qa`) &&
        historyInline.download.includes(`project=${PROJECT_ID}`),
      "history inline card points at the download route",
    );
    check(
      history.text.includes("Attached files") === false,
      "synthetic attachment manifest stays hidden in history",
    );
    check(history.dataUrls.length === 0, "history payload renders no data: URL");

    assertClean(errors, networkFailures);
    return { send: send.body, warning, live, history };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 9: capability downgrade -> warnings + file fallback
// ---------------------------------------------------------------------------

async function scenarioDowngrade(browser, target) {
  const fixture = createFixture({
    sessions: [{ id: S.downgrade, title: "Downgrade QA" }],
    config: {
      forceDeliveryFile: true,
      sendWarnings: [
        { code: "attachment_inline_unsupported" },
        { code: "attachment_capability_unknown" },
      ],
    },
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.downgrade);
    await page.waitForSelector("#chat-sessions .session-item");

    await attachViaInput(page, "design.png");
    await waitForChip(page, "design.png");
    await page
      .locator("#chat-attachments .chat-attachment[data-kind='image'] select")
      .first()
      .selectOption("inline");
    await waitFor(() => fixture.calls.patches.length === 1, "inline downgrade PATCH");
    await page.click("#chat-send");
    await waitFor(() => fixture.calls.messagePosts.length === 1, "downgrade send");
    assertEqual(
      fixture.calls.messagePosts[0].body.attachments,
      [{ id: "att_qa", mode: "inline" }],
      "downgrade scenario requested inline",
    );
    await page.waitForSelector('#chat-messages [data-message-id="msg_qa_1"]', {
      timeout: 5_000,
    });

    const warning = await attachmentWarningState(page);
    check(warning.visible === true, "downgrade warning strip is visible");
    assertEqual(
      warning.items.map((item) => item.code),
      ["attachment_inline_unsupported", "attachment_capability_unknown"],
      "both downgrade warnings render",
    );
    check(
      warning.items.every((item) => item.downgrade === true),
      "downgrade warnings are marked as downgrades",
    );
    check(
      (warning.items[0]?.text ?? "").includes("cannot display") &&
        (warning.items[1]?.text ?? "").includes("could not be confirmed"),
      "downgrade warnings explain the fallback",
    );

    const sent = fixture.messages.get(S.downgrade).at(-1);
    await emitSentMessage(page, S.downgrade, sent);
    await page.waitForSelector('#chat-messages .attachment-card[data-inline="false"]', {
      timeout: 5_000,
    });
    const fallback = await attachmentCards(page);
    const fileCard = fallback.cards.find((card) => card.inline === false);
    check(fileCard !== undefined, "downgraded attachment renders a file-only card");
    assertEqual(fileCard?.state, "sent", "downgraded card is in the sent state");
    assertEqual(fileCard?.meta.includes("File only"), true, "downgraded card meta says File only");
    check(
      fallback.cards.every((card) => card.inline === false),
      "no inline card renders after a downgrade",
    );
    check(
      typeof fileCard?.download === "string" && fileCard.download.includes("/attachments/att_qa"),
      "downgraded card still downloads through the short route",
    );
    check(fallback.dataUrls.length === 0, "downgrade renders no data: URL");
    await shot(page, "attachments-downgrade-1440-dark");

    assertClean(errors, networkFailures);
    return { send: fixture.calls.messagePosts[0].body, warning, fallback };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 10: redeliver a sent inline attachment as a file without mutation
// ---------------------------------------------------------------------------

async function scenarioRedelivery(browser, target) {
  const fixture = createFixture({ sessions: [{ id: S.redeliver, title: "Redelivery QA" }] });
  const seeded = seedSentHistory(fixture, S.redeliver, {
    name: "look.png",
    mime: "image/png",
    size: PNG.length,
    mode: "inline",
    text: "What is this?",
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.redeliver);
    await page.waitForSelector('#chat-messages .attachment-card[data-inline="true"]', {
      timeout: 8_000,
    });
    const redeliver = page.locator(
      '#chat-messages .attachment-card[data-inline="true"] .attachment-card__redeliver',
    );
    check((await redeliver.count()) === 1, "a sent inline card offers Send again as file");
    assertEqual(
      await redeliver.first().textContent(),
      "Send again as file",
      "redelivery control label",
    );

    const before = JSON.parse(JSON.stringify(fixture.messages.get(S.redeliver)));
    const getsBefore = fixture.calls.messageGets.length;
    await redeliver.first().click();
    await waitFor(() => fixture.calls.messagePosts.length === 1, "redelivery send");
    const body = fixture.calls.messagePosts[0].body;
    assertEqual(
      body.attachments,
      [{ id: seeded.record.id, mode: "file" }],
      "redelivery sends the same attachment with mode file",
    );
    check(!("text" in body), "redelivery sends no operator text");
    await waitFor(
      () => fixture.calls.messageGets.length > getsBefore,
      "redelivery hydrates history",
    );

    const after = fixture.messages.get(S.redeliver);
    assertEqual(after.length, 2, "redelivery appends a new message");
    assertEqual(
      JSON.stringify(after[0]),
      JSON.stringify(before[0]),
      "the original message and its delivery are unchanged",
    );
    const newView = after[1].info.hanse.attachments[0];
    assertEqual(newView.inline, false, "new delivery is file-only");
    assertEqual(newView.mode, "file", "new delivery records mode file");
    check(
      after[1].parts.every((part) => part.type !== "file"),
      "the file-only redelivery has no inline file part",
    );

    await page.waitForFunction(
      () =>
        document.querySelectorAll('#chat-messages .attachment-card[data-inline="true"]').length ===
          1 &&
        document.querySelectorAll('#chat-messages .attachment-card[data-inline="false"]').length ===
          1,
      undefined,
      { timeout: 8_000 },
    );
    const warning = await attachmentWarningState(page);
    check(
      warning.items.some((item) => item.code === "attachment_redelivered"),
      "redelivery shows the duplicate warning",
    );
    await shot(page, "attachments-redelivery-1440-dark");

    assertClean(errors, networkFailures);
    return { body, before: before[0], after: after[1], warning };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 11: stream.warning + message.part.omitted -> notice + bounded hydration
// ---------------------------------------------------------------------------

async function scenarioStreamRecovery(browser, target) {
  const fixture = createFixture({ sessions: [{ id: S.stream, title: "Stream QA" }] });
  const seeded = seedHistoryMessage(fixture, S.stream, {
    id: "msg_stream",
    text: "steady history",
  });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.stream);
    await page.waitForFunction(
      () =>
        (document.getElementById("chat-messages")?.textContent ?? "").includes("steady history"),
      undefined,
      { timeout: 8_000 },
    );
    check(
      await page.evaluate(() => window.__qaEventSource?.readyState === 1),
      "stream is open before the recovery event",
    );
    const getsBefore = fixture.calls.messageGets.length;
    await emitSse(page, [
      {
        type: "stream.warning",
        code: "frame_too_large",
        sessionID: S.stream,
        message: "A live update was too large and was skipped; refreshing it from history.",
      },
      {
        type: "message.part.omitted",
        sessionID: S.stream,
        messageID: seeded.messageID,
        partID: seeded.partID,
        partType: "text",
        reason: "too_large",
      },
    ]);
    await page.waitForFunction(
      () => {
        const notice = document.querySelector(".chat-stream-notice");
        return (
          notice !== null &&
          notice.hidden === false &&
          (notice.textContent ?? "").includes("skipped")
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    const notice = await streamNoticeState(page);
    check(
      notice.text.includes("refreshing"),
      "the omitted part notice explains the history refresh",
    );
    // Capture the notice before the reconciliation hydration clears it.
    await shot(page, "attachments-stream-recovery-1440-dark");
    await waitFor(() => fixture.calls.messageGets.length > getsBefore, "recovery hydrates history");
    await wait(900);
    const delta = fixture.calls.messageGets.length - getsBefore;
    check(delta >= 1 && delta <= 4, `history hydration is bounded (${delta} request(s))`);
    check(
      await page.evaluate(() => window.__qaEventSource?.readyState === 1),
      "the stream stays open after a skipped frame",
    );
    await page.waitForFunction(
      () =>
        (document.getElementById("chat-messages")?.textContent ?? "").includes("steady history"),
      undefined,
      { timeout: 5_000 },
    );

    assertClean(errors, networkFailures);
    return { notice, hydrationRequests: delta, seeded: seeded.messageID };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 12: ninth browser stream -> 429 stream_limit with a history recovery path
// ---------------------------------------------------------------------------

async function scenarioStreamLimit(browser, target) {
  const fixture = createFixture({
    sessions: [{ id: S.limit, title: "Stream limit QA" }],
    config: { streamLimit: true },
  });
  seedHistoryMessage(fixture, S.limit, { id: "msg_limit", text: "history survives" });
  const { context, page, errors, networkFailures } = await newPage(browser, target);
  try {
    await installFixtureRoutes(page, fixture);
    await gotoChat(page, target, S.limit);
    await page.waitForFunction(
      () =>
        (document.getElementById("chat-messages")?.textContent ?? "").includes("history survives"),
      undefined,
      { timeout: 8_000 },
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    });
    const getsBefore = fixture.calls.messageGets.length;
    await page.evaluate(() => {
      const source = window.__qaEventSource;
      if (source === null || source === undefined) throw new Error("fake EventSource missing");
      source.onerror({});
      source.onerror({});
      source.onerror({});
    });
    await page.waitForFunction(
      () => {
        const notice = document.querySelector(".chat-stream-notice");
        return (
          notice !== null &&
          notice.hidden === false &&
          (notice.textContent ?? "").includes("Too many live streams")
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    const notice = await streamNoticeState(page);
    check(notice.text.includes("Too many live streams"), "stream_limit notice is explicit");
    check(
      notice.buttons.includes("Retry live") && notice.buttons.includes("Refresh history"),
      "stream_limit offers retry and history actions",
    );
    await waitFor(
      () => fixture.calls.messageGets.length > getsBefore,
      "stream_limit falls back to history",
    );
    await page.waitForFunction(
      () =>
        (document.getElementById("chat-messages")?.textContent ?? "").includes("history survives"),
      undefined,
      { timeout: 5_000 },
    );
    check(fixture.calls.eventGets >= 1, "the client probed the events endpoint for the 429");
    const connection = await page.evaluate(
      () => document.getElementById("chat-live")?.textContent ?? "",
    );
    check(
      connection.toLowerCase().includes("paused"),
      `connection state shows a paused feed (${connection})`,
    );
    await shot(page, "attachments-stream-limit-1440-dark");

    assertClean(errors, networkFailures, [429]);
    return { notice, connection, eventGets: fixture.calls.eventGets };
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
    entry.error = scrub(error instanceof Error ? (error.stack ?? error.message) : String(error));
    if (error !== null && typeof error === "object" && "details" in error) {
      entry.data = error.details;
    }
    report.status = "FAIL";
    throw error;
  } finally {
    entry.ms = Date.now() - started;
    report.scenarios.push(entry);
  }
}

function evidenceFor(entry) {
  if (entry.data !== null && entry.data !== undefined) {
    const text = JSON.stringify(entry.data);
    return text.length > 360 ? `${text.slice(0, 357)}...` : text;
  }
  if (typeof entry.error === "string") {
    const firstLine = entry.error.split("\n")[0];
    return firstLine.length > 360 ? `${firstLine.slice(0, 357)}...` : firstLine;
  }
  return "";
}

function writeReports() {
  report.finishedAt = new Date().toISOString();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const scenarioRows = report.scenarios.map((entry, index) => {
    const status = entry.status === "PASS" ? "PASS" : "FAIL";
    const surface =
      [
        "1 attach controls",
        "2 send",
        "3 remove/blocking",
        "4 foreign/missing",
        "5 title",
        "6 clear race",
        "7 responsive/visual",
        "8 inline delivery",
        "9 inline downgrade",
        "10 redeliver as file",
        "11 stream recovery",
        "12 stream limit",
      ][index] ?? "";
    return `| ${index + 1} | ${surface} | \`${entry.name}\` | ${status} | ${entry.checks.length} | ${evidenceFor(entry).replaceAll("|", "\\|")} |`;
  });
  const screenshotRows = report.screenshots.map((file) => `- \`${file}\``);
  const failures = report.scenarios.filter((entry) => entry.status === "FAIL");
  const expected = [...new Set(report.expectedHttpErrors)].sort();
  const lines = [
    "# Stage C attachments QA",
    "",
    `- Status: **${report.status}**`,
    `- Mode: \`${report.mode}\` (real page/assets, deterministic \`/api/apps/**\` fixtures)`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt ?? ""}`,
    `- Base URL: \`${report.baseUrl ?? ""}\``,
    `- Command: \`node docs/design/attachments-qa.mjs\``,
    "",
    "## Scenarios",
    "",
    "| # | Surface | Scenario | Result | Assertions | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...scenarioRows,
    "",
    "## Failures",
    "",
    ...(failures.length > 0
      ? failures.flatMap((entry) => [
          `### ${entry.name}`,
          "",
          "```",
          entry.error ?? "unknown failure",
          "```",
          "",
        ])
      : ["_none_", ""]),
    "## Screenshots",
    "",
    ...(screenshotRows.length > 0 ? screenshotRows : ["_none_"]),
    "",
    "## Expected HTTP errors exercised",
    "",
    ...(expected.length > 0 ? expected.map((line) => `- ${line}`) : ["_none_"]),
    "",
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
  // Do not persist the ephemeral test port in tracked QA evidence.
  report.baseUrl = "http://127.0.0.1:<ephemeral-test-port>";
  browser = await chromium.launch({ executablePath: chromiumPath });

  const definitions = [
    ["attach-controls", scenarioAttachControls],
    ["send-text-and-file-only", scenarioSend],
    ["remove-and-blocking", scenarioRemoveAndBlocking],
    ["foreign-and-missing", scenarioForeignAndMissing],
    ["title-contract", scenarioTitle],
    ["clear-race", scenarioClearRace],
    ["responsive-visual", scenarioResponsiveVisual],
    ["inline-delivery", scenarioInline],
    ["inline-downgrade", scenarioDowngrade],
    ["redeliver-as-file", scenarioRedelivery],
    ["stream-recovery", scenarioStreamRecovery],
    ["stream-limit", scenarioStreamLimit],
  ];
  for (const [name, scenario] of definitions) {
    try {
      await runScenario(name, () => scenario(browser, server));
    } catch (error) {
      if (!COLLECT) throw error;
      console.error(`\nFAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} catch (error) {
  report.status = "FAIL";
  report.error = scrub(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error("\nFAIL deterministic attachments QA");
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
  console.log("\nPASS deterministic attachments QA");
  console.log(
    `  ${report.scenarios.length} scenario(s), ${assertions} assertion(s), ` +
      `${report.screenshots.length} screenshot(s), zero unexpected console/page errors`,
  );
  console.log(`  report: ${relative(REPORT_JSON)}`);
} else {
  console.error(`\nreport: ${relative(REPORT_JSON)}`);
}
