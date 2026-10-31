import { hashValue } from "../settings/hash.js";
import { ModelProviderValidationError } from "./errors.js";
import {
  MODEL_MODALITIES,
  type ModelModality,
  type ModelProvider,
  type ModelProviderCost,
  type ModelProviderInput,
  type ModelProviderLimit,
  type ModelProviderModalities,
  type ModelProviderModel,
  PROVIDER_NPM,
  type ProviderOverlay,
  type ProviderOverlayModel,
} from "./types.js";

export const MAX_PROVIDERS = 32;
export const MAX_PROVIDER_MODELS = 64;
export const MAX_PROVIDER_PROJECTION_BYTES = 48 * 1024;
export const MAX_PROVIDER_ID = 128;
export const MAX_MODEL_ID = 256;

/** A curated warning set; the full models.dev catalog is intentionally out of scope. */
export const KNOWN_BUNDLED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
  "groq",
  "mistral",
  "xai",
  "cerebras",
  "github-copilot",
  "amazon-bedrock",
  "azure",
]);

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_ID_RE = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TOKENS = 10_000_000;
const MAX_PRICE = 1_000_000;
const MAX_MODEL_NAME = 128;
const MAX_PROVIDER_NAME = 128;
const MAX_BASE_URL = 2048;
const MODALITY_SET: ReadonlySet<string> = new Set(MODEL_MODALITIES);
const DEFAULT_ATTACHMENT_INPUT_MODALITIES: ModelModality[] = ["text", "image", "video", "pdf"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ModelProviderValidationError(`${field} must be a string`);
  }
  return value;
}

export function validateProviderId(value: unknown): string {
  const id = requireString(value, "provider id").trim();
  if (id.length < 1 || id.length > MAX_PROVIDER_ID) {
    throw new ModelProviderValidationError(
      `provider id must be between 1 and ${MAX_PROVIDER_ID} characters`,
    );
  }
  if (!PROVIDER_ID_RE.test(id) || PROTOTYPE_KEYS.has(id)) {
    throw new ModelProviderValidationError(
      "provider id must match ^[a-z0-9][a-z0-9._-]*$ and must not be a prototype key",
    );
  }
  return id;
}

export function validateProviderName(value: unknown, fallbackId: string): string {
  if (value === undefined || value === null) {
    return fallbackId;
  }
  const name = requireString(value, "provider name").trim();
  if (name.length === 0) {
    return fallbackId;
  }
  if (name.length > MAX_PROVIDER_NAME) {
    throw new ModelProviderValidationError(
      `provider name must be at most ${MAX_PROVIDER_NAME} characters`,
    );
  }
  if (hasControlCharacters(name)) {
    throw new ModelProviderValidationError("provider name must not contain control characters");
  }
  return name;
}

