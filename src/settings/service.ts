import { readFileSync } from "node:fs";
import type { RunSshKeygen } from "../git/credentials.js";
import type { ContextPolicy } from "../opencode/context.js";
import type { SqliteDatabase } from "../store/index.js";
import type { WebToolConfig } from "../web/types.js";
import { type GitAuthResolution, GitAuthStore } from "./git-auth.js";
import { hashValue } from "./hash.js";
import {
  type ProviderKeyLocation,
  ProviderKeyStore,
  providerKeyState,
  type StoredProviderKey,
} from "./provider-keys.js";
import {
  DEFAULT_LLM_MODEL,
  findKeyDefinition,
  listKeyDefinitions,
  type ResolverRow,
  resolveEffectiveValue,
} from "./registry.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  GitAuthKind,
  LaunchSettingsSnapshot,
  ProviderKeyState,
  ProviderKeyStatus,
  ResolvedSettings,
  ScopedValue,
  SettingsScope,
  SettingsTarget,
} from "./types.js";

export interface SettingsServiceOptions {
  db: SqliteDatabase;
  secretKey: Buffer;
  hostAuthFile?: string;
  now?: () => Date;
  runSshKeygen?: RunSshKeygen;
  /** Custom provider ids that should appear in the key status map even without a key row. */
  providerIds?: () => readonly string[];
}

/** A settings input validation failure that HTTP callers should map to 400. */
export class SettingsValidationError extends Error {
  readonly code = "VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

interface SettingRow {
  scope: SettingsScope;
  key: string;
  value_json: string;
}

interface ParsedSettingRow {
  scope: SettingsScope;
  key: string;
  value: unknown;
}

interface NormalizedTarget {
  projectId?: string;
  appKey?: string;
}

interface HostAuthRead {
  auth: Record<string, unknown>;
  warning?: string;
}

interface InternalResolution {
  resolved: ResolvedSettings;
  providerStates: Map<string, ProviderKeyState>;
  gitAuth: GitAuthResolution;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SettingsValidationError(`${name} must be a string`);
  }
  return value;
}

function normalizeTarget(target: SettingsTarget): NormalizedTarget {
  const projectId = optionalId(target.projectId, "projectId");
  const appKey = optionalId(target.appKey, "appKey");
  if (appKey !== undefined && projectId === undefined) {
    throw new SettingsValidationError("appKey requires projectId");
  }
  return { projectId, appKey };
}

function targetScopes(target: NormalizedTarget): SettingsScope[] {
  const scopes: SettingsScope[] = ["global"];
  if (target.projectId !== undefined) {
    scopes.push("project");
  }
  if (target.projectId !== undefined && target.appKey !== undefined) {
    scopes.push("app");
  }
  return scopes;
}

function scopeLocation(scope: SettingsScope, target: SettingsTarget): ProviderKeyLocation {
  const normalized = normalizeTarget(target);
  switch (scope) {
    case "global":
      if (normalized.projectId !== undefined || normalized.appKey !== undefined) {
        throw new SettingsValidationError("global scope does not accept projectId or appKey");
      }
      return { scope, projectId: "", appKey: "" };
    case "project":
      if (normalized.projectId === undefined) {
        throw new SettingsValidationError("project scope requires projectId");
      }
      if (normalized.appKey !== undefined) {
        throw new SettingsValidationError("project scope does not accept appKey");
      }
      return { scope, projectId: normalized.projectId, appKey: "" };
    case "app":
      if (normalized.projectId === undefined || normalized.appKey === undefined) {
        throw new SettingsValidationError("app scope requires projectId and appKey");
      }
      return { scope, projectId: normalized.projectId, appKey: normalized.appKey };
    default:
      throw new SettingsValidationError(`unknown settings scope: ${String(scope)}`);
  }
}

function requireDefinition(key: string) {
  const definition = findKeyDefinition(key);
  if (definition === undefined) {
    throw new SettingsValidationError(`unknown settings key: ${key}`);
  }
  return definition;
}

