import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalSocket,
  type TerminalSocket,
  type TerminalStatusKind,
  type TerminalWebSocket,
} from "../../ui/terminal/socket.js";

class FakeWebSocket implements TerminalWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType = "";
  readyState = 0;
  readonly sent: Array<string | ArrayBufferView> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface Harness {
  readonly socket: TerminalSocket;
  readonly statuses: Array<{ kind: TerminalStatusKind; detail?: string }>;
  readonly banners: Array<string | null>;
  readonly fetchMock: ReturnType<typeof vi.fn>;
  readonly authExpired: ReturnType<typeof vi.fn>;
  readonly data: Uint8Array[];
  readonly exits: string[];
  chromeStatus: number;
  runtimeState: string;
  hidden: boolean;
}

function harness(overrides: { runtimeState?: string; chromeStatus?: number } = {}): Harness {
  FakeWebSocket.instances = [];
  let chromeStatus = overrides.chromeStatus ?? 200;
  let runtimeState = overrides.runtimeState ?? "running";
  let hidden = false;
  const statuses: Array<{ kind: TerminalStatusKind; detail?: string }> = [];
  const banners: Array<string | null> = [];
  const data: Uint8Array[] = [];
  const exits: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/ui/chrome")) {
      return { ok: chromeStatus === 200, status: chromeStatus, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ state: runtimeState }) };
  });
  const authExpired = vi.fn();
  const documentStub = {
    get hidden(): boolean {
      return hidden;
    },
  } as unknown as Document;
  const socket = createTerminalSocket({
    wsPath: "/api/apps/alpha/terminal?project=p",
    runtimeUrl: "/api/apps/alpha/runtime?project=p",
    deps: {
      WebSocket: FakeWebSocket as unknown as new (url: string) => TerminalWebSocket,
      fetch: fetchMock as unknown as typeof fetch,
      document: documentStub,
      location: {
        protocol: "http:",
        host: "example.test",
      } as Location,
    },
    onStatus: (kind, detail) => {
      statuses.push(detail === undefined ? { kind } : { kind, detail });
    },
    onBanner: (text) => {
      banners.push(text);
    },
    onData: (bytes) => {
      data.push(bytes);
    },
    onExit: (kind) => {
      exits.push(kind);
    },
    onAuthExpired: authExpired,
  });
  return {
    socket,
    statuses,
    banners,
    fetchMock,
    authExpired,
    data,
    exits,
    get chromeStatus(): number {
      return chromeStatus;
    },
    set chromeStatus(value: number) {
      chromeStatus = value;
    },
    get runtimeState(): string {
      return runtimeState;
    },
    set runtimeState(value: string) {
      runtimeState = value;
    },
    get hidden(): boolean {
      return hidden;
    },
    set hidden(value: boolean) {
      hidden = value;
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function connect(h: Harness): Promise<FakeWebSocket> {
  h.socket.connect(false);
  await flush();
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("no socket was created");
  }
  return socket;
}

async function fail(socket: FakeWebSocket, code = 1010): Promise<void> {
  socket.serverClose(code);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal socket", () => {
  it("runs the runtime preflight and stops without connecting when the agent is stopped", async () => {
    const h = harness({ runtimeState: "stopped" });
    h.socket.connect(false);
    await flush();

    expect(h.statuses.at(-1)).toEqual({ kind: "stopped" });
    expect(h.exits).toContain("stopped");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("connects, sends input bytes, and clamps resize JSON", async () => {
    const h = harness();
    const socket = await connect(h);
    expect(socket.url).toBe("ws://example.test/api/apps/alpha/terminal?project=p");
    socket.open();
    expect(h.statuses.at(-1)).toEqual({ kind: "live" });

    h.socket.sendInput(new Uint8Array([104, 105]));
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(socket.sent[0] as Uint8Array)).toEqual([104, 105]);

    h.socket.sendResize(0, 5000);
    expect(JSON.parse(String(socket.sent.at(-1)))).toEqual({ type: "resize", cols: 1, rows: 1000 });
    const count = socket.sent.length;
    h.socket.sendResize(1, 1000);
    expect(socket.sent).toHaveLength(count);
    h.socket.sendResize(1, 1000, true);
    expect(socket.sent).toHaveLength(count + 1);

    const bytes = new Uint8Array([1, 2, 3]);
    socket.serverMessage(bytes.buffer);
    expect(Array.from(h.data.at(-1) ?? [])).toEqual([1, 2, 3]);
  });

  it.each([1000, 1001])("treats %i as a normal shell exit", async (code) => {
    const h = harness();
    const socket = await connect(h);
    socket.open();
    await fail(socket, code);

    expect(h.statuses.at(-1)).toEqual({ kind: "exited" });
    expect(h.banners.at(-1)).toBe("Shell exited. Reconnect to start a new shell.");
    expect(h.exits).toContain("exited");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("uses exactly five bounded automatic retries and then pauses for a manual reconnect", async () => {
    const h = harness();
    const first = await connect(h);
    first.open();
    await fail(first, 1011);
    expect(h.statuses.at(-1)).toEqual({ kind: "failed" });

    const delays = [1000, 2000, 4000, 8000, 15000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
      const socket = FakeWebSocket.instances.at(-1);
      if (socket === undefined) {
        throw new Error("retry did not open a socket");
      }
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
      await fail(socket, 1011);
      if (index < delays.length - 1) {
        expect(h.statuses.at(-1)).toEqual({ kind: "failed" });
      }
    }

    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(h.statuses.at(-1)).toEqual({ kind: "paused" });
    expect(h.banners.at(-1)).toBe(
      "Connection lost. Automatic reconnects stopped; reconnect to try again.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it("shows a countdown while a non-1011 reconnect is scheduled", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1010);

    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", detail: "in 1s" });
    expect(h.banners.at(-1)).toBe("Connection failed. Reconnecting in 1s.");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("marks an operator close as closed and never retries", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.open();

    h.socket.close();
    expect(h.statuses.at(-1)).toEqual({ kind: "closed" });
    expect(h.banners.at(-1)).toBe("Terminal closed. The application keeps running.");
    expect(h.exits).toContain("closed");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("redirects once on a 401 auth probe and stops retrying", async () => {
    const h = harness({ chromeStatus: 401 });
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1011);

    expect(h.authExpired).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toEqual({ kind: "paused" });
    expect(
      h.fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/ui/chrome")),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("redirects once on a 403 auth probe and stops retrying", async () => {
    const h = harness({ chromeStatus: 403 });
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1011);

    expect(h.authExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("continues bounded retries when the auth probe returns 200", async () => {
    const h = harness({ chromeStatus: 200 });
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1011);

    expect(h.authExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not probe auth while the document is hidden", async () => {
    const h = harness({ chromeStatus: 401 });
    h.hidden = true;
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1011);

    expect(
      h.fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/ui/chrome")),
    ).toHaveLength(0);
    expect(h.authExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores stale callbacks after a new generation replaces the socket", async () => {
    const h = harness();
    const first = await connect(h);
    first.open();
    h.socket.connect(true);
    await flush();
    const second = FakeWebSocket.instances.at(-1);
    if (second === undefined) {
      throw new Error("manual reconnect did not create a socket");
    }
    second.open();
    const before = h.statuses.length;

    first.serverClose(1011);
    await flush();
    expect(h.statuses).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("dispose closes the socket and clears timers, ignoring later callbacks", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.open();
    await fail(socket, 1010);
    const before = h.statuses.length;

    h.socket.dispose();
    socket.serverClose(1011);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.statuses).toHaveLength(before);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
