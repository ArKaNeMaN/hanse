import type {
  DeepSeekOptions,
  WebDriver,
  WebFetchInput,
  WebFetchOutput,
  WebSearchInput,
  WebSearchOutput,
  WebSearchResult,
} from "../types.js";

/** Default DeepSeek API origin. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Maximum search query length enforced before any request is sent. */
export const MAX_SEARCH_QUERY_CHARS = 2048;
/** Maximum fetch URL length enforced before any request is sent. */
export const MAX_FETCH_URL_CHARS = 8192;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONTENT_CHARS = 20_000;
const MAX_TITLE_CHARS = 1024;
const MAX_SNIPPET_CHARS = 4096;
const MAX_URL_CHARS = 8192;
const MAX_RESULTS = 20;

export type WebDriverErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "timeout"
  | "network"
  | "too_large"
  | "invalid_response";

/** Driver failure with a message safe to return to an agent (never contains key material). */
export class WebDriverError extends Error {
  readonly code: WebDriverErrorCode;

  constructor(code: WebDriverErrorCode, message: string) {
    super(message);
    this.name = "WebDriverError";
    this.code = code;
  }
}

export interface DeepSeekDriverConfig extends DeepSeekOptions {
  /** Plaintext API key for the configured provider. */
  apiKey: string;
  /** API origin; injectable for tests. */
  baseUrl?: string;
  /** fetch implementation; injectable for tests. */
  fetch?: typeof fetch;
}

/** Standalone DeepSeek Search/Fetch client. */
export class DeepSeekDriver implements WebDriver {
  readonly id = "deepseek";

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #count: number | undefined;
  readonly #needContent: boolean | undefined;
  readonly #timeoutMs: number;
  readonly #maxContentChars: number;

  constructor(config: DeepSeekDriverConfig) {
    if (typeof config.apiKey !== "string" || config.apiKey.length === 0) {
      throw new WebDriverError("invalid_input", "DeepSeek API key is required");
    }
    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
    this.#fetch = config.fetch ?? fetch;
    this.#count = config.count;
    this.#needContent = config.needContent;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxContentChars = config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  }

  async search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchOutput> {
    const query = validateQuery(input.query);
    const count = input.count ?? this.#count;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS)) {
      throw new WebDriverError("invalid_input", "search count must be an integer from 1 to 20");
    }
    const needContent = input.needContent ?? this.#needContent;
    const body: { query: string; count?: number; need_content?: boolean } = { query };
    if (count !== undefined) {
      body.count = count;
    }
    if (needContent !== undefined) {
      body.need_content = needContent;
    }

    const raw = await this.#post("/v1/tools/search", body, signal);
    if (!isRecord(raw) || !Array.isArray(raw.results)) {
      throw new WebDriverError("invalid_response", "DeepSeek returned an invalid search response");
    }
    const results: WebSearchResult[] = [];
    for (const item of raw.results) {
      if (!isRecord(item)) {
        continue;
      }
      const title = capString(item.title, MAX_TITLE_CHARS);
      const url = capString(item.url, MAX_URL_CHARS);
      if (title.length === 0 && url.length === 0) {
        continue;
      }
      const result: WebSearchResult = { title, url };
      const snippet = capString(item.snippet, MAX_SNIPPET_CHARS);
      const summary = capString(item.summary, MAX_SNIPPET_CHARS);
      const display = snippet.length > 0 ? snippet : summary;
      if (display.length > 0) {
        result.snippet = display;
      }
      const content = capString(item.content, this.#maxContentChars);
      if (content.length > 0) {
        result.content = content;
      }
      const siteName = capString(item.site_name, MAX_SNIPPET_CHARS);
      if (siteName.length > 0) {
        result.siteName = siteName;
      }
      const publishedAt = capString(item.date, MAX_TITLE_CHARS);
      if (publishedAt.length > 0) {
        result.publishedAt = publishedAt;
      }
      results.push(result);
    }
    return { query, results };
  }

  async fetch(input: WebFetchInput, signal: AbortSignal): Promise<WebFetchOutput> {
    const url = validateFetchUrl(input.url);
    const raw = await this.#post("/v1/tools/fetch", { url }, signal);
    if (!isRecord(raw) || typeof raw.content !== "string") {
      throw new WebDriverError("invalid_response", "DeepSeek returned an invalid fetch response");
    }
    const output: WebFetchOutput = {
      url,
      content: capString(raw.content, this.#maxContentChars),
    };
    const title = capString(raw.title, MAX_TITLE_CHARS);
    if (title.length > 0) {
      output.title = title;
    }
    return output;
  }

  async #post(endpoint: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined =
      typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch {
      if (timeout.aborted) {
        throw new WebDriverError("timeout", "DeepSeek request timed out");
      }
      throw new WebDriverError("network", "DeepSeek request failed");
    }

    if (!response.ok) {
      throw statusError(response.status);
    }

    const maxBytes = Math.max(4 * 1024 * 1024, this.#maxContentChars * 6);
    let text: string;
    try {
      text = await readTextBounded(response, maxBytes);
    } catch (error) {
      if (error instanceof WebDriverError) {
        throw error;
      }
      if (timeout.aborted) {
        throw new WebDriverError("timeout", "DeepSeek request timed out");
      }
      throw new WebDriverError("network", "DeepSeek request failed");
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WebDriverError("invalid_response", "DeepSeek returned an invalid response");
    }
  }
}

export function validateQuery(query: unknown): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new WebDriverError("invalid_input", "query must be a non-empty string");
  }
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new WebDriverError(
      "invalid_input",
      `query must be at most ${MAX_SEARCH_QUERY_CHARS} characters`,
    );
  }
  return query;
}

export function validateFetchUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WebDriverError("invalid_input", "url must be a non-empty string");
  }
  if (value.length > MAX_FETCH_URL_CHARS) {
    throw new WebDriverError(
      "invalid_input",
      `url must be at most ${MAX_FETCH_URL_CHARS} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebDriverError("invalid_input", "url must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebDriverError("invalid_input", "url must be a valid HTTP or HTTPS URL");
  }
  if (parsed.hostname.length === 0) {
    throw new WebDriverError("invalid_input", "url must include a host");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new WebDriverError("invalid_input", "url must not contain credentials");
  }
  return value;
}

function statusError(status: number): WebDriverError {
  if (status === 401) {
    return new WebDriverError("unauthorized", "DeepSeek authentication failed (401)");
  }
  if (status === 403) {
    return new WebDriverError("forbidden", "DeepSeek access forbidden (403)");
  }
  if (status === 429) {
    return new WebDriverError("rate_limited", "DeepSeek rate limit exceeded (429); retry later");
  }
  if (status >= 500) {
    return new WebDriverError("server_error", `DeepSeek service error (${status}); retry later`);
  }
  return new WebDriverError("http_error", `DeepSeek request failed (${status})`);
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebDriverError("too_large", "DeepSeek response exceeded the size limit");
  }
  if (response.body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new WebDriverError("too_large", "DeepSeek response exceeded the size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new WebDriverError("too_large", "DeepSeek response exceeded the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capString(value: unknown, limit: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > limit ? value.slice(0, limit) : value;
}
