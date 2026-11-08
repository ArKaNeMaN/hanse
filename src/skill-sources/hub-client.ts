import {
  type HubManifest,
  type ManifestFetchResult,
  SkillSourceError,
  type SkillSourceProvider,
} from "./types.js";
import { parseHubManifest } from "./validation.js";

const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const FILE_MAX_BYTES = 1024 * 1024;

export interface HubProviderOptions {
  endpoint: string;
  buckets: readonly string[];
  token: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillSourceError("response_too_large", "hub response exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export class HanseHubProvider implements SkillSourceProvider {
  readonly #endpoint: string;
  readonly #buckets: readonly string[];
  readonly #token: string | null;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HubProviderOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#buckets = options.buckets;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #headers(etag?: string | null): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#token !== null && this.#token.length > 0) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (etag !== undefined && etag !== null) {
      headers["if-none-match"] = etag;
    }
    return headers;
  }

  async fetchManifest(input: { etag?: string | null }): Promise<ManifestFetchResult> {
    const url = new URL(`${this.#endpoint}/api/v1/manifest`);
    if (this.#buckets.length > 0) {
      url.searchParams.set("buckets", this.#buckets.join(","));
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: this.#headers(input.etag),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SkillSourceError(
        "hub_unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const etag = response.headers.get("etag");
    if (response.status === 304) {
      return { notModified: true, etag };
    }
    if (response.status === 401 || response.status === 403) {
      throw new SkillSourceError("unauthorized", "hub rejected the source token");
    }
    if (!response.ok) {
      throw new SkillSourceError("hub_http_error", `hub returned HTTP ${response.status}`);
    }
    const bytes = await readLimited(response, MANIFEST_MAX_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new SkillSourceError("invalid_manifest", "hub manifest is not valid JSON");
    }
    return { notModified: false, etag, manifest: parseHubManifest(value) as HubManifest };
  }

  async fetchFile(input: { bucket: string; name: string; path: string }): Promise<Uint8Array> {
    const segments = input.path.split("/").map((segment) => encodeURIComponent(segment));
    const url = `${this.#endpoint}/api/v1/skills/${encodeURIComponent(input.bucket)}/${encodeURIComponent(
      input.name,
    )}/files/${segments.join("/")}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: this.#headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SkillSourceError(
        "hub_unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SkillSourceError("unauthorized", "hub rejected the source token");
    }
    if (!response.ok) {
      throw new SkillSourceError(
        "file_http_error",
        `hub returned HTTP ${response.status} for ${input.path}`,
      );
    }
    return readLimited(response, FILE_MAX_BYTES);
  }
}
