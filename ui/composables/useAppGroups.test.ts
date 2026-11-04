import { mount, type VueWrapper } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, type Ref, ref } from "vue";
import { useAppGroups } from "./useAppGroups.js";

let api: ReturnType<typeof useAppGroups> | undefined;
let projectId: Ref<string>;
let appKey: Ref<string>;

function mountGroups(): VueWrapper {
  projectId = ref("p");
  appKey = ref("alpha");
  const Harness = defineComponent({
    setup() {
      api = useAppGroups(projectId, appKey);
      return () => h("div");
    },
  });
  return mount(Harness);
}

const KEY = "hanse:ui:app-groups:p:alpha";

describe("useAppGroups", () => {
  beforeEach(() => {
    window.localStorage.clear();
    api = undefined;
  });

  it("starts with every group closed when storage is empty", () => {
    mountGroups();

    expect(api?.storageKey.value).toBe(KEY);
    expect(api?.isOpen("git")).toBe(false);
    expect(api?.isOpen("image")).toBe(false);
  });

  it("persists toggled groups and reloads them", () => {
    const first = mountGroups();
    api?.toggle("git");
    api?.setOpen("ssh", true);

    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["git", "ssh"]);
    first.unmount();

    mountGroups();
    expect(api?.isOpen("git")).toBe(true);
    expect(api?.isOpen("ssh")).toBe(true);
    expect(api?.isOpen("image")).toBe(false);

    api?.setOpen("git", false);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["ssh"]);
  });

  it("falls back to all closed on invalid JSON and non-array values", () => {
    window.localStorage.setItem(KEY, "{not json");
    mountGroups();
    expect(api?.isOpen("git")).toBe(false);

    window.localStorage.setItem(KEY, JSON.stringify({ git: true }));
    const second = mountGroups();
    expect(api?.isOpen("git")).toBe(false);
    second.unmount();
  });

  it("keeps separate keys for each application", async () => {
    mountGroups();
    api?.setOpen("git", true);

    appKey.value = "beta";
    await nextTick();
    expect(api?.storageKey.value).toBe("hanse:ui:app-groups:p:beta");
    expect(api?.isOpen("git")).toBe(false);

    api?.setOpen("image", true);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["git"]);
    expect(JSON.parse(window.localStorage.getItem("hanse:ui:app-groups:p:beta") ?? "[]")).toEqual([
      "image",
    ]);

    appKey.value = "alpha";
    await nextTick();
    expect(api?.isOpen("git")).toBe(true);
    expect(api?.isOpen("image")).toBe(false);
  });

  it("reloads state when the storage key changes", async () => {
    mountGroups();
    api?.setOpen("git", true);

    projectId.value = "other";
    await nextTick();
    expect(api?.storageKey.value).toBe("hanse:ui:app-groups:other:alpha");
    expect(api?.isOpen("git")).toBe(false);

    api?.setOpen("danger", true);
    projectId.value = "p";
    await nextTick();
    expect(api?.isOpen("git")).toBe(true);
    expect(api?.isOpen("danger")).toBe(false);
  });
});