function validateProvider(provider: unknown): string {
  if (typeof provider !== "string") {
    throw new SettingsValidationError("provider must be a non-empty string");
  }
  const normalized = provider.trim();
  if (normalized.length === 0) {
    throw new SettingsValidationError("provider must be a non-empty string");
  }
  if (normalized.length > 128) {
    throw new SettingsValidationError("provider must be at most 128 characters");
  }
  if (
    normalized.includes("/") ||
    /\s/.test(normalized) ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new SettingsValidationError("provider must not contain whitespace or '/'");
  }
  if (normalized === "__proto__" || normalized === "constructor" || normalized === "prototype") {
    throw new SettingsValidationError("provider is not allowed");
  }
  return normalized;
}

function validateProviderKey(key: unknown): string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new SettingsValidationError("provider key must be a non-empty string");
  }
  if (key.length > 4096) {
    throw new SettingsValidationError("provider key must be at most 4096 characters");
  }
  return key;
}

function requireGitAuthKind(kind: unknown): GitAuthKind {
  if (kind === "ssh" || kind === "https") {
    return kind;
  }
  throw new SettingsValidationError("kind must be ssh or https");
}

function effectiveFor<T>(
  values: ReadonlyMap<string, EffectiveValue<unknown>>,
  key: string,
): EffectiveValue<T> {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`missing resolver output for ${key}`);
  }
  return value as EffectiveValue<T>;
}

function resolverRowsFor(
  scopes: readonly SettingsScope[],
  rowByScopeKey: ReadonlyMap<string, ParsedSettingRow>,
  key: string,
): ResolverRow[] {
  const contributions: ResolverRow[] = [];
  for (const scope of scopes) {
    const row = rowByScopeKey.get(`${scope}:${key}`);
    if (row !== undefined) {
      contributions.push({ scope, value: row.value });
    }
  }
  return contributions;
}

/**
 * Effective settings without the live `context` group. Launch hashing uses this
 * projection so context changes never mark a running agent as needing a restart.
 */
export function launchEffectiveSettings(
  effective: EffectiveSettings,
): Omit<EffectiveSettings, "context"> {
  return {
    llm: effective.llm,
    web: effective.web,
    git: effective.git,
  };
}

/**
 * Hierarchical settings and provider-key resolution for one coordinator DB.
 * Reads merge global -> project -> app; writes target exactly one scope.
 */
export class SettingsService {
  readonly #db: SqliteDatabase;
  readonly #hostAuthFile: string | undefined;
  readonly #now: (() => Date) | undefined;
  readonly #providerKeys: ProviderKeyStore;
  readonly #gitAuth: GitAuthStore;
  readonly #providerIdSource: (() => readonly string[]) | undefined;

