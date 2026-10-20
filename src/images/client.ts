/**
 * Coordinator client for the runner's per-app image build endpoints.
 *
 * The coordinator never talks to Docker itself; it forwards one validated build spec and reads the
 * runner's bounded status/log records. The runtime token is only ever sent in the Authorization
 * header and is deliberately excluded from every error message.
 */

export type RunnerImageStatus = "missing" | "building" | "ready" | "error";

export interface ImageBuildInput {
  appId: string;
  /** Absolute host path the runner will contain under HANSE_HOST_WORKSPACE. */
  appDir: string;
  /** Dockerfile path relative to the app directory. */
  dockerfile: string;
  /** Default/base image reference, including an optional digest. */
  baseImage: string;
  buildArgs?: Record<string, string>;
  specHash?: string;
}

export interface ImageBuildResult {
  buildId: string;
  appId: string;
  status: "building";
}

export interface RunnerImageRecord {
  appId: string;
  status: RunnerImageStatus;
  imageRef: string | null;
  imageId: string | null;
  buildId: string | null;
  logs: string;
  error: string | null;
  updatedAt: string | null;
}

export interface RunnerImageClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Status/build-start requests are bounded; they never wait for the build itself. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 120_000;
const ERROR_EXCERPT_CHARS = 300;
const STATUSES: ReadonlySet<string> = new Set(["missing", "building", "ready", "error"]);

/** Typed failure from the runner image API. `transport` marks a network/timeout failure. */
export class ImageClientError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly transport: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; transport?: boolean } = {},
  ) {
    super(message);
    this.name = "ImageClientError";
    this.status = options.status ?? 0;
    this.code = options.code;
    this.transport = options.transport ?? false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function transportMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : String(error);
}

function parseRecord(value: unknown): RunnerImageRecord {
  if (!isRecord(value)) {
    throw new ImageClientError("image runner returned an invalid record");
  }
  const status = value.status;
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new ImageClientError("image runner returned an unknown image status");
  }
  if (typeof value.appId !== "string" || value.appId.length === 0) {
    throw new ImageClientError("image runner returned a record without an app id");
  }
  return {
    appId: value.appId,
    status: status as RunnerImageStatus,
    imageRef: stringOrNull(value.imageRef),
    imageId: stringOrNull(value.imageId),
    buildId: stringOrNull(value.buildId),
    logs: typeof value.logs === "string" ? value.logs : "",
    error: stringOrNull(value.error),
    updatedAt: stringOrNull(value.updatedAt),
  };
}

export class RunnerImageClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: RunnerImageClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl.length === 0) {
      throw new Error("image runner base URL is required");
    }
    if (options.token.trim().length === 0) {
      throw new Error("HANSE_RUNTIME_TOKEN is required for runner-backed image builds");
    }
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async build(input: ImageBuildInput): Promise<ImageBuildResult> {
    const parsed = await this.#request(
      "/v1/images/build",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      BUILD_TIMEOUT_MS,
    );
    if (
      !isRecord(parsed) ||
      typeof parsed.buildId !== "string" ||
      typeof parsed.appId !== "string" ||
      parsed.status !== "building"
    ) {
      throw new ImageClientError("image runner returned an invalid build response");
    }
    return { buildId: parsed.buildId, appId: parsed.appId, status: "building" };
  }

  async get(appId: string): Promise<RunnerImageRecord> {
    const parsed = await this.#request(
      `/v1/images/${encodeURIComponent(appId)}`,
      { method: "GET" },
      this.#timeoutMs,
    );
    return parseRecord(parsed);
  }

  /** Fetch a historical build record; an unknown build returns `undefined`. */
  async getBuild(buildId: string): Promise<RunnerImageRecord | undefined> {
    try {
      const parsed = await this.#request(
        `/v1/images/builds/${encodeURIComponent(buildId)}`,
        { method: "GET" },
        this.#timeoutMs,
      );
      return parseRecord(parsed);
    } catch (error) {
      if (error instanceof ImageClientError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async #request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "image runner request timed out"
          : `image runner request failed: ${transportMessage(error)}`;
      throw new ImageClientError(message, { transport: true });
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = text.trim().length === 0 ? undefined : JSON.parse(text);
      } catch {
        payload = undefined;
      }
      if (isRecord(payload) && typeof payload.error === "string") {
        throw new ImageClientError(payload.error, {
          status: response.status,
          code: typeof payload.code === "string" ? payload.code : undefined,
        });
      }
      throw new ImageClientError(
        `image runner rejected the request with HTTP ${response.status}: ${text.slice(
          0,
          ERROR_EXCERPT_CHARS,
        )}`,
        { status: response.status },
      );
    }

    if (text.trim().length === 0) {
      throw new ImageClientError("image runner returned an empty response");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ImageClientError("image runner returned invalid JSON");
    }
  }
}
