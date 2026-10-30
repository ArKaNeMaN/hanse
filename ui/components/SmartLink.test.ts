import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { installSpaRoutes } from "../spa-routes.js";
import SmartLink from "./SmartLink.vue";

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
    ],
  });
}

async function mountSpaLink(to: string, router: Router, attrs: Record<string, string> = {}) {
  await router.push("/");
  await router.isReady();
  return mount(SmartLink, {
    props: { to },
    attrs,
    slots: { default: "Projects" },
    global: { plugins: [router] },
  });
}

describe("SmartLink", () => {
  beforeEach(() => {
    installSpaRoutes(["overview", "projects"]);
  });

  it("renders a plain anchor for a legacy path", () => {
    const wrapper = mount(SmartLink, {
      props: { to: "/login" },
      slots: { default: "Sign in" },
    });

    expect(wrapper.element.tagName).toBe("A");
    expect(wrapper.attributes("href")).toBe("/login");
  });

  it("renders a router link and navigates for an SPA path with a query and hash", async () => {
    const router = createTestRouter();
    const wrapper = await mountSpaLink("/projects?q=one#top", router);

    expect(wrapper.element.tagName).toBe("A");
    expect(wrapper.attributes("href")).toBe("/projects?q=one#top");

    const anchor = wrapper.element as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const notCanceled = anchor.dispatchEvent(event);
    await flushPromises();

    expect(notCanceled).toBe(false);
    expect(router.currentRoute.value.fullPath).toBe("/projects?q=one#top");
    wrapper.unmount();
  });

  it("does not intercept modified clicks", async () => {
    const router = createTestRouter();
    const wrapper = await mountSpaLink("/projects", router);

    const anchor = wrapper.element as HTMLAnchorElement;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const notCanceled = anchor.dispatchEvent(event);
    await flushPromises();

    expect(notCanceled).toBe(true);
    expect(router.currentRoute.value.path).toBe("/");
    wrapper.unmount();
  });

  it("does not intercept target or download links", async () => {
    const router = createTestRouter();
    const wrapper = await mountSpaLink("/projects", router, {
      target: "_blank",
      download: "",
    });

    const anchor = wrapper.element as HTMLAnchorElement;
    // jsdom has no browsing context to honour `target=_blank`/`download`; keep the default action
    // hash-only so the test does not print its "not implemented" navigation warning.
    anchor.setAttribute("href", "#");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/");
    wrapper.unmount();
  });

  it("keeps an explicit aria-current from the caller", async () => {
    const router = createTestRouter();
    const wrapper = await mountSpaLink("/projects?filter=waiting", router, {
      "aria-current": "page",
    });

    expect(wrapper.attributes("aria-current")).toBe("page");
    wrapper.unmount();
  });

  it("renders a plain anchor for hash-only links", () => {
    const wrapper = mount(SmartLink, {
      props: { to: "#section" },
      slots: { default: "Section" },
    });

    expect(wrapper.element.tagName).toBe("A");
    expect(wrapper.attributes("href")).toBe("#section");
  });
});
