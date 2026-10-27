/** The only bundled opencode adapter this stage exposes. */
export const PROVIDER_NPM = "@ai-sdk/openai-compatible" as const;

export type ModelProviderScope = "global" | "project" | "app";

export interface ModelProviderLimit {
  context: number;
  output: number;
}

export interface ModelProviderModel {
  id: string;
  name?: string;
  limit: ModelProviderLimit;
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
