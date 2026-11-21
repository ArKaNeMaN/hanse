/**
 * Parent-side client for the sandboxed Mermaid renderer.
 *
 * The iframe is created lazily on the first diagram. The parent and frame exchange messages over a
 * transferred MessageChannel port; the frame is untrusted (opaque origin) and returns only an SVG
 * string. The parent never inserts that markup: `assets/markdown.js` displays it as an inert image.
 */
import {
  hasDiagramRenderer,
  setDiagramRenderer as registerDiagramRenderer,
} from "../../assets/markdown.js";
import {
  type ConnectMessage,
  isErrorMessage,
  isReadyMessage,
  isResultMessage,
  MERMAID_PROTOCOL_VERSION,
  type RenderMessage,
} from "./mermaid-protocol";

export interface SandboxFrame {
  readonly contentWindow: Window | null;
  addEventListener(type: "load", listener: () => void): void;
  removeEventListener(type: "load", listener: () => void): void;
  remove(): void;
}

export interface SandboxTransport {
  post(data: unknown): void;
  close(): void;
}

export interface SandboxTheme {
  theme: "dark" | "light";
  tokens: Record<string, string>;
}

export interface SandboxOptions {
  frameUrl?: string;
  createFrame?: () => SandboxFrame;
  connect?: (frame: SandboxFrame, onMessage: (data: unknown) => void) => SandboxTransport;
  readTheme?: () => SandboxTheme;
  queueLimit?: number;
  cacheLimit?: number;
  connectTimeoutMs?: number;
  renderTimeoutMs?: number;
}

export interface SandboxClient {
  render(source: string, isCancelled?: () => boolean): Promise<string>;
  destroy(): void;
}

const DEFAULT_FRAME_URL = "/assets/ui/mermaid-frame.html";
const MAX_SOURCE_CHARS = 32_000;
const MAX_SVG_CHARS = 1_048_576;
const DEFAULT_QUEUE_LIMIT = 64;
const DEFAULT_CACHE_LIMIT = 32;
const CONNECT_TIMEOUT_MS = 5_000;
const RENDER_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 1;

interface Job {
  id: string;
  source: string;
  theme: "dark" | "light";
  tokens: Record<string, string>;
  isCancelled?: () => boolean;
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
}

function createDefaultFrame(frameUrl: string): SandboxFrame {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = "Mermaid renderer";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText =
    "position:fixed;inset-inline-start:-100000px;top:0;inline-size:1024px;block-size:768px;visibility:hidden;border:0";
  iframe.src = frameUrl;
  document.body.append(iframe);
  return iframe;
}

function defaultConnect(frame: SandboxFrame, onMessage: (data: unknown) => void): SandboxTransport {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    onMessage(event.data);
  };
  const target = frame.contentWindow;
  if (target === null) {
    channel.port1.close();
    channel.port2.close();
    throw new Error("The Mermaid frame is unavailable");
  }
  const connect: ConnectMessage = { v: MERMAID_PROTOCOL_VERSION, type: "connect" };
  target.postMessage(connect, "*", [channel.port2]);
  return {
    post: (data) => channel.port1.postMessage(data),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function readSandboxTheme(): SandboxTheme {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return { theme: "dark", tokens: {} };
  }
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): string => styles.getPropertyValue(name).trim();
  const pie = ["--brass", "--info", "--success", "--warning", "--danger", "--text-2"].map(token);
  const tokens: Record<string, string> = {
    background: "transparent",
    primaryColor: token("--surface-2"),
    mainBkg: token("--surface-2"),
    taskBkgColor: token("--surface-2"),
    primaryTextColor: token("--text-1"),
    primaryBorderColor: token("--line"),
    nodeBorder: token("--line"),
    clusterBorder: token("--line"),
    noteBorderColor: token("--line"),
    lineColor: token("--line-strong"),
    secondaryColor: token("--surface-1"),
    clusterBkg: token("--surface-1"),
    edgeLabelBackground: token("--surface-1"),
    tertiaryColor: token("--inset"),
    sectionBkgColor: token("--inset"),
    altSectionBkgColor: token("--inset"),
    textColor: token("--text-2"),
    noteBkgColor: token("--surface-2"),
    noteTextColor: token("--text-1"),
    rowOdd: token("--line"),
    rowEven: token("--line"),
    gridColor: token("--line"),
    doneTaskBkgColor: token("--surface-1"),
    fontFamily: token("--font-sans"),
    fontSize: "14px",
  };
  for (let index = 0; index < 12; index += 1) {
    tokens[`pie${index + 1}`] = pie[index % pie.length] ?? "";
  }
  return {
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    tokens: Object.fromEntries(Object.entries(tokens).filter(([, value]) => value.length > 0)),
  };
}

