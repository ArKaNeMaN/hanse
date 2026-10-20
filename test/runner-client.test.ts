import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
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
});
