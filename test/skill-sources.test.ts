import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCas } from "../src/skill-sources/cas.js";
import { CompositeSkillSource } from "../src/skill-sources/composite.js";
import { SkillSourceService } from "../src/skill-sources/service.js";
import { SkillService } from "../src/skills/index.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const TOKEN = "test-token";

interface HubSkill {
  name: string;
  description: string;
  files: Array<{ path: string; bytes: Buffer }>;
}

interface HubState {
  revision: string;
  etag: string;
  skills: HubSkill[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function skillDocument(name: string, body = `${name} body`): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`);
}

function skill(name: string, files?: Array<{ path: string; bytes: Buffer }>): HubSkill {
  return {
    name,
    description: `${name} description`,
    files: files ?? [{ path: "SKILL.md", bytes: skillDocument(name) }],
  };
}

function manifest(state: HubState) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buckets: [
      {
        slug: "default",
        name: "Default",
        revision: state.revision,
        skills: state.skills.map((item) => ({
          name: item.name,
          description: item.description,
          version: null,
          contentHash: null,
          files: item.files.map((file) => ({
            path: file.path,
            sha256: sha256(file.bytes),
            size: file.bytes.byteLength,
          })),
        })),
      },
    ],
  };
}

async function startHub(state: () => HubState): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "unauthorized" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/manifest") {
      const current = state();
      if (request.headers["if-none-match"] === current.etag) {
        response.writeHead(304);
        response.end();
        return;
      }
      const body = JSON.stringify(manifest(current));
      response.writeHead(200, {
        "content-type": "application/json",
        etag: current.etag,
      });
      response.end(body);
      return;
    }
    const match = /^\/api\/v1\/skills\/([^/]+)\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (match === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    const bucket = decodeURIComponent(match[1] ?? "");
    const name = decodeURIComponent(match[2] ?? "");
    const filePath = match[3] ?? "";
    const current = state();
    const item = current.skills.find((candidate) => candidate.name === name);
    const file = item?.files.find((candidate) => candidate.path === filePath);
    if (item === undefined || file === undefined || bucket !== "default") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      etag: `"sha256:${sha256(file.bytes)}"`,
    });
    response.end(file.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock hub did not bind a port");
  }
  return { url: `http://127.0.0.1:${address.port}`, server };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(url: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skill-sources-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const service = new SkillSourceService({
    db,
    secretKey: randomBytes(32),
    stateRoot: path.join(dir, "state"),
  });
  const source = service.create(
    {
      slug: "default",
      name: "Default hub",
      endpoint: url,
      config: { buckets: ["default"], allowInsecureHttp: true },
      token: TOKEN,
    },
    "test",
  );
  const managed = new SkillService({ db });
  return {
    db,
    service,
    source,
    managed,
    composite: new CompositeSkillSource(managed, service),
    dir,
  };
}

