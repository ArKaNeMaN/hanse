import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortSession,
  deleteSavedPermission,
  deleteSession,
  isOpenCodeReady,
  listMessagePage,
  listMessages,
  listPermissions,
  listPermissionsV2,
  listProviders,
  listQuestions,
  listQuestionsV2,
  listSavedPermissions,
  listSessionStatuses,
  listSessions,
  listSessionsBounded,
  listTodos,
  MESSAGES_RESPONSE_MAX_BYTES,
  MESSAGES_RESPONSE_TIMEOUT_MS,
  OPENCODE_MAX_BODY_BYTES,
  OPENCODE_REPLY_TIMEOUT_MS,
  OpencodeHttpError,
  PROVIDERS_RESPONSE_MAX_BYTES,
  PROVIDERS_RESPONSE_TIMEOUT_MS,
  rejectQuestion,
  rejectQuestionV2,
  replyPermission,
  replyPermissionV2,
  replyQuestion,
  replyQuestionV2,
  SESSION_STATUS_RESPONSE_MAX_BYTES,
  SESSION_STATUS_RESPONSE_TIMEOUT_MS,
  SESSIONS_RESPONSE_MAX_BYTES,
  SESSIONS_RESPONSE_TIMEOUT_MS,
  SUMMARIZE_RESPONSE_TIMEOUT_MS,
  sendPrompt,
  sendPromptAsync,
  summarizeSession,
  waitForOpenCodeReady,
} from "../src/opencode/client.js";
import { setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
}

interface Upstream {
  endpoint: string;
  calls: UpstreamCall[];
  server: Server;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function upstream(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<Upstream> {
  const calls: UpstreamCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: request.method ?? "", url: request.url ?? "", body });
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls, server };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function noContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

const question = {
  id: "que_1",
  sessionID: "ses_1",
  questions: [
    {
      header: "Pick",
      question: "Which?",
      options: [{ label: "A", description: "first" }],
    },
  ],
};

const permission = {
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["ls*"],
  metadata: {},
  always: ["ls*"],
};

describe("v1 client", () => {
  it("uses the v1 list, reply, reject, and todo endpoints", async () => {
    const server = await upstream((request, response, body) => {
      if (request.url === "/question" && request.method === "GET") {
        json(response, [question]);
        return;
      }
      if (request.url === "/question/que_1/reply") {
        expect(JSON.parse(body)).toEqual({ answers: [["A"]] });
        json(response, true);
        return;
      }
      if (request.url === "/question/que_1/reject") {
        expect(body).toBe("");
        json(response, true);
        return;
      }
      if (request.url === "/permission") {
        json(response, [permission]);
        return;
      }
      if (request.url === "/permission/per_1/reply") {
        expect(JSON.parse(body)).toEqual({ reply: "once" });
        json(response, true);
        return;
      }
      if (request.url === "/session/ses_1/todo") {
        json(response, [{ content: "step", status: "pending", priority: "high" }]);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listQuestions(server.endpoint)).resolves.toEqual([question]);
    await expect(replyQuestion(server.endpoint, "que_1", [["A"]])).resolves.toBe(true);
    await expect(rejectQuestion(server.endpoint, "que_1")).resolves.toBe(true);
    await expect(listPermissions(server.endpoint)).resolves.toEqual([permission]);
    await expect(replyPermission(server.endpoint, "per_1", "once")).resolves.toBe(true);
    await expect(listTodos(server.endpoint, "ses_1")).resolves.toEqual([
      { content: "step", status: "pending", priority: "high" },
    ]);

    expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /question",
      "POST /question/que_1/reply",
      "POST /question/que_1/reject",
      "GET /permission",
      "POST /permission/per_1/reply",
      "GET /session/ses_1/todo",
    ]);
  });
});

