import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSkillHub, type FakeSkillHub } from "../e2e/support/skill-hub.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleSkillSources } from "../src/http/skill-sources.js";
import { createPrincipal } from "../src/identity/principals.js";
import { SkillSourceService } from "../src/skill-sources/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface FixtureOptions {
  hub?: FakeSkillHub;
}

function fixture(options: FixtureOptions = {}): {
  deps: HttpDeps;
  sources: SkillSourceService;
  token: string;
  agentToken: string;
  id: string;
  stateRoot: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skill-sources-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const stateRoot = path.join(dir, "state");
  const sources = new SkillSourceService({
    db,
    secretKey: randomBytes(32),
    stateRoot,
    ...(options.hub === undefined ? {} : { fetchImpl: options.hub.fetchImpl }),
  });
  const source = sources.create(
    {
      slug: "hub",
      name: "Hub",
      endpoint: options.hub === undefined ? "http://127.0.0.1:9" : "https://hub.e2e.test",
      config: { buckets: ["default"], allowInsecureHttp: options.hub === undefined },
      token: "initial-secret",
    },
    "test",
  );
  const token = createPrincipal(db, { kind: "human", name: "alice" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "bot" }).token;
  return {
    token,
    agentToken,
    id: source.id,
    sources,
    stateRoot,
    deps: {
      db,
      workspaceRoot: dir,
      git: new GitService({ workspaceRoot: dir }),
      skillSources: sources,
      getProjects: () => [
        {
          id: "p1",
          name: "Alpha",
          rootPath: dir,
          workspaceRoot: dir,
          service: new CoordinatorService(db, "p1"),
        },
      ],
    },
  };
}

function request(token: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    path: "/api/skill-sources",
    headers: { authorization: `Bearer ${token}` },
    query: {},
    ...overrides,
  };
}

function body(value: unknown): string {
  return JSON.stringify(value);
}

