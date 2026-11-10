import http from "node:http";
import https from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/** Default Bot API base URL (design §9). */
export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
/** The transport never waits longer than this for a Bot API response. */
export const TELEGRAM_TIMEOUT_MS = 15_000;
/** A Bot API response larger than this is treated as unavailable. */
export const TELEGRAM_MAX_RESPONSE_BYTES = 1024 * 1024;

const MAX_DESCRIPTION_LENGTH = 500;
const HTTP_PROXY_PROTOCOLS = new Set(["http:", "https:"]);
const SOCKS_PROXY_PROTOCOLS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

export type TelegramErrorCode =
  | "telegram_unavailable"
  | "telegram_unauthorized"
  | "telegram_rate_limited"
  | "telegram_format"
  | "telegram_not_found"
  | "telegram_rejected";

/**
 * A sanitized Bot API failure.
 *
 * `description` never contains the bot token or the proxy URL; callers may surface it in the
 * settings page or the outbox row. `retryAfterSeconds` is copied from `parameters.retry_after`
 * when Telegram returns a 429.
 */
export class TelegramApiError extends Error {
  readonly code: TelegramErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: TelegramErrorCode,
    description: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(description);
    this.name = "TelegramApiError";
    this.code = code;
    this.status = options.status ?? 0;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The Bot API seam used by the client and the settings test endpoint. */
export interface TelegramTransport {
  call(method: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface TelegramNodeRequest {
  protocol: "http" | "https";
  url: URL;
  body: string;
  agent: http.Agent;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface TelegramNodeResponse {
  status: number;
  body: string;
  tooLarge?: boolean;
}

export type TelegramNodeRequestFn = (request: TelegramNodeRequest) => Promise<TelegramNodeResponse>;

export interface TelegramRequestPlan {
  protocol: "http" | "https";
  agent: http.Agent;
  agentKind: "https-proxy" | "http-proxy" | "socks-proxy";
}

export interface TelegramTransportOptions {
  token: string;
  apiBaseUrl?: string;
  proxyUrl?: string | null;
  fetchImpl?: typeof fetch;
  nodeRequest?: TelegramNodeRequestFn;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Join the configured base URL, bot token, and method with exactly one slash. */
export function telegramApiUrl(apiBaseUrl: string, token: string, method: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/bot${token}/${method}`;
}

/**
 * Select the node request module and proxy agent for a target/proxy pair (design §9).
 *
 * `https:` targets use `node:https`; `http:` targets use `node:http`. An HTTP(S) proxy uses
 * `HttpsProxyAgent` for an HTTPS target and `HttpProxyAgent` for an HTTP target. SOCKS5 proxies
 * use `SocksProxyAgent` with the module matching the target protocol.
 */
export function createRequestPlan(target: URL, proxy: URL): TelegramRequestPlan {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TelegramApiError(
      "telegram_unavailable",
      `unsupported Telegram target protocol: ${target.protocol}`,
    );
  }
  const protocol = target.protocol === "https:" ? "https" : "http";
  if (HTTP_PROXY_PROTOCOLS.has(proxy.protocol)) {
    if (protocol === "https") {
      return { protocol, agent: new HttpsProxyAgent(proxy), agentKind: "https-proxy" };
    }
    return { protocol, agent: new HttpProxyAgent(proxy), agentKind: "http-proxy" };
  }
  if (SOCKS_PROXY_PROTOCOLS.has(proxy.protocol)) {
    return { protocol, agent: new SocksProxyAgent(proxy), agentKind: "socks-proxy" };
  }
  throw new TelegramApiError(
    "telegram_unavailable",
    `unsupported proxy protocol: ${proxy.protocol}`,
  );
}

function combineSignals(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal.aborted) abort(signal.reason);
  else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
  if (!controller.signal.aborted) {
    timeout.addEventListener("abort", () => abort(timeout.reason), { once: true });
  }
  return controller.signal;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "<redacted>");
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    result = result.split(secret).join("<redacted>");
  }
  return result.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "request failed";
}

function isFormatDescription(description: string): boolean {
  return /parse|format|entit|too long|too large|limit|rich_message|block|table|invalid markdown|unsupported/i.test(
    description,
  );
}

function classifyStatus(status: number, description: string): TelegramErrorCode {
  if (status === 401 || status === 403) return "telegram_unauthorized";
  if (status === 429) return "telegram_rate_limited";
  if (status === 404) return "telegram_not_found";
  if (status === 400) {
    return isFormatDescription(description) ? "telegram_format" : "telegram_rejected";
  }
  if (status >= 500 || status === 0) return "telegram_unavailable";
  return "telegram_rejected";
}

interface TelegramResponseBody {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: unknown };
}

function parseBody(text: string): TelegramResponseBody | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as TelegramResponseBody;
  } catch {
    return undefined;
  }
}

function retryAfterOf(body: TelegramResponseBody | undefined): number | undefined {
  const value = body?.parameters?.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function failure(
  status: number,
  body: TelegramResponseBody | undefined,
  rawDescription: string,
  secrets: readonly string[],
): TelegramApiError {
  const description =
    typeof body?.description === "string" && body.description.length > 0
      ? body.description
      : rawDescription;
  const effectiveStatus =
    typeof body?.error_code === "number" && body.error_code > 0 ? body.error_code : status;
  const code = classifyStatus(effectiveStatus, description);
  return new TelegramApiError(code, redact(description, secrets) || "Telegram request failed", {
    status: effectiveStatus,
    retryAfterSeconds: retryAfterOf(body),
  });
}

function unwrap(status: number, text: string, secrets: readonly string[]): unknown {
  const body = parseBody(text);
  if (body === undefined || typeof body.ok !== "boolean") {
    throw new TelegramApiError("telegram_unavailable", "Telegram returned an invalid response", {
      status,
    });
  }
  if (body.ok === true) return body.result;
  throw failure(status, body, "Telegram rejected the request", secrets);
}

async function readFetchText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (tooLarge) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (tooLarge) {
    throw new TelegramApiError(
      "telegram_unavailable",
      `Telegram response exceeded ${maxBytes} bytes`,
    );
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function defaultNodeRequest(request: TelegramNodeRequest): Promise<TelegramNodeResponse> {
  const module = request.protocol === "https" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const outgoing = module.request(
      request.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(request.body)),
        },
        agent: request.agent,
        signal: request.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;
        response.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          total += chunk.length;
          if (total > request.maxResponseBytes) {
            tooLarge = true;
            chunks.length = 0;
            response.destroy();
            finish(() => resolve({ status: response.statusCode ?? 0, body: "", tooLarge: true }));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
              tooLarge,
            }),
          );
        });
        response.on("error", (error) => finish(() => reject(error)));
      },
    );
    outgoing.setTimeout(request.timeoutMs, () => {
      outgoing.destroy(new Error("Telegram request timed out"));
    });
    outgoing.on("error", (error) => finish(() => reject(error)));
    outgoing.end(request.body);
  });
}

function networkFailure(
  error: unknown,
  combined: AbortSignal,
  external: AbortSignal,
  secrets: readonly string[],
): TelegramApiError {
  if (external.aborted) {
    return new TelegramApiError("telegram_unavailable", "Telegram request aborted");
  }
  if (combined.aborted) {
    return new TelegramApiError("telegram_unavailable", "Telegram request timed out");
  }
  return new TelegramApiError(
    "telegram_unavailable",
    redact(messageOf(error), secrets) || "Telegram request failed",
  );
}

/** Direct `fetch` or proxied `node:http(s).request` Bot API transport. */
export class TelegramHttpTransport implements TelegramTransport {
  readonly #token: string;
  readonly #apiBaseUrl: string;
  readonly #proxyUrl: string | null;
  readonly #fetch: typeof fetch;
  readonly #nodeRequest: TelegramNodeRequestFn;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  #cachedProxyUrl: string | null = null;
  #cachedPlan: TelegramRequestPlan | undefined;

  constructor(options: TelegramTransportOptions) {
    this.#token = options.token;
    this.#apiBaseUrl = options.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL;
    this.#proxyUrl = options.proxyUrl ?? null;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#nodeRequest = options.nodeRequest ?? defaultNodeRequest;
    this.#timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? TELEGRAM_MAX_RESPONSE_BYTES;
  }

  async call(method: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const url = telegramApiUrl(this.#apiBaseUrl, this.#token, method);
    const secrets = this.#secrets();
    const combined = combineSignals(signal, this.#timeoutMs);
    if (this.#proxyUrl === null) {
      return this.#callDirect(url, body, combined, signal, secrets);
    }
    return this.#callProxied(url, body, combined, signal, secrets);
  }

  #secrets(): string[] {
    return this.#proxyUrl === null ? [this.#token] : [this.#token, this.#proxyUrl];
  }

  async #callDirect(
    url: string,
    body: unknown,
    combined: AbortSignal,
    external: AbortSignal,
    secrets: readonly string[],
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      throw networkFailure(error, combined, external, secrets);
    }
    let text: string;
    try {
      text = await readFetchText(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw networkFailure(error, combined, external, secrets);
    }
    return unwrap(response.status, text, secrets);
  }

  async #callProxied(
    url: string,
    body: unknown,
    combined: AbortSignal,
    external: AbortSignal,
    secrets: readonly string[],
  ): Promise<unknown> {
    let response: TelegramNodeResponse;
    try {
      const target = new URL(url);
      const proxy = new URL(this.#proxyUrl ?? "");
      const plan = this.#plan(target, proxy);
      response = await this.#nodeRequest({
        protocol: plan.protocol,
        url: target,
        body: JSON.stringify(body),
        agent: plan.agent,
        signal: combined,
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: this.#maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw networkFailure(error, combined, external, secrets);
    }
    if (response.tooLarge === true) {
      throw new TelegramApiError(
        "telegram_unavailable",
        `Telegram response exceeded ${this.#maxResponseBytes} bytes`,
      );
    }
    return unwrap(response.status, response.body, secrets);
  }

  #plan(target: URL, proxy: URL): TelegramRequestPlan {
    if (this.#cachedPlan === undefined || this.#cachedProxyUrl !== this.#proxyUrl) {
      this.#cachedPlan = createRequestPlan(target, proxy);
      this.#cachedProxyUrl = this.#proxyUrl;
    }
    return this.#cachedPlan;
  }
}

export function createTelegramTransport(options: TelegramTransportOptions): TelegramTransport {
  return new TelegramHttpTransport(options);
}
