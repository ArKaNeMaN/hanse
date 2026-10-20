import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  DockerClient,
  DockerError,
  type DockerRequestOptions,
  type DockerResponse,
  type DockerTransport,
} from "../src/runner/docker.js";

function json(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

interface RawBuild {
  path: string;
  body: Buffer;
  options: DockerRequestOptions | undefined;
}

class FakeTransport implements DockerTransport {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly builds: RawBuild[] = [];
  apiVersion = "1.44";
  buildResponse: (path: string) => DockerResponse = () =>
    json(
      200,
      [{ stream: "ok\n" }, { aux: { ID: "sha256:built" } }].map((line) => line),
    );
  imageId: string | undefined = "sha256:fallback";

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<DockerResponse> {
    this.requests.push({ method, path, body });
    if (path === "/version" || path.endsWith("/version")) {
      return json(200, { ApiVersion: this.apiVersion });
    }
    if (path.includes("/images/")) {
      return this.imageId === undefined
        ? json(404, { message: "no such image" })
        : json(200, { Id: this.imageId });
    }
    return json(500, { message: `unexpected request ${method} ${path}` });
  }

  async build(path: string, body: Buffer, options?: DockerRequestOptions): Promise<DockerResponse> {
    this.builds.push({ path, body, options });
    return this.buildResponse(path);
  }
}

function buildOptions(tar = Buffer.from("tar-body")) {
  return {
    tag: "hanse-app-project-app:build-1",
    dockerfile: ".hanse/Dockerfile",
    tar,
    baseImage: "agent-default:test",
    buildArgs: { EXTRA: "curl", HANSE_BASE: "evil:latest" },
    labels: { "hanse.app.id": "project:app", "hanse.image.version": "v1" },
    memoryBytes: 1024,
    nanoCpus: 2_000_000_000,
    pidsLimit: 256,
  };
}

function queryOf(build: RawBuild): URLSearchParams {
  const query = build.path.split("?")[1] ?? "";
  return new URLSearchParams(query);
}

function jsonLines(response: unknown[]): DockerResponse {
  return {
    status: 200,
    body: Buffer.from(response.map((line) => JSON.stringify(line)).join("\n"), "utf8"),
  };
}

describe("DockerClient.buildImage", () => {
  it("sends a raw tar build with BuildKit, labels, args, and resource limits", async () => {
    const transport = new FakeTransport();
    transport.buildResponse = () =>
      jsonLines([{ stream: "Step 1/1\n" }, { aux: { ID: "sha256:result" } }]);
    const client = new DockerClient(transport);
    const tar = Buffer.from("tar-body");

    const result = await client.buildImage(buildOptions(tar));

    expect(result).toEqual({ imageId: "sha256:result", logs: "Step 1/1\n", error: null });
    expect(transport.builds).toHaveLength(1);
    const build = transport.builds[0];
    if (build === undefined) throw new Error("missing build");
    expect(build.body).toEqual(tar);
    expect(build.options?.timeoutMs).toBeUndefined();

    const query = queryOf(build);
    expect(query.get("t")).toBe("hanse-app-project-app:build-1");
    expect(query.get("dockerfile")).toBe(".hanse/Dockerfile");
    expect(query.get("version")).toBe("2");
    expect(query.get("memory")).toBe("1024");
    expect(query.get("memswap")).toBe("1024");
    expect(query.get("cpuperiod")).toBe("100000");
    expect(query.get("cpuquota")).toBe("200000");
    expect(query.get("pidslimit")).toBe("256");
    expect(JSON.parse(query.get("labels") ?? "{}")).toEqual({
      "hanse.app.id": "project:app",
      "hanse.image.version": "v1",
    });
    expect(JSON.parse(query.get("buildargs") ?? "{}")).toEqual({
      EXTRA: "curl",
      HANSE_BASE: "agent-default:test",
    });
  });

  it("falls back to the classic builder when the Engine API predates BuildKit", async () => {
    const transport = new FakeTransport();
    transport.apiVersion = "1.38";
    transport.buildResponse = () => jsonLines([{ aux: { ID: "sha256:classic" } }]);
    const client = new DockerClient(transport);

    const result = await client.buildImage(buildOptions());

    expect(result.imageId).toBe("sha256:classic");
    const build = transport.builds[0];
    if (build === undefined) throw new Error("missing build");
    expect(queryOf(build).has("version")).toBe(false);
  });

  it("parses build errors from a 200 JSON stream", async () => {
    const transport = new FakeTransport();
    transport.buildResponse = () =>
      jsonLines([{ stream: "Step 1/1\n" }, { errorDetail: { message: "boom" }, error: "boom" }]);
    const client = new DockerClient(transport);

    const result = await client.buildImage(buildOptions());

    expect(result.imageId).toBeNull();
    expect(result.error).toBe("boom");
    expect(result.logs).toContain("Step 1/1");
  });

  it("reports a non-2xx build response as a bounded error", async () => {
    const transport = new FakeTransport();
    transport.buildResponse = () => ({
      status: 500,
      body: Buffer.from("daemon unavailable", "utf8"),
    });
    const client = new DockerClient(transport);

    const result = await client.buildImage(buildOptions());

    expect(result.imageId).toBeNull();
    expect(result.error).toContain("daemon unavailable");
  });

  it("falls back to inspecting the tag when the stream has no aux image id", async () => {
    const transport = new FakeTransport();
    transport.buildResponse = () => jsonLines([{ stream: "Successfully built\n" }]);
    transport.imageId = "sha256:inspected";
    const client = new DockerClient(transport);

    const result = await client.buildImage(buildOptions());

    expect(result).toEqual({
      imageId: "sha256:inspected",
      logs: "Successfully built\n",
      error: null,
    });
    expect(transport.requests.some((entry) => entry.path.includes("/images/"))).toBe(true);
  });

  it("fails closed when the transport has no build support", async () => {
    const transport: DockerTransport = {
      async request(): Promise<DockerResponse> {
        return json(200, { ApiVersion: "1.44" });
      },
    };
    const client = new DockerClient(transport);

    await expect(client.buildImage(buildOptions())).rejects.toBeInstanceOf(DockerError);
  });
});
