import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountChat } from "./chat-support.js";

function fixtureMessage(index: number) {
  const suffix = String(index).padStart(3, "0");
  return {
    info: {
      id: `msg_perf_${suffix}`,
      sessionID: "s1",
      role: index % 2 === 0 ? "assistant" : "user",
      time: { created: 1_760_000_000_000 + index },
    },
    parts: [
      {
        id: `prt_perf_${suffix}`,
        sessionID: "s1",
        messageID: `msg_perf_${suffix}`,
        type: "text",
        text: `Perf fixture message ${index}.`,
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat feed performance", () => {
  it("mounts a 500-message feed without constructing a highlight worker", async () => {
    let constructed = 0;
    class CountingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      constructor() {
        constructed += 1;
      }
      postMessage(): void {}
      terminate(): void {}
    }
    vi.stubGlobal("Worker", CountingWorker);
    const messages = Array.from({ length: 500 }, (_, index) => fixtureMessage(index + 1));
    const started = performance.now();
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", { messages });
    await flushPromises();
    const elapsed = performance.now() - started;

    expect(wrapper.findAll("#chat-scroll [data-message-id]")).toHaveLength(500);
    expect(constructed).toBe(0);
    expect(document.querySelectorAll('script[src*="prism"], script[src*="xterm"]')).toHaveLength(0);
    // Record the measured mount time in the test output; no brittle wall-clock assertion.
    console.info(`chat-perf: 500-message mount ${elapsed.toFixed(1)} ms`);
    wrapper.unmount();
  });

  it("streams 20 deltas without replacing existing feed DOM", async () => {
    const { wrapper } = await mountChat();
    const first = wrapper.find('[data-message-id="msg_user"]').element;
    const rows = wrapper.findAll("#chat-scroll [data-message-id]").map((node) => node.element);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-perf" });
    await flushPromises();

    for (let index = 1; index <= 20; index += 1) {
      source.emit({
        type: "message.part.delta",
        seq: index,
        streamID: "stream-perf",
        sessionID: "s1",
        messageID: "msg_assistant",
        partID: "prt_perf_delta",
        partType: "text",
        field: "text",
        delta: `token-${index} `,
      });
      await flushPromises();
    }

    await new Promise((resolve) => setTimeout(resolve, 70));
    await flushPromises();
    expect(wrapper.find('[data-message-id="msg_user"]').element).toBe(first);
    const after = wrapper.findAll("#chat-scroll [data-message-id]").map((node) => node.element);
    expect(after.slice(0, rows.length)).toEqual(rows);
    expect(wrapper.text()).toContain("token-20");
    expect(wrapper.findAll("#chat-scroll [data-message-id]")).toHaveLength(rows.length);
    wrapper.unmount();
  });
});