export function createMermaidSandbox(options: SandboxOptions = {}): SandboxClient {
  const createFrame =
    options.createFrame ?? (() => createDefaultFrame(options.frameUrl ?? DEFAULT_FRAME_URL));
  const connect = options.connect ?? defaultConnect;
  const readTheme = options.readTheme ?? readSandboxTheme;
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const renderTimeoutMs = options.renderTimeoutMs ?? RENDER_TIMEOUT_MS;

  const queue: Job[] = [];
  const cache = new Map<string, string>();
  let frame: SandboxFrame | null = null;
  let transport: SandboxTransport | null = null;
  let ready = false;
  let failed = false;
  let failureReason = "";
  let destroyed = false;
  let restarts = 0;
  let sequence = 0;
  let inFlight: Job | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
  }

  function remember(key: string, svg: string): void {
    if (svg.length > MAX_SVG_CHARS) return;
    cache.delete(key);
    cache.set(key, svg);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function failAll(reason: string): void {
    failed = true;
    failureReason = reason;
    ready = false;
    clearTimers();
    transport?.close();
    transport = null;
    frame?.remove();
    frame = null;
    if (inFlight !== null) {
      inFlight.reject(new Error(reason));
      inFlight = null;
    }
    for (const job of queue.splice(0)) {
      job.reject(new Error(reason));
    }
  }

  function failFrame(reason: string): void {
    ready = false;
    clearTimers();
    transport?.close();
    transport = null;
    frame?.remove();
    frame = null;
    if (inFlight !== null) {
      inFlight.reject(new Error(reason));
      inFlight = null;
    }
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      ensureFrame();
      return;
    }
    failAll(reason);
  }

  function onMessage(data: unknown): void {
    if (isReadyMessage(data)) {
      ready = true;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      drain();
      return;
    }
    if (!isResultMessage(data) && !isErrorMessage(data)) return;
    if (inFlight === null || inFlight.id !== data.id) return;
    const job = inFlight;
    inFlight = null;
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (isResultMessage(data)) {
      remember(`${job.theme}\u0000${job.source}`, data.svg);
      job.resolve(data.svg);
    } else {
      job.reject(new Error(data.message));
    }
    drain();
  }

  function ensureFrame(): void {
    if (destroyed || failed || frame !== null) return;
    let next: SandboxFrame;
    try {
      next = createFrame();
    } catch {
      failAll("The Mermaid renderer could not start.");
      return;
    }
    frame = next;
    const onLoad = (): void => {
      next.removeEventListener("load", onLoad);
      if (destroyed || failed || frame !== next) return;
      try {
        transport = connect(next, onMessage);
      } catch {
        failFrame("The Mermaid renderer could not connect.");
        return;
      }
      connectTimer = setTimeout(() => {
        if (!ready) failFrame("The Mermaid renderer did not become ready.");
      }, connectTimeoutMs);
    };
    next.addEventListener("load", onLoad);
  }

  function drain(): void {
    if (!ready || inFlight !== null || transport === null) return;
    let job = queue.shift();
    while (job !== undefined && job.isCancelled?.() === true) {
      job.reject(new Error("cancelled"));
      job = queue.shift();
    }
    if (job === undefined) return;
    inFlight = job;
    const message: RenderMessage = {
      v: MERMAID_PROTOCOL_VERSION,
      type: "render",
      id: job.id,
      source: job.source,
      theme: job.theme,
      tokens: job.tokens,
    };
    try {
      transport.post(message);
    } catch {
      inFlight = null;
      job.reject(new Error("The Mermaid renderer is unavailable."));
      failFrame("The Mermaid renderer is unavailable.");
      return;
    }
    renderTimer = setTimeout(() => {
      if (inFlight !== job) return;
      inFlight = null;
      job.reject(new Error("The diagram renderer timed out."));
      failFrame("The diagram renderer timed out.");
    }, renderTimeoutMs);
  }

  function render(source: string, isCancelled?: () => boolean): Promise<string> {
    if (destroyed) return Promise.reject(new Error("The diagram renderer was destroyed."));
    if (failed) return Promise.reject(new Error(failureReason));
    if (source.length > MAX_SOURCE_CHARS) {
      return Promise.reject(new Error("Diagram source is too large"));
    }
    const { theme, tokens } = readTheme();
    const cached = cache.get(`${theme}\u0000${source}`);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      if (queue.length >= queueLimit) {
        reject(new Error("The diagram renderer is busy."));
        return;
      }
      queue.push({
        id: `hanse-${Date.now().toString(36)}-${sequence}`,
        source,
        theme,
        tokens,
        ...(isCancelled === undefined ? {} : { isCancelled }),
        resolve,
        reject,
      });
      sequence += 1;
      ensureFrame();
      drain();
    });
  }

  function destroy(): void {
    destroyed = true;
    failAll("The diagram renderer was destroyed.");
  }

  return { render, destroy };
}

let installed: SandboxClient | null = null;

export function installMermaidSandbox(): void {
  if (installed !== null || hasDiagramRenderer()) return;
  installed = createMermaidSandbox();
  registerDiagramRenderer((source, isCancelled) =>
    installed === null
      ? Promise.reject(new Error("not installed"))
      : installed.render(source, isCancelled),
  );
}
