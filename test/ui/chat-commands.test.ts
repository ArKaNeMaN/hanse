import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../../ui/stores/toasts.js";
import { mountChat } from "./chat-support.js";

function command(
  name: string,
  source: "hanse" | "opencode",
  overrides: Record<string, unknown> = {},
) {
  return {
    name,
    source,
    shell: "none",
    available: true,
    description: `Fixture ${name}`,
    ...overrides,
  };
}

const COMMANDS = {
  commands: [
    command("new", "hanse", { action: "new", aliases: ["clear"] }),
    command("help", "hanse", { action: "help" }),
    command("e2e-command", "opencode"),
    command("e2e-shell", "opencode", { shell: "present" }),
    command("other-command", "opencode"),
  ],
  sources: { hanse: "ok", opencode: "ok" },
  warnings: [],
};

async function type(wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"], text: string) {
  await wrapper.find("[data-chat-composer-input]").setValue(text);
  await flushPromises();
}

function pressInput(wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"], key: string) {
  wrapper
    .find("[data-chat-composer-input]")
    .element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("chat slash commands", () => {
  it("opens on slash, filters the catalog, and inserts the active command", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: COMMANDS,
    });
    await type(wrapper, "/e2e");
    expect(wrapper.find("[data-command-palette]").exists()).toBe(true);
    expect(wrapper.findAll("[data-command-name]")).toHaveLength(2);
    expect(wrapper.find('[data-command-name="e2e-command"]').exists()).toBe(true);
    expect(wrapper.find('[data-command-name="other-command"]').exists()).toBe(false);
    expect(wrapper.find(".command-palette__status").text()).toContain("2 commands");

    pressInput(wrapper, "ArrowDown");
    pressInput(wrapper, "Enter");
    await flushPromises();
    const input = wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement;
    expect(input.value).toBe("/e2e-shell ");
    expect(wrapper.find("[data-command-palette]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("confirms a shell command, posts confirmShell, and rekeys the 202 message", async () => {
    const { wrapper, fetchState, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: COMMANDS,
    });
    await type(wrapper, "/e2e-shell");
    pressInput(wrapper, "Enter");
    await flushPromises();
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-command-confirm]").exists()).toBe(true);
    expect(wrapper.find("[data-command-confirm]").text()).toContain("shell blocks");

    await wrapper.find("[data-command-confirm-accept]").trigger("click");
    await flushPromises();

    const post = fetchState.requests.find(
      (request) => request.method === "POST" && request.url.includes("/commands"),
    );
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      name: "e2e-shell",
      confirmShell: true,
    });
    expect(wrapper.find('[data-message-id="msg_command_1"]').text()).toContain("/e2e-shell");
    expect(useToastStore(pinia).toasts.some((toast) => toast.message === "Command accepted.")).toBe(
      true,
    );
    wrapper.unmount();
  });

  it("cancels a shell command without posting", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: COMMANDS,
    });
    await type(wrapper, "/e2e-shell");
    pressInput(wrapper, "Enter");
    await flushPromises();
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    await wrapper.find("[data-command-confirm-cancel]").trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/commands"),
      ),
    ).toBe(false);
    expect((wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value).toBe(
      "/e2e-shell ",
    );
    wrapper.unmount();
  });

  it("confirms an unknown command and sends it as a normal message", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: COMMANDS,
    });
    await type(wrapper, "/mystery hello");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-command-confirm]").text()).toContain("Unknown command");

    await wrapper.find("[data-command-confirm-accept]").trigger("click");
    await flushPromises();
    const post = fetchState.requests.find(
      (request) => request.method === "POST" && request.url.includes("/messages"),
    );
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ text: "/mystery hello" });
    wrapper.unmount();
  });

  it("keeps Hanse commands available with a stopped-agent degradation notice", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: {
        commands: [
          command("new", "hanse", { action: "new" }),
          command("help", "hanse", { action: "help" }),
        ],
        sources: { hanse: "ok", opencode: "stopped" },
        warnings: [
          {
            code: "agent_stopped",
            message: "Application commands load when the agent starts.",
          },
        ],
      },
    });
    await type(wrapper, "/");
    expect(wrapper.find("[data-command-palette]").exists()).toBe(true);
    expect(wrapper.find('[data-command-source="hanse"]').exists()).toBe(true);
    expect(wrapper.find("[data-command-notice]").text()).toContain("agent starts");
    expect(wrapper.find(".command-palette__status").text()).toContain("2 commands");
    wrapper.unmount();
  });

  it("falls back to Hanse commands and reports the error when the list fails", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commandsStatus: 503,
    });
    await type(wrapper, "/");
    expect(wrapper.find("[data-command-palette]").exists()).toBe(true);
    expect(wrapper.find('[data-command-name="new"]').exists()).toBe(true);
    expect(wrapper.find("[data-command-notice]").text()).toContain("unavailable");
    wrapper.unmount();
  });

  it("restores the draft and removes the optimistic row when dispatch fails", async () => {
    const { wrapper, fetchState, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      commands: COMMANDS,
      commandPostStatus: 502,
      commandPostBody: {
        error: "Command outcome unknown.",
        code: "command_failed",
        outcome: "unknown",
      },
    });
    await type(wrapper, "/e2e-command");
    pressInput(wrapper, "Enter");
    await flushPromises();
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();

    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/commands"),
      ),
    ).toBe(true);
    expect(wrapper.findAll('[data-message-id^="local_"]')).toHaveLength(0);
    expect((wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value).toBe(
      "/e2e-command ",
    );
    expect(useToastStore(pinia).toasts.some((toast) => toast.tone === "error")).toBe(true);
    wrapper.unmount();
  });
});
