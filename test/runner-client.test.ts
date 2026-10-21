import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { GitError } from "../src/git/errors.js";
import { RunnerGitClient } from "../src/git/runner-client.js";
import {
  DockerClient,
  DockerError,
  type DockerResponse,
  type DockerTransport,
  demuxDockerStream,
} from "../src/runner/docker.js";

interface Recorded {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

function json(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

function fixture(
  handler: (method: "GET" | "POST" | "DELETE", path: string, body: unknown) => DockerResponse,
): { client: DockerClient; records: Recorded[] } {
  const records: Recorded[] = [];
  const transport: DockerTransport = {
    async request(method, path, body) {
      records.push({ method, path, body });
      return handler(method, path, body);
    },
  };
  return { client: new DockerClient(transport), records };
}

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const createOptions = {
  name: "hanse-app-project-app",
  image: "agent-default:test",
  hostname: "hanse-app-project-app",
  user: "1000:1000",
  entrypoint: ["/usr/local/bin/hanse-agent-entrypoint"],
  cmd: [],
  workingDir: "/data/workspace/project/app",
  env: { HOME: "/data/agents/project/app/home" },
  labels: { "hanse.managed": "true" },
  binds: [
    "/host/workspace/project/app:/data/workspace/project/app:rw",
    "/host/agents/project/app:/data/agents/project/app:rw",
  ],
  tmpfs: { "/tmp": "rw,exec,nosuid,size=1g" },
  memoryBytes: 2048,
  nanoCpus: 2,
  pidsLimit: 512,
  networkName: "hanse-app-project-app",
  networkAliases: ["hanse-app-project-app"],
};

describe("DockerClient", () => {
  it("creates a container with the fixed runtime envelope", async () => {
    const f = fixture((method, path) =>
      method === "POST" && path.startsWith("/containers/create?name=")
        ? json(201, { Id: "container-id" })
        : json(500, { message: "unexpected" }),
    );

    await expect(f.client.createContainer(createOptions)).resolves.toBe("container-id");
    expect(f.records[0]?.path).toBe("/containers/create?name=hanse-app-project-app");
    const body = f.records[0]?.body as {
      Image: string;
      User: string;
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[];
        SecurityOpt: string[];
        Privileged: boolean;
        Binds: string[];
        Memory: number;
        NanoCpus: number;
        PidsLimit: number;
      };
      NetworkingConfig: { EndpointsConfig: Record<string, { Aliases: string[] }> };
    };
    expect(body.Image).toBe("agent-default:test");
    expect(body.User).toBe("1000:1000");
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.Binds).toHaveLength(2);
    expect(body.HostConfig.Memory).toBe(2048);
    expect(body.HostConfig.NanoCpus).toBe(2);
    expect(body.HostConfig.PidsLimit).toBe(512);
    expect(body.NetworkingConfig.EndpointsConfig["hanse-app-project-app"]?.Aliases).toEqual([
      "hanse-app-project-app",
    ]);
  });

  it("creates one-shot containers without networking and waits for the exit code", async () => {
    const f = fixture((method, path) => {
      if (method === "POST" && path.startsWith("/containers/create")) {
        return json(201, { Id: "one-shot" });
      }
      if (method === "POST" && path.includes("/wait")) {
        return json(200, { StatusCode: 0 });
      }
      return json(500, { message: "unexpected" });
    });

    await f.client.createContainer({
      ...createOptions,
      name: "hanse-git-app",
      networkName: "none",
      networkMode: "none",
      networkAliases: [],
      restartPolicy: "no",
    });
    const body = f.records[0]?.body as {
      HostConfig: { NetworkMode: string; RestartPolicy: { Name: string } };
      NetworkingConfig?: unknown;
    };
    expect(body.HostConfig.NetworkMode).toBe("none");
    expect(body.HostConfig.RestartPolicy.Name).toBe("no");
    expect(body.NetworkingConfig).toBeUndefined();

    await expect(f.client.waitContainer("one-shot", 1234)).resolves.toEqual({ StatusCode: 0 });
    expect(f.records[1]?.path).toBe("/containers/one-shot/wait?condition=not-running");
  });

  it("demultiplexes Docker log frames", async () => {
    const payload = Buffer.concat([frame(1, "out"), frame(2, "err")]);
    const f = fixture(() => ({ status: 200, body: payload }));

    await expect(f.client.logs("container-id")).resolves.toEqual({
      logs: "outerr",
      truncated: false,
    });
    expect(demuxDockerStream(Buffer.from("plain logs"))).toBe("plain logs");
  });

  it("filters managed containers and handles idempotent network operations", async () => {
    const f = fixture((method, path) => {
      if (method === "GET" && path.startsWith("/containers/json?")) {
        return json(200, [
          { Id: "one", Names: ["/one"], Image: "img", State: "running", Status: "Up" },
        ]);
      }
      if (method === "POST" && path === "/networks/create") {
        return json(409, { message: "already exists" });
      }
      if (method === "POST" && path.endsWith("/connect")) {
        return json(403, { message: "endpoint with name hanse already exists" });
      }
      return json(204, {});
    });

    await expect(f.client.listContainers("hanse.managed=true")).resolves.toHaveLength(1);
    expect(decodeURIComponent(f.records[0]?.path ?? "")).toContain(
      '"label":["hanse.managed=true"]',
    );
    await expect(
      f.client.ensureNetwork({ name: "app-net", labels: { a: "b" } }),
    ).resolves.toBeUndefined();
    await expect(f.client.connectNetwork("app-net", "hanse", ["hanse"])).resolves.toBeUndefined();
  });

  it("returns undefined for an absent container and raises typed Docker errors", async () => {
    const missing = fixture(() => json(404, { message: "no such container" }));
    await expect(missing.client.inspectContainer("missing")).resolves.toBeUndefined();

    const failing = fixture(() => json(500, { message: "boom" }));
    await expect(failing.client.startContainer("id")).rejects.toBeInstanceOf(DockerError);
  });

  it("inspects a network's labels and containers and maps 404 to undefined", async () => {
    const f = fixture((method, path) => {
      if (method === "GET" && path === "/networks/hanse-app-project-app") {
        return json(200, {
          Name: "hanse-app-project-app",
          Labels: { "hanse.managed": "true", "hanse.app.id": "project:app" },
          Containers: {
            "container-id": { Name: "hanse-app-project-app", EndpointID: "endpoint-id" },
          },
        });
      }
      return json(404, { message: "no such network" });
    });

    await expect(f.client.inspectNetwork("hanse-app-project-app")).resolves.toEqual({
      Name: "hanse-app-project-app",
      Labels: { "hanse.managed": "true", "hanse.app.id": "project:app" },
      Containers: {
        "container-id": { Name: "hanse-app-project-app", EndpointID: "endpoint-id" },
      },
    });
    expect(f.records[0]?.method).toBe("GET");
    expect(f.records[0]?.path).toBe("/networks/hanse-app-project-app");

    await expect(f.client.inspectNetwork("missing")).resolves.toBeUndefined();
  });
});

