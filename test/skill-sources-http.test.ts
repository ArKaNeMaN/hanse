import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function fixture(): { deps: HttpDeps; token: string; agentToken: string; id: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skill-sources-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const sources = new SkillSourceService({
    db,
    secretKey: randomBytes(32),
    stateRoot: path.join(dir, "state"),
  });
  const source = sources.create(
    {
      slug: "hub",
      name: "Hub",
      endpoint: "http://127.0.0.1:9",
      config: { buckets: ["default"], allowInsecureHttp: true },
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
});
