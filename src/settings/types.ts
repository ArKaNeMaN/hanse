import type { GitHttpsCredential, GitSshCredential } from "../git/credentials.js";
import type { WebToolConfig } from "../web/types.js";

export type SettingsScope = "global" | "project" | "app";

export interface SettingsTarget {
  projectId?: string;
  appKey?: string;
}

export type SettingsKey =
  | "llm.model"
  | "web.search"
  | "web.fetch"
  | "context.auto_compact.enabled"
  | "context.auto_compact.percent"
  | "git.user.name"
  | "git.user.email";

export type GitAuthKind = "ssh" | "https";

export type GitAuthScopedState = "absent" | "cleared" | "set";

export type GitAuthStatus =
  | {
      state: "set";
      kind: "ssh";
      source: SettingsScope;
      publicKey: string;
      fingerprint: string;
      hasKnownHosts: boolean;
    }
  | {
      state: "set";
      kind: "https";
      source: SettingsScope;
      hosts: string[];
      username: string;
    }
  | { state: "cleared"; kind: GitAuthKind; source: SettingsScope }
  | { state: "error"; kind: GitAuthKind; message: string }
  | { state: "missing"; kind: GitAuthKind };

export interface GitAuthScoped {
  ssh: Record<SettingsScope, GitAuthScopedState>;
  https: Record<SettingsScope, GitAuthScopedState>;
}

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
  context: {
    autoCompact: {
      enabled: EffectiveValue<boolean>;
      percent: EffectiveValue<number>;
    };
  };
  git: {
    user: {
      name: EffectiveValue<string>;
      email: EffectiveValue<string>;
    };
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
  /** Status-only credential metadata; never contains private keys, tokens, or known-hosts content. */
  gitAuth: { ssh: GitAuthStatus; https: GitAuthStatus };
  gitAuthScoped: GitAuthScoped;
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
  /** Plaintext credentials for materialization only; never exposed on ResolvedSettings or HTTP. */
  gitAuth: { ssh?: GitSshCredential; https?: GitHttpsCredential };
  gitAuthHash: string;
}
