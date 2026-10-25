import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const extensionPath = fileURLToPath(
  new URL("../extensions/hanse-agent/extension.js", import.meta.url),
);

function webviewScript() {
  const source = readFileSync(extensionPath, "utf8");
  const start = source.indexOf("<script>") + "<script>".length;
  const end = source.indexOf("</script>");
  return source.slice(start, end);
}

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.scrollTop = 0;
    this.parentNode = null;
  }
  appendChild(child) {
    if (child.tagName === "#fragment") {
      for (const inner of [...child.children]) this.appendChild(inner);
      child.children = [];
      return child;
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  insertBefore(node, reference) {
    if (node.tagName === "#fragment") {
      for (const child of [...node.children]) this.insertBefore(child, reference);
      node.children = [];
      return node;
    }
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentNode = this;
    return node;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  querySelectorAll(selector) {
    const found = [];
    const wantThumbnail = selector === "img[data-thumb-key]";
    const walk = (node) => {
      if (wantThumbnail && node.tagName === "img" && typeof node.dataset.thumbKey === "string") {
        found.push(node);
      }
      for (const child of node.children) walk(child);
    };
    walk(this);
    return found;
  }
  get scrollHeight() {
    return this.children.length * 20;
  }
}

function createWebview() {
  const ids = new Map();
  for (const id of ["tabs", "older", "messages", "status", "input", "send", "err"]) {
    ids.set(id, new Element("div"));
  }
  const posted = [];
  let messageHandler = null;
  let blobCounter = 0;
  const context = {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    window: {
      addEventListener: (_name, handler) => {
        messageHandler = handler;
      },
    },
    document: {
      getElementById: (id) => ids.get(id) ?? null,
      createElement: (tag) => new Element(tag),
      createDocumentFragment: () => new Element("#fragment"),
      querySelectorAll: (selector) => ids.get("messages").querySelectorAll(selector),
    },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    Uint8Array,
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type;
      }
    },
    URL: { createObjectURL: () => `blob:test-${++blobCounter}` },
    Map,
    Set,
    Array,
    Object,
    Math,
    isFinite,
    String,
    JSON,
    console,
  };
  vm.createContext(context);
  vm.runInContext(webviewScript(), context, { filename: "extension-webview.js" });
  return {
    context,
    posted,
    ids,
    dispatch: (message) => messageHandler({ data: message }),
  };
}

const manifest = {
  type: "text",
  synthetic: true,
  metadata: { hanse: "attachment-manifest" },
  text: "Attached files ...",
};
const readSynthetic = {
  type: "text",
  synthetic: true,
  data: { text: "Called the Read tool with the following input: {}" },
};
const png = {
  id: "att_png",
  name: "shot.png",
  mime: "image/png",
  size: 2048,
  kind: "image",
  state: "sent",
  downloadURL: "/api/apps/a/attachments/att_png",
  inline: false,
};
const svg = {
  id: "att_svg",
  name: "x.svg",
  mime: "image/svg+xml",
  size: 10,
  kind: "file",
  state: "sent",
  downloadURL: "/api/apps/a/attachments/att_svg",
  inline: false,
};