describe("v2 client", () => {
  it("passes location[directory] to the v2 lists and keeps saved permissions unscoped", async () => {
    const server = await upstream((request, response, body) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/question/request") {
        expect(url.searchParams.get("location[directory]")).toBe("/tmp/app dir");
        json(response, { location: { directory: "/tmp/app dir" }, data: [question] });
        return;
      }
      if (url.pathname === "/api/permission/request") {
        expect(url.searchParams.get("location[directory]")).toBe("/tmp/app dir");
        json(response, {
          location: { directory: "/tmp/app dir" },
          data: [{ ...permission, action: "bash", resources: ["ls*"] }],
        });
        return;
      }
      if (url.pathname === "/api/permission/saved" && request.method === "GET") {
        expect(url.search).toBe("");
        json(response, {
          data: [{ id: "psv_1", projectID: "prj_1", action: "bash", resource: "ls*" }],
        });
        return;
      }
      if (url.pathname === "/api/session/ses_1/question/que_1/reply") {
        expect(JSON.parse(body)).toEqual({ answers: [["A"]] });
        noContent(response);
        return;
      }
      if (url.pathname === "/api/session/ses_1/question/que_1/reject") {
        expect(body).toBe("");
        noContent(response);
        return;
      }
      if (url.pathname === "/api/session/ses_1/permission/per_1/reply") {
        expect(JSON.parse(body)).toEqual({ reply: "always" });
        noContent(response);
        return;
      }
      if (url.pathname === "/api/permission/saved/psv_1" && request.method === "DELETE") {
        noContent(response);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listQuestionsV2(server.endpoint, "/tmp/app dir")).resolves.toEqual([question]);
    await expect(listPermissionsV2(server.endpoint, "/tmp/app dir")).resolves.toEqual([
      { ...permission, action: "bash", resources: ["ls*"] },
    ]);
    await expect(listSavedPermissions(server.endpoint)).resolves.toEqual([
      { id: "psv_1", projectID: "prj_1", action: "bash", resource: "ls*" },
    ]);
    await expect(
      replyQuestionV2(server.endpoint, "ses_1", "que_1", [["A"]]),
    ).resolves.toBeUndefined();
    await expect(rejectQuestionV2(server.endpoint, "ses_1", "que_1")).resolves.toBeUndefined();
    await expect(
      replyPermissionV2(server.endpoint, "ses_1", "per_1", "always"),
    ).resolves.toBeUndefined();
    await expect(deleteSavedPermission(server.endpoint, "psv_1")).resolves.toBeUndefined();
  });
});

