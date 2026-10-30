import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import TopbarActions from "../../ui/components/TopbarActions.vue";
import { useChatUiStore } from "../../ui/stores/chat-ui.js";
import { clearTopbarActions } from "../../ui/topbar.js";
import { boot, mountChat } from "./chat-support.js";

function topbarShell(): void {
  document.body.insertAdjacentHTML(
    "beforeend",
    '<header class="topbar"><div class="topbar__actions"></div></header>',
  );
}

function actions(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".topbar__actions");
  if (element === null) throw new Error("missing topbar");
  return element;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat policy warnings", () => {
  it("publishes warnings to chatUi, renders the rail warning, and toggles the topbar chip", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      promptsWarnings: ["Synthetic policy warning."],
    });
    await flushPromises();
    const chatUi = useChatUiStore(pinia);
    expect(chatUi.policyVisible).toBe(true);
    expect(chatUi.policyWarnings).toEqual(["Synthetic policy warning."]);
    expect(wrapper.find("[data-chat-policy-warning]").text()).toContain(
      "Synthetic policy warning.",
    );

    topbarShell();
    clearTopbarActions();
    const topbar = mount(TopbarActions, {
      props: { topbar: boot().topbar, workspace: "chat" },
      global: { plugins: [pinia] },
    });
    await nextTick();
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(false);

    chatUi.setContextOpen(false);
    await actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.click();
    await nextTick();
    expect(chatUi.contextOpen).toBe(true);
    expect(actions().querySelector("#chat-policy-chip")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    await wrapper.find("[data-policy-dismiss]").trigger("click");
    await nextTick();
    expect(chatUi.policyWarnings).toEqual([]);
    expect(chatUi.policyVisible).toBe(false);
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(true);
    expect(wrapper.find("[data-chat-policy-warning]").exists()).toBe(false);

    topbar.unmount();
    wrapper.unmount();
  });

  it("hides the chip and warning section when the prompt read has no warnings", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      promptsWarnings: [],
    });
    await flushPromises();
    topbarShell();
    clearTopbarActions();
    const topbar = mount(TopbarActions, {
      props: { topbar: boot().topbar, workspace: "chat" },
      global: { plugins: [pinia] },
    });
    await nextTick();
    expect(useChatUiStore(pinia).policyVisible).toBe(false);
    expect(actions().querySelector<HTMLButtonElement>("#chat-policy-chip")?.hidden).toBe(true);
    expect(wrapper.find("[data-chat-policy-warning]").exists()).toBe(false);
    topbar.unmount();
    wrapper.unmount();
  });
});
