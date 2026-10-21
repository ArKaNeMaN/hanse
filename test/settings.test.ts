import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunSshKeygen } from "../src/git/credentials.js";
import {
  hashValue,
  launchEffectiveSettings,
  resolveEffectiveValue,
  type SettingsKeyDefinition,
  SettingsService,
  SettingsValidationError,
  stableStringify,
} from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const now = new Date("2026-10-19T10:00:00.000Z");

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  key: Buffer;
  hostAuthFile: string;
  service: SettingsService;
}

function fakeSshKeygen(): RunSshKeygen {
  return (args) => {
    if (args[0] === "-y") {
      return {
        status: 0,
        stdout: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake fake@test\n",
        stderr: "",
      };
    }
    if (args[0] === "-lf") {
      return { status: 0, stdout: "256 SHA256:fakefingerprint fake@test (ED25519)\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

const VALID_SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-private-key-body\n-----END OPENSSH PRIVATE KEY-----\n";

function fixture(
  options: {
    hostAuth?: Record<string, unknown>;
    hostAuthRaw?: string;
    runSshKeygen?: RunSshKeygen;
  } = {},
): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-settings-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const key = randomBytes(32);
  const hostAuthFile = path.join(dir, "auth.json");
  let useHostFile = false;
  if (options.hostAuth !== undefined) {
    writeFileSync(hostAuthFile, JSON.stringify(options.hostAuth));
    useHostFile = true;
  }
  if (options.hostAuthRaw !== undefined) {
    writeFileSync(hostAuthFile, options.hostAuthRaw);
    useHostFile = true;
  }
  const service = new SettingsService({
    db,
    secretKey: key,
    hostAuthFile: useHostFile ? hostAuthFile : undefined,
    now: () => now,
    runSshKeygen: options.runSshKeygen,
  });
  return { db, key, hostAuthFile, service };
}

function insertSetting(
  db: SqliteDatabase,
  scope: string,
  projectId: string,
  appKey: string,
  key: string,
  valueJson: string,
): void {
  db.prepare(
    "INSERT INTO settings (scope, project_id, app_key, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(scope, projectId, appKey, key, valueJson, now.toISOString());
}

const appTarget = { projectId: "p", appKey: "web" };
const projectTarget = { projectId: "p" };

describe("settings defaults and precedence", () => {
  it("returns the built-in defaults and absent scoped rows", () => {
    const { service } = fixture();
    const resolved = service.resolve({});

    expect(resolved.effective.llm.model).toEqual({
      value: "deepseek/deepseek-flash",
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(resolved.effective.web.search).toEqual({
      value: { driver: "builtin" },
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(resolved.effective.web.fetch).toEqual({
      value: { driver: "builtin" },
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(resolved.effective.context.autoCompact.enabled).toEqual({
      value: false,
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(resolved.effective.context.autoCompact.percent).toEqual({
      value: 80,
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(resolved.scoped["global:llm.model"]).toEqual({ state: "absent", value: null });
    expect(resolved.scoped["global:web.search"]).toEqual({ state: "absent", value: null });
    expect(resolved.scoped["global:context.auto_compact.enabled"]).toEqual({
      state: "absent",
      value: null,
    });
    expect(resolved.scoped["global:context.auto_compact.percent"]).toEqual({
      state: "absent",
      value: null,
    });
    expect(resolved.warnings).toEqual([]);
  });

  it("lets the narrowest scope win and reports the contributing scopes", () => {
    const { service } = fixture();
    service.set("global", {}, "llm.model", "global/model", "owner");
    service.set("project", projectTarget, "llm.model", "project/model", "owner");
    service.set("app", appTarget, "llm.model", "app/model", "owner");

    const global = service.resolve({});
    expect(global.effective.llm.model).toEqual({
      value: "global/model",
      state: "set",
      source: "global",
      sources: ["global"],
    });

    const project = service.resolve(projectTarget);
    expect(project.effective.llm.model.value).toBe("project/model");
    expect(project.effective.llm.model.source).toBe("project");
    expect(project.scoped["project:llm.model"]).toEqual({
      state: "set",
      value: "project/model",
    });
    expect(project.scoped["app:llm.model"]).toBeUndefined();

    const app = service.resolve(appTarget);
    expect(app.effective.llm.model.value).toBe("app/model");
    expect(app.effective.llm.model.source).toBe("app");
    expect(app.scoped["app:llm.model"]).toEqual({ state: "set", value: "app/model" });
  });

  it("stops inheritance at a cleared scope and allows a narrower re-set", () => {
    const { service } = fixture();
    service.set("global", {}, "llm.model", "global/model", "owner");
    service.clear("project", projectTarget, "web.search", "owner");

    const project = service.resolve(projectTarget);
    expect(project.effective.web.search).toEqual({
      value: null,
      state: "cleared",
      source: "project",
      sources: ["project"],
    });
    expect(project.scoped["project:web.search"]).toEqual({ state: "cleared", value: null });

    service.set("app", appTarget, "web.search", { driver: "builtin" }, "owner");
    expect(service.resolve(appTarget).effective.web.search).toEqual({
      value: { driver: "builtin" },
      state: "set",
      source: "app",
      sources: ["app"],
    });

    service.clear("global", {}, "web.fetch", "owner");
    service.set("project", projectTarget, "web.fetch", { driver: "builtin" }, "owner");
    expect(service.resolve(projectTarget).effective.web.fetch.state).toBe("set");
  });
});

describe("context auto-compaction settings", () => {
  it("resolves global -> project -> app and inherits narrower overrides", () => {
    const { service } = fixture();
    service.set("global", {}, "context.auto_compact.enabled", true, "owner");
    service.set("global", {}, "context.auto_compact.percent", 90, "owner");
    service.set("project", projectTarget, "context.auto_compact.percent", 70, "owner");
    service.set("app", appTarget, "context.auto_compact.enabled", false, "owner");
    service.set("app", appTarget, "context.auto_compact.percent", 60, "owner");

    const global = service.resolve({});
    expect(global.effective.context.autoCompact.enabled).toEqual({
      value: true,
      state: "set",
      source: "global",
      sources: ["global"],
    });
    expect(global.effective.context.autoCompact.percent).toEqual({
      value: 90,
      state: "set",
      source: "global",
      sources: ["global"],
    });

    const project = service.resolve(projectTarget);
    expect(project.effective.context.autoCompact.enabled.value).toBe(true);
    expect(project.effective.context.autoCompact.enabled.source).toBe("global");
    expect(project.effective.context.autoCompact.percent).toEqual({
      value: 70,
      state: "set",
      source: "project",
      sources: ["project"],
    });

    const app = service.resolve(appTarget);
    expect(app.effective.context.autoCompact.enabled).toEqual({
      value: false,
      state: "set",
      source: "app",
      sources: ["app"],
    });
    expect(app.effective.context.autoCompact.percent.value).toBe(60);
    expect(app.scoped["app:context.auto_compact.percent"]).toEqual({
      state: "set",
      value: 60,
    });

    service.inherit("app", appTarget, "context.auto_compact.percent");
    expect(service.resolve(appTarget).effective.context.autoCompact.percent).toEqual({
      value: 70,
      state: "set",
      source: "project",
      sources: ["project"],
    });
  });

  it("validates booleans and integer percentages and refuses clears", () => {
    const { service } = fixture();

    for (const invalid of ["true", 1, null, "on"] as unknown[]) {
      expect(() =>
        service.set("global", {}, "context.auto_compact.enabled", invalid, "owner"),
      ).toThrow(SettingsValidationError);
    }
    for (const invalid of [0, 100, 1.5, "80", null] as unknown[]) {
      expect(() =>
        service.set("global", {}, "context.auto_compact.percent", invalid, "owner"),
      ).toThrow(SettingsValidationError);
    }

    service.set("global", {}, "context.auto_compact.percent", 1, "owner");
    service.set("global", {}, "context.auto_compact.percent", 99, "owner");
    expect(service.resolve({}).effective.context.autoCompact.percent.value).toBe(99);

    expect(() => service.clear("global", {}, "context.auto_compact.enabled", "owner")).toThrow(
      /not clearable/,
    );
    expect(() => service.clear("global", {}, "context.auto_compact.percent", "owner")).toThrow(
      /not clearable/,
    );
  });
});

describe("context policy and launch projection", () => {
  it("returns the three-key policy with effective sources", () => {
    const { db, service } = fixture();
    expect(service.contextPolicy({})).toEqual({
      enabled: false,
      percent: 80,
      model: "deepseek/deepseek-flash",
      enabledSource: "default",
      percentSource: "default",
    });

    service.set("global", {}, "llm.model", "global/model", "owner");
    service.set("global", {}, "context.auto_compact.enabled", true, "owner");
    service.set("project", projectTarget, "context.auto_compact.percent", 65, "owner");

    expect(service.contextPolicy({})).toEqual({
      enabled: true,
      percent: 80,
      model: "global/model",
      enabledSource: "global",
      percentSource: "default",
    });
    expect(service.contextPolicy(projectTarget)).toEqual({
      enabled: true,
      percent: 65,
      model: "global/model",
      enabledSource: "global",
      percentSource: "project",
    });

    insertSetting(db, "app", "p", "web", "context.auto_compact.percent", '"66"');
    expect(service.contextPolicy(appTarget)).toEqual({
      enabled: true,
      percent: 65,
      model: "global/model",
      enabledSource: "global",
      percentSource: "project",
    });
  });

  it("omits context from the launch projection while the full hash includes it", () => {
    const { service } = fixture();
    const preChangeEffective = {
      llm: {
        model: {
          value: "deepseek/deepseek-flash",
          state: "default",
          source: "default",
          sources: ["default"],
        },
      },
      web: {
        search: {
          value: { driver: "builtin" },
          state: "default",
          source: "default",
          sources: ["default"],
        },
        fetch: {
          value: { driver: "builtin" },
          state: "default",
          source: "default",
          sources: ["default"],
        },
      },
      git: {
        user: {
          name: {
            value: null,
            state: "default",
            source: "default",
            sources: ["default"],
          },
          email: {
            value: null,
            state: "default",
            source: "default",
            sources: ["default"],
          },
        },
      },
    };

    const projected = launchEffectiveSettings(service.resolve({}).effective);
    expect("context" in projected).toBe(false);
    expect(projected).toEqual(preChangeEffective);
    expect(hashValue(projected)).toBe(hashValue(preChangeEffective));

    const baseHash = service.effectiveHash(appTarget);
    service.set("global", {}, "context.auto_compact.enabled", true, "owner");
    const enabledHash = service.effectiveHash(appTarget);
    expect(enabledHash).not.toBe(baseHash);
    expect(hashValue(launchEffectiveSettings(service.resolve(appTarget).effective))).toBe(
      hashValue(preChangeEffective),
    );

    service.set("global", {}, "context.auto_compact.percent", 55, "owner");
    expect(service.effectiveHash(appTarget)).not.toBe(enabledHash);
    expect(hashValue(launchEffectiveSettings(service.resolve(appTarget).effective))).toBe(
      hashValue(preChangeEffective),
    );

    service.set("global", {}, "llm.model", "changed/model", "owner");
    expect(hashValue(launchEffectiveSettings(service.resolve(appTarget).effective))).not.toBe(
      hashValue(preChangeEffective),
    );
  });
});

describe("append resolution", () => {
  const appendDefinition: SettingsKeyDefinition<string[]> = {
    key: "test.append",
    schema: z.array(z.string()),
    merge: "append",
    clearable: true,
    defaultValue: [],
  };

  it("concatenates contributors wide to narrow and lists both sources", () => {
    const warnings: string[] = [];
    const resolved = resolveEffectiveValue(
      appendDefinition,
      [
        { scope: "global", value: ["global-a"] },
        { scope: "project", value: ["project-b"] },
      ],
      warnings,
    );
    expect(resolved).toEqual({
      value: ["global-a", "project-b"],
      state: "set",
      source: "project",
      sources: ["global", "project"],
    });
    expect(warnings).toEqual([]);
  });

  it("clears the accumulated list at a null scope and can be re-set narrower", () => {
    const cleared = resolveEffectiveValue(appendDefinition, [
      { scope: "global", value: ["global-a"] },
      { scope: "project", value: ["project-b"] },
      { scope: "app", value: null },
    ]);
    expect(cleared).toEqual({
      value: null,
      state: "cleared",
      source: "app",
      sources: ["app"],
    });

    const reset = resolveEffectiveValue(appendDefinition, [
      { scope: "global", value: ["global-a"] },
      { scope: "project", value: null },
      { scope: "app", value: ["app-c"] },
    ]);
    expect(reset).toEqual({
      value: ["app-c"],
      state: "set",
      source: "app",
      sources: ["app"],
    });
  });

  it("falls back to the default and warns for an invalid contributor", () => {
    const warnings: string[] = [];
    const resolved = resolveEffectiveValue(
      appendDefinition,
      [{ scope: "global", value: "not-an-array" }],
      warnings,
    );
    expect(resolved).toEqual({
      value: [],
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(warnings).toHaveLength(1);
  });
});

describe("clear, invalid rows, and validation", () => {
  it("rejects clearing llm.model and skips a raw null model row with a warning", () => {
    const { db, service } = fixture();
    service.set("global", {}, "llm.model", "global/model", "owner");
    expect(() => service.clear("global", {}, "llm.model", "owner")).toThrow(
      SettingsValidationError,
    );

    insertSetting(db, "app", "p", "web", "llm.model", "null");
    const resolved = service.resolve(appTarget);
    expect(resolved.effective.llm.model).toEqual({
      value: "global/model",
      state: "set",
      source: "global",
      sources: ["global"],
    });
    expect(resolved.scoped["app:llm.model"]).toEqual({ state: "cleared", value: null });
    expect(resolved.warnings.some((warning) => warning.includes("not clearable"))).toBe(true);

    service.inherit("global", {}, "llm.model");
    const defaulted = service.resolve(appTarget);
    expect(defaulted.effective.llm.model).toEqual({
      value: "deepseek/deepseek-flash",
      state: "default",
      source: "default",
      sources: ["default"],
    });
  });

  it("skips invalid stored values and falls back with a warning", () => {
    const { db, service } = fixture();
    service.set("global", {}, "llm.model", "global/model", "owner");
    insertSetting(db, "app", "p", "web", "llm.model", "42");
    insertSetting(db, "global", "", "", "web.search", '{"driver":"bogus"}');

    const resolved = service.resolve(appTarget);
    expect(resolved.effective.llm.model.value).toBe("global/model");
    expect(resolved.effective.llm.model.source).toBe("global");
    expect(resolved.effective.web.search.state).toBe("default");
    expect(resolved.scoped["app:llm.model"]).toEqual({ state: "set", value: 42 });
    expect(resolved.warnings.some((warning) => warning.includes("llm.model"))).toBe(true);
    expect(resolved.warnings.some((warning) => warning.includes("web.search"))).toBe(true);
  });

  it("validates targets, keys, values, and input bounds", () => {
    const { service } = fixture();

    expect(() => service.resolve({ appKey: "web" })).toThrow(SettingsValidationError);
    expect(() => service.set("project", {}, "llm.model", "provider/model", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() => service.set("app", projectTarget, "llm.model", "provider/model", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() =>
      service.set("global", projectTarget, "llm.model", "provider/model", "owner"),
    ).toThrow(SettingsValidationError);
    expect(() => service.set("global", {}, "unknown.key", 1, "owner")).toThrow(
      SettingsValidationError,
    );

    expect(() => service.set("global", {}, "llm.model", 42, "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() => service.set("global", {}, "llm.model", "no-slash", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() =>
      service.set("global", {}, "llm.model", `${"x".repeat(256)}/model`, "owner"),
    ).toThrow(SettingsValidationError);
    expect(() => service.set("global", {}, "web.search", { driver: "bogus" }, "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() =>
      service.set(
        "global",
        {},
        "web.search",
        { driver: "deepseek", options: { provider: "deepseek", count: 21 } },
        "owner",
      ),
    ).toThrow(SettingsValidationError);
  });

  it("validates provider ids and key bounds", () => {
    const { service } = fixture();
    expect(() => service.setProviderKey("global", {}, "x".repeat(129), "key", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() => service.setProviderKey("global", {}, "deepseek", "", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() =>
      service.setProviderKey("global", {}, "deepseek", "x".repeat(4097), "owner"),
    ).toThrow(SettingsValidationError);
    expect(() => service.setProviderKey("global", {}, "__proto__", "key", "owner")).toThrow(
      SettingsValidationError,
    );
  });
});

describe("provider key resolution", () => {
  it("resolves set, clear, and inherit across scopes", () => {
    const { service } = fixture();
    service.setProviderKey("global", {}, "deepseek", "global-secret", "owner");
    expect(service.resolve(appTarget).providerKeys.deepseek).toEqual({
      state: "set",
      source: "global",
    });

    service.setProviderKey("project", projectTarget, "deepseek", "project-secret", "owner");
    const inherited = service.snapshot(appTarget);
    expect(inherited.resolved.providerKeys.deepseek).toEqual({
      state: "set",
      source: "project",
    });
    expect(inherited.providerKeys.get("deepseek")).toEqual({
      state: "set",
      key: "project-secret",
    });
    expect(inherited.mergedAuth.deepseek).toEqual({ type: "api", key: "project-secret" });

    service.clearProviderKey("app", appTarget, "deepseek", "owner");
    const cleared = service.snapshot(appTarget);
    expect(cleared.resolved.providerKeys.deepseek).toEqual({
      state: "cleared",
      source: "app",
    });
    expect(cleared.providerKeys.get("deepseek")).toEqual({ state: "cleared" });
    expect(cleared.mergedAuth.deepseek).toBeUndefined();

    service.inheritProviderKey("app", appTarget, "deepseek");
    expect(service.resolve(appTarget).providerKeys.deepseek).toEqual({
      state: "set",
      source: "project",
    });

    service.clearProviderKey("project", projectTarget, "deepseek", "owner");
    const inheritedClear = service.resolve(appTarget);
    expect(inheritedClear.providerKeys.deepseek).toEqual({
      state: "cleared",
      source: "project",
    });
  });

  it("falls back to host auth only when no settings row exists", () => {
    const { service } = fixture({
      hostAuth: {
        deepseek: { type: "api", key: "host-secret" },
        anthropic: { type: "oauth", access: "token" },
      },
    });
    const resolved = service.resolve({});
    expect(resolved.providerKeys.deepseek).toEqual({
      state: "host",
      source: "host-auth",
      authType: "api",
    });
    expect(resolved.providerKeys.anthropic).toEqual({
      state: "host",
      source: "host-auth",
      authType: "oauth",
    });

    const snapshot = service.snapshot({});
    expect(snapshot.mergedAuth.deepseek).toEqual({ type: "api", key: "host-secret" });
    expect(snapshot.mergedAuth.anthropic).toEqual({ type: "oauth", access: "token" });
  });

  it("uses a wider settings key over host auth and suppresses the host on clear", () => {
    const { service } = fixture({
      hostAuth: { deepseek: { type: "api", key: "host-secret" } },
    });
    service.setProviderKey("global", {}, "deepseek", "settings-secret", "owner");

    const snapshot = service.snapshot(appTarget);
    expect(snapshot.providerKeys.get("deepseek")).toEqual({
      state: "set",
      key: "settings-secret",
    });
    expect(snapshot.mergedAuth.deepseek).toEqual({ type: "api", key: "settings-secret" });

    service.clearProviderKey("global", {}, "deepseek", "owner");
    const cleared = service.snapshot(appTarget);
    expect(cleared.resolved.providerKeys.deepseek).toEqual({
      state: "cleared",
      source: "global",
    });
    expect(cleared.mergedAuth.deepseek).toBeUndefined();
  });

  it("treats an invalid host auth file as empty with a warning", () => {
    const { service } = fixture({ hostAuthRaw: "{not json" });
    const resolved = service.resolve({});
    expect(resolved.warnings.some((warning) => warning.includes("not valid JSON"))).toBe(true);
    expect(service.snapshot({}).mergedAuth).toEqual({});
  });

  it("reports a decrypt error and does not fall back to host auth", () => {
    const { db, service } = fixture({
      hostAuth: { deepseek: { type: "api", key: "host-secret" } },
    });
    service.setProviderKey("global", {}, "deepseek", "sentinel-secret", "owner");
    db.prepare(
      "UPDATE provider_keys SET cipher = 'broken-cipher' WHERE provider = 'deepseek'",
    ).run();

    const resolved = service.resolve({});
    expect(resolved.providerKeys.deepseek).toEqual({
      state: "error",
      message: 'provider key for "deepseek" could not be decrypted',
    });

    const snapshot = service.snapshot({});
    expect(snapshot.providerKeys.has("deepseek")).toBe(false);
    expect(snapshot.mergedAuth.deepseek).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("sentinel-secret");
    expect(snapshot.authHash).not.toContain("sentinel-secret");
  });

  it("represents empty merged auth as an empty object", () => {
    const { service } = fixture();
    expect(service.snapshot({}).mergedAuth).toEqual({});
  });
});

describe("hashing", () => {
  it("stable-stringifies objects with a fixed key order", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
    );
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
  });

  it("is stable across calls and changes with settings or auth", () => {
    const { hostAuthFile, service } = fixture({
      hostAuth: {
        deepseek: { type: "api", key: "host-secret" },
        openai: { type: "api", key: "openai-host-secret" },
      },
    });
    const base = service.effectiveHash(appTarget);
    expect(service.effectiveHash(appTarget)).toBe(base);

    service.set("global", {}, "llm.model", "other/model", "owner");
    const modelChanged = service.effectiveHash(appTarget);
    expect(modelChanged).not.toBe(base);

    service.setProviderKey("global", {}, "deepseek", "settings-secret", "owner");
    const keyChanged = service.effectiveHash(appTarget);
    expect(keyChanged).not.toBe(modelChanged);

    writeFileSync(
      hostAuthFile,
      JSON.stringify({
        deepseek: { type: "api", key: "other-host-secret" },
        openai: { type: "api", key: "other-openai-host-secret" },
      }),
    );
    expect(service.effectiveHash(appTarget)).not.toBe(keyChanged);
  });

  it("never exposes plaintext secrets through hashes", () => {
    const sentinel = "SENTINEL-PLAINTEXT-KEY";
    const { service } = fixture({ hostAuth: { openai: { type: "api", key: sentinel } } });
    service.setProviderKey("global", {}, "deepseek", sentinel, "owner");

    const snapshot = service.snapshot(appTarget);
    expect(snapshot.authHash).not.toContain(sentinel);
    expect(service.effectiveHash(appTarget)).not.toContain(sentinel);
    expect(JSON.stringify(snapshot.resolved)).not.toContain(sentinel);
  });
});

describe("git identity", () => {
  it("defaults to null and resolves global -> project -> app with clear and inherit", () => {
    const { service } = fixture();
    const initial = service.resolve({});
    expect(initial.effective.git.user.name).toEqual({
      value: null,
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(initial.effective.git.user.email.state).toBe("default");
    expect(initial.scoped["global:git.user.name"]).toEqual({ state: "absent", value: null });
    expect(initial.scoped["global:git.user.email"]).toEqual({ state: "absent", value: null });

    service.set("global", {}, "git.user.name", "Global Agent", "owner");
    service.set("global", {}, "git.user.email", "global@example.com", "owner");
    service.set("project", projectTarget, "git.user.name", "Project Agent", "owner");
    service.set("app", appTarget, "git.user.email", "app@example.com", "owner");

    const app = service.resolve(appTarget);
    expect(app.effective.git.user.name).toMatchObject({
      value: "Project Agent",
      state: "set",
      source: "project",
    });
    expect(app.effective.git.user.email).toMatchObject({
      value: "app@example.com",
      state: "set",
      source: "app",
      sources: ["app"],
    });
    expect(app.scoped["app:git.user.email"]).toEqual({
      state: "set",
      value: "app@example.com",
    });

    service.clear("project", projectTarget, "git.user.name", "owner");
    const cleared = service.resolve(appTarget);
    expect(cleared.effective.git.user.name).toEqual({
      value: null,
      state: "cleared",
      source: "project",
      sources: ["project"],
    });
    expect(cleared.scoped["project:git.user.name"]).toEqual({ state: "cleared", value: null });

    service.set("app", appTarget, "git.user.name", "App Agent", "owner");
    expect(service.resolve(appTarget).effective.git.user.name.value).toBe("App Agent");
    service.inherit("app", appTarget, "git.user.name");
    expect(service.resolve(appTarget).effective.git.user.name.state).toBe("cleared");
  });

  it("trims and validates user name and email", () => {
    const { service } = fixture();
    service.set("global", {}, "git.user.name", "  Alice Agent  ", "owner");
    service.set("global", {}, "git.user.email", "  alice@example.com  ", "owner");
    expect(service.resolve({}).effective.git.user.name.value).toBe("Alice Agent");
    expect(service.resolve({}).effective.git.user.email.value).toBe("alice@example.com");

    expect(() => service.set("global", {}, "git.user.name", "   ", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() => service.set("global", {}, "git.user.name", "bad\u0000name", "owner")).toThrow(
      SettingsValidationError,
    );
    expect(() => service.set("global", {}, "git.user.name", "x".repeat(257), "owner")).toThrow(
      SettingsValidationError,
    );
    for (const email of ["no-at-sign", "two@at@signs.com", "has space@example.com", "a@b c"]) {
      expect(() => service.set("global", {}, "git.user.email", email, "owner")).toThrow(
        SettingsValidationError,
      );
    }
    expect(() => service.set("global", {}, "git.user.email", "x".repeat(321), "owner")).toThrow(
      SettingsValidationError,
    );
  });
});

describe("git credentials", () => {
  it("stores HTTPS status without plaintext and resolves it wide to narrow", () => {
    const { service } = fixture();
    service.setGitAuth(
      "global",
      {},
      "https",
      {
        hosts: ["GitHub.com", "github.com", "gitlab.com"],
        username: " x-access-token ",
        token: "s3cret",
      },
      "owner",
    );

    const resolved = service.resolve(appTarget);
    expect(resolved.gitAuth.https).toEqual({
      state: "set",
      kind: "https",
      source: "global",
      hosts: ["github.com", "gitlab.com"],
      username: "x-access-token",
    });
    expect(resolved.gitAuth.ssh).toEqual({ state: "missing", kind: "ssh" });
    expect(resolved.gitAuthScoped.https).toEqual({
      global: "set",
      project: "absent",
      app: "absent",
    });
    expect(resolved.gitAuthScoped.ssh).toEqual({
      global: "absent",
      project: "absent",
      app: "absent",
    });
    expect("gitAuthHash" in resolved).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain("s3cret");

    const snapshot = service.snapshot(appTarget);
    expect(snapshot.gitAuth.https).toEqual({
      hosts: ["github.com", "gitlab.com"],
      username: "x-access-token",
      token: "s3cret",
    });
    expect(snapshot.gitAuth.ssh).toBeUndefined();
    expect(JSON.stringify(snapshot.resolved)).not.toContain("s3cret");
    expect(snapshot.gitAuthHash).not.toContain("s3cret");

    service.clearGitAuth("app", appTarget, "https", "owner");
    expect(service.resolve(appTarget).gitAuth.https).toEqual({
      state: "cleared",
      kind: "https",
      source: "app",
    });
    service.inheritGitAuth("app", appTarget, "https");
    expect(service.resolve(appTarget).gitAuth.https).toMatchObject({
      state: "set",
      source: "global",
    });
  });

  it("keeps SSH and HTTPS independent and derives SSH metadata", () => {
    const { service } = fixture({ runSshKeygen: fakeSshKeygen() });
    service.setGitAuth("global", {}, "ssh", { privateKey: VALID_SSH_KEY }, "owner");
    service.setGitAuth(
      "project",
      projectTarget,
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: "token-value" },
      "owner",
    );

    const resolved = service.resolve(appTarget);
    expect(resolved.gitAuth.ssh).toEqual({
      state: "set",
      kind: "ssh",
      source: "global",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake fake@test",
      fingerprint: "SHA256:fakefingerprint",
      hasKnownHosts: false,
    });
    expect(resolved.gitAuth.https).toMatchObject({ state: "set", source: "project" });
    expect(JSON.stringify(resolved)).not.toContain(VALID_SSH_KEY);

    const snapshot = service.snapshot(appTarget);
    expect(snapshot.gitAuth.ssh?.privateKey).toBe(VALID_SSH_KEY);
    expect(JSON.stringify(snapshot.resolved)).not.toContain("fake-private-key-body");
  });

  it("changes gitAuthHash when either credential is set, changed, or cleared", () => {
    const { service } = fixture({ runSshKeygen: fakeSshKeygen() });
    const base = service.effectiveHash(appTarget);
    const baseHash = service.snapshot(appTarget).gitAuthHash;

    service.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: "one" },
      "owner",
    );
    const httpsHash = service.snapshot(appTarget).gitAuthHash;
    expect(httpsHash).not.toBe(baseHash);
    expect(service.effectiveHash(appTarget)).not.toBe(base);

    service.setGitAuth("global", {}, "ssh", { privateKey: VALID_SSH_KEY }, "owner");
    const bothHash = service.snapshot(appTarget).gitAuthHash;
    expect(bothHash).not.toBe(httpsHash);
    expect(service.effectiveHash(appTarget)).not.toBe(base);

    service.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: "two" },
      "owner",
    );
    expect(service.snapshot(appTarget).gitAuthHash).not.toBe(bothHash);

    service.clearGitAuth("global", {}, "https", "owner");
    expect(service.snapshot(appTarget).gitAuthHash).not.toBe(bothHash);
    expect(service.snapshot(appTarget).gitAuthHash).not.toContain("one");
    expect(service.snapshot(appTarget).gitAuthHash).not.toContain("two");
  });
});