describe("typed upstream errors", () => {
  it("carries status, path, and a bounded body excerpt", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "nope", detail: "x".repeat(2_000) }));
    });

    const error = await listQuestions(server.endpoint).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    const typed = error as OpencodeHttpError;
    expect(typed.status).toBe(404);
    expect(typed.path).toBe("/question");
    expect(typed.bodyExcerpt.length).toBeLessThanOrEqual(300);
    expect(typed.bodyExcerpt).toContain("nope");
  });

  it("carries upstream 502 status", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(502);
      response.end("upstream down");
    });
    const error = await listPermissions(server.endpoint).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(502);
  });

  it("times out reads with a typed transport error", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const error = await listQuestions(server.endpoint, { timeoutMs: 50 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("timed out");
  });

  it("rejects a response body over the configured cap", async () => {
    const server = await upstream((_request, response) => {
      json(response, { value: "x".repeat(128) });
    });
    const error = await listQuestions(server.endpoint, { maxBytes: 16 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("exceeded");
    expect(OPENCODE_MAX_BODY_BYTES).toBe(1024 * 1024);
  });
});

describe("async prompt client", () => {
  it("posts the exact prompt_async body and accepts 204 without parsing JSON", async () => {
    const server = await upstream((request, response, body) => {
      if (request.url === "/session/ses_1/prompt_async" && request.method === "POST") {
        expect(JSON.parse(body)).toEqual({
          parts: [{ type: "text", text: "hello" }],
          messageID: "msg_0123",
        });
        noContent(response);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(
      sendPromptAsync(server.endpoint, "ses_1", "hello", "msg_0123"),
    ).resolves.toBeUndefined();
    expect(server.calls).toEqual([
      {
        method: "POST",
        url: "/session/ses_1/prompt_async",
        body: JSON.stringify({
          parts: [{ type: "text", text: "hello" }],
          messageID: "msg_0123",
        }),
      },
    ]);
    expect(OPENCODE_REPLY_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards a provider/model pair in the prompt_async body", async () => {
    const server = await upstream((request, response, body) => {
      if (request.url === "/session/ses_1/prompt_async" && request.method === "POST") {
        expect(JSON.parse(body)).toEqual({
          parts: [{ type: "text", text: "hello" }],
          messageID: "msg_0123",
          model: { providerID: "deepseek", modelID: "deepseek-flash" },
        });
        noContent(response);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(
      sendPromptAsync(
        server.endpoint,
        "ses_1",
        "hello",
        "msg_0123",
        undefined,
        "deepseek/deepseek-flash",
      ),
    ).resolves.toBeUndefined();
  });

  it("maps upstream 404, 405, and 5xx as typed errors", async () => {
    const server = await upstream((request, response) => {
      if (request.url === "/session/missing/prompt_async") {
        response.writeHead(404);
        response.end("no session");
        return;
      }
      if (request.url === "/session/old/prompt_async") {
        response.writeHead(405);
        response.end("no route");
        return;
      }
      if (request.url === "/session/broken/prompt_async") {
        response.writeHead(500);
        response.end("boom");
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    const missing = await sendPromptAsync(server.endpoint, "missing", "hi", "msg_1").catch(
      (caught: unknown) => caught,
    );
    expect(missing).toBeInstanceOf(OpencodeHttpError);
    expect((missing as OpencodeHttpError).status).toBe(404);

    const old = await sendPromptAsync(server.endpoint, "old", "hi", "msg_2").catch(
      (caught: unknown) => caught,
    );
    expect(old).toBeInstanceOf(OpencodeHttpError);
    expect((old as OpencodeHttpError).status).toBe(405);

    const broken = await sendPromptAsync(server.endpoint, "broken", "hi", "msg_3").catch(
      (caught: unknown) => caught,
    );
    expect(broken).toBeInstanceOf(OpencodeHttpError);
    expect((broken as OpencodeHttpError).status).toBe(500);
  });

  it("reports a timeout as a status-0 transport error", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const error = await sendPromptAsync(server.endpoint, "ses_1", "hi", "msg_1", {
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("timed out");
  });
});

describe("bounded messages client", () => {
  it("uses the explicit 8 MiB cap and 30 s timeout defaults", () => {
    expect(MESSAGES_RESPONSE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(MESSAGES_RESPONSE_TIMEOUT_MS).toBe(30_000);
  });

  it("reads a valid messages response through the capped reader", async () => {
    const messages = [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const server = await upstream((request, response) => {
      if (request.method === "GET" && request.url === "/session/ses_1/message") {
        json(response, messages);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listMessages(server.endpoint, "ses_1")).resolves.toEqual(messages);
  });

  it("accepts a valid response larger than the default 1 MiB body cap", async () => {
    const text = "x".repeat(2 * 1024 * 1024);
    const messages = [
      { info: { id: "msg_big", role: "assistant" }, parts: [{ type: "text", text }] },
    ];
    const server = await upstream((_request, response) => {
      json(response, messages);
    });

    const received = await listMessages(server.endpoint, "ses_1");
    expect(received).toHaveLength(1);
    expect(received[0]?.parts[0]?.text).toBe(text);
  });

  it("throws messages_too_large on cap overflow", async () => {
    const server = await upstream((_request, response) => {
      json(response, [{ info: { id: "msg_1", role: "user" }, parts: [] }]);
    });
    const error = await listMessages(server.endpoint, "ses_1", { maxBytes: 16 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).code).toBe("messages_too_large");
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("exceeded");
  });

  it("does not report a transport timeout as messages_too_large", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const error = await listMessages(server.endpoint, "ses_1", { timeoutMs: 50 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).code).toBeUndefined();
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("timed out");
  });
});

describe("paged messages client", () => {
  it("sends limit and an encoded before cursor and reads the next cursor header", async () => {
    const messages = [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const before = "cur/one+= two";
    const nextCursor = "next/one+= two";
    const server = await upstream((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/session/ses_1/message") {
        expect(url.searchParams.get("limit")).toBe("30");
        expect(url.searchParams.get("before")).toBe(before);
        response.writeHead(200, {
          "content-type": "application/json",
          "x-next-cursor": nextCursor,
        });
        response.end(JSON.stringify(messages));
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    const page = await listMessagePage(server.endpoint, "ses_1", { limit: 30, before });
    expect(page).toEqual({ messages, nextCursor });
    expect(server.calls[0]?.url).toBe("/session/ses_1/message?limit=30&before=cur%2Fone%2B%3D+two");
  });

  it("omits nextCursor when the header is absent", async () => {
    const messages = [{ info: { id: "msg_1", role: "assistant" }, parts: [] }];
    const server = await upstream((_request, response) => {
      json(response, messages);
    });

    await expect(listMessagePage(server.endpoint, "ses_1", { limit: 5 })).resolves.toEqual({
      messages,
    });
  });

  it("keeps the messages_too_large code on cap overflow", async () => {
    const server = await upstream((_request, response) => {
      json(response, [{ info: { id: "msg_1", role: "user" }, parts: [] }]);
    });
    const error = await listMessagePage(server.endpoint, "ses_1", {
      limit: 5,
      maxBytes: 16,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).code).toBe("messages_too_large");
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("exceeded");
  });
});

describe("blocking prompt client", () => {
  it("keeps the synchronous message body and parses the message response", async () => {
    const message = {
      info: { id: "msg_1", role: "user" },
      parts: [{ type: "text", text: "hello" }],
    };
    const server = await upstream((request, response, body) => {
      if (request.url === "/session/ses_1/message" && request.method === "POST") {
        expect(JSON.parse(body)).toEqual({ parts: [{ type: "text", text: "hello" }] });
        json(response, message);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(sendPrompt(server.endpoint, "ses_1", "hello")).resolves.toEqual(message);
    expect(server.calls).toHaveLength(1);
  });

  it("forwards a provider/model pair on the blocking prompt", async () => {
    const message = {
      info: { id: "msg_1", role: "user" },
      parts: [{ type: "text", text: "hello" }],
    };
    const server = await upstream((request, response, body) => {
      if (request.url === "/session/ses_1/message" && request.method === "POST") {
        expect(JSON.parse(body)).toEqual({
          parts: [{ type: "text", text: "hello" }],
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
        });
        json(response, message);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(
      sendPrompt(server.endpoint, "ses_1", "hello", "deepseek/deepseek-v4-pro"),
    ).resolves.toEqual(message);
  });
});

describe("endpoint authorization", () => {
  it("adds the registered Basic header to JSON and delete calls", async () => {
    const seen: Array<string | undefined> = [];
    const server = await upstream((request, response) => {
      seen.push(request.headers.authorization);
      if ((request.method ?? "GET") === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, []);
    });
    setEndpointAuthorization(server.endpoint, "opencode", "hunter2");

    await listSessions(server.endpoint);
    await deleteSession(server.endpoint, "ses_1");

    const expected = `Basic ${Buffer.from("opencode:hunter2", "utf8").toString("base64")}`;
    expect(seen).toEqual([expected, expected]);
  });
});

describe("abort client", () => {
  it("posts to the abort route with auth and parses a true body", async () => {
    const seen: Array<{ method?: string; url?: string; body: string; auth?: string }> = [];
    const server = await upstream((request, response, body) => {
      seen.push({
        method: request.method,
        url: request.url,
        body,
        auth: request.headers.authorization,
      });
      json(response, true);
    });
    setEndpointAuthorization(server.endpoint, "opencode", "hunter2");

    await expect(abortSession(server.endpoint, "ses_1")).resolves.toBe(true);

    expect(seen).toEqual([
      {
        method: "POST",
        url: "/session/ses_1/abort",
        body: "",
        auth: `Basic ${Buffer.from("opencode:hunter2", "utf8").toString("base64")}`,
      },
    ]);
  });

  it("returns false for an already-idle turn", async () => {
    const server = await upstream((_request, response) => {
      json(response, false);
    });

    await expect(abortSession(server.endpoint, "ses_1")).resolves.toBe(false);
    expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /session/ses_1/abort",
    ]);
  });

  it("keeps an upstream 404 as a typed error", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"no session"}');
    });

    const error = await abortSession(server.endpoint, "ses_1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(404);
    expect((error as OpencodeHttpError).path).toBe("/session/ses_1/abort");
  });

  it("keeps a transport failure as a typed status-0 error", async () => {
    const server = await upstream((request) => {
      request.socket.destroy();
    });

    const error = await abortSession(server.endpoint, "ses_1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).path).toBe("/session/ses_1/abort");
  });
});

describe("provider catalog client", () => {
  it("reads GET /config/providers with the 4 MiB cap and 10 s timeout", async () => {
    const payload = {
      providers: [
        {
          id: "deepseek",
          models: {
            "deepseek-flash": {
              id: "deepseek-flash",
              limit: { context: 128_000, output: 8_192 },
            },
            "deepseek-pro": { limit: { context: 256_000, input: 200_000, output: 16_384 } },
          },
        },
      ],
      default: { chat: "deepseek/deepseek-flash" },
    };
    const server = await upstream((request, response) => {
      if (request.method === "GET" && request.url === "/config/providers") {
        json(response, payload);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listProviders(server.endpoint)).resolves.toEqual(payload);
    expect(server.calls).toEqual([{ method: "GET", url: "/config/providers", body: "" }]);
    expect(PROVIDERS_RESPONSE_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(PROVIDERS_RESPONSE_TIMEOUT_MS).toBe(10_000);
  });

  it("normalizes a malformed catalog to an empty provider list", async () => {
    const bodies: unknown[] = [null, [], { providers: "nope" }, { default: ["x"] }];
    for (const body of bodies) {
      const server = await upstream((_request, response) => {
        json(response, body);
      });
      await expect(listProviders(server.endpoint)).resolves.toEqual({ providers: [] });
    }
  });

  it("rejects a catalog body over 4 MiB", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ providers: [], padding: "x".repeat(PROVIDERS_RESPONSE_MAX_BYTES) }),
      );
    });

    const error = await listProviders(server.endpoint).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("exceeded");
  });

  it("times out with a typed transport error after the configured timeout", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const original = AbortSignal.timeout;
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds: number) =>
        original.call(AbortSignal, Math.min(milliseconds, 50)),
      );
    try {
      const error = await listProviders(server.endpoint).catch((caught: unknown) => caught);
      expect(spy).toHaveBeenCalledWith(PROVIDERS_RESPONSE_TIMEOUT_MS);
      expect(error).toBeInstanceOf(OpencodeHttpError);
      expect((error as OpencodeHttpError).status).toBe(0);
      expect((error as OpencodeHttpError).bodyExcerpt).toContain("timed out");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("bounded sessions client", () => {
  it("reads GET /session with the 5 s timeout and 2 MiB cap", async () => {
    const sessions = [
      { id: "ses_1", title: "one" },
      { id: "ses_2", title: "two", parentID: "ses_1" },
    ];
    const server = await upstream((request, response) => {
      if (request.method === "GET" && request.url === "/session") {
        json(response, sessions);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listSessionsBounded(server.endpoint)).resolves.toEqual(sessions);
    expect(SESSIONS_RESPONSE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SESSIONS_RESPONSE_TIMEOUT_MS).toBe(5_000);
  });

  it("rejects a session list over 2 MiB", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([{ id: "ses_1", padding: "x".repeat(SESSIONS_RESPONSE_MAX_BYTES) }]),
      );
    });

    const error = await listSessionsBounded(server.endpoint).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("exceeded");
  });

  it("times out with a typed transport error after the configured timeout", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const original = AbortSignal.timeout;
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds: number) =>
        original.call(AbortSignal, Math.min(milliseconds, 50)),
      );
    try {
      const error = await listSessionsBounded(server.endpoint).catch((caught: unknown) => caught);
      expect(spy).toHaveBeenCalledWith(SESSIONS_RESPONSE_TIMEOUT_MS);
      expect(error).toBeInstanceOf(OpencodeHttpError);
      expect((error as OpencodeHttpError).status).toBe(0);
      expect((error as OpencodeHttpError).bodyExcerpt).toContain("timed out");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("session status client", () => {
  it("reads GET /session/status and drops absent or malformed entries", async () => {
    const server = await upstream((request, response) => {
      if (request.method === "GET" && request.url === "/session/status") {
        json(response, {
          ses_busy: { type: "busy" },
          ses_retry: { type: "retry", attempt: 2, message: "retrying" },
          ses_bad: { label: "no type" },
          ses_null: null,
          ses_list: [],
        });
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(listSessionStatuses(server.endpoint)).resolves.toEqual({
      ses_busy: { type: "busy" },
      ses_retry: { type: "retry", attempt: 2, message: "retrying" },
    });
    expect(SESSION_STATUS_RESPONSE_MAX_BYTES).toBe(1024 * 1024);
    expect(SESSION_STATUS_RESPONSE_TIMEOUT_MS).toBe(5_000);
  });

  it("returns an empty map when the status body is not an object", async () => {
    const server = await upstream((_request, response) => json(response, []));

    await expect(listSessionStatuses(server.endpoint)).resolves.toEqual({});
  });
});

describe("summarize client", () => {
  it("posts the exact model body to the encoded summarize path and parses booleans", async () => {
    const calls: UpstreamCall[] = [];
    const server = await upstream((request, response, body) => {
      calls.push({ method: request.method ?? "", url: request.url ?? "", body });
      if (request.method === "POST" && request.url === "/session/ses%2F1/summarize") {
        json(response, true);
        return;
      }
      if (request.method === "POST" && request.url === "/session/ses_false/summarize") {
        json(response, false);
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    await expect(
      summarizeSession(server.endpoint, "ses/1", {
        providerID: "deepseek",
        modelID: "deepseek-flash",
      }),
    ).resolves.toBe(true);
    await expect(
      summarizeSession(server.endpoint, "ses_false", {
        providerID: "deepseek",
        modelID: "deepseek-flash",
      }),
    ).resolves.toBe(false);
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/session/ses%2F1/summarize",
        body: JSON.stringify({
          providerID: "deepseek",
          modelID: "deepseek-flash",
          auto: false,
        }),
      },
      {
        method: "POST",
        url: "/session/ses_false/summarize",
        body: JSON.stringify({
          providerID: "deepseek",
          modelID: "deepseek-flash",
          auto: false,
        }),
      },
    ]);
  });

  it("defaults to a ten-minute timeout", async () => {
    const server = await upstream((_request, response) => {
      json(response, true);
    });
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await summarizeSession(server.endpoint, "ses_1", {
        providerID: "deepseek",
        modelID: "deepseek-flash",
      });
      expect(SUMMARIZE_RESPONSE_TIMEOUT_MS).toBe(600_000);
      expect(spy).toHaveBeenCalledWith(600_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("aborts through the caller signal with a typed transport error", async () => {
    const server = await upstream(() => {
      // Never respond.
    });
    const controller = new AbortController();
    controller.abort();
    const error = await summarizeSession(
      server.endpoint,
      "ses_1",
      { providerID: "deepseek", modelID: "deepseek-flash" },
      { signal: controller.signal },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("aborted");
  });

  it("maps HTTP failures and custom timeouts to typed errors", async () => {
    const failing = await upstream((_request, response) => {
      response.writeHead(500);
      response.end("boom");
    });
    const httpError = await summarizeSession(failing.endpoint, "ses_1", {
      providerID: "deepseek",
      modelID: "deepseek-flash",
    }).catch((caught: unknown) => caught);
    expect(httpError).toBeInstanceOf(OpencodeHttpError);
    expect((httpError as OpencodeHttpError).status).toBe(500);

    const hanging = await upstream(() => {
      // Never respond.
    });
    const timeoutError = await summarizeSession(
      hanging.endpoint,
      "ses_1",
      { providerID: "deepseek", modelID: "deepseek-flash" },
      { timeoutMs: 50 },
    ).catch((caught: unknown) => caught);
    expect(timeoutError).toBeInstanceOf(OpencodeHttpError);
    expect((timeoutError as OpencodeHttpError).status).toBe(0);
    expect((timeoutError as OpencodeHttpError).bodyExcerpt).toContain("timed out");
  });

  it("rejects a non-boolean response body as a typed error", async () => {
    const server = await upstream((_request, response) => {
      json(response, { ok: true });
    });
    const error = await summarizeSession(server.endpoint, "ses_1", {
      providerID: "deepseek",
      modelID: "deepseek-flash",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect((error as OpencodeHttpError).bodyExcerpt).toContain("boolean");
  });
});

describe("opencode readiness probe", () => {
  it("polls /agent until the server answers", async () => {
    let attempts = 0;
    const server = await upstream((_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        response.writeHead(503);
        response.end("booting");
        return;
      }
      json(response, []);
    });

    await expect(
      waitForOpenCodeReady(server.endpoint, {
        timeoutMs: 1_000,
        pollMs: 10,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBe(true);
    expect(server.calls.map((call) => call.url)).toEqual(["/agent", "/agent", "/agent"]);
  });

  it("returns false when the deadline expires", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(503);
      response.end("booting");
    });

    await expect(
      waitForOpenCodeReady(server.endpoint, {
        timeoutMs: 50,
        pollMs: 10,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBe(false);
    expect(await isOpenCodeReady(server.endpoint, 100)).toBe(false);
  });
});
