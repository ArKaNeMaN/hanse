import {
  listProviders,
  type OpencodeModelLimit,
  type OpencodeProviderModel,
  type OpencodeProviders,
} from "../opencode/client.js";

export interface ModalityCapabilities {
  image?: boolean;
  video?: boolean;
  pdf?: boolean;
}

export interface ModelCapabilities {
  input?: ModalityCapabilities;
  attachment?: boolean;
}

export interface ModelCatalogEntry {
  providerID: string;
  modelID: string;
  capabilities: ModelCapabilities;
  limit: OpencodeModelLimit;
}

export type CapabilityOutcome =
  | { status: "known"; entry: ModelCatalogEntry }
  | { status: "unknown" };

export interface CapabilityResolverOptions {
  loadCatalog?: (endpoint: string) => Promise<OpencodeProviders>;
  /** Catalog failure is retried once, then reported unknown (design §D4/D10). */
  retries?: number;
  timeoutMs?: number;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceCapabilities(value: unknown): ModelCapabilities {
  const record = asRecord(value);
  if (record === undefined) return {};
  const input = asRecord(record.input);
  const capabilities: ModelCapabilities = {};
  if (input !== undefined) {
    const modalities: ModalityCapabilities = {};
    const image = optionalBoolean(input.image);
    const video = optionalBoolean(input.video);
    const pdf = optionalBoolean(input.pdf);
    if (image !== undefined) modalities.image = image;
    if (video !== undefined) modalities.video = video;
    if (pdf !== undefined) modalities.pdf = pdf;
    capabilities.input = modalities;
  }
  const attachment = optionalBoolean(record.attachment);
  if (attachment !== undefined) capabilities.attachment = attachment;
  return capabilities;
}

function coerceLimit(value: unknown): OpencodeModelLimit {
  const record = asRecord(value);
  if (record === undefined) return {};
  const limit: OpencodeModelLimit = {};
  if (typeof record.context === "number") limit.context = record.context;
  if (typeof record.input === "number") limit.input = record.input;
  if (typeof record.output === "number") limit.output = record.output;
  return limit;
}

/** Split a `provider/model` setting exactly once; model ids may contain slashes. */
export function parseModelSetting(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function findCatalogEntry(
  catalog: OpencodeProviders,
  model: string | undefined,
): ModelCatalogEntry | undefined {
  const parsed = parseModelSetting(model);
  if (parsed === undefined) return undefined;
  for (const provider of catalog.providers) {
    if (provider.id !== parsed.providerID) continue;
    const entry = provider.models[parsed.modelID];
    if (entry === undefined) return undefined;
    return {
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      capabilities: coerceCapabilities((entry as OpencodeProviderModel).capabilities),
      limit: coerceLimit((entry as OpencodeProviderModel).limit),
    };
  }
  return undefined;
}

/**
 * Resolve the effective model's catalogue entry. A missing catalogue or missing model is
 * `unknown`, never a silent capability grant.
 */
export async function resolveModelCapabilities(
  endpoint: string,
  model: string | undefined,
  options: CapabilityResolverOptions = {},
): Promise<CapabilityOutcome> {
  if (parseModelSetting(model) === undefined) return { status: "unknown" };
  const load = options.loadCatalog ?? ((target: string) => listProviders(target));
  const attempts = Math.max(1, (options.retries ?? 1) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const catalog = await load(endpoint);
      const entry = findCatalogEntry(catalog, model);
      return entry === undefined ? { status: "unknown" } : { status: "known", entry };
    } catch {
      // Retry once, then fall back to file mode.
    }
  }
  return { status: "unknown" };
}

export function modalitySupported(
  capabilities: ModelCapabilities,
  kind: "image" | "video" | "pdf",
): boolean | undefined {
  if (capabilities.attachment !== true) {
    return capabilities.attachment === false ? false : undefined;
  }
  const support = capabilities.input?.[kind];
  return support === true ? true : support === false ? false : undefined;
}
