import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeXMLHttpRequest, installXhr, mountChat } from "./chat-support.js";

function file(name: string): File {
  return new File(["fixture"], name, { type: "text/plain" });
}

function dragEvent(type: string, files: readonly File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
    configurable: true,
  });
  return event;
}

function pasteEvent(files: readonly File[]): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((entry) => ({ kind: "file", getAsFile: () => entry })),
    },
    configurable: true,
  });
  return event;
}

beforeEach(() => {
  installXhr();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("chat attachment drop and paste", () => {
  it("adds files dropped on the composer", async () => {
    const { wrapper } = await mountChat();
    wrapper
      .find("form[data-chat-composer]")
      .element.dispatchEvent(dragEvent("drop", [file("dropped.txt")]));
    await flushPromises();
    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    expect(wrapper.find("[data-attachment-key]").text()).toContain("dropped.txt");
    wrapper.unmount();
  });

  it("adds files dropped on the attachment strip only once", async () => {
    const { wrapper } = await mountChat();
    wrapper
      .find("[data-chat-attachments]")
      .element.dispatchEvent(dragEvent("drop", [file("once.txt")]));
    await flushPromises();
    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    expect(wrapper.findAll("[data-attachment-key]")).toHaveLength(1);
    wrapper.unmount();
  });

  it("adds clipboard image/file items pasted into the textarea", async () => {
    const { wrapper } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]").element;
    input.dispatchEvent(pasteEvent([file("pasted.png")]));
    await flushPromises();
    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    expect(wrapper.find("[data-attachment-key]").text()).toContain("pasted.png");
    wrapper.unmount();
  });

  it("aborts pending uploads on unmount and never creates object URLs", async () => {
    const url = URL as unknown as {
      createObjectURL?: (value: Blob) => string;
      revokeObjectURL?: (value: string) => void;
    };
    const originalCreate = url.createObjectURL;
    const originalRevoke = url.revokeObjectURL;
    const create = vi.fn();
    const revoke = vi.fn();
    url.createObjectURL = create;
    url.revokeObjectURL = revoke;
    const { wrapper } = await mountChat();
    wrapper
      .find("form[data-chat-composer]")
      .element.dispatchEvent(dragEvent("drop", [file("cleanup.txt"), file("cleanup2.txt")]));
    await flushPromises();
    const xhrs = [...FakeXMLHttpRequest.instances];
    expect(xhrs).toHaveLength(2);

    wrapper.unmount();
    await flushPromises();
    expect(xhrs.every((xhr) => xhr.aborted)).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    url.createObjectURL = originalCreate;
    url.revokeObjectURL = originalRevoke;
  });
});
