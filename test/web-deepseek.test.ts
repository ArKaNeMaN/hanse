import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DeepSeekDriver,
  MAX_FETCH_URL_CHARS,
  MAX_SEARCH_QUERY_CHARS,
  WebDriverError,
} from "../src/web/drivers/deepseek.js";
import { parseDeepSeekOptions, webDriverDefinitions } from "../src/web/registry.js";

const KEY = "sk-test-secret-sentinel";

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Handler = (request: RecordedRequest, response: import("node:http").ServerResponse) => void;

async function fakeServer(handler: Handler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: body.length > 0 ? (JSON.parse(body) as unknown) : undefined,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind fake server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function jsonResponse(
  response: import("node:http").ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function driver(
  baseUrl: string,
  overrides: Partial<ConstructorParameters<typeof DeepSeekDriver>[0]> = {},
) {
  return new DeepSeekDriver({
    provider: "deepseek",
    apiKey: KEY,
    baseUrl,
    fetch,
    ...overrides,
  });
}

const signal = new AbortController().signal;

describe("DeepSeekDriver", () => {
  it("sends the exact search request and normalizes results", async () => {
    const server = await fakeServer((_req, res) =>
      jsonResponse(res, {
        results: [
          {
            rerank_score: 2.4,
            title: "DeepSeek V4",
            url: "https://example.com/v4",
            snippet: "Short snippet",
            summary: "Longer summary",
            content: "Full content",
            site_name: "Example",
            date: "2026-06-01T00:00:00+00:00",
          },
        ],
      }),
    );
    try {
      const output = await driver(server.baseUrl, { count: 5, needContent: true }).search(
        { query: "deepseek v4" },
        signal,
      );
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0];
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe("/v1/tools/search");
      expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request?.headers["content-type"]).toBe("application/json");
      expect(request?.json).toEqual({ query: "deepseek v4", count: 5, need_content: true });
      expect(output).toEqual({
        query: "deepseek v4",
        results: [
          {
            title: "DeepSeek V4",
            url: "https://example.com/v4",
            snippet: "Short snippet",
            content: "Full content",
            siteName: "Example",
            publishedAt: "2026-06-01T00:00:00+00:00",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("omits optional search fields and lets input override configured options", async () => {
    const server = await fakeServer((_req, res) => jsonResponse(res, { results: [] }));
    try {
      await driver(server.baseUrl).search({ query: "plain" }, signal);
      expect(server.requests[0]?.json).toEqual({ query: "plain" });

      await driver(server.baseUrl, { count: 2, needContent: false }).search(
        { query: "override", count: 7, needContent: true },
        signal,
      );
      expect(server.requests[1]?.json).toEqual({
        query: "override",
        count: 7,
        need_content: true,
      });
    } finally {
      await server.close();
    }
  });

  it("falls back to the long summary when no snippet is returned", async () => {
    const server = await fakeServer((_req, res) =>
      jsonResponse(res, {
        results: [{ title: "T", url: "https://example.com", snippet: "", summary: "Summary" }],
      }),
    );
    try {
      const output = await driver(server.baseUrl).search({ query: "q" }, signal);
      expect(output.results[0]?.snippet).toBe("Summary");
    } finally {
      await server.close();
    }
  });

  it("sends the exact fetch request and returns normalized content", async () => {
    const server = await fakeServer((_req, res) =>
      jsonResponse(res, { title: "Example", content: "# Example\n\nBody" }),
    );
    try {
      const output = await driver(server.baseUrl).fetch({ url: "https://example.com/a" }, signal);
      expect(server.requests[0]?.url).toBe("/v1/tools/fetch");
      expect(server.requests[0]?.json).toEqual({ url: "https://example.com/a" });
      expect(output).toEqual({
        url: "https://example.com/a",
        title: "Example",
        content: "# Example\n\nBody",
      });
    } finally {
      await server.close();
    }
  });

  it("caps fetch and search content at maxContentChars", async () => {
    const oversized = "x".repeat(5000);
    const server = await fakeServer((req, res) => {
      if (req.url === "/v1/tools/fetch") {
        jsonResponse(res, { title: "T", content: oversized });
        return;
      }
      jsonResponse(res, {
        results: [{ title: "T", url: "https://example.com", content: oversized }],
      });
    });
    try {
      const options = { maxContentChars: 1024 };
      const fetched = await driver(server.baseUrl, options).fetch(
        { url: "https://example.com" },
        signal,
      );
      expect(fetched.content).toHaveLength(1024);
      const searched = await driver(server.baseUrl, options).search({ query: "q" }, signal);
      expect(searched.results[0]?.content).toHaveLength(1024);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid queries before sending a request", async () => {
    const server = await fakeServer((_req, res) => jsonResponse(res, { results: [] }));
    try {
      const deepseek = driver(server.baseUrl);
      await expect(deepseek.search({ query: "" }, signal)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(deepseek.search({ query: "   " }, signal)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        deepseek.search({ query: "x".repeat(MAX_SEARCH_QUERY_CHARS + 1) }, signal),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        deepseek.search({ query: 42 as unknown as string }, signal),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(deepseek.search({ query: "q", count: 21 }, signal)).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects non-http, credentialed, and oversized fetch URLs before sending", async () => {
    const server = await fakeServer((_req, res) => jsonResponse(res, { title: "", content: "" }));
    try {
      const deepseek = driver(server.baseUrl);
      const invalid = [
        "ftp://example.com/file",
        "https://user:pass@example.com/",
        "https://user@example.com/",
        "not a url",
        `https://example.com/${"x".repeat(MAX_FETCH_URL_CHARS)}`,
        "javascript:alert(1)",
      ];
      for (const url of invalid) {
        await expect(deepseek.fetch({ url }, signal)).rejects.toMatchObject({
          name: "WebDriverError",
          code: "invalid_input",
        });
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "http_error"],
  ] as const)("maps HTTP %i to a safe %s error", async (status, code) => {
    const server = await fakeServer((_req, res) =>
      jsonResponse(res, { error: { message: `leaked ${KEY}` } }, status),
    );
    try {
      const error = await driver(server.baseUrl)
        .search({ query: "q" }, signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WebDriverError);
      expect((error as WebDriverError).code).toBe(code);
      expect((error as WebDriverError).message).not.toContain(KEY);
      expect((error as WebDriverError).message).not.toContain("leaked");
      expect(JSON.stringify(error)).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });

  it("times out without leaking request details", async () => {
    const server = await fakeServer(() => {
      // Intentionally never respond.
    });
    try {
      const error = await driver(server.baseUrl, { timeoutMs: 1000 })
        .search({ query: "q" }, signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WebDriverError);
      expect((error as WebDriverError).code).toBe("timeout");
      expect((error as WebDriverError).message).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });

  it("maps network failures and malformed responses to safe errors", async () => {
    const network = new DeepSeekDriver({
      provider: "deepseek",
      apiKey: KEY,
      fetch: (() => Promise.reject(new Error(`boom ${KEY}`))) as typeof fetch,
    });
    const networkError = await network.search({ query: "q" }, signal).catch((error) => error);
    expect(networkError).toBeInstanceOf(WebDriverError);
    expect((networkError as WebDriverError).code).toBe("network");
    expect((networkError as WebDriverError).message).not.toContain(KEY);

    const server = await fakeServer((_req, res) => {
      res.statusCode = 200;
      res.end("not json");
    });
    try {
      const invalid = await driver(server.baseUrl)
        .search({ query: "q" }, signal)
        .catch((error) => error);
      expect(invalid).toBeInstanceOf(WebDriverError);
      expect((invalid as WebDriverError).code).toBe("invalid_response");
    } finally {
      await server.close();
    }
  });

  it("requires an API key", () => {
    expect(
      () =>
        new DeepSeekDriver({
          provider: "deepseek",
          apiKey: "",
        }),
    ).toThrow(WebDriverError);
  });
});

describe("web driver registry", () => {
  it("registers builtin as unmanaged and deepseek as managed", () => {
    const builtin = webDriverDefinitions.find((definition) => definition.id === "builtin");
    const deepseek = webDriverDefinitions.find((definition) => definition.id === "deepseek");
    expect(builtin?.managed).toBe(false);
    expect(builtin?.fields).toEqual([]);
    expect(deepseek?.managed).toBe(true);
    expect(deepseek?.fields.map((field) => field.name)).toEqual([
      "provider",
      "count",
      "needContent",
      "timeoutMs",
      "maxContentChars",
    ]);
    expect(deepseek?.fields.find((field) => field.name === "provider")?.required).toBe(true);
  });

  it("validates provider and option bounds strictly", () => {
    expect(parseDeepSeekOptions({ provider: "deepseek" })).toEqual({ provider: "deepseek" });
    expect(() => parseDeepSeekOptions({ provider: "" })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "p".repeat(129) })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", count: 0 })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", count: 21 })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", timeoutMs: 999 })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", timeoutMs: 60001 })).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", maxContentChars: 1023 })).toThrow();
    expect(() =>
      parseDeepSeekOptions({ provider: "deepseek", maxContentChars: 1048577 }),
    ).toThrow();
    expect(() => parseDeepSeekOptions({ provider: "deepseek", extra: true })).toThrow();
  });
});
