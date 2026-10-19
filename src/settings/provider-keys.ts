import { open, seal } from "../secrets/crypto.js";
import type { SqliteDatabase } from "../store/index.js";
import type { ProviderKeyState, ProviderKeyStatus, SettingsScope } from "./types.js";

export interface ProviderKeyLocation {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
}

interface ProviderKeyRow {
  scope: SettingsScope;
  project_id: string;
  app_key: string;
  provider: string;
  cipher: string | null;
  nonce: string | null;
  cleared: number;
}

export interface StoredProviderKey {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
  provider: string;
  cipher: string | null;
  nonce: string | null;
  cleared: boolean;
}

export interface ResolvedProviderKey {
  status: ProviderKeyStatus;
  /** Present only for an effective `set` key. */
  key?: string;
}

const SCOPE_ORDER: Record<SettingsScope, number> = { global: 0, project: 1, app: 2 };

function toStored(row: ProviderKeyRow): StoredProviderKey {
  return {
    scope: row.scope,
    projectId: row.project_id,
    appKey: row.app_key,
    provider: row.provider,
    cipher: row.cipher,
    nonce: row.nonce,
    cleared: row.cleared === 1,
  };
}

function hostAuthType(entry: unknown): "api" | "oauth" | "wellknown" {
  if (entry !== null && typeof entry === "object") {
    const type = (entry as { type?: unknown }).type;
    if (type === "api" || type === "oauth" || type === "wellknown") {
      return type;
    }
  }
  return "wellknown";
}

/**
 * Encrypted provider-key storage. Ciphertext is sealed with the coordinator
 * secret key; a cleared row is a logical tombstone. `secure_delete` plus a WAL
 * checkpoint removes the previous page in normal operation, but physical media
 * backups may still retain old pages.
 */
export class ProviderKeyStore {
  readonly #db: SqliteDatabase;
  readonly #secretKey: Buffer;

  constructor(db: SqliteDatabase, secretKey: Buffer) {
    this.#db = db;
    this.#secretKey = secretKey;
    // Overwrite freed pages where SQLite can; the checkpoint below covers the WAL.
    this.#db.pragma("secure_delete = ON");
  }

  set(
    location: ProviderKeyLocation,
    provider: string,
    key: string,
    actor: string,
    now: Date,
  ): void {
    const sealed = seal(this.#secretKey, key);
    this.#db
      .prepare(
        `INSERT INTO provider_keys
           (scope, project_id, app_key, provider, cipher, nonce, cleared, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @provider, @cipher, @nonce, 0, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, provider) DO UPDATE SET
           cipher = excluded.cipher,
           nonce = excluded.nonce,
           cleared = 0,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        provider,
        cipher: sealed.cipher,
        nonce: sealed.nonce,
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  clear(location: ProviderKeyLocation, provider: string, actor: string, now: Date): void {
    this.#db
      .prepare(
        `INSERT INTO provider_keys
           (scope, project_id, app_key, provider, cipher, nonce, cleared, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @provider, NULL, NULL, 1, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, provider) DO UPDATE SET
           cipher = NULL,
           nonce = NULL,
           cleared = 1,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        provider,
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  inherit(location: ProviderKeyLocation, provider: string): void {
    this.#db
      .prepare(
        "DELETE FROM provider_keys WHERE scope = ? AND project_id = ? AND app_key = ? AND provider = ?",
      )
      .run(location.scope, location.projectId, location.appKey, provider);
    this.#checkpoint();
  }

  #checkpoint(): void {
    try {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort physical cleanup; the mutation is already committed.
    }
  }

  /** Rows for the scopes that apply to a target, ordered wide to narrow. */
  listFor(projectId?: string, appKey?: string): StoredProviderKey[] {
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
        `SELECT scope, project_id, app_key, provider, cipher, nonce, cleared
           FROM provider_keys
          WHERE ${conditions.join(" OR ")}
          ORDER BY scope, project_id, app_key, provider`,
      )
      .all(params) as ProviderKeyRow[];
    return rows.map(toStored).sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  }

  /** Resolve one provider across the supplied rows, falling back to host auth. */
  resolve(
    provider: string,
    rows: readonly StoredProviderKey[],
    hostAuth: Record<string, unknown>,
  ): ResolvedProviderKey {
    let selected: StoredProviderKey | undefined;
    for (const row of rows) {
      if (row.provider === provider) {
        selected = row;
      }
    }

    if (selected !== undefined) {
      if (selected.cleared) {
        return { status: { state: "cleared", source: selected.scope } };
      }
      if (selected.cipher === null || selected.nonce === null) {
        return {
          status: {
            state: "error",
            message: `provider key for "${provider}" is not readable`,
          },
        };
      }
      try {
        const key = open(this.#secretKey, { cipher: selected.cipher, nonce: selected.nonce });
        return { status: { state: "set", source: selected.scope }, key };
      } catch {
        return {
          status: {
            state: "error",
            message: `provider key for "${provider}" could not be decrypted`,
          },
        };
      }
    }

    if (Object.hasOwn(hostAuth, provider)) {
      return {
        status: {
          state: "host",
          source: "host-auth",
          authType: hostAuthType(hostAuth[provider]),
        },
      };
    }
    return { status: { state: "missing" } };
  }
}

/** Convert an effective provider key to the state consumed by the launcher. */
export function providerKeyState(resolved: ResolvedProviderKey): ProviderKeyState | undefined {
  if (resolved.status.state === "set" && resolved.key !== undefined) {
    return { state: "set", key: resolved.key };
  }
  if (resolved.status.state === "cleared") {
    return { state: "cleared" };
  }
  return undefined;
}
