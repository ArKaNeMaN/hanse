import {
  type PreviewCleanup,
  PreviewError,
  type PreviewFailureCode,
  type PreviewOpenInput,
  type PreviewOperatorHost,
  type PreviewRecord,
  type PreviewView,
} from "./types.js";

export interface PreviewServiceOptions {
  now?: () => number;
  maxPerApp?: number;
  ttlMs?: number;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_MAX_LENGTH = 64;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const RESERVED_PORTS = new Set([4100]);
const DEFAULT_MAX_PER_APP = 8;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

function invalid(code: PreviewFailureCode, message: string): PreviewError {
  return new PreviewError(code, message);
}

function validateKey(value: unknown): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw invalid(
      "preview_invalid_key",
      "key must be 1-32 lowercase letters, digits, or hyphens and start with a letter or digit",
    );
  }
  return value;
}

function validateName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > NAME_MAX_LENGTH) {
    throw invalid("preview_invalid_name", "name must be 1-64 printable ASCII characters");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw invalid("preview_invalid_name", "name must be 1-64 printable ASCII characters");
    }
  }
  return value;
}

function validatePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("preview_invalid_port", "port must be an integer in 1024..65535");
  }
  if (value < MIN_PORT || value > MAX_PORT) {
    throw invalid("preview_invalid_port", "port must be an integer in 1024..65535");
  }
  if (RESERVED_PORTS.has(value)) {
    throw invalid("preview_reserved_port", `port ${value} is reserved`);
  }
  return value;
}

function validateTargetHost(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("/") ||
    value.includes(":") ||
    /\s/.test(value)
  ) {
    throw invalid("preview_internal_error", "targetHost must be a non-empty container name");
  }
  return value;
}

function basePathFor(record: PreviewRecord): string {
  const projectId = encodeURIComponent(record.projectId);
  const appKey = encodeURIComponent(record.appKey);
  const key = encodeURIComponent(record.key);
  return `/preview/${projectId}/${appKey}/${key}/`;
}

/** App-scoped, in-memory preview registry with lazy expiry and an operator-host memory. */
export class PreviewService implements PreviewCleanup {
  readonly #now: () => number;
  readonly #maxPerApp: number;
  readonly #ttlMs: number;
  readonly #byApp = new Map<string, Map<string, PreviewRecord>>();
  readonly #operatorHosts = new Map<string, PreviewOperatorHost>();

  constructor(options: PreviewServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxPerApp = options.maxPerApp ?? DEFAULT_MAX_PER_APP;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  open(input: PreviewOpenInput): PreviewRecord {
    const key = validateKey(input.key);
    const name = validateName(input.name);
    const port = validatePort(input.port);
    const targetHost = validateTargetHost(input.targetHost);

    const now = this.#now();
    this.#prune(input.appId, now);

    let records = this.#byApp.get(input.appId);
    if (records === undefined) {
      records = new Map<string, PreviewRecord>();
      this.#byApp.set(input.appId, records);
    }

    const expiresAt = now + this.#ttlMs;
    const existing = records.get(key);
    if (existing !== undefined) {
      const updated: PreviewRecord = {
        ...input,
        key,
        name,
        port,
        targetHost,
        createdAt: existing.createdAt,
        expiresAt,
      };
      records.set(key, updated);
      return updated;
    }

    if (records.size >= this.#maxPerApp) {
      throw invalid("preview_limit", `app ${input.appId} has reached its preview limit`);
    }

    const record: PreviewRecord = {
      ...input,
      key,
      name,
      port,
      targetHost,
      createdAt: now,
      expiresAt,
    };
    records.set(key, record);
    return record;
  }

  get(appId: string, key: string): PreviewRecord | undefined {
    this.#prune(appId, this.#now());
    return this.#byApp.get(appId)?.get(key);
  }

  list(appId: string): PreviewRecord[] {
    this.#prune(appId, this.#now());
    const records = this.#byApp.get(appId);
    if (records === undefined) {
      return [];
    }
    return [...records.values()].sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return right.createdAt - left.createdAt;
      }
      if (left.key < right.key) return -1;
      if (left.key > right.key) return 1;
      return 0;
    });
  }

  close(appId: string, key: string): boolean {
    this.#prune(appId, this.#now());
    const records = this.#byApp.get(appId);
    if (records === undefined) {
      return false;
    }
    const closed = records.delete(key);
    if (records.size === 0) {
      this.#byApp.delete(appId);
    }
    return closed;
  }

  clearApp(appId: string): void {
    this.#byApp.delete(appId);
    this.#operatorHosts.delete(appId);
  }

  clearAll(): void {
    this.#byApp.clear();
    this.#operatorHosts.clear();
  }

  /**
   * Remember the latest human chat-page `Host` for an app. Only a host-like value is accepted;
   * the raw value and a framework-allowlist-friendly hostname are stored.
   */
  recordOperatorHost(appId: string, host: string): void {
    if (typeof host !== "string" || host.length === 0) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      return;
    }
    if (
      parsed.hostname.length === 0 ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return;
    }
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (hostname.length === 0) {
      return;
    }
    this.#operatorHosts.set(appId, { host, hostname });
  }

  operatorHost(appId: string): PreviewOperatorHost | undefined {
    const entry = this.#operatorHosts.get(appId);
    return entry === undefined ? undefined : { host: entry.host, hostname: entry.hostname };
  }

  view(record: PreviewRecord): PreviewView {
    const basePath = basePathFor(record);
    return {
      key: record.key,
      name: record.name,
      port: record.port,
      url: basePath,
      basePath,
      basePathWithoutTrailingSlash: basePath.slice(0, -1),
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  views(appId: string): PreviewView[] {
    return this.list(appId).map((record) => this.view(record));
  }

  #prune(appId: string, now: number): void {
    const records = this.#byApp.get(appId);
    if (records === undefined) {
      return;
    }
    for (const [key, record] of records) {
      if (record.expiresAt <= now) {
        records.delete(key);
      }
    }
    if (records.size === 0) {
      this.#byApp.delete(appId);
    }
  }
}
