import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ToolPart from "../../ui/components/chat/ToolPart.vue";
import { part } from "./chat-render-support.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function tool(
  id: string,
  toolName: string,
  options: {
    status?: string;
    output?: string;
    input?: Record<string, unknown>;
    error?: string;
  } = {},
) {
  const status = options.status ?? "completed";
  return part({
    id,
    type: "tool",
    status,
    data: {
      id,
      type: "tool",
      tool: toolName,
      state: {
        status,
        input: options.input ?? {},
        metadata: options.output === undefined ? {} : { output: options.output },
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.error === undefined ? {} : { error: options.error }),
      },
    },
  });
}

describe("ToolPart", () => {
  it("coalesces running output to 100 ms and flushes the final text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = tool("t1", "bash", { status: "running", output: "line one" });
    const wrapper = mount(ToolPart, { props: { part: first } });
    await nextTick();
    expect(wrapper.find("[data-tool-output]").text()).toBe("line one");

    await wrapper.setProps({
      part: tool("t1", "bash", { status: "running", output: "line one\nline two" }),
    });
    await nextTick();
    expect(wrapper.find("[data-tool-output]").text()).toBe("line one");
    vi.advanceTimersByTime(99);
    await nextTick();
    expect(wrapper.find("[data-tool-output]").text()).toBe("line one");
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find("[data-tool-output]").text()).toContain("line two");
    wrapper.unmount();
  });

  it("renders the bash tail in a pre node and completed updates immediately", async () => {
    const wrapper = mount(ToolPart, {
      props: {
        part: tool("t1", "bash", {
          status: "completed",
          input: { command: "npm test" },
          output: "test output\nall green",
        }),
      },
    });
    await nextTick();
    const output = wrapper.find("[data-tool-output]");
    expect(output.element.tagName).toBe("PRE");
    expect(output.text()).toContain("all green");
    expect(wrapper.find("summary").text()).toContain("npm test");
    wrapper.unmount();
  });

  it("renders structured Hanse tool fields as key/value nodes, not raw HTML", async () => {
    const wrapper = mount(ToolPart, {
      props: {
        part: tool("t1", "hanse_list_dir", {
          output: JSON.stringify({ path: "src", entries: [{ name: "<script>x</script>" }] }),
        }),
      },
    });
    await nextTick();
    expect(wrapper.find(".tool-kv").exists()).toBe(true);
    expect(wrapper.find(".tool-kv").text()).toContain("path");
    expect(wrapper.find(".tool-kv").text()).toContain("src");
    expect(wrapper.find(".tool-code--json").text()).toContain("<script>x</script>");
    expect(wrapper.findAll("script")).toHaveLength(0);
    wrapper.unmount();
  });

  it("renders todowrite items with their status", async () => {
    const wrapper = mount(ToolPart, {
      props: {
        part: tool("t1", "todowrite", {
          input: {
            todos: [
              { status: "completed", content: "Write tests" },
              { status: "in_progress", content: "Run tests" },
            ],
          },
        }),
      },
    });
    await nextTick();
    const items = wrapper.findAll("[data-tool-todos] li");
    expect(items).toHaveLength(2);
    expect(items[0]?.attributes("data-status")).toBe("completed");
    expect(wrapper.text()).toContain("Run tests");
    wrapper.unmount();
  });

  it("opens an error tool and renders a failure card", async () => {
    const wrapper = mount(ToolPart, {
      props: {
        part: tool("t1", "hanse_ssh_exec", {
          status: "completed",
          output: JSON.stringify({ ok: false, code: "no_host", message: "no such host" }),
        }),
      },
    });
    await nextTick();
    expect(wrapper.find("[data-tool-error]").text()).toContain("no_host");
    expect(wrapper.find("[data-tool-error]").text()).toContain("no such host");

    const error = tool("t2", "bash", { status: "error", output: "", error: "command failed" });
    const errored = mount(ToolPart, { props: { part: error } });
    await nextTick();
    expect(errored.find("details").attributes("open")).toBeDefined();
    expect(errored.find("[data-tool-output]").text()).toContain("command failed");
    wrapper.unmount();
    errored.unmount();
  });
});
