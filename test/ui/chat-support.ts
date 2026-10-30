import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { BootPayload } from "../../ui/boot.js";
import type { ChatResponse } from "../../ui/chat/types.js";
import ChatPage from "../../ui/pages/ChatPage.vue";

export const CHAT_PROPS: ChatResponse = {
  app: {
    id: "p:alpha",
    projectId: "p",
    projectName: "Project",
    appKey: "alpha",
    href: "/projects/p/apps/alpha",
    folder: "/workspace/p/apps/alpha",
    master: false,
  },
  links: {
    app: "/projects/p/apps/alpha",
    ide: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Falpha",
    settings: "/projects/p/apps/alpha/settings",
    skills: "/projects/p/apps/alpha/skills",
    terminal: "/terminal?app=alpha&project=p",
    handoffs: "/handoffs?q=alpha",
  },
  runtime: {
    state: "running",
    runtimeUrl: "/api/apps/alpha/runtime?project=p",
  },
  appOptions: [],
  pendingRestart: false,
  handoffs: [],
  previews: [],
  deleting: { app: false, project: false, pending: false },
  breadcrumb: [
    { label: "Projects", href: "/projects" },
    { label: "Project", href: "/projects/p" },
    { label: "alpha", href: "/projects/p/apps/alpha" },
    { label: "Chat" },
  ],
  title: "alpha chat",
  topbar: {
    ideHref: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Falpha",
    needsInputCount: 0,
    policyVisible: false,
    contextToggle: true,
  },
  chrome: {
    sidebarNav: "",
    breadcrumb: "",
    title: "alpha chat",
    active: "none",
    pendingCount: 0,
    sshPendingCount: 0,
  },
};

export interface ChatFixture {
  readonly sessions?: readonly { id: string; title?: string; parentID?: string }[];
  readonly sessionsStatus?: number;
  readonly sessionsCode?: string;
  readonly messages?: readonly unknown[];
  readonly olderMessages?: readonly unknown[];
  readonly nextCursor?: string | null;
  readonly messagePages?: readonly {
    readonly before: string | null;
    readonly messages: readonly unknown[];
    readonly nextCursor: string | null;
  }[];
  readonly olderStatus?: number;
  readonly olderCode?: string;
  readonly deletingPending?: boolean;
  readonly chatStatus?: number;
  readonly createSessionID?: string;
  readonly createSessionStatus?: number;
  readonly deleteSessionStatus?: number;
}

export function boot(overrides: Partial<BootPayload> = {}): BootPayload {
  return {
    route: { id: "chat", params: {} },
    props: CHAT_PROPS,
    chrome: CHAT_PROPS.chrome,
    spaRoutes: ["chat"],
    topbar: CHAT_PROPS.topbar,
    ...overrides,
  };
}

