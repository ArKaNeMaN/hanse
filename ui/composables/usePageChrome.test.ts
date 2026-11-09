import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { routeKey } from "../../src/shared/routes.js";
import type { BootPayload, ChromeData } from "../boot.js";
import { useChromeStore } from "../stores/chrome.js";
import { usePageChrome } from "./usePageChrome.js";

const CHROME: ChromeData = {
  title: "Projects",
  active: "projects",
  breadcrumb: [{ label: "Projects" }],
  projects: [],
  masterHref: "/chat?app=master&project=hanse-master",
  pendingCount: 0,
  sshPendingCount: 0,
};

function boot(): BootPayload {
  return {
    route: { id: "projects", params: {} },
    props: {},
    chrome: CHROME,
    routeKey: routeKey("projects", {}, {}),
    spaRoutes: ["projects"],
    topbar: { ideHref: "/ide/" },
  };
}

function query<T extends { chrome?: ChromeData }>(initial: T | undefined) {
  return {
    data: ref<T | undefined>(initial),
    isFetching: ref(false),
    refetch: vi.fn(async () => undefined),
  };
}

function probe<T extends { chrome?: ChromeData }>(
  pageQuery: ReturnType<typeof query<T>>,
  payload: BootPayload = boot(),
) {
  return defineComponent({
    setup() {
      usePageChrome(pageQuery, payload);
      return () => h("div");
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="route-announcer"></div>';
  setActivePinia(createPinia());
  useChromeStore().initialize(boot());
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("usePageChrome precedence", () => {
  it("applies cached chrome without an extra request", () => {
    const pageQuery = query({ chrome: { ...CHROME, title: "Cached" } });
    mount(probe(pageQuery));
    expect(useChromeStore().current?.title).toBe("Cached");
    expect(pageQuery.refetch).not.toHaveBeenCalled();
  });

  it("re-applies the boot chrome when the route matches the boot route", () => {
    const pageQuery = query<{ chrome?: ChromeData }>({});
    mount(probe(pageQuery));
    expect(useChromeStore().current).toEqual(CHROME);
    expect(pageQuery.refetch).not.toHaveBeenCalled();
  });

  it("forces one refetch for a different route with data but no chrome", async () => {
    useChromeStore().setRouteKey(routeKey("projects", {}, { q: "next" }));
    const pageQuery = query<{ chrome?: ChromeData }>({});
    mount(probe(pageQuery));
    await Promise.resolve();
    expect(pageQuery.refetch).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expect(pageQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it("leaves an undefined query alone", () => {
    useChromeStore().setRouteKey(routeKey("projects", {}, { q: "next" }));
    const pageQuery = query<{ chrome?: ChromeData }>(undefined);
    mount(probe(pageQuery));
    expect(pageQuery.refetch).not.toHaveBeenCalled();
  });

  it("does not force a refetch for a disabled query", () => {
    useChromeStore().setRouteKey(routeKey("projects", {}, { q: "next" }));
    const pageQuery = {
      ...query<{ chrome?: ChromeData }>({}),
      enabled: ref(false),
    };
    mount(probe(pageQuery));
    expect(pageQuery.refetch).not.toHaveBeenCalled();
  });
});

describe("usePageChrome primary refresh registration", () => {
  it("keeps a newer page's registration when an older page unmounts", () => {
    const first = mount(probe(query<{ chrome?: ChromeData }>(undefined)));
    const second = mount(probe(query<{ chrome?: ChromeData }>(undefined)));
    const store = useChromeStore();
    const secondToken = store.primaryRefresh?.token;

    first.unmount();
    expect(store.primaryRefresh?.token).toBe(secondToken);

    second.unmount();
    expect(store.primaryRefresh).toBeUndefined();
  });

  it("reports the visibility refreshing flag", () => {
    const pageQuery = query<{ chrome?: ChromeData }>(undefined);
    const wrapper = mount(
      defineComponent({
        setup() {
          const { refreshing } = usePageChrome(pageQuery, boot());
          return () => h("span", refreshing.value ? "refreshing" : "idle");
        },
      }),
    );
    expect(wrapper.text()).toBe("idle");
    useChromeStore().visibilityRefreshing = true;
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.text()).toBe("refreshing");
      wrapper.unmount();
    });
  });

  it("treats a disabled query as already fetching for visibility refresh", () => {
    const pageQuery = {
      ...query<{ chrome?: ChromeData }>(undefined),
      enabled: ref(false),
    };
    mount(probe(pageQuery));
    expect(useChromeStore().primaryRefresh?.isFetching()).toBe(true);
  });
});
