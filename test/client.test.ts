import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteSavedPermission,
  listMessagePage,
  listMessages,
  listPermissions,
  listPermissionsV2,
  listQuestions,
  listQuestionsV2,
  listSavedPermissions,
  listTodos,
  MESSAGES_RESPONSE_MAX_BYTES,
  MESSAGES_RESPONSE_TIMEOUT_MS,
  OPENCODE_MAX_BODY_BYTES,
  OPENCODE_REPLY_TIMEOUT_MS,
  OpencodeHttpError,
  rejectQuestion,
  rejectQuestionV2,
  replyPermission,
  replyPermissionV2,
  replyQuestion,
  replyQuestionV2,
  sendPrompt,
  sendPromptAsync,
} from "../src/opencode/client.js";

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
