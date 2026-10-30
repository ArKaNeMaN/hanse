import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { BootTopbar } from "../../ui/boot.js";
import TopbarActions from "../../ui/components/TopbarActions.vue";
import { useChatUiStore } from "../../ui/stores/chat-ui.js";
import { clearTopbarActions } from "../../ui/topbar.js";

function shell(defaultMarkup = '<a id="server-default" href="/ide/">IDE</a>'): void {
  document.body.innerHTML = `<header class="topbar"><div class="topbar__actions">${defaultMarkup}</div></header><main id="main"></main>`;
}

function actions(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".topbar__actions");
  if (element === null) {
    throw new Error("missing actions container");
  }
  return element;
}

const CHAT: BootTopbar = {
  ideHref: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Fweb",
  needsInputCount: 0,
  policyVisible: false,
  contextToggle: true,
};

beforeEach(() => {
  shell();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TopbarActions", () => {
  it("clears the server fallback once and renders one chat action set", async () => {
    expect(actions().querySelector("#server-default")).not.toBeNull();
    clearTopbarActions();
    expect(actions().children).toHaveLength(0);

    const wrapper = mount(TopbarActions, {
      props: { topbar: CHAT, workspace: "chat" },
      global: { plugins: [createPinia()] },
    });
    await nextTick();

    expect(actions().querySelector("#server-default")).toBeNull();
    expect(actions().querySelectorAll("#chat-input-needed")).toHaveLength(1);
    expect(actions().querySelectorAll("#chat-policy-chip")).toHaveLength(1);
    expect(actions().querySelectorAll("[data-chat-context-toggle]")).toHaveLength(1);
    expect(actions().querySelectorAll("a")).toHaveLength(1);
    expect(actions().querySelector("#chat-input-needed-count")?.textContent?.trim()).toBe("0");
    expect(actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.hidden).toBe(true);
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(true);
    expect(actions().querySelector("a")?.getAttribute("href")).toBe(CHAT.ideHref);
    wrapper.unmount();
  });

  it("renders only the default IDE action for terminal and restores it on prop change", async () => {
    clearTopbarActions();
    const wrapper = mount(TopbarActions, {
      props: { topbar: CHAT, workspace: "chat" },
      global: { plugins: [createPinia()] },
    });
    await nextTick();
    expect(actions().querySelector("#chat-input-needed")).not.toBeNull();

    await wrapper.setProps({
      topbar: { ideHref: "/ide/?folder=%2Fworkspace%2Fp" },
      workspace: undefined,
    });
    await nextTick();

    expect(actions().querySelector("#chat-input-needed")).toBeNull();
    expect(actions().querySelector("#chat-policy-chip")).toBeNull();
    expect(actions().querySelector("[data-chat-context-toggle]")).toBeNull();
    expect(actions().querySelectorAll("a")).toHaveLength(1);
    expect(actions().querySelector("a")?.getAttribute("aria-label")).toBe("Open IDE in a new tab");
    wrapper.unmount();
  });

  it("shows the needs-input count and policy chip when the seed says so", async () => {
    clearTopbarActions();
    const wrapper = mount(TopbarActions, {
      props: { topbar: { ...CHAT, needsInputCount: 2, policyVisible: true }, workspace: "chat" },
      global: { plugins: [createPinia()] },
    });
    await nextTick();
    expect(actions().querySelector("#chat-input-needed-count")?.textContent?.trim()).toBe("2");
    expect(actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.hidden).toBe(false);
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(false);
    wrapper.unmount();
  });
});

describe("TopbarActions chat store", () => {
  it("renders the chat set on a direct chat boot and resets to the default when the store leaves", async () => {
    shell();
    clearTopbarActions();
    const pinia = createPinia();
    const wrapper = mount(TopbarActions, {
      props: { topbar: CHAT, workspace: "chat" },
      global: { plugins: [pinia] },
    });
    await nextTick();
    expect(actions().querySelector("#chat-input-needed")).not.toBeNull();

    const store = useChatUiStore(pinia);
    store.reset();
    await wrapper.setProps({ workspace: undefined });
    await nextTick();
    expect(actions().querySelector("#chat-input-needed")).toBeNull();
    expect(actions().querySelector("#chat-policy-chip")).toBeNull();
    expect(actions().querySelectorAll("a")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("TopbarActions chat state ownership", () => {
  it("renders the count and policy visibility published by the chat store", async () => {
    clearTopbarActions();
    const pinia = createPinia();
    const wrapper = mount(TopbarActions, {
      props: { topbar: CHAT, workspace: "chat" },
      global: { plugins: [pinia] },
    });
    await nextTick();
    const store = useChatUiStore(pinia);
    store.activate({ ideHref: CHAT.ideHref });
    store.setNeedsInput(3);
    store.setPolicyWarnings(["One policy warning."]);
    await nextTick();

    expect(actions().querySelector("#chat-input-needed-count")?.textContent?.trim()).toBe("3");
    expect(actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.hidden).toBe(false);
    expect(actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.ariaLabel).toBe(
      "3 requests need input",
    );
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(false);

    store.dismissPolicyWarnings();
    store.setNeedsInput(0);
    await nextTick();
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(true);
    expect(actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.hidden).toBe(true);
    expect(actions().querySelector("#chat-input-needed-count")?.textContent?.trim()).toBe("0");
    wrapper.unmount();
  });

  it("opens the queue, policy rail, and context rail through the persistent store", async () => {
    clearTopbarActions();
    const pinia = createPinia();
    const wrapper = mount(TopbarActions, {
      props: { topbar: { ...CHAT, needsInputCount: 1, policyVisible: true }, workspace: "chat" },
      global: { plugins: [pinia] },
    });
    await nextTick();
    const store = useChatUiStore(pinia);
    store.activate({ ideHref: CHAT.ideHref });

    await actions().querySelector<HTMLButtonElement>("#chat-input-needed")?.click();
    await nextTick();
    expect(store.queueOpen).toBe(true);
    expect(actions().querySelector("#chat-input-needed")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    await actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.click();
    await nextTick();
    expect(store.contextOpen).toBe(true);
    expect(store.queueOpen).toBe(false);

    await actions().querySelector<HTMLButtonElement>("[data-chat-context-toggle]")?.click();
    await nextTick();
    expect(store.contextOpen).toBe(false);

    await actions().querySelector<HTMLButtonElement>("[data-chat-context-toggle]")?.click();
    await nextTick();
    expect(store.contextOpen).toBe(true);
    wrapper.unmount();
  });
});
