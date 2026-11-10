import http from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { describe, expect, it } from "vitest";
import {
  createRequestPlan,
  TelegramApiError,
  TelegramHttpTransport,
  type TelegramNodeRequest,
  telegramApiUrl,
} from "../src/notifications/telegram/transport.js";

const SIGNAL = new AbortController().signal;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchOf(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

describe("telegram transport", () => {
  it("joins a base URL path with exactly one slash", () => {
    expect(telegramApiUrl("https://api.telegram.org", "123:abc", "sendMessage")).toBe(
      "https://api.telegram.org/bot123:abc/sendMessage",
    );
    expect(telegramApiUrl("https://example.test/bot-api/", "123:abc", "sendMessage")).toBe(
      "https://example.test/bot-api/bot123:abc/sendMessage",
    );
  });

  it("selects the request module and proxy agent for every target/proxy pair", () => {
    const httpsTarget = new URL("https://api.telegram.org/bot1/sendMessage");
    const httpTarget = new URL("http://api.local/bot1/sendMessage");

    const httpsHttpProxy = createRequestPlan(httpsTarget, new URL("http://proxy:8080"));
    expect(httpsHttpProxy.protocol).toBe("https");
    expect(httpsHttpProxy.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(httpsHttpProxy.agentKind).toBe("https-proxy");

    const httpsHttpsProxy = createRequestPlan(httpsTarget, new URL("https://proxy:8443"));
    expect(httpsHttpsProxy.agent).toBeInstanceOf(HttpsProxyAgent);

    const httpHttpProxy = createRequestPlan(httpTarget, new URL("http://proxy:8080"));
    expect(httpHttpProxy.protocol).toBe("http");
    expect(httpHttpProxy.agent).toBeInstanceOf(HttpProxyAgent);
    expect(httpHttpProxy.agentKind).toBe("http-proxy");

    const httpHttpsProxy = createRequestPlan(httpTarget, new URL("https://proxy:8443"));
    expect(httpHttpsProxy.agent).toBeInstanceOf(HttpProxyAgent);

    const httpsSocks = createRequestPlan(httpsTarget, new URL("socks5h://proxy:1080"));
    expect(httpsSocks.protocol).toBe("https");
    expect(httpsSocks.agent).toBeInstanceOf(SocksProxyAgent);
    expect(httpsSocks.agentKind).toBe("socks-proxy");

    const httpSocks = createRequestPlan(httpTarget, new URL("socks5://proxy:1080"));
    expect(httpSocks.protocol).toBe("http");
    expect(httpSocks.agent).toBeInstanceOf(SocksProxyAgent);
  });

  it("rejects unsupported target and proxy schemes", () => {
    expect(() => createRequestPlan(new URL("ftp://api"), new URL("http://proxy:1"))).toThrow(
      TelegramApiError,
    );
    expect(() => createRequestPlan(new URL("https://api"), new URL("ftp://proxy:1"))).toThrow(
      /unsupported proxy protocol/,
    );
  });

  it("uses direct fetch and returns the Bot API result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, { ok: true, result: { message_id: 42 } });
    }) as typeof fetch;
    const transport = new TelegramHttpTransport({
      token: "123:secret",
      apiBaseUrl: "https://example.test/api/",
      fetchImpl,
    });

    await expect(transport.call("sendMessage", { text: "hi" }, SIGNAL)).resolves.toEqual({
      message_id: 42,
    });
    expect(calls[0]?.url).toBe("https://example.test/api/bot123:secret/sendMessage");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe('{"text":"hi"}');
  });

  it("maps 429, format 400, other 400, 401/403, 404, and 5xx", async () => {
    const call = (status: number, body: unknown) =>
      new TelegramHttpTransport({
        token: "t",
        fetchImpl: fetchOf(jsonResponse(status, body)),
      }).call("sendMessage", {}, SIGNAL);

    await expect(
      call(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 7 },
      }),
    ).rejects.toMatchObject({ code: "telegram_rate_limited", retryAfterSeconds: 7 });
    await expect(
      call(400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: unexpected end",
      }),
    ).rejects.toMatchObject({ code: "telegram_format" });
    await expect(
      call(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    ).rejects.toMatchObject({ code: "telegram_rejected" });
    await expect(
      call(401, { ok: false, error_code: 401, description: "Unauthorized" }),
    ).rejects.toMatchObject({ code: "telegram_unauthorized" });
    await expect(
      call(403, { ok: false, error_code: 403, description: "Forbidden" }),
    ).rejects.toMatchObject({ code: "telegram_unauthorized" });
    await expect(
      call(404, { ok: false, error_code: 404, description: "Not Found" }),
    ).rejects.toMatchObject({ code: "telegram_not_found" });
    await expect(
      call(500, { ok: false, error_code: 500, description: "Server error" }),
    ).rejects.toMatchObject({ code: "telegram_unavailable" });
  });

  it("maps an ok:false body even when the HTTP status is 200", async () => {
    const transport = new TelegramHttpTransport({
      token: "t",
      fetchImpl: fetchOf(
        jsonResponse(200, {
          ok: false,
          error_code: 400,
          description: "Bad Request: message is too long",
        }),
      ),
    });
    await expect(transport.call("sendMessage", {}, SIGNAL)).rejects.toMatchObject({
      code: "telegram_format",
    });
  });

  it("caps the response body and rejects invalid JSON", async () => {
    const tooLarge = new TelegramHttpTransport({
      token: "t",
      maxResponseBytes: 16,
      fetchImpl: fetchOf(new Response("x".repeat(64), { status: 200 })),
    });
    await expect(tooLarge.call("sendMessage", {}, SIGNAL)).rejects.toMatchObject({
      code: "telegram_unavailable",
      message: expect.stringContaining("exceeded"),
    });

    const invalid = new TelegramHttpTransport({
      token: "t",
      fetchImpl: fetchOf(new Response("not json", { status: 200 })),
    });
    await expect(invalid.call("sendMessage", {}, SIGNAL)).rejects.toMatchObject({
      code: "telegram_unavailable",
    });
  });

  it("times out and honors an external abort", async () => {
    const hangingFetch = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })) as typeof fetch;

    const timedOut = new TelegramHttpTransport({
      token: "t",
      timeoutMs: 10,
      fetchImpl: hangingFetch,
    });
    await expect(timedOut.call("sendMessage", {}, SIGNAL)).rejects.toMatchObject({
      code: "telegram_unavailable",
      message: expect.stringContaining("timed out"),
    });

    const controller = new AbortController();
    const aborted = new TelegramHttpTransport({ token: "t", fetchImpl: hangingFetch });
    const pending = aborted.call("sendMessage", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "telegram_unavailable",
      message: expect.stringContaining("aborted"),
    });
  });

  it("redacts the token and proxy URL from transport errors", async () => {
    const token = "123456:SUPER-SECRET-TOKEN";
    const proxyUrl = "http://user:proxy-password@proxy.internal:8080";
    const direct = new TelegramHttpTransport({
      token,
      fetchImpl: (async () => {
        throw new Error(`failed ${token}`);
      }) as typeof fetch,
    });
    await expect(direct.call("sendMessage", {}, SIGNAL)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(token) && message.includes("<redacted>");
    });

    const proxied = new TelegramHttpTransport({
      token,
      proxyUrl,
      nodeRequest: async (request) => {
        throw new Error(`failed ${token} via ${proxyUrl} ${request.protocol}`);
      },
    });
    await expect(proxied.call("sendMessage", {}, SIGNAL)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        !message.includes(token) &&
        !message.includes("proxy-password") &&
        message.includes("<redacted>")
      );
    });
  });

  it("uses node:https + HttpsProxyAgent for an HTTPS target through an HTTP proxy", async () => {
    const calls: TelegramNodeRequest[] = [];
    const transport = new TelegramHttpTransport({
      token: "123:secret",
      proxyUrl: "http://proxy:8080",
      nodeRequest: async (request) => {
        calls.push(request);
        return { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 9 } }) };
      },
    });

    await expect(transport.call("sendMessage", { text: "hi" }, SIGNAL)).resolves.toEqual({
      message_id: 9,
    });
    expect(calls[0]?.protocol).toBe("https");
    expect(calls[0]?.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(calls[0]?.url.pathname).toBe("/bot123:secret/sendMessage");
    expect(calls[0]?.body).toBe('{"text":"hi"}');
  });

  it("uses node:http + HttpProxyAgent for an HTTP target and SocksProxyAgent for SOCKS", async () => {
    const calls: TelegramNodeRequest[] = [];
    const transport = new TelegramHttpTransport({
      token: "t",
      apiBaseUrl: "http://api.local",
      proxyUrl: "http://proxy:8080",
      nodeRequest: async (request) => {
        calls.push(request);
        return { status: 200, body: JSON.stringify({ ok: true, result: {} }) };
      },
    });
    await transport.call("sendMessage", {}, SIGNAL);
    expect(calls[0]?.protocol).toBe("http");
    expect(calls[0]?.agent).toBeInstanceOf(HttpProxyAgent);

    const socksCalls: TelegramNodeRequest[] = [];
    const socks = new TelegramHttpTransport({
      token: "t",
      proxyUrl: "socks5h://proxy:1080",
      nodeRequest: async (request) => {
        socksCalls.push(request);
        return { status: 200, body: JSON.stringify({ ok: true, result: {} }) };
      },
    });
    await socks.call("sendMessage", {}, SIGNAL);
    expect(socksCalls[0]?.protocol).toBe("https");
    expect(socksCalls[0]?.agent).toBeInstanceOf(SocksProxyAgent);
  });

  it("maps an oversized proxied response to unavailable", async () => {
    const transport = new TelegramHttpTransport({
      token: "t",
      proxyUrl: "http://proxy:8080",
      nodeRequest: async () => ({ status: 200, body: "", tooLarge: true }),
    });
    await expect(transport.call("sendMessage", {}, SIGNAL)).rejects.toMatchObject({
      code: "telegram_unavailable",
      message: expect.stringContaining("exceeded"),
    });
  });

  it("accepts the default node request implementation type", () => {
    expect(typeof http.request).toBe("function");
  });
});
