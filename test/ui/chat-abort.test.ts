import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { useChatComposer } from "../../ui/composables/useChatComposer.js";
import { useChatComposerStore } from "../../ui/stores/chat-composer.js";
import { useChatFeedStore } from "../../ui/stores/chat-feed.js";

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function install(session = "s1") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const feed = useChatFeedStore(pinia);
  feed.reset(session);
  const store = useChatComposerStore(pinia);
  store.bindWorkspace("alpha:p");
  store.setSession(session);
  const sessionRef = ref<string | null>(session);
  let api: ReturnType<typeof useChatComposer> | undefined;
  const Harness = defineComponent({
    setup() {
      api = useChatComposer({
        app: ref("alpha"),
        project: ref("p"),
        sessionID: sessionRef,
        stopped: ref(false),
        deletionPending: ref(false),
        selectSession: () => undefined,
        hasHistory: () => true,
        refreshMessages: () => Promise.resolve(),
        onSessionGone: () => undefined,
        onSessionDeleted: () => undefined,
      });
      return () => h("div");
    },
  });
  const wrapper = mount(Harness, { global: { plugins: [pinia] } });
  if (api === undefined) throw new Error("composer did not initialize");
  return { api, store, feed, wrapper };
}

describe("chat abort", () => {
  it("keeps last-wins when Stop overtakes an in-flight send", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "PUT") {
          return Promise.resolve(json(200, { text: "Rapid draft" }));
        }
        if (url.includes("/abort")) {
          return Promise.resolve(json(200, { aborted: true }));
        }
        if (url.includes("/messages")) {
          return pending.promise;
        }
        return Promise.resolve(json(200, {}));
      }),
    );
    const { api, store, feed, wrapper } = install();
    store.setDraft("Rapid draft");

    const sending = api.send();
    await vi.waitFor(() => {
      expect(store.acceptance?.state).toBe("sending");
    });
    expect(feed.thread.order).toHaveLength(1);

    await api.stop();
    expect(store.draft).toBe("Rapid draft");
    expect(store.abortPending).toBe(true);
    api.noteAgentStatus("s1", "idle");
    expect(store.abortPending).toBe(false);

    pending.resolve(json(202, { accepted: true, messageID: "msg_slow" }));
    await sending;
    await flushPromises();

    expect(feed.thread.messages.has("msg_slow")).toBe(false);
    expect(feed.thread.order).toHaveLength(0);
    expect(store.error).toBeNull();
    wrapper.unmount();
  });

  it("recognizes intentional aborts and ignores network failures", () => {
    const { api, wrapper } = install();
    expect(api.shouldSuppressAbort({ name: "MessageAbortedError", sessionID: "s1" })).toBe(true);
    expect(
      api.shouldSuppressAbort({
        name: "Error",
        message: "operation was aborted by user",
        sessionID: "s1",
      }),
    ).toBe(true);
    expect(
      api.shouldSuppressAbort({ name: "Error", message: "socket hang up", sessionID: "s1" }),
    ).toBe(false);
    wrapper.unmount();
  });

  it("reports an already-idle stop without suppressing queue promotion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { aborted: false })),
    );
    const { api, store, wrapper } = install();
    await api.stop();
    expect(store.error).toBe("The turn was already idle.");
    expect(store.abortPending).toBe(false);
    wrapper.unmount();
  });
});
