import { afterEach, describe, expect, it, vi } from "vitest";
import { apiMutation, apiQuery } from "../../ui/api.js";
import { postPrompt } from "../../ui/chat/send.js";
import { createChatStream } from "../../ui/chat/stream.js";
import { FakeEventSource } from "./chat-support.js";

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("chat auth expiry and logout", () => {
  it("redirects a 401 read with the current chat path", async () => {
    window.history.replaceState(null, "", "/chat?app=alpha&project=p&session=s1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(401, { error: "sign in required" })),
    );
    const onUnauthorized = vi.fn();

    await expect(apiQuery("/api/ui/chat", { onUnauthorized })).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    expect(onUnauthorized).toHaveBeenCalledWith("/chat?app=alpha&project=p&session=s1");
  });

  it("redirects a 401 mutation and keeps the SPA client header", async () => {
    window.history.replaceState(null, "", "/chat?app=alpha&project=p&session=s1");
    const fetchMock = vi.fn(async () => response(401, { error: "sign in required" }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();

    await expect(
      apiMutation(
        "/api/apps/alpha/sessions/s1/draft?project=p",
        { json: { text: "hello" } },
        { method: "PUT", onUnauthorized },
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(onUnauthorized).toHaveBeenCalledWith("/chat?app=alpha&project=p&session=s1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("same-origin");
    expect(((init?.headers ?? {}) as Record<string, string>)["x-hanse-client"]).toBe("spa");
  });

  it("logs out through /login?next= for a 401 without a custom handler", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: {
        pathname: "/chat",
        search: "?app=alpha&project=p",
        hash: "",
        assign,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(401, { error: "sign in required" })),
    );

    await expect(apiQuery("/api/ui/chat")).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/chat?app=alpha&project=p")}`,
    );
  });

  it("probes the cookie session once when the SSE pause reports 401", async () => {
    const location = {
      pathname: "/chat",
      search: "?app=alpha&project=p",
      hash: "",
      assign: vi.fn(),
    };
    const document = { hidden: false } as Document;
    const fetchMock = vi.fn(async () => response(401, { error: "sign in required" }));
    const onAuthExpired = vi.fn();
    const adapter = createChatStream({
      url: "/api/apps/alpha/events?project=p",
      onAuthExpired,
      deps: {
        EventSource: FakeEventSource as unknown as new (url: string) => never,
        fetch: fetchMock as unknown as typeof fetch,
        document,
        location: location as unknown as Location,
      },
    });
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");

    source.onerror?.({});
    source.onerror?.({});
    source.onerror?.({});
    await vi.waitFor(() => expect(onAuthExpired).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/apps/alpha/events?project=p");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/ui/chrome?path=/chat");
    expect(source.closed).toBe(true);
    expect(adapter.status()).toBe("paused");

    source.onerror?.({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it("logs out through /login?next= when the SSE probe returns 401", async () => {
    const assign = vi.fn();
    const location = {
      pathname: "/chat",
      search: "?app=alpha&project=p&session=s1",
      hash: "",
      assign,
    };
    const adapter = createChatStream({
      url: "/api/apps/alpha/events?project=p",
      deps: {
        EventSource: FakeEventSource as unknown as new (url: string) => never,
        fetch: vi.fn(async () => response(401)) as unknown as typeof fetch,
        document: { hidden: false } as Document,
        location: location as unknown as Location,
      },
    });
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.onerror?.({});
    source.onerror?.({});
    source.onerror?.({});
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/chat?app=alpha&project=p&session=s1")}`,
    );
    adapter.dispose();
  });

  it("does not probe or count failures while the document is hidden", async () => {
    const fetchMock = vi.fn(async () => response(401));
    const adapter = createChatStream({
      url: "/api/apps/alpha/events?project=p",
      deps: {
        EventSource: FakeEventSource as unknown as new (url: string) => never,
        fetch: fetchMock as unknown as typeof fetch,
        document: { hidden: true } as Document,
        location: {
          pathname: "/chat",
          search: "",
          hash: "",
          assign: vi.fn(),
        } as unknown as Location,
      },
    });
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.onerror?.({});
    source.onerror?.({});
    source.onerror?.({});
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.failures()).toBe(0);
    expect(adapter.status()).toBe("reconnecting");
    adapter.dispose();
  });

  it("stays paused without a logout when the session probe returns 200", async () => {
    const onAuthExpired = vi.fn();
    const fetchMock = vi
      .fn(async () => response(401))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const adapter = createChatStream({
      url: "/api/apps/alpha/events?project=p",
      onAuthExpired,
      deps: {
        EventSource: FakeEventSource as unknown as new (url: string) => never,
        fetch: fetchMock as unknown as typeof fetch,
        document: { hidden: false } as Document,
        location: {
          pathname: "/chat",
          search: "",
          hash: "",
          assign: vi.fn(),
        } as unknown as Location,
      },
    });
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.onerror?.({});
    source.onerror?.({});
    source.onerror?.({});
    await vi.waitFor(() => expect(adapter.status()).toBe("paused"));
    await Promise.resolve();
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it("redirects a 401 send probe with the current chat path", async () => {
    window.history.replaceState(null, "", "/chat?app=alpha&project=p&session=s1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(401, { error: "sign in required" })),
    );
    const onUnauthorized = vi.fn();

    await expect(
      postPrompt("/api/apps/alpha/sessions/s1/messages?async=1", "hello", { onUnauthorized }),
    ).rejects.toThrow("sign in required");
    expect(onUnauthorized).toHaveBeenCalledWith("/chat?app=alpha&project=p&session=s1");
  });
});
