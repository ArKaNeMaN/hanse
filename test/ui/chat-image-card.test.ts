import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatAttachmentCard from "../../ui/components/chat/ChatAttachmentCard.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

const base = {
  id: "att_1",
  name: "ui.png",
  mime: "image/png",
  size: 42,
  kind: "image" as const,
  mode: "inline" as const,
  state: "sent" as const,
  downloadURL: "/api/apps/alpha/agent-media/amed_1?project=p",
  inline: true,
};

describe("ChatAttachmentCard image rendering", () => {
  it("renders a large image button, caption, and origin", async () => {
    const onOpen = vi.fn();
    const wrapper = mount(ChatAttachmentCard, {
      props: { attachment: { ...base, caption: "Settings", origin: "agent" } },
      attrs: { onOpen },
    });
    expect(wrapper.classes()).toContain("attachment-card--image");
    expect(wrapper.attributes("data-origin")).toBe("agent");
    expect(wrapper.find("[data-attachment-open]").attributes("aria-label")).toBe(
      "Open image: ui.png",
    );
    expect(wrapper.find(".attachment-card__image").attributes("src")).toContain("/agent-media/");
    expect(wrapper.find(".attachment-card__caption").text()).toBe("Settings");
    await wrapper.find("[data-attachment-open]").trigger("click");
    expect(onOpen).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("keeps non-image attachments compact", () => {
    const wrapper = mount(ChatAttachmentCard, {
      props: {
        attachment: {
          ...base,
          kind: "file",
          mode: "file",
          mime: "text/plain",
          downloadURL: "/api/apps/alpha/attachments/att_1?project=p",
        },
      },
    });
    expect(wrapper.classes()).not.toContain("attachment-card--image");
    expect(wrapper.find("[data-attachment-open]").exists()).toBe(false);
    expect(wrapper.find("[data-attachment-download]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the missing placeholder without an image", () => {
    const wrapper = mount(ChatAttachmentCard, {
      props: { attachment: { ...base, state: "missing" } },
    });
    expect(wrapper.find(".attachment-card__image").exists()).toBe(false);
    expect(wrapper.find("[data-attachment-missing]").exists()).toBe(true);
    wrapper.unmount();
  });
});