export function props(fixture: ChatFixture = {}): ChatResponse {
  return {
    ...CHAT_PROPS,
    deleting: {
      app: fixture.deletingPending === true,
      project: false,
      pending: fixture.deletingPending === true,
    },
  };
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

export const FIXTURE_MESSAGES = [
  {
    info: {
      id: "msg_user",
      sessionID: "s1",
      role: "user",
      time: { created: 1_760_000_001_000 },
    },
    parts: [
      {
        id: "prt_user",
        sessionID: "s1",
        messageID: "msg_user",
        type: "text",
        text: "Hello from the fixture.",
      },
    ],
  },
  {
    info: {
      id: "msg_assistant",
      sessionID: "s1",
      role: "assistant",
      parentID: "msg_user",
      finish: "stop",
      time: { created: 1_760_000_002_000, completed: 1_760_000_003_000 },
    },
    parts: [
      {
        id: "prt_assistant",
        sessionID: "s1",
        messageID: "msg_assistant",
        type: "text",
        text: "Synthetic assistant reply.",
      },
    ],
  },
];

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

export interface InstalledFetch {
  readonly mock: ReturnType<typeof vi.fn>;
  readonly requests: Array<{ method: string; url: string }>;
}

export function installFetch(fixture: ChatFixture = {}): InstalledFetch {
  FakeEventSource.instances = [];
  const requests: Array<{ method: string; url: string }> = [];
  let sessions = (fixture.sessions ?? [{ id: "s1", title: "Session one" }]).map((session) => ({
    ...session,
  }));
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (url.startsWith("/api/ui/chat")) {
      const status = fixture.chatStatus ?? 200;
      return status === 200 ? json(200, props(fixture)) : json(status, { error: "not found" });
    }
    if (url.startsWith("/api/apps/alpha/sessions?") || url === "/api/apps/alpha/sessions") {
      if (method === "POST") {
        const status = fixture.createSessionStatus ?? 200;
        if (status !== 200) {
          return json(status, { error: "agent is stopped", code: "agent_stopped" });
        }
        const created = {
          id: fixture.createSessionID ?? "s_new",
          title: "New session",
          time: { created: 1_760_000_010_000, updated: 1_760_000_010_000 },
        };
        sessions = [...sessions, created];
        return json(200, created);
      }
      const status = fixture.sessionsStatus ?? 200;
      if (status !== 200) {
        return json(status, {
          error: "agent is stopped",
          code: fixture.sessionsCode ?? "agent_stopped",
        });
      }
      return json(200, { sessions });
    }
    const deleteMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)(?:\?.*)?$/.exec(url);
    if (deleteMatch !== null && method === "DELETE") {
      const status = fixture.deleteSessionStatus ?? 200;
      if (status !== 200) {
        return json(status, { error: "session could not be deleted", code: "delete_failed" });
      }
      const target = decodeURIComponent(deleteMatch[1] ?? "");
      const removed = new Set([target]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const session of sessions) {
          if (
            session.parentID !== undefined &&
            removed.has(session.parentID) &&
            !removed.has(session.id)
          ) {
            removed.add(session.id);
            changed = true;
          }
        }
      }
      sessions = sessions.filter((session) => !removed.has(session.id));
      return json(200, { deleted: true });
    }
    if (/\/sessions\/[^/]+\/messages/.test(url)) {
      const before = new URL(url, "http://localhost").searchParams.get("before");
      if (before !== null) {
        const status = fixture.olderStatus ?? 200;
        if (status !== 200) {
          return json(status, {
            error: "invalid message cursor",
            code: fixture.olderCode ?? "invalid_cursor",
          });
        }
        const page = fixture.messagePages?.find((entry) => entry.before === before);
        if (page !== undefined) {
          return json(200, { messages: page.messages, nextCursor: page.nextCursor });
        }
        return json(200, { messages: fixture.olderMessages ?? [], nextCursor: null });
      }
      const tail = fixture.messagePages?.find((entry) => entry.before === null);
      if (tail !== undefined) {
        return json(200, { messages: tail.messages, nextCursor: tail.nextCursor });
      }
      return json(200, {
        messages: fixture.messages ?? FIXTURE_MESSAGES,
        nextCursor: fixture.nextCursor ?? null,
      });
    }
    if (/\/sessions\/[^/]+\/notices/.test(url)) {
      return json(200, { notices: [], nextCursor: null });
    }
    if (/\/sessions\/[^/]+\/context/.test(url)) {
      return json(200, {
        sessionID: "s1",
        state: "ready",
        used: 10,
        limit: 100,
        percent: 10,
        model: null,
        status: "idle",
        updatedAt: "2026-10-30T00:00:00.000Z",
        lastCompactedAt: null,
        lastError: null,
        autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
      });
    }
    if (/\/sessions\/[^/]+\/todo/.test(url)) {
      return json(200, []);
    }
    if (/\/runtime\?/.test(url)) {
      return json(200, { state: "running" });
    }
    if (/\/commands\?/.test(url)) {
      return json(200, { commands: [] });
    }
    return json(404, { error: `no fixture for ${url}` });
  });
  vi.stubGlobal("fetch", mock);
  (window as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  return { mock, requests };
}

export async function mountChat(
  path = "/chat?app=alpha&project=p&session=s1",
  fixture: ChatFixture = {},
) {
  document.body.innerHTML =
    '<meta name="viewport" content="width=device-width, initial-scale=1" /><main id="main" class="page" tabindex="-1"></main>';
  const fetchState = installFetch(fixture);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/chat",
        name: "chat",
        component: ChatPage,
        meta: { workspace: "chat", legacyRetired: false },
      },
      { path: "/projects", name: "projects", component: { template: "<div />" } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pinia = createPinia();
  const wrapper = mount(ChatPage, {
    props: { boot: boot() },
    attachTo: document.getElementById("main") ?? document.body,
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] },
  });
  await flushPromises();
  return { wrapper, router, fetchState, queryClient, pinia };
}
