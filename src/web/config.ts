import { z } from "zod";
import type { EffectiveSettings } from "../settings/types.js";
import { deepseekOptionsSchema } from "./registry.js";
import type { DeepSeekOptions, WebMcpConfig, WebToolConfig } from "./types.js";

/** Strict shape of a managed `hanse_web` tool configuration (bare per-tool options). */
const webMcpConfigSchema = z
  .object({
    search: deepseekOptionsSchema.optional(),
    fetch: deepseekOptionsSchema.optional(),
  })
  .strict();

function managedOptions(value: WebToolConfig | null): DeepSeekOptions | undefined {
  if (value === null || value.driver !== "deepseek") {
    return undefined;
  }
  const parsed = deepseekOptionsSchema.safeParse(value.options);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Build the `HANSE_WEB_CONFIG` value for the effective web settings.
 * Only managed (DeepSeek) tools are included; built-in/disabled tools are omitted.
 */
export function buildWebMcpConfig(web: EffectiveSettings["web"]): WebMcpConfig | undefined {
  const search = managedOptions(web.search.value);
  const fetch = managedOptions(web.fetch.value);
  if (search === undefined && fetch === undefined) {
    return undefined;
  }
  const config: WebMcpConfig = {};
  if (search !== undefined) {
    config.search = search;
  }
  if (fetch !== undefined) {
    config.fetch = fetch;
  }
  return config;
}

/** Parse and validate the exact `HANSE_WEB_CONFIG` shape. */
export function parseWebMcpConfig(input: unknown): WebMcpConfig {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new Error("HANSE_WEB_CONFIG must be valid JSON");
    }
  }
  const parsed = webMcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "HANSE_WEB_CONFIG must be an object with optional search/fetch DeepSeek options",
    );
  }
  return parsed.data;
}
