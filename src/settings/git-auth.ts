import { z } from "zod";
import {
  GitCredentialValidationError,
  type GitHttpsCredential,
  type GitSshCredential,
  parseStoredHttpsCredential,
  parseStoredSshCredential,
  type RunSshKeygen,
  runSshKeygen,
  validateHttpsCredential,
  validateSshCredential,
} from "../git/credentials.js";
import { open, seal } from "../secrets/crypto.js";
import type { SqliteDatabase } from "../store/index.js";
import { hashValue } from "./hash.js";
import type { GitAuthKind, GitAuthScopedState, GitAuthStatus, SettingsScope } from "./types.js";

const AUTH_KEYS: Record<GitAuthKind, string> = {
  ssh: "git.auth.ssh",
  https: "git.auth.https",
};

const SCOPE_ORDER: Record<SettingsScope, number> = { global: 0, project: 1, app: 2 };

const sshMetaSchema = z
  .object({
    kind: z.literal("ssh"),
    publicKey: z.string().min(1),
    fingerprint: z.string().min(1),
    hasKnownHosts: z.boolean(),
  })
  .strict();

const httpsMetaSchema = z
  .object({
    kind: z.literal("https"),
    hosts: z.array(z.string()).min(1),
    username: z.string().min(1),
  })
  .strict();

export interface GitAuthLocation {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
}

interface GitAuthRow {
  scope: SettingsScope;
  project_id: string;
  app_key: string;
  key: string;
  cipher: string | null;
  nonce: string | null;
  meta_json: string;
  cleared: number;
}

export interface StoredGitAuthRow {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
  key: string;
  cipher: string | null;
  nonce: string | null;
  metaJson: string;
  cleared: boolean;
}

export interface GitAuthKindResolution {
  status: GitAuthStatus;
  scoped: Record<SettingsScope, GitAuthScopedState>;
  value?: GitSshCredential | GitHttpsCredential;
}

export interface GitAuthResolution {
  ssh: GitAuthKindResolution;
  https: GitAuthKindResolution;
  gitAuth: { ssh?: GitSshCredential; https?: GitHttpsCredential };
  gitAuthHash: string;
}

export interface GitAuthStoreOptions {
  runSshKeygen?: RunSshKeygen;
}

function toStored(row: GitAuthRow): StoredGitAuthRow {
  return {
    scope: row.scope,
    projectId: row.project_id,
    appKey: row.app_key,
    key: row.key,
    cipher: row.cipher,
    nonce: row.nonce,
    metaJson: row.meta_json,
    cleared: row.cleared === 1,
  };
}

function scopedState(row: StoredGitAuthRow | undefined): GitAuthScopedState {
  if (row === undefined) {
    return "absent";
  }
  return row.cleared ? "cleared" : "set";
}

function errorStatus(kind: GitAuthKind, message: string): GitAuthStatus {
  return { state: "error", kind, message };
}

function parseMeta<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * Encrypted git credential storage. The sealed value is the complete credential object; `meta_json`
 * contains only public metadata. Clearing writes a tombstone, inheriting deletes the row.
 */
export class GitAuthStore {
  readonly #db: SqliteDatabase;
  readonly #secretKey: Buffer;
  readonly #runSshKeygen: RunSshKeygen;

  constructor(db: SqliteDatabase, secretKey: Buffer, options: GitAuthStoreOptions = {}) {
    this.#db = db;
    this.#secretKey = secretKey;
    this.#runSshKeygen = options.runSshKeygen ?? runSshKeygen;
    this.#db.pragma("secure_delete = ON");
  }

