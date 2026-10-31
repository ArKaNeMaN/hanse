/** The only bundled opencode adapter this stage exposes. */
export const PROVIDER_NPM = "@ai-sdk/openai-compatible" as const;

export type ModelProviderScope = "global" | "project" | "app";

/** Input/output modalities understood by opencode's model config. */
export const MODEL_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

export interface ModelProviderLimit {
  context: number;
  /** Optional separate input cap; opencode falls back to `context` when absent. */
  input?: number;
  output: number;
}

export interface ModelProviderCost {
  /** USD per one million tokens. */
  input: number;
  /** USD per one million tokens. */
  output: number;
  /** USD per one million cached input tokens. */
  cacheRead?: number;
  /** USD per one million cached write tokens. */
  cacheWrite?: number;
}

export interface ModelProviderModalities {
  input?: ModelModality[];
  output?: ModelModality[];
}

export interface ModelProviderModel {
  id: string;
  name?: string;
  limit: ModelProviderLimit;
  attachment?: boolean;
  reasoning?: boolean;
  /** Opencode defaults this to `true`; emit `false` to disable tool calls. */
  toolCall?: boolean;
  temperature?: boolean;
  cost?: ModelProviderCost;
  modalities?: ModelProviderModalities;
}

export interface ModelProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelProviderModel[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelProviderModel[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOverlayModel {
  name?: string;
  limit: ModelProviderLimit;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: ModelProviderModalities;
}

export interface ProviderOverlay {
  npm: typeof PROVIDER_NPM;
  name: string;
  options: { baseURL: string };
  models: Record<string, ProviderOverlayModel>;
}

export interface ModelProviderSnapshot {
  providers: ModelProvider[];
  /** `undefined` exactly when `providers` is empty. */
  overlay: Record<string, ProviderOverlay> | undefined;
  /** `undefined` exactly when `providers` is empty. */
  hash: string | undefined;
}

export interface ModelProviderReference {
  scope: ModelProviderScope;
  projectId: string;
  appKey: string;
}
