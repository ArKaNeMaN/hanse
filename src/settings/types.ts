import type { WebToolConfig } from "../web/types.js";

export type SettingsScope = "global" | "project" | "app";

export interface SettingsTarget {
  projectId?: string;
  appKey?: string;
}

export type SettingsKey = "llm.model" | "web.search" | "web.fetch";

export type MergeStrategy = "replace" | "append";

export interface EffectiveValue<T> {
  value: T | null;
  state: "set" | "cleared" | "default";
  /** Narrowest scope that contributed to the value. */
  source: SettingsScope | "default";
  /** Every scope that contributed, wide to narrow. */
  sources: Array<SettingsScope | "default">;
}

export interface ScopedValue<T> {
  state: "absent" | "cleared" | "set";
  value: T | null;
}

export interface EffectiveSettings {
  llm: { model: EffectiveValue<string> };
  web: {
    search: EffectiveValue<WebToolConfig>;
    fetch: EffectiveValue<WebToolConfig>;
  };
}

export interface PendingRestart {
  appId: string;
  appKey: string;
  projectId: string;
  reasons: string[];
}

export type ProviderKeyStatus =
  | { state: "set"; source: SettingsScope }
  | { state: "cleared"; source: SettingsScope }
  | { state: "missing" }
  | { state: "host"; source: "host-auth"; authType: "api" | "oauth" | "wellknown" }
  | { state: "error"; message: string };

export interface ResolvedSettings {
  effective: EffectiveSettings;
  scoped: Record<string, ScopedValue<unknown>>;
  providerKeys: Record<string, ProviderKeyStatus>;
  warnings: string[];
}

export interface SettingsResponse extends ResolvedSettings {
  pendingRestart: PendingRestart[];
}

export type ProviderKeyState = { state: "set"; key: string } | { state: "cleared" };

export interface LaunchSettingsSnapshot {
  resolved: ResolvedSettings;
  mergedAuth: Record<string, unknown>;
  authHash: string;
  providerKeys: Map<string, ProviderKeyState>;
}