describe("bundled IDE extension webview", () => {
  it("hides synthetic parts and renders file-only attachment cards", () => {
    const view = createWebview();
    view.context.renderMessages(
      [
        {
          info: { id: "m1", role: "user" },
          parts: [manifest, { type: "text", text: "hello" }, readSynthetic],
          attachments: [{ ...png, name: "top.png" }],
        },
        {
          info: {
            id: "m2",
            role: "user",
            hanse: { attachments: [png, svg, { ...png, name: "dup.png" }] },
          },
          parts: [manifest],
        },
      ],
      true,
    );
    const rendered = view.ids.get("messages").children;
    expect(rendered).toHaveLength(2);
    expect(rendered[0].children[0].textContent).toBe("you: hello");
    const card = rendered[0].children[1].children[0];
    expect(card.children[1].children[0].textContent).toBe("top.png");
    expect(card.children[1].children[1].textContent).toBe("2.0 KB · image/png");
    const download = card.children[2];
    expect(download.textContent).toBe("Download");
    download.onclick();
    expect(JSON.stringify(view.posted.at(-1))).toBe(
      JSON.stringify({
        type: "download",
        downloadURL: "/api/apps/a/attachments/att_png",
        name: "top.png",
      }),
    );
    const cards = rendered[1].children[0].children;
    expect(cards.map((item) => item.dataset.kind)).toEqual(["image", "file"]);
    expect(view.posted.some((message) => message.key === "att:att_svg")).toBe(false);
  });

  it("loads thumbnails only for safe image types and never renders data URLs", () => {
    const view = createWebview();
    view.context.renderMessages(
      [
        {
          info: { id: "m1", role: "assistant" },
          parts: [
            {
              type: "file",
              mime: "image/png",
              filename: "inline.png",
              url: "/api/apps/a/attachments/att_inline",
              attachment: { id: "att_inline", size: 30, kind: "image" },
            },
            {
              type: "file",
              mime: "text/html",
              filename: "evil.html",
              url: "data:text/html,<script>x</script>",
              attachment: { id: "att_evil", size: 40, kind: "file" },
            },
          ],
        },
      ],
      true,
    );
    const cards = view.ids.get("messages").children[0].children[0].children;
    expect(cards).toHaveLength(2);
    expect(cards[0].children[0].children[0].tagName).toBe("img");
    expect(cards[1].children).toHaveLength(2);
    expect(view.posted.some((message) => message.key === "file:att_evil")).toBe(false);
    expect(view.posted.every((message) => !JSON.stringify(message).includes("data:"))).toBe(true);
    view.dispatch({
      type: "thumbnail",
      key: "file:att_inline",
      mime: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(cards[0].children[0].children[0].src.startsWith("blob:test-")).toBe(true);
  });

  it("replaces snapshots without duplicating and prepends older pages once", () => {
    const view = createWebview();
    const tail = [{ info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "b" }] }];
    const older = [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "a" }] }];
    view.context.renderMessages(tail, true);
    view.context.renderMessages(tail, true);
    expect(view.ids.get("messages").children).toHaveLength(1);
    view.context.prependMessages([...older, ...tail]);
    expect(view.ids.get("messages").children).toHaveLength(2);
  });
});

let extension;
let provider;
let mode = "initial";
let requestLog = [];
let sent = [];
let messagesCalls = 0;

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requestLog.push({ method: request.method, url: request.url, body });
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, data) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (url.pathname === "/api/projects") {
      return json(200, { projects: [{ name: "P", apps: [{ appKey: "a" }] }] });
    }
    if (url.pathname === "/api/apps/a/sessions" && request.method === "POST") {
      return json(200, { id: "s1" });
    }
    if (url.pathname === "/api/apps/a/sessions" && request.method === "GET") {
      return json(200, { sessions: [{ id: "s1" }] });
    }
    if (url.pathname === "/api/apps/a/sessions/s1/messages" && request.method === "GET") {
      messagesCalls += 1;
      if (mode === "initial") return json(200, { messages: [], nextCursor: "c0" });
      if (mode === "missing") return json(200, { messages: [], nextCursor: null });
      return json(200, {
        messages: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
        nextCursor: null,
      });
    }
    if (url.pathname === "/api/apps/a/sessions/s1/messages" && request.method === "POST") {
      if (url.searchParams.get("async") === "1") {
        if (mode === "noasync") {
          return json(502, {
            error: "async prompt route unavailable",
            code: "async_unavailable",
            outcome: "not_sent",
          });
        }
        return json(202, { accepted: true, messageID: "m1", sessionID: "s1" });
      }
      return json(200, { message: { info: { id: "m1", role: "user" }, parts: [] } });
    }
    return json(404, { error: "not found" });
  });
});

