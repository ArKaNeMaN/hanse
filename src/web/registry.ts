import { z } from "zod";
import type { DeepSeekOptions, DriverField, WebDriverDefinition, WebDriverId } from "./types.js";

/** Search result count bounds accepted by the DeepSeek driver. */
export const DEEPSEEK_COUNT_MIN = 1;
export const DEEPSEEK_COUNT_MAX = 20;
/** Request timeout bounds accepted by the DeepSeek driver (milliseconds). */
export const DEEPSEEK_TIMEOUT_MIN_MS = 1000;
export const DEEPSEEK_TIMEOUT_MAX_MS = 60_000;
/** Fetched/search content bounds accepted by the DeepSeek driver (characters). */
export const DEEPSEEK_CONTENT_MIN_CHARS = 1024;
export const DEEPSEEK_CONTENT_MAX_CHARS = 1_048_576;
/** Provider id bound shared with the settings validation rules. */
export const DEEPSEEK_PROVIDER_MAX_CHARS = 128;

/** Strict DeepSeek options schema; unknown fields are rejected. */
export const deepseekOptionsSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .min(1)
      .max(DEEPSEEK_PROVIDER_MAX_CHARS)
      .refine((value) => !/[\s/]/.test(value), "provider must not contain whitespace or '/'"),
    count: z.number().int().min(DEEPSEEK_COUNT_MIN).max(DEEPSEEK_COUNT_MAX).optional(),
    needContent: z.boolean().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(DEEPSEEK_TIMEOUT_MIN_MS)
      .max(DEEPSEEK_TIMEOUT_MAX_MS)
      .optional(),
    maxContentChars: z
      .number()
      .int()
      .min(DEEPSEEK_CONTENT_MIN_CHARS)
      .max(DEEPSEEK_CONTENT_MAX_CHARS)
      .optional(),
  })
  .strict();

/** Built-in web tool driver accepts no options. */
export const builtinOptionsSchema = z.object({}).strict();

export const DEEPSEEK_FIELDS: DriverField[] = [
  {
    name: "provider",
    label: "Provider",
    type: "text",
    placeholder: "deepseek",
    required: true,
  },
  {
    name: "count",
    label: "Results",
    type: "number",
    min: DEEPSEEK_COUNT_MIN,
    max: DEEPSEEK_COUNT_MAX,
  },
  {
    name: "needContent",
    label: "Include page content in results",
    type: "checkbox",
  },
  {
    name: "timeoutMs",
    label: "Timeout (ms)",
    type: "number",
    min: DEEPSEEK_TIMEOUT_MIN_MS,
    max: DEEPSEEK_TIMEOUT_MAX_MS,
  },
  {
    name: "maxContentChars",
    label: "Maximum content characters",
    type: "number",
    min: DEEPSEEK_CONTENT_MIN_CHARS,
    max: DEEPSEEK_CONTENT_MAX_CHARS,
  },
];

/** Built-in search/fetch uses opencode/OMO tools; the coordinator does not manage it. */
export const builtinWebDriver: WebDriverDefinition<Record<string, never>> = {
  id: "builtin",
  label: "Built-in",
  managed: false,
  optionsSchema: builtinOptionsSchema,
  fields: [],
};

/** DeepSeek standalone Search/Fetch driver; managed by the `hanse_web` server. */
export const deepseekWebDriver: WebDriverDefinition<DeepSeekOptions> = {
  id: "deepseek",
  label: "DeepSeek",
  managed: true,
  optionsSchema: deepseekOptionsSchema,
  fields: DEEPSEEK_FIELDS,
};

const DEFINITIONS: Record<WebDriverId, WebDriverDefinition<unknown>> = {
  builtin: builtinWebDriver as WebDriverDefinition<unknown>,
  deepseek: deepseekWebDriver as WebDriverDefinition<unknown>,
};

/** All registered web tool drivers, in display order. */
export const webDriverDefinitions: WebDriverDefinition<unknown>[] = [
  builtinWebDriver as WebDriverDefinition<unknown>,
  deepseekWebDriver as WebDriverDefinition<unknown>,
];

/** Look up a driver definition by id. */
export function getWebDriverDefinition(id: WebDriverId): WebDriverDefinition<unknown> {
  return DEFINITIONS[id];
}

/** Validate DeepSeek options with the strict registry schema. */
export function parseDeepSeekOptions(value: unknown): DeepSeekOptions {
  return deepseekOptionsSchema.parse(value);
}
