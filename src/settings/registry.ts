import { z } from "zod";
import type { WebToolConfig } from "../web/types.js";
import type { EffectiveValue, MergeStrategy, SettingsScope } from "./types.js";

/** Default model preserves the image-baked OMO baseline. */
export const DEFAULT_LLM_MODEL = "deepseek/deepseek-flash";

/** Default web driver preserves the existing built-in tools. */
export const DEFAULT_WEB_TOOL_CONFIG: WebToolConfig = { driver: "builtin" };

export interface SettingsKeyDefinition<T = unknown> {
  /** Stable key used in the database and the settings API. */
  key: string;
  /** Validates a stored or submitted value. */
  schema: z.ZodType<T>;
  /** How values from wider scopes combine with narrower scopes. */
  merge: MergeStrategy;
  /** Whether an explicit `null` (clear) row is allowed for this key. */
  clearable: boolean;
  /** Effective value when no scope contributes. */
  defaultValue: T;
}

export const llmModelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\s]+\/\S+$/, "model must be provider/model");

export const deepSeekOptionsSchema = z
  .object({
    provider: z.string().min(1).max(128),
    count: z.number().int().min(1).max(20).optional(),
    needContent: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
    maxContentChars: z.number().int().min(1024).max(1048576).optional(),
  })
  .strict();

export const webToolConfigSchema: z.ZodType<WebToolConfig> = z.discriminatedUnion("driver", [
  z.object({ driver: z.literal("builtin") }).strict(),
  z
    .object({
      driver: z.literal("deepseek"),
      options: deepSeekOptionsSchema,
    })
    .strict(),
]);

export const llmModelDefinition: SettingsKeyDefinition<string> = {
  key: "llm.model",
  schema: llmModelSchema,
  merge: "replace",
  clearable: false,
  defaultValue: DEFAULT_LLM_MODEL,
};

export const webSearchDefinition: SettingsKeyDefinition<WebToolConfig> = {
  key: "web.search",
  schema: webToolConfigSchema,
  merge: "replace",
  clearable: true,
  defaultValue: DEFAULT_WEB_TOOL_CONFIG,
};

export const webFetchDefinition: SettingsKeyDefinition<WebToolConfig> = {
  key: "web.fetch",
  schema: webToolConfigSchema,
  merge: "replace",
  clearable: true,
  defaultValue: DEFAULT_WEB_TOOL_CONFIG,
};

/** Production key registry. */
export const KEY_DEFINITIONS: readonly SettingsKeyDefinition[] = [
  llmModelDefinition,
  webSearchDefinition,
  webFetchDefinition,
];

const DEFINITIONS_BY_KEY = new Map(
  KEY_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function findKeyDefinition(key: string): SettingsKeyDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(key);
}

export function listKeyDefinitions(): readonly SettingsKeyDefinition[] {
  return KEY_DEFINITIONS;
}

/** A raw parsed row at one scope; absent scopes are omitted from the input. */
export interface ResolverRow {
  scope: SettingsScope;
  value: unknown;
}

function invalidWarning(key: string, scope: SettingsScope): string {
  return `invalid stored value for "${key}" at ${scope} scope; ignoring it`;
}

function notClearableWarning(key: string, scope: SettingsScope): string {
  return `"${key}" is not clearable; ignoring the null value at ${scope} scope`;
}

function resolveReplace<T>(
  definition: SettingsKeyDefinition<T>,
  rows: readonly ResolverRow[],
  warnings: string[],
): EffectiveValue<T> {
  let value: T | undefined;
  let source: SettingsScope | undefined;

  for (const row of rows) {
    if (row.value === null) {
      if (!definition.clearable) {
        warnings.push(notClearableWarning(definition.key, row.scope));
        continue;
      }
      value = undefined;
      source = row.scope;
      continue;
    }
    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success) {
      warnings.push(invalidWarning(definition.key, row.scope));
      continue;
    }
    value = parsed.data;
    source = row.scope;
  }

  if (source === undefined) {
    return {
      value: structuredClone(definition.defaultValue),
      state: "default",
      source: "default",
      sources: ["default"],
    };
  }
  if (value === undefined) {
    return { value: null, state: "cleared", source, sources: [source] };
  }
  return { value, state: "set", source, sources: [source] };
}

function resolveAppend<T>(
  definition: SettingsKeyDefinition<T>,
  rows: readonly ResolverRow[],
  warnings: string[],
): EffectiveValue<T> {
  let accumulated: unknown[] | undefined;
  let clearedAt: SettingsScope | undefined;
  const contributors: SettingsScope[] = [];

  for (const row of rows) {
    if (row.value === null) {
      if (!definition.clearable) {
        warnings.push(notClearableWarning(definition.key, row.scope));
        continue;
      }
      accumulated = [];
      contributors.length = 0;
      clearedAt = row.scope;
      continue;
    }
    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success || !Array.isArray(parsed.data)) {
      warnings.push(invalidWarning(definition.key, row.scope));
      continue;
    }
    accumulated = [...(accumulated ?? []), ...parsed.data];
    contributors.push(row.scope);
    clearedAt = undefined;
  }

  if (accumulated === undefined) {
    return {
      value: structuredClone(definition.defaultValue),
      state: "default",
      source: "default",
      sources: ["default"],
    };
  }
  if (contributors.length === 0) {
    const source = clearedAt ?? "default";
    return { value: null, state: "cleared", source, sources: [source] };
  }
  const source = contributors[contributors.length - 1];
  if (source === undefined) {
    return {
      value: structuredClone(definition.defaultValue),
      state: "default",
      source: "default",
      sources: ["default"],
    };
  }
  return { value: accumulated as T, state: "set", source, sources: [...contributors] };
}

/**
 * Resolve one key from raw rows supplied wide-to-narrow. This is the pure
 * resolver hook used by tests to exercise `append` without registering a
 * production key.
 */
export function resolveEffectiveValue<T>(
  definition: SettingsKeyDefinition<T>,
  rows: readonly ResolverRow[],
  warnings: string[] = [],
): EffectiveValue<T> {
  if (definition.merge === "append") {
    return resolveAppend(definition, rows, warnings);
  }
  return resolveReplace(definition, rows, warnings);
}