export function validateBaseUrl(value: unknown): string {
  const raw = requireString(value, "base URL").trim();
  if (raw.length < 1 || raw.length > MAX_BASE_URL) {
    throw new ModelProviderValidationError(
      `base URL must be between 1 and ${MAX_BASE_URL} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ModelProviderValidationError("base URL must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProviderValidationError("base URL must use http or https");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ModelProviderValidationError("base URL must not contain user information");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new ModelProviderValidationError("base URL must not contain a query or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  let normalized = parsed.toString();
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function validateModelId(value: unknown): string {
  const id = requireString(value, "model id").trim();
  if (id.length < 1 || id.length > MAX_MODEL_ID) {
    throw new ModelProviderValidationError(
      `model id must be between 1 and ${MAX_MODEL_ID} characters`,
    );
  }
  if (!MODEL_ID_RE.test(id) || PROTOTYPE_KEYS.has(id)) {
    throw new ModelProviderValidationError(
      "model id must match ^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$ and must not be a prototype key",
    );
  }
  return id;
}

function validateModelName(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const name = requireString(value, "model name").trim();
  if (name.length === 0) {
    return undefined;
  }
  if (name.length > MAX_MODEL_NAME) {
    throw new ModelProviderValidationError(
      `model name must be at most ${MAX_MODEL_NAME} characters`,
    );
  }
  if (hasControlCharacters(name) || name.includes("|")) {
    throw new ModelProviderValidationError(
      "model name must not contain control characters or the | separator",
    );
  }
  return name;
}

function validateToken(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TOKENS) {
    throw new ModelProviderValidationError(
      `${field} must be an integer between 1 and ${MAX_TOKENS}`,
    );
  }
  return value;
}

function validateOptionalToken(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return validateToken(value, field);
}

function validateOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ModelProviderValidationError(`${field} must be a boolean`);
  }
  return value;
}

function validatePrice(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    throw new ModelProviderValidationError(`${field} must be a number between 0 and ${MAX_PRICE}`);
  }
  return value;
}

function validateCost(value: unknown): ModelProviderCost | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ModelProviderValidationError("model cost must be an object");
  }
  return {
    input: validatePrice(value.input, "cost input"),
    output: validatePrice(value.output, "cost output"),
    ...(value.cacheRead === undefined
      ? {}
      : { cacheRead: validatePrice(value.cacheRead, "cost cache read") }),
    ...(value.cacheWrite === undefined
      ? {}
      : { cacheWrite: validatePrice(value.cacheWrite, "cost cache write") }),
  };
}

function validateModalityList(value: unknown, field: string): ModelModality[] | undefined {
  if (!Array.isArray(value)) {
    throw new ModelProviderValidationError(`${field} must be an array`);
  }
  const seen = new Set<ModelModality>();
  for (const entry of value) {
    if (typeof entry !== "string" || !MODALITY_SET.has(entry)) {
      throw new ModelProviderValidationError(
        `${field} entries must be one of ${MODEL_MODALITIES.join(", ")}`,
      );
    }
    seen.add(entry as ModelModality);
  }
  if (seen.size === 0) {
    return undefined;
  }
  return MODEL_MODALITIES.filter((modality) => seen.has(modality));
}

function validateModalities(value: unknown): ModelProviderModalities | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ModelProviderValidationError("model modalities must be an object");
  }
  const input =
    value.input === undefined ? undefined : validateModalityList(value.input, "modalities input");
  const output =
    value.output === undefined
      ? undefined
      : validateModalityList(value.output, "modalities output");
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function validateLimit(value: unknown): ModelProviderLimit {
  if (!isRecord(value)) {
    throw new ModelProviderValidationError("model limit must be an object");
  }
  const input = validateOptionalToken(value.input, "input");
  return {
    context: validateToken(value.context, "context"),
    ...(input === undefined ? {} : { input }),
    output: validateToken(value.output, "output"),
  };
}

function validateModel(value: unknown): ModelProviderModel {
  if (!isRecord(value)) {
    throw new ModelProviderValidationError("each model must be an object");
  }
  const id = validateModelId(value.id);
  const name = validateModelName(value.name);
  const attachment = validateOptionalBoolean(value.attachment, "model attachment");
  const reasoning = validateOptionalBoolean(value.reasoning, "model reasoning");
  const toolCall = validateOptionalBoolean(value.toolCall, "model toolCall");
  const temperature = validateOptionalBoolean(value.temperature, "model temperature");
  const cost = validateCost(value.cost);
  const modalities =
    validateModalities(value.modalities) ??
    (attachment === true ? { input: [...DEFAULT_ATTACHMENT_INPUT_MODALITIES] } : undefined);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    limit: validateLimit(value.limit),
    ...(attachment === undefined ? {} : { attachment }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(toolCall === undefined ? {} : { toolCall }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(cost === undefined ? {} : { cost }),
    ...(modalities === undefined ? {} : { modalities }),
  };
}

export function validateModels(value: unknown): ModelProviderModel[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new ModelProviderValidationError("at least one model is required");
  }
  if (value.length > MAX_PROVIDER_MODELS) {
    throw new ModelProviderValidationError(
      `a provider may define at most ${MAX_PROVIDER_MODELS} models`,
    );
  }
  const models = value.map(validateModel);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) {
      throw new ModelProviderValidationError(`duplicate model id: ${model.id}`);
    }
    seen.add(model.id);
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function validateInput(input: unknown): ModelProviderInput {
  if (!isRecord(input)) {
    throw new ModelProviderValidationError("provider input must be an object");
  }
  const id = validateProviderId(input.id);
  const name = validateProviderName(input.name, id);
  const baseUrl = validateBaseUrl(input.baseUrl);
  const models = validateModels(input.models);
  for (const model of models) {
    if (`${id}/${model.id}`.length > 256) {
      throw new ModelProviderValidationError(
        `provider id and model id together must fit the 256-character llm.model bound: ${id}/${model.id}`,
      );
    }
  }
  return { id, name, baseUrl, models };
}

/** Parse the settings form's one-line-per-model text. */
export function parseModelLines(text: unknown): ModelProviderModel[] {
  if (typeof text !== "string") {
    throw new ModelProviderValidationError("models must be a string");
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new ModelProviderValidationError("at least one model is required");
  }
  const models: ModelProviderModel[] = [];
  for (const line of lines) {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 3 || parts.length > 4) {
      throw new ModelProviderValidationError(
        "each model line must be id | context | output | optional name; a display name cannot contain |",
      );
    }
    const [id, context, output, name] = parts;
    if (id === undefined || context === undefined || output === undefined) {
      throw new ModelProviderValidationError(
        "each model line must be id | context | output | optional name",
      );
    }
    models.push({
      id,
      ...(name === undefined || name.length === 0 ? {} : { name }),
      limit: {
        context: Number(context),
        output: Number(output),
      },
    });
  }
  return validateModels(models);
}

function overlayModel(model: ModelProviderModel): ProviderOverlayModel {
  return {
    ...(model.name === undefined ? {} : { name: model.name }),
    limit: {
      context: model.limit.context,
      ...(model.limit.input === undefined ? {} : { input: model.limit.input }),
      output: model.limit.output,
    },
    ...(model.attachment === undefined ? {} : { attachment: model.attachment }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.toolCall === undefined ? {} : { tool_call: model.toolCall }),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.cost === undefined
      ? {}
      : {
          cost: {
            input: model.cost.input,
            output: model.cost.output,
            ...(model.cost.cacheRead === undefined ? {} : { cache_read: model.cost.cacheRead }),
            ...(model.cost.cacheWrite === undefined ? {} : { cache_write: model.cost.cacheWrite }),
          },
        }),
    ...(model.modalities === undefined
      ? {}
      : {
          modalities: {
            ...(model.modalities.input === undefined ? {} : { input: [...model.modalities.input] }),
            ...(model.modalities.output === undefined
              ? {}
              : { output: [...model.modalities.output] }),
          },
        }),
  };
}

export function toOverlay(
  providers: readonly ModelProvider[],
): Record<string, ProviderOverlay> | undefined {
  if (providers.length === 0) {
    return undefined;
  }
  const entries = [...providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const models = Object.fromEntries(
        [...provider.models]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((model) => [model.id, overlayModel(model)]),
      );
      return [
        provider.id,
        {
          npm: PROVIDER_NPM,
          name: provider.name,
          options: { baseURL: provider.baseUrl },
          models,
        },
      ] as const;
    });
  return Object.fromEntries(entries);
}

export function hashProviders(providers: readonly ModelProvider[]): string | undefined {
  if (providers.length === 0) {
    return undefined;
  }
  return hashValue({
    providers: [...providers]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        models: [...provider.models]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((model) => ({ id: model.id, ...overlayModel(model) })),
      })),
  });
}

export function providerProjectionBytes(providers: readonly ModelProvider[]): number {
  const overlay = toOverlay(providers);
  return Buffer.byteLength(
    JSON.stringify(overlay === undefined ? {} : { provider: overlay }),
    "utf8",
  );
}

export function collisionWarnings(id: string, existingProviderIds: ReadonlySet<string>): string[] {
  const warnings: string[] = [];
  if (KNOWN_BUNDLED_PROVIDER_IDS.has(id)) {
    warnings.push(
      `"${id}" is a common bundled provider id; this definition replaces its adapter, name, base URL, and models.`,
    );
  }
  if (existingProviderIds.has(id)) {
    warnings.push(
      `A provider-key row or host auth already exists for "${id}"; check the stored credential before pointing it at this base URL.`,
    );
  }
  return warnings;
}

export function providerBaseUrlWarnings(baseUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (loopback) {
    return [
      "A loopback base URL points at the app container, not the host or coordinator; use the host's LAN address.",
    ];
  }
  if (parsed.protocol === "http:") {
    return [
      "This base URL uses plain HTTP outside loopback; the provider key will travel in cleartext.",
    ];
  }
  return [];
}
