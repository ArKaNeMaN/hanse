import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ChatImageLightbox from "../../ui/components/chat/ChatImageLightbox.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

function image(overrides: Record<string, unknown> = {}) {
  return {
    src: "/api/apps/alpha/agent-media/amed_1?project=p",
    downloadURL: "/api/apps/alpha/agent-media/amed_1?project=p",
    name: "ui.png",
    caption: "Settings after the save",
    ...overrides,
  };
}

describe("ChatImageLightbox", () => {
  it("opens the native dialog and renders the full image", async () => {
    const wrapper = mount(ChatImageLightbox, {
      props: { image: image() },
      attachTo: document.body,
    });
    await nextTick();
    const dialog = wrapper.find("dialog");
    expect(dialog.attributes("open")).toBe("");
    expect(wrapper.find(".lightbox__image").attributes("src")).toContain("/agent-media/");
    expect(wrapper.find("#chat-lightbox-title").text()).toBe("ui.png");
    expect(wrapper.text()).toContain("Settings after the save");
    expect(wrapper.find("[data-chat-lightbox-download]").attributes("href")).toContain(
      "/agent-media/",
    );
    wrapper.unmount();
  });

  it("emits close from the close button, cancel, and backdrop", async () => {
    const onClose = vi.fn();
    const wrapper = mount(ChatImageLightbox, {
      props: { image: image() },
      attrs: { onClose },
      attachTo: document.body,
    });
    await nextTick();
    await wrapper.find("[data-chat-lightbox-close]").trigger("click");
    expect(onClose).toHaveBeenCalledTimes(1);
    await wrapper.find("dialog").trigger("cancel");
    expect(onClose).toHaveBeenCalledTimes(2);
    await wrapper.find("dialog").trigger("click");
    expect(onClose).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("does not open when the image is null", async () => {
    const wrapper = mount(ChatImageLightbox, {
      props: { image: null },
      attachTo: document.body,
    });
    await nextTick();
    expect(wrapper.find("dialog").attributes("open")).toBeUndefined();
    wrapper.unmount();
  });
});