  set(
    location: GitAuthLocation,
    kind: GitAuthKind,
    value: unknown,
    actor: string,
    now: Date,
  ): void {
    if (kind === "ssh") {
      const validated = validateSshCredential(value, this.#runSshKeygen);
      const secret: GitSshCredential = {
        privateKey: validated.privateKey,
        ...(validated.knownHosts === undefined ? {} : { knownHosts: validated.knownHosts }),
      };
      this.#write(location, AUTH_KEYS.ssh, secret, actor, now, {
        kind: "ssh",
        publicKey: validated.publicKey,
        fingerprint: validated.fingerprint,
        hasKnownHosts: validated.hasKnownHosts,
      });
      return;
    }
    if (kind === "https") {
      const validated = validateHttpsCredential(value);
      const secret: GitHttpsCredential = {
        hosts: validated.hosts,
        username: validated.username,
        token: validated.token,
      };
      this.#write(location, AUTH_KEYS.https, secret, actor, now, {
        kind: "https",
        hosts: validated.hosts,
        username: validated.username,
      });
      return;
    }
    throw new GitCredentialValidationError("Unsupported git credential kind.", "kind");
  }

  clear(location: GitAuthLocation, kind: GitAuthKind, actor: string, now: Date): void {
    const key = this.#keyFor(kind);
    this.#db
      .prepare(
        `INSERT INTO setting_secrets
           (scope, project_id, app_key, key, cipher, nonce, meta_json, cleared, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @key, NULL, NULL, '{}', 1, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, key) DO UPDATE SET
           cipher = NULL,
           nonce = NULL,
           meta_json = '{}',
           cleared = 1,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        key,
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  inherit(location: GitAuthLocation, kind: GitAuthKind): void {
    const key = this.#keyFor(kind);
    this.#db
      .prepare(
        "DELETE FROM setting_secrets WHERE scope = ? AND project_id = ? AND app_key = ? AND key = ?",
      )
      .run(location.scope, location.projectId, location.appKey, key);
    this.#checkpoint();
  }

  /** Rows for the scopes that apply to a target, ordered wide to narrow. */
  listFor(projectId?: string, appKey?: string): StoredGitAuthRow[] {
    const conditions = ["scope = 'global'"];
    const params: Record<string, string> = {};
    if (projectId !== undefined) {
      conditions.push("(scope = 'project' AND project_id = @projectId)");
      params.projectId = projectId;
    }
    if (projectId !== undefined && appKey !== undefined) {
      conditions.push("(scope = 'app' AND project_id = @projectId AND app_key = @appKey)");
      params.appKey = appKey;
    }
    const rows = this.#db
      .prepare(
        `SELECT scope, project_id, app_key, key, cipher, nonce, meta_json, cleared
           FROM setting_secrets
          WHERE ${conditions.join(" OR ")}`,
      )
      .all(params) as GitAuthRow[];
    return rows.map(toStored).sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  }

  /** Resolve both credential kinds, decrypting only the effective row for each. */
  resolve(rows: readonly StoredGitAuthRow[]): GitAuthResolution {
    const ssh = this.#resolveKind("ssh", rows);
    const https = this.#resolveKind("https", rows);
    const gitAuth: { ssh?: GitSshCredential; https?: GitHttpsCredential } = {};
    if (ssh.value !== undefined) {
      gitAuth.ssh = ssh.value as GitSshCredential;
    }
    if (https.value !== undefined) {
      gitAuth.https = https.value as GitHttpsCredential;
    }
    const sshHash = this.#hashPart(ssh);
    const httpsHash = this.#hashPart(https);
    return {
      ssh,
      https,
      gitAuth,
      gitAuthHash: hashValue({ purpose: "git-auth-v1", ssh: sshHash, https: httpsHash }),
    };
  }

  #hashPart(resolution: GitAuthKindResolution): unknown {
    if (resolution.value !== undefined) {
      return resolution.value;
    }
    if (resolution.status.state === "error") {
      return { error: `${resolution.status.kind}_unreadable` };
    }
    return null;
  }

  #resolveKind(kind: GitAuthKind, rows: readonly StoredGitAuthRow[]): GitAuthKindResolution {
    const key = AUTH_KEYS[kind];
    const scoped: Record<SettingsScope, GitAuthScopedState> = {
      global: "absent",
      project: "absent",
      app: "absent",
    };
    let selected: StoredGitAuthRow | undefined;
    for (const row of rows) {
      if (row.key !== key) {
        continue;
      }
      scoped[row.scope] = scopedState(row);
      selected = row;
    }
    if (selected === undefined) {
      return { status: { state: "missing", kind }, scoped };
    }
    if (selected.cleared) {
      return { status: { state: "cleared", kind, source: selected.scope }, scoped };
    }
    if (selected.cipher === null || selected.nonce === null) {
      return {
        status: errorStatus(kind, `The stored ${kind.toUpperCase()} credential is unreadable.`),
        scoped,
      };
    }
    let plaintext: unknown;
    try {
      plaintext = JSON.parse(
        open(this.#secretKey, { cipher: selected.cipher, nonce: selected.nonce }),
      );
    } catch {
      return {
        status: errorStatus(
          kind,
          `The stored ${kind.toUpperCase()} credential could not be decrypted.`,
        ),
        scoped,
      };
    }
    if (kind === "ssh") {
      const value = parseStoredSshCredential(plaintext);
      const meta = parseMeta(selected.metaJson, sshMetaSchema);
      if (value === undefined || meta === undefined) {
        return {
          status: errorStatus(kind, "The stored SSH credential is invalid."),
          scoped,
        };
      }
      return {
        status: {
          state: "set",
          kind: "ssh",
          source: selected.scope,
          publicKey: meta.publicKey,
          fingerprint: meta.fingerprint,
          hasKnownHosts: meta.hasKnownHosts,
        },
        scoped,
        value,
      };
    }
    const value = parseStoredHttpsCredential(plaintext);
    const httpsMeta = parseMeta(selected.metaJson, httpsMetaSchema);
    if (value === undefined || httpsMeta === undefined) {
      return {
        status: errorStatus(kind, "The stored HTTPS credential is invalid."),
        scoped,
      };
    }
    return {
      status: {
        state: "set",
        kind: "https",
        source: selected.scope,
        hosts: httpsMeta.hosts,
        username: httpsMeta.username,
      },
      scoped,
      value,
    };
  }

  #keyFor(kind: GitAuthKind): string {
    const key = AUTH_KEYS[kind];
    if (key === undefined) {
      throw new GitCredentialValidationError("Unsupported git credential kind.", "kind");
    }
    return key;
  }

  #write(
    location: GitAuthLocation,
    key: string,
    secret: GitSshCredential | GitHttpsCredential,
    actor: string,
    now: Date,
    meta: Record<string, unknown>,
  ): void {
    const sealed = seal(this.#secretKey, JSON.stringify(secret));
    this.#db
      .prepare(
        `INSERT INTO setting_secrets
           (scope, project_id, app_key, key, cipher, nonce, meta_json, cleared, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @key, @cipher, @nonce, @meta_json, 0, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, key) DO UPDATE SET
           cipher = excluded.cipher,
           nonce = excluded.nonce,
           meta_json = excluded.meta_json,
           cleared = 0,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        key,
        cipher: sealed.cipher,
        nonce: sealed.nonce,
        meta_json: JSON.stringify(meta),
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  #checkpoint(): void {
    try {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort physical cleanup; the mutation is already committed.
    }
  }
}
