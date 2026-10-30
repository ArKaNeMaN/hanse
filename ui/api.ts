/**
 * Framework-free JSON client for the SPA surface.
 *
 * Queries are cookie-only same-origin reads; mutations carry `X-Hanse-Client: spa` so the
 * coordinator can answer with JSON instead of the legacy `303`. A 401 sends the browser to the
 * login page with the current local path preserved.
 */

export interface ApiRequestOptions {
  /** Test seam; production redirects to `/login?next=<current path>`. */
  readonly onUnauthorized?: (nextPath: string) => void;
  /** Abort a stale workspace read (session switch, app switch, unmount). */
  readonly signal?: AbortSignal;
}

export type ApiMutationBody =
  | { readonly form: Record<string, string> }
  | { readonly json: unknown };

export interface ApiMutationOptions extends ApiRequestOptions {
  /**
   * Defaults to `POST`; the SSH host API uses `PATCH` for updates, chat drafts use `PUT`, and
   * deletes use `DELETE`.
   */
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Optional delivery outcome (`unknown` / `not_sent`) carried by prompt sends. */
  readonly outcome: string | undefined;
  /** Parsed response payload, retained for callers that need message ids on failure. */
  readonly payload: unknown;

  constructor(message: string, status: number, code?: string, outcome?: string, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.outcome = outcome;
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentLocalPath(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function defaultUnauthorized(nextPath: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.location.assign(`/login?next=${encodeURIComponent(nextPath)}`);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorFrom(response: Response, payload: unknown): ApiError {
  const message =
    isRecord(payload) && typeof payload.error === "string" && payload.error.length > 0
      ? payload.error
      : `Request failed (${response.status})`;
  const code =
    isRecord(payload) && typeof payload.code === "string" && payload.code.length > 0
      ? payload.code
      : undefined;
  const outcome =
    isRecord(payload) && typeof payload.outcome === "string" && payload.outcome.length > 0
      ? payload.outcome
      : undefined;
  return new ApiError(message, response.status, code, outcome, payload);
}

async function parse<T>(response: Response, options: ApiRequestOptions): Promise<T> {
  const payload = await readPayload(response);
  if (response.status === 401) {
    const next = currentLocalPath();
    (options.onUnauthorized ?? defaultUnauthorized)(next);
    throw new ApiError("sign in required", 401, "unauthenticated");
  }
  if (!response.ok) {
    throw errorFrom(response, payload);
  }
  return payload as T;
}

/** `GET` a JSON endpoint with same-origin credentials. */
export async function apiQuery<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parse<T>(response, options);
}

/**
 * Write a form-encoded or JSON body (`POST` by default, or an explicit `PATCH`/`DELETE`). The
 * header is mandatory: without it the coordinator keeps the legacy `303` success path.
 */
export async function apiMutation<T>(
  path: string,
  body: ApiMutationBody,
  options: ApiMutationOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-hanse-client": "spa",
  };
  let payload: string;
  if ("form" in body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body.form).toString();
  } else {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body.json);
  }

  const { method = "POST", signal, ...requestOptions } = options;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
  return parse<T>(response, requestOptions);
}
