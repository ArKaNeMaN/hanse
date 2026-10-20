import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmoProfileStore, PINNED_AGENTS, PINNED_CATEGORIES } from "../src/opencode/omo-profile.js";
import { sha256Hex } from "../src/settings/hash.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseConfig() {
  return {
    $schema: "https://example.invalid/omo.schema.json",
    disabled_hooks: ["auto-update-checker"],
    "[opencode]": {
      agents: {
        sisyphus: { model: "base/model", reasoning: "high" },
        extra: { model: "base/model" },
      },
      categories: {
        quick: { model: "base/model", temperature: 0.2 },
      },
    },
  };
}

function fixture(config: unknown = baseConfig()): {
  dir: string;
  file: string;
  store: OmoProfileStore;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-omo-"));
  dirs.push(dir);
  const file = path.join(dir, ".omo", "omo.jsonc");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return { dir, file, store: new OmoProfileStore({ path: file }) };
}

type Json = Record<string, unknown>;

function profileFor(json: Json, name: string): Json {
  const profiles = json.profiles as Json;
  return profiles[name] as Json;
}

describe("OmoProfileStore", () => {
  it("generates a profile per app and preserves the base config", async () => {
    const { file, store } = fixture();
    const first = await store.ensure({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    });
    const second = await store.ensure({
      appId: "p:api",
      model: "deepseek/deepseek-flash",
      disableWebsearch: false,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect(first.name).toBe(`hanse-app-${sha256Hex("p:web").slice(0, 16)}`);
    expect(second.name).toBe(`hanse-app-${sha256Hex("p:api").slice(0, 16)}`);
    expect(first.name).not.toBe(second.name);

    const json = JSON.parse(readFileSync(file, "utf8")) as Json;
    expect(json.$schema).toBe("https://example.invalid/omo.schema.json");
    expect(json.disabled_hooks).toEqual(["auto-update-checker"]);
    const baseOpencode = json["[opencode]"] as Json;
    expect((baseOpencode.agents as Json).sisyphus).toEqual({
      model: "base/model",
      reasoning: "high",
    });

    const opencode = (profileFor(json, first.name ?? "") as Json)["[opencode]"] as Json;
    expect(opencode.disabled_mcps).toEqual(["websearch"]);
    expect((opencode.agents as Json).sisyphus).toEqual({
      model: "deepseek/deepseek-pro",
      reasoning: "high",
    });
    expect((opencode.agents as Json).extra).toEqual({ model: "deepseek/deepseek-pro" });
    expect((opencode.categories as Json).quick).toEqual({
      model: "deepseek/deepseek-pro",
      temperature: 0.2,
    });

    const secondOpencode = (profileFor(json, second.name ?? "") as Json)["[opencode]"] as Json;
    expect(secondOpencode.disabled_mcps).toEqual([]);
  });

  it("reads the base from the store path and writes the profile to a separate target", async () => {
    const { dir, file, store } = fixture();
    const target = path.join(dir, "agents", "p", "web", "home", ".omo", "omo.jsonc");
    const input = {
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    };

    const first = await store.ensure(input, target);
    expect(first.applied).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(baseConfig());

    const written = JSON.parse(readFileSync(target, "utf8")) as Json;
    expect(written.$schema).toBe("https://example.invalid/omo.schema.json");
    expect(profileFor(written, first.name ?? "")).toBeDefined();
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const second = await store.ensure(input, path.join(dir, "other", "omo.jsonc"));
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("adds every pinned agent and category with the selected model", async () => {
    const { file, store } = fixture();
    const result = await store.ensure({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: false,
    });
    const json = JSON.parse(readFileSync(file, "utf8")) as Json;
    const opencode = (profileFor(json, result.name ?? "") as Json)["[opencode]"] as Json;
    const agents = opencode.agents as Json;
    const categories = opencode.categories as Json;
    for (const name of PINNED_AGENTS) {
      expect((agents[name] as Json).model).toBe("deepseek/deepseek-pro");
    }
    for (const name of PINNED_CATEGORIES) {
      expect((categories[name] as Json).model).toBe("deepseek/deepseek-pro");
    }
  });

  it("unions the base disabled_mcps with websearch", async () => {
    const config = baseConfig();
    (config["[opencode]"] as Record<string, unknown>).disabled_mcps = ["other"];
    const { file, store } = fixture(config);
    const result = await store.ensure({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    });
    const json = JSON.parse(readFileSync(file, "utf8")) as Json;
    const opencode = (profileFor(json, result.name ?? "") as Json)["[opencode]"] as Json;
    expect(opencode.disabled_mcps).toEqual(["other", "websearch"]);
  });

  it("warns when the base already disables websearch and built-in cannot re-enable it", async () => {
    const config = baseConfig();
    (config["[opencode]"] as Record<string, unknown>).disabled_mcps = ["websearch"];
    const { file, store } = fixture(config);
    const result = await store.ensure({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: false,
    });
    expect(result.applied).toBe(true);
    expect(result.warning).toContain("cannot be re-enabled");
    const json = JSON.parse(readFileSync(file, "utf8")) as Json;
    const opencode = (profileFor(json, result.name ?? "") as Json)["[opencode]"] as Json;
    expect(opencode.disabled_mcps).toEqual(["websearch"]);
  });

  it("falls back without writing on a JSON parse failure", async () => {
    const raw = "{ not valid json";
    const { file, store } = fixture(raw);
    const result = await store.ensure({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    });
    expect(result.applied).toBe(false);
    expect(result.name).toBe(`hanse-app-${sha256Hex("p:web").slice(0, 16)}`);
    expect(result.warning).toContain("omo_profile_unavailable");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(file, "utf8")).toBe(raw);

    const preview = store.preview({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    });
    expect(preview.contentHash).toBe(result.contentHash);
    expect(preview.applied).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("falls back when the config cannot be written", async () => {
    const { file, store } = fixture();
    const configDir = path.dirname(file);
    const originalMode = 0o700;
    chmodSync(configDir, 0o500);
    try {
      const result = await store.ensure({
        appId: "p:web",
        model: "deepseek/deepseek-pro",
        disableWebsearch: false,
      });
      expect(result.applied).toBe(false);
      expect(result.warning).toContain("omo_profile_write_failed");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(baseConfig());
    } finally {
      chmodSync(configDir, originalMode);
    }
  });

  it("serializes concurrent ensure calls and preserves both profiles", async () => {
    const { file, store } = fixture();
    const [first, second] = await Promise.all([
      store.ensure({ appId: "p:web", model: "deepseek/one", disableWebsearch: true }),
      store.ensure({ appId: "p:api", model: "deepseek/two", disableWebsearch: false }),
    ]);
    const json = JSON.parse(readFileSync(file, "utf8")) as Json;
    const profiles = json.profiles as Json;
    expect(Object.keys(profiles)).toHaveLength(2);
    expect(profiles[first.name ?? ""]).toBeDefined();
    expect(profiles[second.name ?? ""]).toBeDefined();
    const firstOpencode = (profileFor(json, first.name ?? "") as Json)["[opencode]"] as Json;
    const secondOpencode = (profileFor(json, second.name ?? "") as Json)["[opencode]"] as Json;
    expect((firstOpencode.disabled_mcps as string[]).includes("websearch")).toBe(true);
    expect(secondOpencode.disabled_mcps).toEqual([]);
  });

  it("previews without writing", () => {
    const { file, store } = fixture();
    const before = readFileSync(file, "utf8");
    const result = store.preview({
      appId: "p:web",
      model: "deepseek/deepseek-pro",
      disableWebsearch: true,
    });
    expect(result.applied).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty("profiles");
  });
});