describe("skill sources", () => {
  it("publishes a snapshot and exposes active records", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [
        skill("alpha", [
          { path: "SKILL.md", bytes: skillDocument("alpha") },
          { path: "references/guide.md", bytes: Buffer.from("guide") },
        ]),
      ],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      const result = await f.service.sync(f.source.id);
      expect(result.changed).toBe(true);
      expect(result.skillCount).toBe(1);
      const records = f.service.activeRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ name: "alpha", bucket: "default", revision: "rev-1" });
      expect(records[0]?.files.map((file) => file.path).sort()).toEqual([
        "SKILL.md",
        "references/guide.md",
      ]);
      const record = records[0];
      if (record === undefined) throw new Error("missing record");
      const files = f.service.readSkillFiles(record);
      expect(Buffer.from(files[0]?.content ?? []).toString("utf8")).toContain("name: alpha");
    } finally {
      hub.server.close();
    }
  });

  it("treats a 304 as unchanged and reuses the active snapshot", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [skill("alpha")],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      const first = await f.service.sync(f.source.id);
      const second = await f.service.sync(f.source.id);
      expect(second.changed).toBe(false);
      expect(second.snapshotId).toBe(first.snapshotId);
    } finally {
      hub.server.close();
    }
  });

  it("quarantines an invalid external skill name without failing the source", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [skill("Bad_Name")],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      const result = await f.service.sync(f.source.id);
      expect(result.state).toBe("degraded");
      expect(f.service.activeRecords()).toEqual([]);
      expect(f.service.skills(f.source.id)).toEqual([
        expect.objectContaining({ name: "Bad_Name", state: "quarantined" }),
      ]);
    } finally {
      hub.server.close();
    }
  });

  it("guards a mass deletion and accepts it with force", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [skill("alpha")],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      await f.service.sync(f.source.id);
      const next: HubState = { revision: "rev-2", etag: '"m1-two"', skills: [] };
      Object.assign(state, next);
      await expect(f.service.sync(f.source.id)).rejects.toMatchObject({ code: "deletion_guard" });
      const forced = await f.service.sync(f.source.id, { force: true });
      expect(forced.changed).toBe(true);
    } finally {
      hub.server.close();
    }
  });

  it("keeps the active snapshot while pinned", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [skill("alpha")],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      const first = await f.service.sync(f.source.id);
      f.service.pin(f.source.id, "test");
      const next: HubState = {
        revision: "rev-2",
        etag: '"m1-two"',
        skills: [skill("alpha", [{ path: "SKILL.md", bytes: skillDocument("alpha", "changed") }])],
      };
      Object.assign(state, next);
      const second = await f.service.sync(f.source.id);
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(f.service.get(f.source.id)?.activeSnapshotId).toBe(first.snapshotId);
    } finally {
      hub.server.close();
    }
  });

  it("merges local and external skills with local-wins precedence", async () => {
    const state: HubState = {
      revision: "rev-1",
      etag: '"m1-one"',
      skills: [skill("alpha"), skill("beta")],
    };
    const hub = await startHub(() => state);
    const f = fixture(hub.url);
    try {
      f.managed.create(
        "global",
        {},
        { name: "alpha", description: "local alpha", content: "local body" },
        "test",
      );
      await f.service.sync(f.source.id);
      const target = {};
      const capture = f.composite.capture(target);
      const byName = new Map(capture.resolved.effective.map((entry) => [entry.name, entry]));
      expect(byName.get("alpha")).toMatchObject({
        mode: "managed",
        description: "local alpha",
        shadowedExternal: true,
      });
      expect(byName.get("beta")).toMatchObject({
        mode: "external",
        source: null,
        externalKey: `${f.source.id}:default:beta`,
      });

      const appRoot = path.join(f.dir, "app");
      const xdg = path.join(appRoot, "config");
      const home = path.join(appRoot, "home");
      const cache = path.join(appRoot, "cache");
      const appDir = path.join(appRoot, "repo");
      for (const directory of [xdg, home, cache, appDir]) {
        mkdirSync(directory, { recursive: true });
      }
      const options = { appRoot, home, xdgCacheHome: cache, appDir };
      const applied = f.composite.apply(target, xdg, options, capture);
      expect(applied.written).toContain("skills/alpha/SKILL.md");
      expect(applied.written).toContain("skills/beta/SKILL.md");
      expect(
        readFileSync(path.join(xdg, "opencode", "skills", "alpha", "SKILL.md"), "utf8"),
      ).toContain('description: "local alpha"');
      expect(readFileSync(path.join(xdg, "opencode", "skills", "beta", "SKILL.md"), "utf8")).toBe(
        skillDocument("beta").toString("utf8"),
      );

      const before = f.composite.hash(target);
      Object.assign(state, {
        revision: "rev-2",
        etag: '"m1-two"',
        skills: [
          skill("alpha"),
          skill("beta", [{ path: "SKILL.md", bytes: skillDocument("beta", "changed") }]),
        ],
      });
      await f.service.sync(f.source.id, { force: true });
      expect(f.composite.hash(target)).not.toBe(before);
    } finally {
      hub.server.close();
    }
  });

  it("repairs a corrupt content-addressed blob", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-skill-cas-"));
    dirs.push(dir);
    const cas = new SkillCas(dir);
    const bytes = Buffer.from("payload");
    const stored = cas.put(bytes);
    const blob = cas.blobPath(stored.sha256);
    rmSync(blob);
    expect(() => cas.read(stored.sha256, stored.size)).toThrow();
    cas.put(bytes);
    expect(Buffer.from(cas.read(stored.sha256, stored.size)).toString("utf8")).toBe("payload");
  });
});
