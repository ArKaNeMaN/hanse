import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeXMLHttpRequest, installXhr, mountChat } from "./chat-support.js";

function file(name: string, type = "text/plain", size = 12): File {
  return new File(["x".repeat(Math.min(size, 64))], name, { type });
}

async function addFiles(
  wrapper: VueWrapper,
  files: readonly File[],
  selector = "[data-chat-attach-input]",
): Promise<void> {
  const input = wrapper.find(selector);
  const element = input.element as HTMLInputElement;
  Object.defineProperty(element, "files", { value: files, configurable: true });
  await input.trigger("change");
  await flushPromises();
}

function uploadBody(id: string, overrides: Record<string, unknown> = {}) {
  return {
    attachment: {
      id,
      name: "fixture.txt",
      mime: "text/plain",
      size: 12,
      kind: "file",
      mode: "auto",
      state: "draft",
      downloadURL: `/api/apps/alpha/attachments/${id}`,
      inline: false,
      ...overrides,
    },
    quota: { percent: 12 },
  };
}

beforeEach(() => {
  installXhr();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("chat attachments", () => {
  it("uploads through XHR with progress, headers, and a ready chip", async () => {
    const { wrapper } = await mountChat();
    await addFiles(wrapper, [file("notes.txt")]);
    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    const xhr = FakeXMLHttpRequest.instances[0];
    expect(xhr?.url).toContain("/api/apps/alpha/attachments");
    expect(xhr?.url).toContain("project=p");
    expect(xhr?.url).toContain("session=s1");
    expect(xhr?.headers["content-disposition"]).toContain("notes.txt");

    xhr?.progress(50, 100);
    await flushPromises();
    expect(wrapper.find("[data-attachment-key]").text()).toContain("Uploading 50%");
    expect(wrapper.find(".chat-attachment__progress").attributes("aria-valuenow")).toBe("50");

    xhr?.respond(201, uploadBody("att_1"));
    await flushPromises();
    expect(wrapper.find('[data-attachment-id="att_1"]').attributes("data-status")).toBe("ready");
    expect(wrapper.find("[data-chat-attachment-quota]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("enforces 10 files and 100 MiB per file", async () => {
    const { wrapper } = await mountChat();
    await addFiles(
      wrapper,
      Array.from({ length: 11 }, (_, index) => file(`f${index}.txt`)),
    );
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
    expect(wrapper.find("[data-chat-send-error]").text()).toContain("Attach at most 10 files");

    const oversized = file("huge.bin", "application/octet-stream");
    Object.defineProperty(oversized, "size", { value: 100 * 1024 * 1024 + 1 });
    await addFiles(wrapper, [oversized]);
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
    wrapper.unmount();
  });

  it("runs at most two uploads at once and starts the third on completion", async () => {
    const { wrapper } = await mountChat();
    await addFiles(wrapper, [file("a.txt"), file("b.txt"), file("c.txt")]);
    expect(FakeXMLHttpRequest.instances).toHaveLength(2);
    FakeXMLHttpRequest.instances[0]?.respond(201, uploadBody("att_a"));
    await flushPromises();
    expect(FakeXMLHttpRequest.instances).toHaveLength(3);
    wrapper.unmount();
  });

  it("cancels an upload with abort and removes the chip", async () => {
    const { wrapper } = await mountChat();
    await addFiles(wrapper, [file("cancel.txt")]);
    const xhr = FakeXMLHttpRequest.instances[0];
    await wrapper.find("[data-attachment-cancel]").trigger("click");
    await flushPromises();
    expect(xhr?.aborted).toBe(true);
    expect(wrapper.find("[data-attachment-key]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("retries a failed upload and keeps the file for the retry", async () => {
    const { wrapper } = await mountChat();
    await addFiles(wrapper, [file("retry.txt")]);
    FakeXMLHttpRequest.instances[0]?.fail();
    await flushPromises();
    const chip = wrapper.find("[data-attachment-key]");
    expect(chip.attributes("data-status")).toBe("error");
    expect(chip.find("[data-attachment-retry]").exists()).toBe(true);

    await chip.find("[data-attachment-retry]").trigger("click");
    await flushPromises();
    expect(FakeXMLHttpRequest.instances).toHaveLength(2);
    expect(FakeXMLHttpRequest.instances[1]?.sentBody).toBeInstanceOf(File);
    wrapper.unmount();
  });

  it("renders a quota warning and rehydrates draft attachments after reload", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      quotaPercent: 85,
      draftAttachments: [
        {
          id: "att_existing",
          name: "existing.png",
          mime: "image/png",
          size: 42,
          kind: "image",
          mode: "auto",
          state: "draft",
          downloadURL: "/api/apps/alpha/attachments/att_existing",
          inline: false,
        },
      ],
    });
    expect(wrapper.find("[data-chat-attachment-quota]").text()).toContain("85% full");
    const chip = wrapper.find('[data-attachment-id="att_existing"]');
    expect(chip.exists()).toBe(true);
    expect(chip.attributes("data-status")).toBe("ready");
    wrapper.unmount();
  });

  it("patches inline/file mode and sends ready attachments in the payload", async () => {
    const { wrapper, fetchState } = await mountChat();
    await addFiles(wrapper, [file("photo.png", "image/png")]);
    FakeXMLHttpRequest.instances[0]?.respond(
      201,
      uploadBody("att_photo", {
        name: "photo.png",
        mime: "image/png",
        kind: "image",
        mode: "auto",
      }),
    );
    await flushPromises();

    const select = wrapper.find("[data-attachment-mode]");
    expect(select.exists()).toBe(true);
    await select.setValue("file");
    await flushPromises();
    const patch = fetchState.requests.find((request) => request.method === "PATCH");
    expect(patch?.url).toContain("/attachments/att_photo");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ mode: "file" });

    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Look");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    const send = fetchState.requests.find(
      (request) => request.method === "POST" && request.url.includes("/messages"),
    );
    expect(JSON.parse(send?.body ?? "{}")).toEqual({
      text: "Look",
      attachments: [{ id: "att_photo", mode: "file" }],
    });
    expect(wrapper.find("[data-attachment-key]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("allows an attachment-only send and keeps the empty text payload", async () => {
    const { wrapper, fetchState } = await mountChat();
    await addFiles(wrapper, [file("only.txt")]);
    FakeXMLHttpRequest.instances[0]?.respond(201, uploadBody("att_only"));
    await flushPromises();
    expect(wrapper.find("[data-chat-send]").attributes("disabled")).toBeUndefined();

    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    const send = fetchState.requests.find(
      (request) => request.method === "POST" && request.url.includes("/messages"),
    );
    expect(JSON.parse(send?.body ?? "{}")).toEqual({
      text: "",
      attachments: [{ id: "att_only", mode: "file" }],
    });
    wrapper.unmount();
  });

  it("restores attachments when delivery is rejected", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      custom: ({ method, url }) =>
        method === "POST" && url.includes("/messages")
          ? {
              status: 409,
              body: { error: "application is pending deletion", code: "deletion_pending" },
            }
          : undefined,
    });
    await addFiles(wrapper, [file("restore.txt")]);
    FakeXMLHttpRequest.instances[0]?.respond(201, uploadBody("att_restore"));
    await flushPromises();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Rejected");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-attachment-id="att_restore"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