describe("skill sources HTTP API", () => {
  it("lists sources for a human and rejects an agent principal", async () => {
    const f = fixture();
    const listed = await handleSkillSources(f.deps, request(f.token));
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body ?? "{}").sources).toHaveLength(1);
    const denied = await handleSkillSources(f.deps, request(f.agentToken));
    expect(denied.status).toBe(403);
  });

  it("creates a source and never returns the token", async () => {
    const f = fixture();
    const response = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        body: body({
          action: "create",
          slug: "other",
          name: "Other",
          endpoint: "http://127.0.0.1:9",
          config: { buckets: ["default"], allowInsecureHttp: true },
          token: "super-secret",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.body).not.toContain("super-secret");
    expect(JSON.parse(response.body ?? "{}").source.tokenSet).toBe(true);
  });

  it("sets and clears a source secret write-only", async () => {
    const f = fixture();
    const set = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        body: body({ action: "secret", id: f.id, token: "new-secret" }),
      }),
    );
    expect(set.status).toBe(200);
    expect(set.body).not.toContain("new-secret");
    expect(JSON.parse(set.body ?? "{}").source.tokenSet).toBe(true);
    const cleared = await handleSkillSources(
      f.deps,
      request(f.token, { method: "POST", body: body({ action: "clear-secret", id: f.id }) }),
    );
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body ?? "{}").source.tokenSet).toBe(false);
  });

  it("rejects cross-site mutations and unknown actions", async () => {
    const f = fixture();
    const crossSite = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}` },
        origin: "http://evil.example",
        host: "127.0.0.1",
        body: body({ action: "delete", id: f.id }),
      }),
    );
    expect(crossSite.status).toBe(403);
    const unknown = await handleSkillSources(
      f.deps,
      request(f.token, { method: "POST", body: body({ action: "wat" }) }),
    );
    expect(unknown.status).toBe(400);
  });

  it("returns an empty skill list before the first sync and maps a hub failure to 502", async () => {
    const f = fixture();
    const skills = await handleSkillSources(
      f.deps,
      request(f.token, { path: `/api/skill-sources/${encodeURIComponent(f.id)}/skills` }),
    );
    expect(skills.status).toBe(200);
    expect(JSON.parse(skills.body ?? "{}").skills).toEqual([]);
    const sync = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        path: `/api/skill-sources/${encodeURIComponent(f.id)}/sync`,
        body: body({ force: true }),
      }),
    );
    expect(sync.status).toBe(502);
  });

  it("returns 409 for a duplicate slug", async () => {
    const f = fixture();
    const response = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        body: body({
          action: "create",
          slug: "hub",
          name: "Duplicate",
          endpoint: "http://127.0.0.1:9",
          config: { buckets: ["default"], allowInsecureHttp: true },
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({ code: "slug_taken" });
  });

  it("requires a non-empty token to replace a secret", async () => {
    const f = fixture();
    for (const payload of [
      { action: "secret", id: f.id },
      { action: "secret", id: f.id, token: "" },
      { action: "secret", id: f.id, token: "   " },
    ]) {
      const response = await handleSkillSources(
        f.deps,
        request(f.token, { method: "POST", body: body(payload) }),
      );
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(response.body ?? "{}"), JSON.stringify(payload)).toMatchObject({
        code: "VALIDATION",
        field: "token",
      });
    }
    const pathResponse = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        path: `/api/skill-sources/${encodeURIComponent(f.id)}/secret`,
        body: body({}),
      }),
    );
    expect(pathResponse.status).toBe(400);
    expect(JSON.parse(pathResponse.body ?? "{}")).toMatchObject({
      code: "VALIDATION",
      field: "token",
    });
    const replaced = await handleSkillSources(
      f.deps,
      request(f.token, {
        method: "POST",
        body: body({ action: "secret", id: f.id, token: "replacement-secret" }),
      }),
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body).not.toContain("replacement-secret");
    const cleared = await handleSkillSources(
      f.deps,
      request(f.token, { method: "POST", body: body({ action: "clear-secret", id: f.id }) }),
    );
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body ?? "{}").source.tokenSet).toBe(false);
  });

  it("soft-disables and hard-deletes a source", async () => {
    const f = fixture();
    const disabled = await handleSkillSources(
      f.deps,
      request(f.token, { method: "POST", body: body({ action: "disable", id: f.id }) }),
    );
    expect(disabled.status).toBe(200);
    expect(JSON.parse(disabled.body ?? "{}").source).toMatchObject({
      enabled: false,
      mode: "track",
    });
    expect(f.sources.list()).toHaveLength(1);
    const deleted = await handleSkillSources(
      f.deps,
      request(f.token, { method: "POST", body: body({ action: "delete", id: f.id, hard: true }) }),
    );
    expect(deleted.status).toBe(200);
    expect(f.sources.list()).toEqual([]);
  });

  describe("file preview", () => {
    function previewRequest(
      f: ReturnType<typeof fixture>,
      query: Record<string, string>,
    ): HttpRequest {
      return request(f.token, {
        path: `/api/skill-sources/${encodeURIComponent(f.id)}/files`,
        query,
      });
    }

    async function syncedFixture(files: Array<{ path: string; content: string | Uint8Array }>) {
      const hub = createFakeSkillHub({
        skills: [{ name: "alpha", description: "Alpha skill", files }],
      });
      const f = fixture({ hub });
      await f.sources.sync(f.id);
      const snapshotId = f.sources.get(f.id)?.activeSnapshotId ?? "";
      return { f, snapshotId };
    }

    it("returns bounded text and binary metadata without a caller-supplied hash", async () => {
      const { f, snapshotId } = await syncedFixture([
        { path: "SKILL.md", content: "---\nname: alpha\ndescription: Alpha skill\n---\n\nBody\n" },
        { path: "assets/blob.bin", content: Uint8Array.from([0, 1, 2, 3]) },
      ]);
      const text = await handleSkillSources(
        f.deps,
        previewRequest(f, { snapshotId, bucket: "default", name: "alpha", path: "SKILL.md" }),
      );
      expect(text.status).toBe(200);
      expect(text.headers?.["cache-control"]).toBe("no-store");
      expect(JSON.parse(text.body ?? "{}")).toMatchObject({
        path: "SKILL.md",
        encoding: "text",
        text: expect.stringContaining("Body"),
      });

      const binary = await handleSkillSources(
        f.deps,
        previewRequest(f, {
          snapshotId,
          bucket: "default",
          name: "alpha",
          path: "assets/blob.bin",
        }),
      );
      expect(binary.status).toBe(200);
      const payload = JSON.parse(binary.body ?? "{}") as Record<string, unknown>;
      expect(payload).toMatchObject({ encoding: "binary", size: 4 });
      expect(payload).not.toHaveProperty("text");
    });

    it("caps text at 64 KiB", async () => {
      const { f, snapshotId } = await syncedFixture([
        { path: "SKILL.md", content: "x".repeat(70 * 1024) },
      ]);
      const response = await handleSkillSources(
        f.deps,
        previewRequest(f, { snapshotId, bucket: "default", name: "alpha", path: "SKILL.md" }),
      );
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body ?? "{}") as {
        encoding: string;
        text: string;
        truncated: boolean;
      };
      expect(payload.encoding).toBe("text");
      expect(payload.text.length).toBe(64 * 1024);
      expect(payload.truncated).toBe(true);
    });

    it("rejects invalid queries and non-matching snapshots or paths", async () => {
      const { f, snapshotId } = await syncedFixture([
        { path: "SKILL.md", content: "---\nname: alpha\ndescription: Alpha skill\n---\n" },
      ]);
      const invalid = await handleSkillSources(
        f.deps,
        previewRequest(f, { snapshotId, name: "alpha", path: "SKILL.md" }),
      );
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body ?? "{}")).toMatchObject({
        code: "VALIDATION",
        field: "bucket",
      });

      const mismatch = await handleSkillSources(
        f.deps,
        previewRequest(f, {
          snapshotId: "other",
          bucket: "default",
          name: "alpha",
          path: "SKILL.md",
        }),
      );
      expect(mismatch.status).toBe(404);
      expect(JSON.parse(mismatch.body ?? "{}")).toMatchObject({ code: "snapshot_mismatch" });

      for (const pathValue of ["../SKILL.md", "assets/missing.txt"]) {
        const missing = await handleSkillSources(
          f.deps,
          previewRequest(f, {
            snapshotId,
            bucket: "default",
            name: "alpha",
            path: pathValue,
          }),
        );
        expect(missing.status, pathValue).toBe(404);
        expect(JSON.parse(missing.body ?? "{}")).toMatchObject({ code: "file_not_found" });
      }

      const missingSkill = await handleSkillSources(
        f.deps,
        previewRequest(f, { snapshotId, bucket: "default", name: "missing", path: "SKILL.md" }),
      );
      expect(missingSkill.status).toBe(404);
      expect(JSON.parse(missingSkill.body ?? "{}")).toMatchObject({ code: "skill_not_found" });
    });

    it("returns 404 for a missing blob", async () => {
      const { f, snapshotId } = await syncedFixture([
        { path: "SKILL.md", content: "---\nname: alpha\ndescription: Alpha skill\n---\n" },
      ]);
      const sha = f.sources.skills(f.id)[0]?.files.find((file) => file.path === "SKILL.md")?.sha256;
      expect(sha).toEqual(expect.any(String));
      rmSync(
        path.join(
          f.stateRoot,
          "skill-sources",
          "blobs",
          "sha256",
          (sha ?? "").slice(0, 2),
          sha ?? "",
        ),
      );
      const response = await handleSkillSources(
        f.deps,
        previewRequest(f, { snapshotId, bucket: "default", name: "alpha", path: "SKILL.md" }),
      );
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body ?? "{}")).toMatchObject({ code: "blob_missing" });
    });

    it("rejects an agent principal", async () => {
      const { f, snapshotId } = await syncedFixture([
        { path: "SKILL.md", content: "---\nname: alpha\ndescription: Alpha skill\n---\n" },
      ]);
      const response = await handleSkillSources(f.deps, {
        ...previewRequest(f, {
          snapshotId,
          bucket: "default",
          name: "alpha",
          path: "SKILL.md",
        }),
        headers: { authorization: `Bearer ${f.agentToken}` },
      });
      expect(response.status).toBe(403);
    });
  });
});
