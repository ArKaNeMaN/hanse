#!/usr/bin/env node
/*
 * Execute Prism inside the built `chat-highlight-worker.js` with headless Chromium.
 *
 * `npm run build` is not required for this script: Vite builds only the worker (and its shared
 * imports) into a temporary directory, then the script serves that directory over loopback and
 * instantiates it as a real module worker. A tokenization result is required, not just successful
 * construction. No network, Docker, or opencode is used.
 *
 * Run after `npm run build` per the Stage 0 gate; the worker build is independent, so this script
 * also works on its own.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = mkdtempSync(path.join(tmpdir(), "hanse-chat-worker-smoke-"));

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

function fail(message) {
  process.stderr.write(`check:chat-worker: ${message}\n`);
  process.exitCode = 1;
}

function findPlaywrightModule() {
  const candidates = [
    path.resolve(ROOT, "node_modules", "playwright", "index.mjs"),
    "/usr/lib/node_modules/gsd-pi/node_modules/playwright/index.mjs",
  ];
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.unshift(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (existsSync(root)) {
    const builds = readdirSync(root)
      .filter((entry) => entry.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const build of builds) {
      const candidate = path.join(root, build, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const modulePath = findPlaywrightModule();
if (modulePath === undefined) {
  fail("Playwright is not installed; keep the existing devDependency available.");
} else {
  process.env.CHAT_WORKER_SMOKE_OUT = OUT_DIR;
  const { build } = await import("vite");
  try {
    await build({
      configFile: path.join(SCRIPT_DIR, "vite.worker-smoke.config.mjs"),
      mode: "production",
      logLevel: "silent",
    });
  } catch (error) {
    fail(`worker build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const workerPath = path.join(OUT_DIR, "chat-highlight-worker.js");
if (process.exitCode !== 1 && !existsSync(workerPath)) {
  fail("the built worker is missing; the Vite worker build produced no entry");
}

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function startStaticServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>chat worker smoke</title>");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const resolved = path.resolve(OUT_DIR, relative);
    if (!resolved.startsWith(`${OUT_DIR}${path.sep}`) || !existsSync(resolved)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(readFileSync(resolved));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("static server did not bind a loopback port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function probeWorker() {
  const messages = [];
  const errors = [];
  const worker = new Worker("/chat-highlight-worker.js", { type: "module" });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("worker tokenization timed out"));
    }, 10_000);
    const finish = (value) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    worker.onerror = (event) => {
      errors.push(event.message ?? "worker error");
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message ?? "worker error"));
    };
    worker.onmessage = (event) => {
      const data = event.data;
      messages.push(data);
      if (data?.type === "ready") {
        worker.postMessage({
          type: "tokenize",
          jobID: "job-smoke",
          streamID: "stream-smoke",
          language: "typescript",
          text: "const answer: number = 42;\\nconsole.log(answer);\\n",
        });
        return;
      }
      if (data?.type === "tokens" || data?.type === "plain" || data?.type === "error") {
        finish(data);
      }
    };
    worker.postMessage({ type: "init" });
  });
  return { result, messages, errors };
}

let browser;
let server;
try {
  if (process.exitCode !== 1) {
    const started = await startStaticServer();
    server = started.server;
    const executablePath = findChromium();
    const { chromium } = await import(`file://${modulePath}`);
    browser = await chromium.launch(
      executablePath === undefined
        ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] }
        : { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] },
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:${started.port}/`, { waitUntil: "load" });
    const { result, messages, errors } = await page.evaluate(probeWorker);
    await context.close();

    if (errors.length > 0) fail(`worker errors: ${errors.join("; ")}`);
    if (consoleErrors.length > 0) fail(`console/page errors: ${consoleErrors.join("; ")}`);
    if (result?.type !== "tokens") {
      fail(
        `expected a token result from the built worker, got ${JSON.stringify(result ?? messages)}`,
      );
    } else {
      const lines = Array.isArray(result.lines) ? result.lines : [];
      const segments = lines.flat();
      const typed = segments.some(
        (segment) => Array.isArray(segment) && Array.isArray(segment[1]) && segment[1].length > 0,
      );
      if (lines.length === 0) fail("the built worker returned no token lines");
      else if (!typed) fail("the built worker returned no typed token segments");
      else if (!(typeof result.tokenNodes === "number" && result.tokenNodes > 0)) {
        fail("the built worker returned no token nodes");
      } else {
        process.stdout.write(
          `check:chat-worker ok (${lines.length} lines, ${result.tokenNodes} token nodes)\n`,
        );
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  rmSync(OUT_DIR, { recursive: true, force: true });
}

if (process.exitCode === 1) process.exit(1);
