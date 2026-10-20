import type {
  ReconcileResponse,
  RuntimeAppStatus,
  RuntimeErrorBody,
  RuntimeLogs,
} from "./protocol.js";
import type { AppRuntimeSpec } from "./spec.js";

/**
 * Transport-neutral runtime API consumed by the coordinator.
 *
 * B0 implements it with {@link HttpAgentRuntimeClient} (the agent supervisor); B1/B2 reuse the same
 * interface for the container runner.
 */
export interface AgentRuntimeClient {
  /** Ensure one app host and return its effective status. Idempotent by `specHash`. */
  ensure(spec: AppRuntimeSpec): Promise<RuntimeAppStatus>;
  /** Stop one app host and return its final status. Unknown apps are a no-op. */
  delete(appId: string): Promise<RuntimeAppStatus>;
  /** Current status, or `undefined` when the app has never been started. */
  status(appId: string): Promise<RuntimeAppStatus | undefined>;
  /** Bounded logs, or `undefined` when the app has never been started. */
  logs(appId: string): Promise<RuntimeLogs | undefined>;
  /** Stop every host whose app id is not in the desired list. */
  reconcile(appIds: string[]): Promise<ReconcileResponse>;
}

/** Historical name used in the runtime plan; identical to {@link AgentRuntimeClient}. */
export type RuntimeClient = AgentRuntimeClient;

/** Typed runtime failure. `status` is 0 for transport failures. */
export class RuntimeClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly bodyExcerpt: string;

  constructor(status: number, message: string, code?: string, bodyExcerpt = "") {
    super(message);
    this.name = "RuntimeClientError";
    this.status = status;
    this.code = code;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export interface HttpAgentRuntimeClientOptions {
  /** Supervisor base URL, for example `http://127.0.0.1:8789`. */
  baseUrl: string;
  /** Shared `HANSE_RUNTIME_TOKEN`. */
  token: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 30 s to cover a cold host start. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_EXCERPT_CHARS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorBody(text: string): RuntimeErrorBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || typeof parsed.error !== "string") return undefined;
    return {
      error: parsed.error,
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
    };
  } catch {
    return undefined;
  }
}

function transportMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * HTTP client for the B0.4 supervisor.
 *
 * Every call sends `Authorization: Bearer <HANSE_RUNTIME_TOKEN>` and treats non-2xx responses as
 * typed errors. A 404 on `status`/`logs` means "never started", which the manager maps to a start.
 */
export class HttpAgentRuntimeClient implements AgentRuntimeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpAgentRuntimeClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl.length === 0) {
      throw new Error("agent runtime base URL is required");
    }
    if (options.token.trim().length === 0) {
      throw new Error("HANSE_RUNTIME_TOKEN is required");
    }
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ensure(spec: AppRuntimeSpec): Promise<RuntimeAppStatus> {
    return (await this.#request<RuntimeAppStatus>(
      "POST",
      `/v1/apps/${encodeURIComponent(spec.appId)}/ensure`,
      spec,
    )) as RuntimeAppStatus;
  }

  async delete(appId: string): Promise<RuntimeAppStatus> {
    return (await this.#request<RuntimeAppStatus>(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}`,
    )) as RuntimeAppStatus;
  }

  status(appId: string): Promise<RuntimeAppStatus | undefined> {
    return this.#request<RuntimeAppStatus>(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}`,
      undefined,
      true,
    );
  }

  logs(appId: string): Promise<RuntimeLogs | undefined> {
    return this.#request<RuntimeLogs>(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/logs`,
      undefined,
      true,
    );
  }

  async reconcile(appIds: string[]): Promise<ReconcileResponse> {
    return (await this.#request<ReconcileResponse>("POST", "/v1/reconcile", {
      appIds,
    })) as ReconcileResponse;
  }

  async #request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    notFoundIsUndefined = false,
  ): Promise<T | undefined> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RuntimeClientError(
        0,
        `runtime ${method} ${path} failed: ${transportMessage(error)}`,
      );
    }

    const text = await response.text().catch(() => "");
    if (response.status === 404 && notFoundIsUndefined) {
      return undefined;
    }
    if (!response.ok) {
      const parsed = errorBody(text);
      const detail = parsed?.error ?? text.slice(0, ERROR_EXCERPT_CHARS) ?? "";
      throw new RuntimeClientError(
        response.status,
        `runtime ${method} ${path} -> ${response.status}: ${detail}`,
        parsed?.code,
        text.slice(0, ERROR_EXCERPT_CHARS),
      );
    }
    if (text.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RuntimeClientError(
        response.status,
        `runtime ${method} ${path} returned invalid JSON`,
      );
    }
  }
}

/** Alias for the B0 supervisor transport; B1 keeps the interface and swaps the implementation. */
export { HttpAgentRuntimeClient as SupervisorRuntimeClient };