  constructor(options: SettingsServiceOptions) {
    this.#db = options.db;
    this.#hostAuthFile = options.hostAuthFile;
    this.#now = options.now;
    this.#providerKeys = new ProviderKeyStore(options.db, options.secretKey);
    this.#providerIdSource = options.providerIds;
    this.#gitAuth = new GitAuthStore(options.db, options.secretKey, {
      runSshKeygen: options.runSshKeygen,
    });
  }

  /** Provider ids with a key row in any scope plus the host-auth keys. */
  allProviderIds(): string[] {
    const rows = this.#db
      .prepare("SELECT DISTINCT provider FROM provider_keys ORDER BY provider")
      .all() as { provider: string }[];
    const host = this.#readHostAuth();
    return [...new Set([...rows.map((row) => row.provider), ...Object.keys(host.auth)])].sort();
  }

  /** Effective settings plus raw scoped rows, provider statuses, and warnings. */
  resolve(target: SettingsTarget): ResolvedSettings {
    const host = this.#readHostAuth();
    return this.#resolve(target, host).resolved;
  }

  /** One host-auth read shared by the written auth file and the auth hash. */
  snapshot(target: SettingsTarget): LaunchSettingsSnapshot {
    const host = this.#readHostAuth();
    const { resolved, providerStates, gitAuth } = this.#resolve(target, host);

    const merged = new Map(Object.entries(host.auth));
    for (const [provider, status] of Object.entries(resolved.providerKeys)) {
      if (status.state === "set") {
        const state = providerStates.get(provider);
        if (state?.state === "set") {
          merged.set(provider, { type: "api", key: state.key });
        }
      } else if (status.state === "cleared" || status.state === "error") {
        // An error must not silently fall back to the host key.
        merged.delete(provider);
      }
    }
    const mergedAuth = Object.fromEntries(merged);

    return {
      resolved,
      mergedAuth,
      authHash: hashValue(mergedAuth),
      providerKeys: providerStates,
      gitAuth: gitAuth.gitAuth,
      gitAuthHash: gitAuth.gitAuthHash,
    };
  }

  /**
   * Stable hash of the full effective settings (including the live `context`
   * group) plus merged auth; a diagnostics value, never a launch signal.
   */
  effectiveHash(target: SettingsTarget): string {
    const snapshot = this.snapshot(target);
    return hashValue({
      effective: snapshot.resolved.effective,
      providerKeys: snapshot.resolved.providerKeys,
      authHash: snapshot.authHash,
      gitAuthHash: snapshot.gitAuthHash,
    });
  }

  /** Three-key live policy for the context monitor; no auth/provider/git resolution. */
  contextPolicy(target: SettingsTarget): ContextPolicy {
    const normalized = normalizeTarget(target);
    const scopes = targetScopes(normalized);
    const { rows } = this.#readSettings(normalized);
    const rowByScopeKey = new Map<string, ParsedSettingRow>();
    for (const row of rows) {
      rowByScopeKey.set(`${row.scope}:${row.key}`, row);
    }

    const values = new Map<string, EffectiveValue<unknown>>();
    for (const key of [
      "llm.model",
      "context.auto_compact.enabled",
      "context.auto_compact.percent",
    ]) {
      values.set(
        key,
        resolveEffectiveValue(requireDefinition(key), resolverRowsFor(scopes, rowByScopeKey, key)),
      );
    }

    const model = effectiveFor<string>(values, "llm.model");
    const enabled = effectiveFor<boolean>(values, "context.auto_compact.enabled");
    const percent = effectiveFor<number>(values, "context.auto_compact.percent");
    return {
      enabled: enabled.value ?? false,
      percent: percent.value ?? 80,
      model: model.value ?? DEFAULT_LLM_MODEL,
      enabledSource: enabled.source,
      percentSource: percent.source,
    };
  }

  set(
    scope: SettingsScope,
    target: SettingsTarget,
    key: string,
    value: unknown,
    actor: string,
  ): void {
    const location = scopeLocation(scope, target);
    const definition = requireDefinition(key);
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map((issue) => issue.path.join("."))
        .filter((field) => field.length > 0);
      const suffix = fields.length > 0 ? ` (${fields.join(", ")})` : "";
      throw new SettingsValidationError(`invalid value for "${key}"${suffix}`);
    }
    this.#write(location, key, JSON.stringify(parsed.data), actor);
  }

  clear(scope: SettingsScope, target: SettingsTarget, key: string, actor: string): void {
    const location = scopeLocation(scope, target);
    const definition = requireDefinition(key);
    if (!definition.clearable) {
      throw new SettingsValidationError(`"${key}" is not clearable; use inherit instead`);
    }
    this.#write(location, key, "null", actor);
  }

  inherit(scope: SettingsScope, target: SettingsTarget, key: string): void {
    const location = scopeLocation(scope, target);
    requireDefinition(key);
    this.#db
      .prepare(
        "DELETE FROM settings WHERE scope = ? AND project_id = ? AND app_key = ? AND key = ?",
      )
      .run(location.scope, location.projectId, location.appKey, key);
  }

  setProviderKey(
    scope: SettingsScope,
    target: SettingsTarget,
    provider: string,
    key: string,
    actor: string,
  ): void {
    const location = scopeLocation(scope, target);
    const safeProvider = validateProvider(provider);
    const safeKey = validateProviderKey(key);
    this.#providerKeys.set(location, safeProvider, safeKey, actor, this.#timestamp());
  }

  clearProviderKey(
    scope: SettingsScope,
    target: SettingsTarget,
    provider: string,
    actor: string,
  ): void {
    const location = scopeLocation(scope, target);
    const safeProvider = validateProvider(provider);
    this.#providerKeys.clear(location, safeProvider, actor, this.#timestamp());
  }

  inheritProviderKey(scope: SettingsScope, target: SettingsTarget, provider: string): void {
    const location = scopeLocation(scope, target);
    const safeProvider = validateProvider(provider);
    this.#providerKeys.inherit(location, safeProvider);
  }

  setGitAuth(
    scope: SettingsScope,
    target: SettingsTarget,
    kind: GitAuthKind,
    value: unknown,
    actor: string,
  ): void {
    const location = scopeLocation(scope, target);
    this.#gitAuth.set(location, requireGitAuthKind(kind), value, actor, this.#timestamp());
  }

  clearGitAuth(
    scope: SettingsScope,
    target: SettingsTarget,
    kind: GitAuthKind,
    actor: string,
  ): void {
    const location = scopeLocation(scope, target);
    this.#gitAuth.clear(location, requireGitAuthKind(kind), actor, this.#timestamp());
  }

  inheritGitAuth(scope: SettingsScope, target: SettingsTarget, kind: GitAuthKind): void {
    const location = scopeLocation(scope, target);
    this.#gitAuth.inherit(location, requireGitAuthKind(kind));
  }

  /** Resolve the effective git credential for a project (global + project scopes only). */
  projectGitAuth(projectId: string): GitAuthResolution {
    return this.#gitAuth.resolve(this.#gitAuth.listFor(projectId));
  }

  #timestamp(): Date {
    return this.#now === undefined ? new Date() : this.#now();
  }

  #write(location: ProviderKeyLocation, key: string, valueJson: string, actor: string): void {
    this.#db
      .prepare(
        `INSERT INTO settings
           (scope, project_id, app_key, key, value_json, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @key, @value_json, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        key,
        value_json: valueJson,
        updated_at: this.#timestamp().toISOString(),
        updated_by: actor,
      });
  }

  #readHostAuth(): HostAuthRead {
    if (this.#hostAuthFile === undefined) {
      return { auth: {} };
    }
    let raw: string;
    try {
      raw = readFileSync(this.#hostAuthFile, "utf8");
    } catch {
      return { auth: {}, warning: "host auth file could not be read; using empty auth" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { auth: {}, warning: "host auth file is not valid JSON; using empty auth" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { auth: {}, warning: "host auth file is not a JSON object; using empty auth" };
    }
    return { auth: parsed as Record<string, unknown> };
  }

  #readSettings(target: NormalizedTarget): {
    rows: ParsedSettingRow[];
    warnings: string[];
  } {
    const conditions = ["scope = 'global'"];
    const params: Record<string, string> = {};
    if (target.projectId !== undefined) {
      conditions.push("(scope = 'project' AND project_id = @projectId)");
      params.projectId = target.projectId;
    }
    if (target.projectId !== undefined && target.appKey !== undefined) {
      conditions.push("(scope = 'app' AND project_id = @projectId AND app_key = @appKey)");
      params.appKey = target.appKey;
    }
    const rows = this.#db
      .prepare(`SELECT scope, key, value_json FROM settings WHERE ${conditions.join(" OR ")}`)
      .all(params) as SettingRow[];

    const parsedRows: ParsedSettingRow[] = [];
    const warnings: string[] = [];
    for (const row of rows) {
      try {
        parsedRows.push({ scope: row.scope, key: row.key, value: JSON.parse(row.value_json) });
      } catch {
        warnings.push(`invalid stored JSON for "${row.key}" at ${row.scope} scope; ignoring it`);
      }
    }
    return { rows: parsedRows, warnings };
  }

  #resolve(target: SettingsTarget, host: HostAuthRead): InternalResolution {
    const normalized = normalizeTarget(target);
    const scopes = targetScopes(normalized);
    const { rows, warnings } = this.#readSettings(normalized);
    if (host.warning !== undefined) {
      warnings.unshift(host.warning);
    }

    const rowByScopeKey = new Map<string, ParsedSettingRow>();
    for (const row of rows) {
      rowByScopeKey.set(`${row.scope}:${row.key}`, row);
    }

    const scoped: Record<string, ScopedValue<unknown>> = {};
    const resolverRows = new Map<string, ResolverRow[]>();
    for (const definition of listKeyDefinitions()) {
      for (const scope of scopes) {
        const row = rowByScopeKey.get(`${scope}:${definition.key}`);
        if (row === undefined) {
          scoped[`${scope}:${definition.key}`] = { state: "absent", value: null };
          continue;
        }
        if (row.value === null) {
          scoped[`${scope}:${definition.key}`] = { state: "cleared", value: null };
          continue;
        }
        const parsed = definition.schema.safeParse(row.value);
        scoped[`${scope}:${definition.key}`] = parsed.success
          ? { state: "set", value: parsed.data }
          : { state: "set", value: row.value };
      }
      resolverRows.set(definition.key, resolverRowsFor(scopes, rowByScopeKey, definition.key));
    }

    const values = new Map<string, EffectiveValue<unknown>>();
    for (const definition of listKeyDefinitions()) {
      values.set(
        definition.key,
        resolveEffectiveValue(definition, resolverRows.get(definition.key) ?? [], warnings),
      );
    }

    const effective: EffectiveSettings = {
      llm: { model: effectiveFor<string>(values, "llm.model") },
      web: {
        search: effectiveFor<WebToolConfig>(values, "web.search"),
        fetch: effectiveFor<WebToolConfig>(values, "web.fetch"),
      },
      context: {
        autoCompact: {
          enabled: effectiveFor<boolean>(values, "context.auto_compact.enabled"),
          percent: effectiveFor<number>(values, "context.auto_compact.percent"),
        },
      },
      git: {
        user: {
          name: effectiveFor<string>(values, "git.user.name"),
          email: effectiveFor<string>(values, "git.user.email"),
        },
      },
    };

    const providerRows = this.#providerKeys.listFor(normalized.projectId, normalized.appKey);
    const providers = this.#providerIds(effective, providerRows, host.auth);
    const statuses = new Map<string, ProviderKeyStatus>();
    const providerStates = new Map<string, ProviderKeyState>();
    for (const provider of [...providers].sort()) {
      const resolved = this.#providerKeys.resolve(provider, providerRows, host.auth);
      statuses.set(provider, resolved.status);
      const state = providerKeyState(resolved);
      if (state !== undefined) {
        providerStates.set(provider, state);
      }
    }

    const gitAuth = this.#gitAuth.resolve(
      this.#gitAuth.listFor(normalized.projectId, normalized.appKey),
    );

    return {
      resolved: {
        effective,
        scoped,
        providerKeys: Object.fromEntries(statuses),
        gitAuth: {
          ssh: gitAuth.ssh.status,
          https: gitAuth.https.status,
        },
        gitAuthScoped: {
          ssh: gitAuth.ssh.scoped,
          https: gitAuth.https.scoped,
        },
        warnings,
      },
      providerStates,
      gitAuth,
    };
  }

  #providerIds(
    effective: EffectiveSettings,
    providerRows: readonly StoredProviderKey[],
    hostAuth: Record<string, unknown>,
  ): Set<string> {
    const providers = new Set<string>();
    for (const row of providerRows) {
      providers.add(row.provider);
    }
    for (const key of Object.keys(hostAuth)) {
      providers.add(key);
    }
    const model = effective.llm.model.value;
    if (model !== null) {
      const provider = model.split("/")[0];
      if (provider !== undefined && provider.length > 0) {
        providers.add(provider);
      }
    }
    for (const tool of [effective.web.search.value, effective.web.fetch.value]) {
      if (tool !== null && tool.driver === "deepseek") {
        providers.add(tool.options.provider);
      }
    }
    for (const id of this.#providerIdSource?.() ?? []) {
      providers.add(id);
    }
    return providers;
  }
}