const previousApiBase = process.env.HANSE_API_BASE;
const previousToken = process.env.HANSE_OPERATOR_TOKEN;

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  process.env.HANSE_API_BASE = `http://127.0.0.1:${address.port}`;
  process.env.HANSE_OPERATOR_TOKEN = "test-token";
  const fakeVscode = {
    window: {
      registerWebviewViewProvider(_id, value) {
        provider = value;
        return { dispose() {} };
      },
      showSaveDialog: async () => undefined,
      showInformationMessage() {},
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand: async () => undefined,
    },
    workspace: { workspaceFolders: [], fs: { writeFile: async () => undefined } },
    Uri: { file: (value) => ({ fsPath: value }), joinPath: (uri, name) => ({ ...uri, name }) },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "vscode") return fakeVscode;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    extension = createRequire(import.meta.url)(extensionPath);
  } finally {
    Module._load = originalLoad;
  }
  extension.activate({ subscriptions: [] });
});

afterAll(() => {
  server.close();
  if (previousApiBase === undefined) delete process.env.HANSE_API_BASE;
  else process.env.HANSE_API_BASE = previousApiBase;
  if (previousToken === undefined) delete process.env.HANSE_OPERATOR_TOKEN;
  else process.env.HANSE_OPERATOR_TOKEN = previousToken;
});

function resolveView() {
  sent = [];
  let handler;
  provider.resolveWebviewView({
    webview: {
      options: {},
      set html(_value) {},
      onDidReceiveMessage(value) {
        handler = value;
      },
      postMessage(value) {
        sent.push(value);
      },
    },
  });
  return handler;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("bundled IDE extension host", () => {
  let handler;

  beforeAll(async () => {
    handler = resolveView();
    await handler({ type: "init" });
    await tick();
    await handler({ type: "select", app: "a" });
    await tick();
  });

  it("reads the 30-message tail and forwards the cursor for older pages", async () => {
    expect(requestLog.some((entry) => entry.url.includes("limit=30"))).toBe(true);
    expect(sent.some((message) => message.type === "session" && message.sessionId === "s1")).toBe(
      true,
    );
    requestLog = [];
    await handler({ type: "older", cursor: "c0" });
    await tick();
    expect(requestLog.some((entry) => entry.url.includes("before=c0"))).toBe(true);
  });

  it("sends with ?async=1, handles 202, and renders the eventual reply", async () => {
    mode = "ok";
    requestLog = [];
    await handler({ type: "send", app: "a", sessionId: "s1", text: "hi" });
    await tick();
    expect(
      requestLog.some((entry) => entry.method === "POST" && entry.url.includes("async=1")),
    ).toBe(true);
    const snapshot = sent.filter((message) => message.type === "messages").at(-1);
    expect(snapshot.messages).toHaveLength(2);
    expect(
      sent.some((message) => message.type === "recovery" && message.state === "complete"),
    ).toBe(true);
  });

  it("stops after the bounded read schedule instead of polling forever", async () => {
    mode = "missing";
    messagesCalls = 0;
    requestLog = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 0;
    };
    try {
      await handler({ type: "send", app: "a", sessionId: "s1", text: "again" });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(messagesCalls).toBe(6);
    expect(
      requestLog.filter((entry) => entry.method === "POST" && entry.url.includes("async=1")),
    ).toHaveLength(1);
    expect(sent.filter((message) => message.type === "error").at(-1)?.error).toMatch(
      /has not appeared yet/,
    );
  });

  it("falls back to the blocking route once when async is unavailable", async () => {
    mode = "noasync";
    requestLog = [];
    await handler({ type: "send", app: "a", sessionId: "s1", text: "fallback" });
    await tick();
    expect(
      requestLog.filter((entry) => entry.method === "POST" && !entry.url.includes("async=1")),
    ).toHaveLength(1);
    expect(
      sent.some((message) => message.type === "recovery" && message.state === "complete"),
    ).toBe(true);
  });
});
