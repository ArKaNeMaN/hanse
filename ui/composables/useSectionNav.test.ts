import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { useSectionNav } from "./useSectionNav.js";

const IDS = ["section-a", "section-b", "section-c"] as const;
const TOPS = { "section-a": 400, "section-b": 1000, "section-c": 1600 } as const;

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

let api: ReturnType<typeof useSectionNav> | undefined;

const Harness = defineComponent({
  setup() {
    api = useSectionNav(IDS);
    return () => h("div");
  },
});

function layout(): { main: HTMLElement; nav: HTMLElement } {
  document.body.replaceChildren();
  const main = document.createElement("main");
  main.id = "main";
  const nav = document.createElement("nav");
  nav.setAttribute("data-section-nav", "");
  main.append(nav);
  for (const id of IDS) {
    const section = document.createElement("section");
    section.id = id;
    main.append(section);
  }
  document.body.append(main);

  Object.defineProperty(main, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(main, "clientHeight", { configurable: true, value: 800 });
  Object.defineProperty(nav, "offsetHeight", { configurable: true, value: 40 });
  main.getBoundingClientRect = () => rect(0);
  main.scrollTop = 0;
  for (const id of IDS) {
    const section = document.getElementById(id);
    if (section !== null) {
      section.getBoundingClientRect = () => rect(TOPS[id] - main.scrollTop);
    }
  }
  return { main, nav };
}

afterEach(() => {
  api = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useSectionNav", () => {
  it("marks the first section at the top, then follows scrolling and bottom edge", async () => {
    const { main } = layout();
    const wrapper = mount(Harness);
    expect(api?.activeId.value).toBe("section-a");

    main.scrollTop = 1000;
    main.dispatchEvent(new Event("scroll"));
    expect(api?.activeId.value).toBe("section-b");

    main.scrollTop = 1200;
    main.dispatchEvent(new Event("scroll"));
    expect(api?.activeId.value).toBe("section-c");

    wrapper.unmount();
  });

  it("activates a section immediately and scrolls the main container", () => {
    const { main } = layout();
    const wrapper = mount(Harness);

    api?.activate("section-b");
    expect(api?.activeId.value).toBe("section-b");
    expect(main.scrollTop).toBe(1000 - 40 - 8);

    api?.activate("missing");
    expect(api?.activeId.value).toBe("section-b");

    wrapper.unmount();
  });

  it("removes its listeners on unmount and leaves one set after a remount", () => {
    const { main } = layout();
    const add = vi.spyOn(main, "addEventListener");
    const remove = vi.spyOn(main, "removeEventListener");

    const first = mount(Harness);
    expect(add.mock.calls.filter((call) => call[0] === "scroll")).toHaveLength(1);
    first.unmount();
    expect(remove.mock.calls.filter((call) => call[0] === "scroll")).toHaveLength(1);

    const second = mount(Harness);
    const added = add.mock.calls.filter((call) => call[0] === "scroll").length;
    const removed = remove.mock.calls.filter((call) => call[0] === "scroll").length;
    expect(added - removed).toBe(1);

    second.unmount();
    expect(add.mock.calls.filter((call) => call[0] === "scroll")).toHaveLength(2);
    expect(remove.mock.calls.filter((call) => call[0] === "scroll")).toHaveLength(2);
  });
});
