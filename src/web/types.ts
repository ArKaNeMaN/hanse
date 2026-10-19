import type { z } from "zod";

/** Supported web tool driver ids. */
export type WebDriverId = "builtin" | "deepseek";

/** DeepSeek standalone Search/Fetch options. */
export interface DeepSeekOptions {
  /** Provider whose API key is used for the request. */
  provider: string;
  /** Number of search results to request (1-20). */
  count?: number;
  /** Ask DeepSeek to include page content in search results. */
  needContent?: boolean;
  /** Per-request timeout in milliseconds (1000-60000). */
  timeoutMs?: number;
  /** Maximum characters returned by fetch (1024-1048576). */
  maxContentChars?: number;
}

/** Effective configuration for one web tool. */
export type WebToolConfig =
  | { driver: "builtin" }
  | { driver: "deepseek"; options: DeepSeekOptions };

/** Input accepted by the search tool. */
export interface WebSearchInput {
  query: string;
  count?: number;
  needContent?: boolean;
}

/** Normalized search result returned to the agent. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
}

export interface WebFetchInput {
  url: string;
}

export interface WebFetchOutput {
  url: string;
  title?: string;
  content: string;
}

/** Common driver contract used by the managed web MCP server. */
export interface WebDriver {
  readonly id: string;
  search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchOutput>;
  fetch(input: WebFetchInput, signal: AbortSignal): Promise<WebFetchOutput>;
}

export type DriverFieldType = "text" | "password" | "number" | "checkbox" | "select";

/** Server-rendered form descriptor for a driver option. */
export interface DriverField {
  name: string;
  label: string;
  type: DriverFieldType;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
}

export interface WebDriverContext {
  fetch: typeof fetch;
  baseUrl: string;
}

/** Registry entry for a web tool driver. */
export interface WebDriverDefinition<O = unknown> {
  id: WebDriverId;
  label: string;
  managed: boolean;
  optionsSchema: z.ZodType<O>;
  fields: DriverField[];
  create?(options: O, context: WebDriverContext): WebDriver;
}

/** Config passed to the managed `hanse_web` server; only managed tools are present. */
export interface WebMcpConfig {
  search?: DeepSeekOptions;
  fetch?: DeepSeekOptions;
}