describe("RunnerGitClient.test", () => {
  const resolved = { root: "/tmp/app", appDir: "/tmp/app", appId: "project:app" };

  it("posts a draft test request and parses the result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new RunnerGitClient({
      baseUrl: "http://runner:8790",
      token: "runtime-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            test: {
              ok: true,
              kind: "ssh",
              remote: "ssh://git@example.com/repo.git",
              refs: 2,
              head: "abc",
              warnings: ["tofu"],
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.test(resolved, {
      kind: "ssh",
      remote: "ssh://git@example.com/repo.git",
    });

    expect(result).toMatchObject({ ok: true, kind: "ssh", refs: 2, head: "abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://runner:8790/v1/apps/project%3Aapp/git/test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      kind: "ssh",
      remote: "ssh://git@example.com/repo.git",
    });
    expect((calls[0]?.init.signal as AbortSignal | undefined)?.aborted).toBe(false);
  });

  it("maps runner error codes including the new test failures", async () => {
    const cases: Array<{ status: number; code: string }> = [
      { status: 409, code: "not_running" },
      { status: 409, code: "restart_required" },
      { status: 409, code: "missing_remote" },
      { status: 400, code: "credential_scheme_mismatch" },
      { status: 400, code: "host_not_allowed" },
      { status: 503, code: "runner_required" },
      { status: 504, code: "timeout" },
      { status: 502, code: "auth_failed" },
    ];

    for (const entry of cases) {
      const client = new RunnerGitClient({
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: entry.code, code: entry.code }), {
            status: entry.status,
          }),
      });
      await expect(client.test(resolved, { kind: "https" })).rejects.toMatchObject({
        code: entry.code,
      });
    }
  });

  it("maps a timeout and rejects an invalid result", async () => {
    const timeout = new RunnerGitClient({
      baseUrl: "http://runner:8790",
      token: "runtime-token",
      fetchImpl: async () => {
        throw new DOMException("timed out", "AbortError");
      },
    });
    await expect(timeout.test(resolved, { kind: "https" })).rejects.toBeInstanceOf(GitError);
    await expect(timeout.test(resolved, { kind: "https" })).rejects.toMatchObject({
      code: "timeout",
    });

    const invalid = new RunnerGitClient({
      baseUrl: "http://runner:8790",
      token: "runtime-token",
      fetchImpl: async () => new Response(JSON.stringify({ test: { ok: false } }), { status: 200 }),
    });
    await expect(invalid.test(resolved, { kind: "https" })).rejects.toMatchObject({
      code: "git_failed",
    });
  });
});
