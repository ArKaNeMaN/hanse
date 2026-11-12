import { createHash } from "node:crypto";

export interface FakeSkillFile {
  path: string;
  content: string | Uint8Array;
}

export interface FakeSkill {
  name: string;
  description?: string;
  version?: string | null;
  files: FakeSkillFile[];
}

export interface FakeSkillHubState {
  revision: string;
  etag: string;
  bucket: string;
  generatedAt: string;
  skills: FakeSkill[];
}

export interface FakeSkillHubOptions {
  revision?: string;
  etag?: string;
  bucket?: string;
  generatedAt?: string;
  skills?: FakeSkill[];
  token?: string | null;
}

export interface FakeSkillHub {
  readonly state: FakeSkillHubState;
  readonly token: string | null;
  readonly fetchImpl: typeof fetch;
  setSkills(skills: FakeSkill[], revision?: string, etag?: string): void;
  setRevision(revision: string, etag?: string): void;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(file: FakeSkillFile): Buffer {
  return typeof file.content === "string"
    ? Buffer.from(file.content, "utf8")
    : Buffer.from(file.content);
}

function skillDocument(skill: FakeSkill): FakeSkillFile {
  const description = skill.description ?? `${skill.name} description`;
  return {
    path: "SKILL.md",
    content: `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n# ${skill.name}\n`,
  };
}

function filesFor(skill: FakeSkill): FakeSkillFile[] {
  const files = [...skill.files];
  if (!files.some((file) => file.path === "SKILL.md")) {
    files.unshift(skillDocument(skill));
  }
  return files;
}

function manifestFor(state: FakeSkillHubState): unknown {
  return {
    schemaVersion: 1,
    generatedAt: state.generatedAt,
    buckets: [
      {
        slug: state.bucket,
        name: state.bucket,
        revision: state.revision,
        skills: state.skills.map((skill) => ({
          name: skill.name,
          description: skill.description ?? `${skill.name} description`,
          version: skill.version ?? null,
          contentHash: null,
          files: filesFor(skill).map((file) => {
            const bytes = bytesOf(file);
            return { path: file.path, sha256: sha256(bytes), size: bytes.byteLength };
          }),
        })),
      },
    ],
  };
}

export function createFakeSkillHub(options: FakeSkillHubOptions = {}): FakeSkillHub {
  const state: FakeSkillHubState = {
    revision: options.revision ?? "e2e-rev-1",
    etag: options.etag ?? '"e2e-hub-rev-1"',
    bucket: options.bucket ?? "default",
    generatedAt: options.generatedAt ?? "2026-11-11T09:00:00.000Z",
    skills: options.skills ?? [],
  };
  const token = options.token ?? null;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const authorization =
      init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : new Headers(init?.headers).get("authorization");
    if (token !== null && authorization !== `Bearer ${token}`) {
      return new Response(JSON.stringify({ code: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      });
    }
    if (url.pathname === "/api/v1/manifest") {
      const ifNoneMatch =
        init?.headers instanceof Headers
          ? init.headers.get("if-none-match")
          : new Headers(init?.headers).get("if-none-match");
      if (ifNoneMatch === state.etag) {
        return new Response(null, { status: 304 });
      }
      const body = JSON.stringify(manifestFor(state));
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", etag: state.etag },
      });
    }
    const match = /^\/api\/v1\/skills\/([^/]+)\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (match === null) {
      return new Response("not found", { status: 404 });
    }
    const bucket = decodeURIComponent(match[1] ?? "");
    const name = decodeURIComponent(match[2] ?? "");
    const filePath = (match[3] ?? "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const skill = state.skills.find((entry) => entry.name === name);
    const file =
      skill === undefined ? undefined : filesFor(skill).find((entry) => entry.path === filePath);
    if (bucket !== state.bucket || skill === undefined || file === undefined) {
      return new Response("not found", { status: 404 });
    }
    const bytes = bytesOf(file);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        etag: `"sha256:${sha256(bytes)}"`,
      },
    });
  }) as typeof fetch;

  return {
    state,
    token,
    fetchImpl,
    setSkills(skills, revision, etag) {
      state.skills = skills;
      if (revision !== undefined) state.revision = revision;
      if (etag !== undefined) state.etag = etag;
    },
    setRevision(revision, etag) {
      state.revision = revision;
      if (etag !== undefined) state.etag = etag;
    },
  };
}
