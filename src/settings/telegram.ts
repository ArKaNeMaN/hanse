import { z } from "zod";
import { open, seal } from "../secrets/crypto.js";
import type { SqliteDatabase } from "../store/index.js";
import type { SecretStatus, SettingsScope } from "./types.js";

export type NotificationSecretField = "bot_token" | "proxy_url";

const SECRET_KEYS: Record<NotificationSecretField, string> = {
  bot_token: "notifications.telegram.bot_token",
  proxy_url: "notifications.telegram.proxy_url",
};

const SCOPE_ORDER: Record<SettingsScope, number> = { global: 0, project: 1, app: 2 };

export interface NotificationSecretLocation {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
}

interface NotificationSecretRow {
  scope: SettingsScope;
  project_id: string;
  app_key: string;
  key: string;
  cipher: string | null;
  nonce: string | null;
  cleared: number;
}

export interface StoredNotificationSecret {
  scope: SettingsScope;
  projectId: string;
  appKey: string;
  field: NotificationSecretField;
  cipher: string | null;
  nonce: string | null;
  cleared: boolean;
}

export interface TelegramSecretConfig {
  botToken?: string;
  proxyUrl?: string;
}

export interface NotificationSecretResolution {
  botToken: SecretStatus;
  proxyUrl: SecretStatus;
  config: TelegramSecretConfig;
}

export class TelegramSecretValidationError extends Error {
  readonly code = "invalid_telegram_secret";
  readonly field: NotificationSecretField;

  constructor(field: NotificationSecretField, message: string) {
    super(`${field} ${message}`);
    this.name = "TelegramSecretValidationError";
    this.field = field;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const scheme = url.protocol.replace(/:$/, "");
    if (!["http", "https", "socks5", "socks5h"].includes(scheme)) {
      return false;
    }
    return url.hash === "";
  } catch {
    return false;
  }
}

function isPublicBaseUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isApiBaseUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export const botTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\d{5,}:[A-Za-z0-9_-]{20,}$/, "must look like <digits>:<token>");

export const proxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isProxyUrl, "must be an http, https, socks5, or socks5h URL without a fragment");

export const chatIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^(-?\d+|@[A-Za-z0-9_]+)$/, "must be a numeric id or an @name");

export const publicBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    isPublicBaseUrl,
    "must be an http or https URL without credentials, a query, or a fragment",
  )
  .transform(stripTrailingSlash);

export const apiBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isApiBaseUrl, "must be an http or https URL without credentials or a fragment")
  .transform(stripTrailingSlash);

export function validateBotToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new TelegramSecretValidationError("bot_token", "must be a string");
  }
  const parsed = botTokenSchema.safeParse(value);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "is invalid";
    throw new TelegramSecretValidationError("bot_token", reason);
  }
  return parsed.data;
}

export function validateProxyUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new TelegramSecretValidationError("proxy_url", "must be a string");
  }
  const parsed = proxyUrlSchema.safeParse(value);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "is invalid";
    throw new TelegramSecretValidationError("proxy_url", reason);
  }
  return parsed.data;
}

function toStored(row: NotificationSecretRow): StoredNotificationSecret {
  const field = row.key === SECRET_KEYS.bot_token ? "bot_token" : "proxy_url";
  return {
    scope: row.scope,
    projectId: row.project_id,
    appKey: row.app_key,
    field,
    cipher: row.cipher,
    nonce: row.nonce,
    cleared: row.cleared === 1,
  };
}

interface FieldResolution {
  status: SecretStatus;
  value?: string;
}

/**
 * Encrypted Telegram bot-token/proxy storage. Clearing writes a tombstone, inheriting deletes the
 * row; resolution follows app > project > global and never returns plaintext in a status.
 */
export class NotificationSecretStore {
  readonly #db: SqliteDatabase;
  readonly #secretKey: Buffer;

  constructor(db: SqliteDatabase, secretKey: Buffer) {
    this.#db = db;
    this.#secretKey = secretKey;
    this.#db.pragma("secure_delete = ON");
  }

  set(
    location: NotificationSecretLocation,
    field: NotificationSecretField,
    value: unknown,
    actor: string,
    now: Date,
  ): void {
    const plaintext = field === "bot_token" ? validateBotToken(value) : validateProxyUrl(value);
    const sealed = seal(this.#secretKey, plaintext);
    this.#db
      .prepare(
        `INSERT INTO setting_secrets
           (scope, project_id, app_key, key, cipher, nonce, meta_json, cleared, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @key, @cipher, @nonce, '{}', 0, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, key) DO UPDATE SET
           cipher = excluded.cipher,
           nonce = excluded.nonce,
           meta_json = '{}',
           cleared = 0,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        scope: location.scope,
        project_id: location.projectId,
        app_key: location.appKey,
        key: SECRET_KEYS[field],
        cipher: sealed.cipher,
        nonce: sealed.nonce,
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  clear(
    location: NotificationSecretLocation,
    field: NotificationSecretField,
    actor: string,
    now: Date,
  ): void {
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
        key: SECRET_KEYS[field],
        updated_at: now.toISOString(),
        updated_by: actor,
      });
    this.#checkpoint();
  }

  inherit(location: NotificationSecretLocation, field: NotificationSecretField): void {
    this.#db
      .prepare(
        "DELETE FROM setting_secrets WHERE scope = ? AND project_id = ? AND app_key = ? AND key = ?",
      )
      .run(location.scope, location.projectId, location.appKey, SECRET_KEYS[field]);
    this.#checkpoint();
  }

  listFor(projectId?: string, appKey?: string): StoredNotificationSecret[] {
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
        `SELECT scope, project_id, app_key, key, cipher, nonce, cleared
           FROM setting_secrets
          WHERE key IN (@botToken, @proxyUrl) AND (${conditions.join(" OR ")})`,
      )
      .all({
        ...params,
        botToken: SECRET_KEYS.bot_token,
        proxyUrl: SECRET_KEYS.proxy_url,
      }) as NotificationSecretRow[];
    return rows.map(toStored).sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  }

  resolve(rows: readonly StoredNotificationSecret[]): NotificationSecretResolution {
    const botToken = this.#resolveField("bot_token", rows);
    const proxyUrl = this.#resolveField("proxy_url", rows);
    return {
      botToken: botToken.status,
      proxyUrl: proxyUrl.status,
      config: {
        ...(botToken.value === undefined ? {} : { botToken: botToken.value }),
        ...(proxyUrl.value === undefined ? {} : { proxyUrl: proxyUrl.value }),
      },
    };
  }

  #resolveField(
    field: NotificationSecretField,
    rows: readonly StoredNotificationSecret[],
  ): FieldResolution {
    let selected: StoredNotificationSecret | undefined;
    for (const row of rows) {
      if (row.field === field) {
        selected = row;
      }
    }
    if (selected === undefined) {
      return { status: { state: "missing" } };
    }
    if (selected.cleared) {
      return { status: { state: "cleared", source: selected.scope } };
    }
    if (selected.cipher === null || selected.nonce === null) {
      return { status: { state: "missing" } };
    }
    try {
      const value = open(this.#secretKey, { cipher: selected.cipher, nonce: selected.nonce });
      return { status: { state: "set", source: selected.scope }, value };
    } catch {
      return { status: { state: "missing" } };
    }
  }

  #checkpoint(): void {
    try {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort physical cleanup; the mutation is already committed.
    }
  }
}
