import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { createMemoryHistory, createRouter, useRoute, useRouter } from "vue-router";
import { normalizeChatQuery, useChatRouteState } from "../../ui/chat/useChatRouteState.js";

const Harness = defineComponent({
  setup(_props, { expose }) {
    const router = useRouter();
    const route = useRoute();
    const state = useChatRouteState(router, route);
    expose({ state });
    return () => h("div");
  },
});

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/chat", name: "chat", component: { template: "<div />" } },
      { path: "/projects", name: "projects", component: { template: "<div />" } },
    ],
  });
}

async function setup(path: string) {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(Harness, { global: { plugins: [router] } });
  const state = (wrapper.vm as unknown as { state: ReturnType<typeof useChatRouteState> }).state;
  return { router, wrapper, state };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("normalizeChatQuery", () => {
  it("keeps strings only, trims, and drops arrays and blank values", () => {
    expect(
      normalizeChatQuery({
        app: " alpha ",
        project: ["p", "other"],
        session: "  ",
        extra: "ignored",
      }),
    ).toEqual({ app: "alpha", project: "", session: null });
    expect(normalizeChatQuery({ app: ["alpha"], session: "s1" })).toEqual({
      app: "",
      project: "",
      session: "s1",
    });
  });
});

describe("useChatRouteState", () => {
  it("reads the deep link query as the sole source", async () => {
    const { state, wrapper } = await setup("/chat?app=alpha&project=p&session=s1");
    expect(state.app.value).toBe("alpha");
    expect(state.project.value).toBe("p");
    expect(state.session.value).toBe("s1");
    expect(state.workspaceKey.value).toBe("alpha:p");
    wrapper.unmount();
  });

  it("selects through router.replace exactly once and never writes history directly", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=s1");
    const replace = vi.spyOn(router, "replace");
    const historyReplace = vi.spyOn(window.history, "replaceState");
    const historyPush = vi.spyOn(window.history, "pushState");

    state.selectSession("s2");
    await flushPromises();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toMatchObject({
      query: { app: "alpha", project: "p", session: "s2" },
    });
    expect(historyReplace).not.toHaveBeenCalled();
    expect(historyPush).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.session).toBe("s2");
    expect(state.session.value).toBe("s2");
    wrapper.unmount();
  });

  it("last-wins for rapid session selections", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=s1");
    state.selectSession("s2");
    state.selectSession("s3");
    state.selectSession("s4");
    await flushPromises();
    expect(router.currentRoute.value.query.session).toBe("s4");
    expect(state.session.value).toBe("s4");
    expect(state.pendingSession.value).toBeNull();
    wrapper.unmount();
  });

  it("restores back/forward query changes through the one watcher", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=s1");
    state.selectSession("s2");
    await flushPromises();
    state.switchApp("beta", "p");
    await flushPromises();
    expect(state.app.value).toBe("beta");
    router.back();
    await vi.waitFor(() => expect(state.app.value).toBe("alpha"));
    expect(state.session.value).toBe("s2");
    router.forward();
    await vi.waitFor(() => expect(state.app.value).toBe("beta"));
    expect(state.session.value).toBeNull();
    wrapper.unmount();
  });

  it("canonicalizes an absent session to the first root", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=missing");
    const replace = vi.spyOn(router, "replace");
    const target = state.canonicalize([
      { id: "root", title: "Root" },
      { id: "child", title: "Child", parentID: "root" },
    ]);
    await flushPromises();
    expect(target).toBe("root");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.query.session).toBe("root");
    wrapper.unmount();
  });

  it("preserves the requested session when the list is empty or the agent is stopped", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=keep");
    const replace = vi.spyOn(router, "replace");
    expect(state.canonicalize([])).toBeNull();
    expect(state.canonicalize([{ id: "root" }], { stopped: true })).toBeNull();
    expect(state.canonicalize([{ id: "root" }], { unavailable: true })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(state.session.value).toBe("keep");
    wrapper.unmount();
  });

  it("keeps an existing requested session without writing the URL", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=child");
    const replace = vi.spyOn(router, "replace");
    expect(state.canonicalize([{ id: "root" }, { id: "child", parentID: "root" }])).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("switches app through router.push and drops the old session", async () => {
    const { router, state, wrapper } = await setup("/chat?app=alpha&project=p&session=s1");
    const push = vi.spyOn(router, "push");
    state.switchApp("beta", "p");
    await flushPromises();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      name: "chat",
      query: { app: "beta", project: "p" },
    });
    expect(router.currentRoute.value.query).toEqual({ app: "beta", project: "p" });
    expect(state.session.value).toBeNull();
    wrapper.unmount();
  });
});
