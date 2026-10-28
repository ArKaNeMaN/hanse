import { recordEvent } from "../store/events.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  ModelProviderConflictError,
  ModelProviderInUseError,
  ModelProviderNotFoundError,
  ModelProviderValidationError,
} from "./errors.js";
import {
  type ModelProvider,
  type ModelProviderReference,
  type ModelProviderScope,
  type ModelProviderSnapshot,
  PROVIDER_NPM,
} from "./types.js";
import {
  collisionWarnings as buildCollisionWarnings,
  hashProviders,
  MAX_PROVIDER_PROJECTION_BYTES,
  MAX_PROVIDERS,
  providerProjectionBytes,
  toOverlay,
  validateInput,
} from "./validation.js";

export interface ModelProviderServiceOptions {
  db: SqliteDatabase;
  now?: () => Date;
}

interface ModelProviderRow {
  id: string;
  name: string;
  npm: string;
  base_url: string;
  models_json: string;
  created_at: string;
  updated_at: string;
}

interface ModelReferenceRow {
  scope: string;
  project_id: string;
  app_key: string;
  value_json: string;
}

/**
 * Global custom model-provider registry. One validated snapshot feeds the overlay, the launch hash,
 * the settings page, and the delete guard.
 */
export class ModelProviderService {
  readonly #db: SqliteDatabase;
  readonly #now: (() => Date) | undefined;

  constructor(options: ModelProviderServiceOptions) {
    this.#db = options.db;
    this.#now = options.now;
  }

  snapshot(): ModelProviderSnapshot {
    const providers = this.#readAll();
    return {
      providers,
      overlay: toOverlay(providers),
      hash: hashProviders(providers),
    };
  }

  list(): ModelProvider[] {
    return this.#readAll();
  }

  get(id: string): ModelProvider | undefined {
    return this.#readAll().find((provider) => provider.id === id);
  }

  create(input: unknown, _actor: string): ModelProvider {
    const normalized = validateInput(input);
    if (this.#count() >= MAX_PROVIDERS) {
      throw new ModelProviderValidationError(
        `at most ${MAX_PROVIDERS} custom providers are allowed`,
      );
    }
    if (this.#exists(normalized.id)) {
      throw new ModelProviderConflictError();
    }
    const now = this.#nowIso();
    const providers = [...this.#readAll(), { ...normalized, createdAt: now, updatedAt: now }];
    this.#ensureProjection(providers);
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO model_providers
             (id, name, npm, base_url, models_json, created_at, updated_at)
           VALUES
             (@id, @name, @npm, @base_url, @models_json, @created_at, @updated_at)`,
        )
        .run({
          id: normalized.id,
          name: normalized.name,
          npm: PROVIDER_NPM,
          base_url: normalized.baseUrl,
          models_json: JSON.stringify(normalized.models),
          created_at: now,
          updated_at: now,
        });
      recordEvent(this.#db, "global", "provider.created", {
        id: normalized.id,
        models: normalized.models.length,
      });
    })();
    return this.#require(normalized.id);
  }

  update(id: string, input: unknown, _actor: string): ModelProvider {
    if (!this.#exists(id)) {
      throw new ModelProviderNotFoundError();
    }
    const base =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const normalized = validateInput({ ...base, id });
    const now = this.#nowIso();
    const current = this.#readAll();
    const providers = current.some((provider) => provider.id === id)
      ? current.map((provider) =>
          provider.id === id
            ? {
                ...provider,
                ...normalized,
                createdAt: provider.createdAt,
                updatedAt: now,
              }
            : provider,
        )
      : [...current, { ...normalized, createdAt: now, updatedAt: now }];
    this.#ensureProjection(providers);
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE model_providers
              SET name = @name,
                  base_url = @base_url,
                  models_json = @models_json,
                  updated_at = @updated_at
            WHERE id = @id`,
        )
        .run({
          id,
          name: normalized.name,
          base_url: normalized.baseUrl,
          models_json: JSON.stringify(normalized.models),
          updated_at: now,
        });
      recordEvent(this.#db, "global", "provider.updated", {
        id,
        models: normalized.models.length,
      });
    })();
    return this.#require(id);
  }

  delete(id: string, _actor: string): void {
    if (!this.#exists(id)) {
      throw new ModelProviderNotFoundError();
    }
    this.#db.transaction(() => {
      const references = this.#references(id);
      if (references.length > 0) {
        throw new ModelProviderInUseError(id, references);
      }
      this.#db.prepare("DELETE FROM model_providers WHERE id = ?").run(id);
      recordEvent(this.#db, "global", "provider.deleted", { id });
    })();
  }

  collisionWarnings(id: string, existingProviderIds: ReadonlySet<string>): string[] {
    return buildCollisionWarnings(id, existingProviderIds);
  }

  #readAll(): ModelProvider[] {
    const rows = this.#db
      .prepare(
        `SELECT id, name, npm, base_url, models_json, created_at, updated_at
           FROM model_providers
          ORDER BY id`,
      )
      .all() as ModelProviderRow[];
    const providers: ModelProvider[] = [];
    for (const row of rows) {
      try {
        const models = JSON.parse(row.models_json) as unknown;
        const normalized = validateInput({
          id: row.id,
          name: row.name,
          baseUrl: row.base_url,
          models,
        });
        providers.push({
          ...normalized,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      } catch {
        // A manually edited or corrupt row must not prevent an app from starting.
      }
    }
    return providers;
  }

  #count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM model_providers").get() as {
      count: number;
    };
    return row.count;
  }

  #exists(id: string): boolean {
    const row = this.#db.prepare("SELECT 1 AS found FROM model_providers WHERE id = ?").get(id);
    return row !== undefined;
  }

  #require(id: string): ModelProvider {
    const provider = this.get(id);
    if (provider === undefined) {
      throw new ModelProviderValidationError(`custom provider "${id}" could not be reloaded`);
    }
    return provider;
  }

  #ensureProjection(providers: readonly ModelProvider[]): void {
    const bytes = providerProjectionBytes(providers);
    if (bytes > MAX_PROVIDER_PROJECTION_BYTES) {
      throw new ModelProviderValidationError(
        `custom providers need ${bytes} bytes, exceeding the ${MAX_PROVIDER_PROJECTION_BYTES}-byte overlay budget; remove a provider or models`,
      );
    }
  }

  #references(id: string): ModelProviderReference[] {
    const rows = this.#db
      .prepare(
        `SELECT scope, project_id, app_key, value_json
           FROM settings
          WHERE key = 'llm.model'
          ORDER BY scope, project_id, app_key`,
      )
      .all() as ModelReferenceRow[];
    const references: ModelProviderReference[] = [];
    const prefix = `${id}/`;
    for (const row of rows) {
      let value: unknown;
      try {
        value = JSON.parse(row.value_json);
      } catch {
        continue;
      }
      if (typeof value !== "string" || !value.startsWith(prefix)) {
        continue;
      }
      references.push({
        scope: row.scope as ModelProviderScope,
        projectId: row.project_id,
        appKey: row.app_key,
      });
    }
    return references;
  }

  #nowIso(): string {
    return (this.#now?.() ?? new Date()).toISOString();
  }
}
