import { describe, expect, it } from "vitest";
import {
  collisionWarnings,
  ModelProviderConflictError,
  type ModelProviderInput,
  ModelProviderInUseError,
  type ModelProviderModel,
  ModelProviderNotFoundError,
  ModelProviderService,
  ModelProviderValidationError,
  parseModelLines,
  providerBaseUrlWarnings,
} from "../src/model-providers/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const NOW = "2026-10-27T12:00:00.000Z";

function fixture(): { db: SqliteDatabase; service: ModelProviderService } {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return { db, service: new ModelProviderService({ db, now: () => new Date(NOW) }) };
}

function model(id: string, overrides: Partial<ModelProviderModel> = {}): ModelProviderModel {
  return {
    id,
    limit: { context: 1000, output: 100 },
    ...overrides,
  };
}

function input(overrides: Partial<ModelProviderInput> = {}): ModelProviderInput {
  return {
    id: "llm-lan",
    name: "LLM LAN",
    baseUrl: "http://gateway:4000/v1",
    models: [model("deepseek")],
    ...overrides,
  };
}

function setModel(
  db: SqliteDatabase,
  scope: "global" | "project" | "app",
  projectId: string,
  appKey: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO settings (scope, project_id, app_key, key, value_json, updated_at)
     VALUES (?, ?, ?, 'llm.model', ?, ?)`,
  ).run(scope, projectId, appKey, JSON.stringify(value), NOW);
}

describe("ModelProviderService", () => {
  it("creates, lists, updates, and deletes a provider with audit events", () => {
    const { db, service } = fixture();
    const created = service.create(input({ name: "" }), "operator");
    expect(created).toMatchObject({
      id: "llm-lan",
      name: "llm-lan",
      baseUrl: "http://gateway:4000/v1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(created.models).toEqual([model("deepseek")]);
    expect(service.list()).toEqual([created]);
    expect(service.get("llm-lan")).toEqual(created);

    const updated = service.update(
      "llm-lan",
      {
        name: "LAN",
        baseUrl: "https://gateway:4000/v1/",
        models: [model("deepseek-pro"), model("deepseek", { name: "DeepSeek" })],
      },
      "operator",
    );
    expect(updated.name).toBe("LAN");
    expect(updated.baseUrl).toBe("https://gateway:4000/v1");
    expect(updated.models.map((entry) => entry.id)).toEqual(["deepseek", "deepseek-pro"]);
    expect(updated.models[0]?.name).toBe("DeepSeek");

    service.delete("llm-lan", "operator");
    expect(service.list()).toEqual([]);
    const events = db.prepare("SELECT type FROM events ORDER BY id").all() as { type: string }[];
    expect(events.map((event) => event.type)).toEqual([
      "provider.created",
      "provider.updated",
      "provider.deleted",
    ]);
  });

  it("returns an empty snapshot for an empty registry", () => {
    const { service } = fixture();
    expect(service.snapshot()).toEqual({
      providers: [],
      overlay: undefined,
      hash: undefined,
    });
  });

  it("projects a deterministic overlay and hash", () => {
    const { service } = fixture();
    const original = input({
      models: [model("deepseek-pro"), model("deepseek", { name: "DeepSeek" })],
    });
    service.create(original, "operator");
    const first = service.snapshot();
    expect(first.overlay).toEqual({
      "llm-lan": {
        npm: "@ai-sdk/openai-compatible",
        name: "LLM LAN",
        options: { baseURL: "http://gateway:4000/v1" },
        models: {
          deepseek: { name: "DeepSeek", limit: { context: 1000, output: 100 } },
          "deepseek-pro": { limit: { context: 1000, output: 100 } },
        },
      },
    });
    expect(first.hash).toBeTypeOf("string");

    service.update("llm-lan", original, "operator");
    expect(service.snapshot().hash).toBe(first.hash);

    service.update("llm-lan", input({ name: "Renamed" }), "operator");
    expect(service.snapshot().hash).not.toBe(first.hash);
  });

  it("rejects invalid provider ids, names, URLs, and models", () => {
    const { service } = fixture();
    for (const id of ["LLM", "-llm", "__proto__", "constructor", "a/b"]) {
      expect(() => service.create(input({ id }), "operator")).toThrow(ModelProviderValidationError);
    }
    expect(() => service.create(input({ name: "\u0000bad" }), "operator")).toThrow(
      ModelProviderValidationError,
    );
    for (const baseUrl of [
      "ftp://gateway:4000/v1",
      "http://user:pass@gateway:4000/v1",
      "http://gateway:4000/v1?x=1",
      "http://gateway:4000/v1#x",
      "not a url",
    ]) {
      expect(() => service.create(input({ baseUrl }), "operator")).toThrow(
        ModelProviderValidationError,
      );
    }
    expect(() => service.create(input({ models: [] }), "operator")).toThrow(
      ModelProviderValidationError,
    );
    expect(() =>
      service.create(input({ models: [model("deepseek"), model("deepseek")] }), "operator"),
    ).toThrow(ModelProviderValidationError);
    expect(() => service.create(input({ models: [model("__proto__")] }), "operator")).toThrow(
      ModelProviderValidationError,
    );
    expect(() =>
      service.create(input({ models: [model("m", { name: "bad|name" })] }), "operator"),
    ).toThrow(ModelProviderValidationError);
    expect(() =>
      service.create(
        input({ models: [model("m", { limit: { context: 0, output: 1 } })] }),
        "operator",
      ),
    ).toThrow(ModelProviderValidationError);
  });

  it("rejects a provider/model pair that cannot fit llm.model", () => {
    const { service } = fixture();
    expect(() =>
      service.create(input({ id: "llm-lan", models: [model("x".repeat(256))] }), "operator"),
    ).toThrow(/256-character/);
  });

  it("normalizes a base URL and defaults a blank provider name", () => {
    const { service } = fixture();
    const withoutSlash = service.create(
      input({ id: "one", name: "", baseUrl: "http://gateway:4000/" }),
      "operator",
    );
    expect(withoutSlash.name).toBe("one");
    expect(withoutSlash.baseUrl).toBe("http://gateway:4000");
    const withPath = service.create(
      input({ id: "two", baseUrl: "http://gateway:4000/v1/" }),
      "operator",
    );
    expect(withPath.baseUrl).toBe("http://gateway:4000/v1");
  });

  it("caps the registry at 32 providers", () => {
    const { service } = fixture();
    for (let index = 0; index < 32; index += 1) {
      service.create(input({ id: `p${index}` }), "operator");
    }
    expect(() => service.create(input({ id: "p32" }), "operator")).toThrow(/at most 32/);
  });

  it("caps the provider projection at 48 KiB", () => {
    const { service } = fixture();
    const bigModels = Array.from({ length: 64 }, (_, index) =>
      model(`${String(index).padStart(2, "0")}${"x".repeat(198)}`, {
        name: "n".repeat(128),
      }),
    );
    service.create(input({ id: "p0", models: bigModels }), "operator");
    service.create(input({ id: "p1", models: bigModels }), "operator");
    expect(() => service.create(input({ id: "p2", models: bigModels }), "operator")).toThrow(
      /overlay budget/,
    );
  });

  it("enforces the projection cap when repairing an invalid row", () => {
    const { db, service } = fixture();
    const bigModels = Array.from({ length: 64 }, (_, index) =>
      model(`${String(index).padStart(2, "0")}${"x".repeat(198)}`, {
        name: "n".repeat(128),
      }),
    );
    service.create(input({ id: "p0", models: bigModels }), "operator");
    service.create(input({ id: "p1", models: bigModels }), "operator");
    db.prepare(
      `INSERT INTO model_providers (id, name, npm, base_url, models_json, created_at, updated_at)
       VALUES ('bad', 'Bad', '@ai-sdk/openai-compatible', 'http://host', '[]', ?, ?)`,
    ).run(NOW, NOW);

    expect(() =>
      service.update("bad", { name: "Bad", baseUrl: "http://host", models: bigModels }, "operator"),
    ).toThrow(/overlay budget/);
  });

  it("filters a manually edited invalid row from every consumer", () => {
    const { db, service } = fixture();
    db.prepare(
      `INSERT INTO model_providers (id, name, npm, base_url, models_json, created_at, updated_at)
       VALUES ('bad', 'Bad', '@ai-sdk/openai-compatible', 'http://host', '[]', ?, ?)`,
    ).run(NOW, NOW);
    expect(service.list()).toEqual([]);
    expect(service.snapshot()).toEqual({
      providers: [],
      overlay: undefined,
      hash: undefined,
    });
  });

  it("refuses to delete a provider referenced by any llm.model scope", () => {
    const { db, service } = fixture();
    service.create(input(), "operator");
    setModel(db, "global", "", "", "llm-lan/deepseek");
    setModel(db, "project", "p", "", "llm-lan/deepseek-pro");
    setModel(db, "app", "p", "a", "other/model");

    try {
      service.delete("llm-lan", "operator");
      throw new Error("delete should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderInUseError);
      expect((error as ModelProviderInUseError).references).toEqual([
        { scope: "global", projectId: "", appKey: "" },
        { scope: "project", projectId: "p", appKey: "" },
      ]);
    }
    expect(service.get("llm-lan")).toBeDefined();

    db.prepare("DELETE FROM settings WHERE value_json = ?").run(JSON.stringify("llm-lan/deepseek"));
    db.prepare("DELETE FROM settings WHERE value_json = ?").run(
      JSON.stringify("llm-lan/deepseek-pro"),
    );
    service.delete("llm-lan", "operator");
    expect(service.get("llm-lan")).toBeUndefined();
  });

  it("ignores a null llm.model row in the delete guard", () => {
    const { db, service } = fixture();
    service.create(input(), "operator");
    db.prepare(
      "INSERT INTO settings (scope, project_id, app_key, key, value_json, updated_at) VALUES ('global', '', '', 'llm.model', 'null', ?)",
    ).run(NOW);
    expect(() => service.delete("llm-lan", "operator")).not.toThrow();
  });

  it("reports missing and duplicate providers", () => {
    const { service } = fixture();
    expect(() => service.update("missing", input(), "operator")).toThrow(
      ModelProviderNotFoundError,
    );
    expect(() => service.delete("missing", "operator")).toThrow(ModelProviderNotFoundError);
    service.create(input(), "operator");
    expect(() => service.create(input(), "operator")).toThrow(ModelProviderConflictError);
  });
});

describe("model provider helpers", () => {
  it("parses the settings textarea format", () => {
    expect(
      parseModelLines("deepseek | 1000000 | 64000 | DeepSeek\ndeepseek-pro | 1000000 | 64000"),
    ).toEqual([
      { id: "deepseek", name: "DeepSeek", limit: { context: 1000000, output: 64000 } },
      { id: "deepseek-pro", limit: { context: 1000000, output: 64000 } },
    ]);
    expect(() => parseModelLines("deepseek | nope | 1")).toThrow(ModelProviderValidationError);
    expect(() => parseModelLines("deepseek | 0 | 1")).toThrow(ModelProviderValidationError);
    expect(() => parseModelLines("deepseek | 1 | 2 | a | b")).toThrow(ModelProviderValidationError);
  });

  it("warns on bundled ids, keyed ids, loopback, and plain HTTP", () => {
    expect(collisionWarnings("deepseek", new Set())).toHaveLength(1);
    expect(collisionWarnings("llm-lan", new Set(["llm-lan"]))).toHaveLength(1);
    expect(collisionWarnings("llm-lan", new Set())).toEqual([]);
    expect(providerBaseUrlWarnings("http://127.0.0.1:4000/v1")[0]).toContain("loopback");
    expect(providerBaseUrlWarnings("http://gateway:4000/v1")[0]).toContain("plain HTTP");
    expect(providerBaseUrlWarnings("https://gateway:4000/v1")).toEqual([]);
  });
});
