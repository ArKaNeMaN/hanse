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
  readonly draftText?: string;
  readonly drafts?: Readonly<Record<string, string>>;
  readonly pendingSends?: readonly unknown[];
  readonly messagesBySession?: Readonly<Record<string, readonly unknown[]>>;
  readonly sentMessageID?: string;
  readonly sendStatus?: number;
  readonly sendBody?: unknown;
  readonly blockingStatus?: number;
  readonly blockingBody?: unknown;
  readonly abortStatus?: number;
  readonly abortBody?: unknown;
  readonly deleteIfEmptyBody?: unknown;
  readonly retryBody?: unknown;
  readonly dismissBody?: unknown;
  readonly questions?: readonly unknown[];
  readonly permissions?: readonly unknown[];
  readonly savedPermissions?: readonly unknown[];
  readonly promptsWarnings?: readonly string[];
  readonly promptsStatus?: number;
  readonly savedPermissionsStatus?: number;
  readonly todos?:
    | readonly unknown[]
    | { readonly todos: readonly unknown[]; readonly truncated?: boolean };
  readonly previews?: readonly unknown[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly sshApprovals?: readonly unknown[];
  readonly draftAttachments?: readonly unknown[];
  readonly quotaPercent?: number;
  readonly attachmentDeleteStatus?: number;
  readonly attachmentPatchStatus?: number;
  readonly commands?: {
    readonly commands?: readonly unknown[];
    readonly sources?: Record<string, unknown>;
    readonly warnings?: readonly unknown[];
  };
  readonly commandsStatus?: number;
  readonly commandPostStatus?: number;
  readonly commandPostBody?: unknown;
  readonly appOptions?: ChatResponse["appOptions"];
  readonly questionReplyStatus?: number;
  readonly permissionReplyStatus?: number;
  readonly compactStatus?: number;
  readonly restartStatus?: number;
  readonly previewCloseStatus?: number;
  readonly custom?: (request: {
    readonly method: string;
    readonly url: string;
    readonly body: string | undefined;
  }) => { readonly status: number; readonly body: unknown } | undefined;
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
    appOptions: fixture.appOptions ?? CHAT_PROPS.appOptions,
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
  readonly requests: Array<{
    method: string;
    url: string;
    body?: string;
    keepalive?: boolean;
  }>;
}

export function installFetch(fixture: ChatFixture = {}): InstalledFetch {
  FakeEventSource.instances = [];
  const requests: Array<{
    method: string;
    url: string;
    body?: string;
    keepalive?: boolean;
  }> = [];
  let sessions = (fixture.sessions ?? [{ id: "s1", title: "Session one" }]).map((session) => ({
    ...session,
  }));
  const drafts = new Map<string, string>(
    Object.entries(fixture.drafts ?? { s1: fixture.draftText ?? "" }),
  );
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method,
      url,
      ...(bodyText === undefined ? {} : { body: bodyText }),
      ...(init?.keepalive === true ? { keepalive: true } : {}),
    });
    const custom = fixture.custom?.({ method, url, body: bodyText });
    if (custom !== undefined) {
      return json(custom.status, custom.body);
    }
    if (url.startsWith("/api/ui/chat")) {
      const status = fixture.chatStatus ?? 200;
      return status === 200 ? json(200, props(fixture)) : json(status, { error: "not found" });
    }
    if (url.startsWith("/api/apps/alpha/prompts")) {
      const status = fixture.promptsStatus ?? 200;
      if (status !== 200) {
        return json(status, { error: "prompts unavailable", code: "prompts_unavailable" });
      }
      return json(200, {
        questions: fixture.questions ?? [],
        permissions: fixture.permissions ?? [],
        ...(fixture.promptsWarnings === undefined ? {} : { warnings: fixture.promptsWarnings }),
      });
    }
    if (url.startsWith("/api/apps/alpha/permissions/saved")) {
      const revoke = /\/permissions\/saved\/([^/?]+)/.exec(url);
      if (revoke !== null && method === "DELETE") {
        return json(200, { ok: true });
      }
      const status = fixture.savedPermissionsStatus ?? 200;
      if (status !== 200) {
        return json(status, { error: "saved permissions unavailable" });
      }
      return json(200, { permissions: fixture.savedPermissions ?? [] });
    }
    if (/\/api\/apps\/alpha\/questions\/[^/]+\/(reply|reject)/.test(url)) {
      const status = fixture.questionReplyStatus ?? 200;
      return json(
        status,
        status === 200 ? { ok: true } : { error: "prompt expired", code: "prompt_expired" },
      );
    }
    if (/\/api\/apps\/alpha\/permissions\/[^/]+\/reply/.test(url)) {
      const status = fixture.permissionReplyStatus ?? 200;
      return json(
        status,
        status === 200 ? { ok: true } : { error: "prompt expired", code: "prompt_expired" },
      );
    }
    if (/\/api\/apps\/alpha\/ssh\/approvals/.test(url)) {
      if (method === "POST") {
        return json(200, { approval: { id: "approval" } });
      }
      return json(200, { approvals: fixture.sshApprovals ?? [] });
    }
    if (/\/api\/apps\/alpha\/previews/.test(url)) {
      const close = /\/previews\/([^/?]+)\/close/.test(url);
      if (close && method === "POST") {
        const status = fixture.previewCloseStatus ?? 200;
        return json(
          status,
          status === 200 ? { ok: true, closed: true } : { error: "preview unavailable" },
        );
      }
      return json(200, { previews: fixture.previews ?? [] });
    }
    if (/\/api\/apps\/alpha\/sessions\/[^/]+\/compact/.test(url) && method === "POST") {
      const status = fixture.compactStatus ?? 202;
      return json(
        status,
        status === 202
          ? { accepted: true }
          : { error: "compaction unavailable", code: "compaction_unavailable" },
      );
    }
    if (/\/api\/apps\/alpha\/restart/.test(url) && method === "POST") {
      const status = fixture.restartStatus ?? 200;
      return json(status, status === 200 ? { restarted: true } : { error: "restart failed" });
    }
    if (url.startsWith("/api/apps/alpha/commands")) {
      const status = fixture.commandsStatus ?? 200;
      if (status !== 200) {
        return json(status, { error: "commands unavailable", code: "commands_unavailable" });
      }
      return json(200, {
        commands: fixture.commands?.commands ?? [],
        sources: fixture.commands?.sources ?? { hanse: "ok", opencode: "ok" },
        warnings: fixture.commands?.warnings ?? [],
      });
    }
    const commandPostMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/commands(?:\?.*)?$/.exec(
      url,
    );
    if (commandPostMatch !== null && method === "POST") {
      const status = fixture.commandPostStatus ?? 202;
      return json(
        status,
        fixture.commandPostBody ??
          (status === 202
            ? {
                accepted: true,
                messageID: "msg_command_1",
                sessionID: decodeURIComponent(commandPostMatch[1] ?? ""),
              }
            : { error: "command failed", code: "command_failed", outcome: "unknown" }),
      );
    }
    const attachmentDelete = /^\/api\/apps\/alpha\/attachments\/([^/?]+)(?:\?.*)?$/.exec(url);
    if (attachmentDelete !== null) {
      const status =
        method === "PATCH"
          ? (fixture.attachmentPatchStatus ?? 200)
          : (fixture.attachmentDeleteStatus ?? 200);
      if (status !== 200) {
        return json(status, { error: "attachment unavailable", code: "attachment_unavailable" });
      }
      if (method === "PATCH") {
        const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        return json(200, {
          attachment: {
            id: attachmentDelete[1],
            name: "fixture.bin",
            mime: "application/octet-stream",
            size: 10,
            kind: "file",
            mode: typeof parsed.mode === "string" ? parsed.mode : "auto",
            state: "draft",
            downloadURL: `/api/apps/alpha/attachments/${attachmentDelete[1]}`,
            inline: false,
          },
        });
      }
      return json(200, { deleted: true });
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
    const sessionOf = (value: string): string => decodeURIComponent(value);
    const draftMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/draft(?:\?.*)?$/.exec(url);
    if (draftMatch !== null) {
      const sessionId = sessionOf(draftMatch[1] ?? "");
      if (method === "PUT") {
        const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const text = typeof parsed.text === "string" ? parsed.text : "";
        if (text.length === 0) {
          drafts.delete(sessionId);
        } else {
          drafts.set(sessionId, text);
        }
        return json(200, { text, updatedAt: "2026-10-30T00:00:00.000Z" });
      }
      return json(200, {
        text: drafts.get(sessionId) ?? "",
        attachments: fixture.draftAttachments ?? [],
        pendingSends: fixture.pendingSends ?? [],
        quota: { percent: fixture.quotaPercent ?? 0 },
        updatedAt: null,
      });
    }
    const sendMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/messages(?:\?|$)/.exec(url);
    if (sendMatch !== null && method === "POST") {
      const parsedUrl = new URL(url, "http://localhost");
      const async = parsedUrl.searchParams.get("async") === "1";
      const status = async ? (fixture.sendStatus ?? 200) : (fixture.blockingStatus ?? 200);
      const body = async
        ? (fixture.sendBody ?? {
            accepted: true,
            messageID: fixture.sentMessageID ?? "msg_sent_1",
            sessionID: sessionOf(sendMatch[1] ?? ""),
          })
        : (fixture.blockingBody ?? {
            messageID: "msg_blocking_assistant",
            userMessageID: fixture.sentMessageID ?? "msg_sent_1",
            info: null,
            truncated: true,
          });
      return json(status, body);
    }
    const abortMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/abort(?:\?.*)?$/.exec(url);
    if (abortMatch !== null && method === "POST") {
      return json(fixture.abortStatus ?? 200, fixture.abortBody ?? { aborted: true });
    }
    const emptyMatch = /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/delete-if-empty(?:\?.*)?$/.exec(
      url,
    );
    if (emptyMatch !== null && method === "POST") {
      return json(200, fixture.deleteIfEmptyBody ?? { deleted: false });
    }
    const retryMatch =
      /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/pending\/([^/?]+)\/retry(?:\?.*)?$/.exec(url);
    if (retryMatch !== null && method === "POST") {
      return json(200, fixture.retryBody ?? { retried: true, messageID: "msg_retried" });
    }
    const pendingMatch =
      /^\/api\/apps\/alpha\/sessions\/([^/?]+)\/pending\/([^/?]+)(?:\?.*)?$/.exec(url);
    if (pendingMatch !== null && method === "DELETE") {
      return json(200, fixture.dismissBody ?? { dismissed: true });
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
      const sessionMatch = /\/sessions\/([^/?]+)\/messages/.exec(url);
      const sessionID = sessionMatch === null ? "s1" : decodeURIComponent(sessionMatch[1] ?? "");
      return json(200, {
        messages: fixture.messagesBySession?.[sessionID] ?? fixture.messages ?? FIXTURE_MESSAGES,
        nextCursor: fixture.nextCursor ?? null,
      });
    }
    if (/\/sessions\/[^/]+\/notices/.test(url)) {
      return json(200, { notices: [], nextCursor: null });
    }
    if (/\/sessions\/[^/]+\/context/.test(url)) {
      return json(
        200,
        fixture.contextSnapshot ?? {
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
        },
      );
    }
    if (/\/sessions\/[^/]+\/todo/.test(url)) {
      return json(200, fixture.todos ?? []);
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

export class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  method = "";
  url = "";
  status = 0;
  responseText = "";
  aborted = false;
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
  readonly headers: Record<string, string> = {};
  readonly upload: {
    listeners: Map<string, EventListener[]>;
    addEventListener: (type: string, listener: EventListener) => void;
  };
  private readonly listeners = new Map<string, EventListener[]>();

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
    const uploadListeners = new Map<string, EventListener[]>();
    this.upload = {
      listeners: uploadListeners,
      addEventListener: (type, listener) => {
        const list = uploadListeners.get(type) ?? [];
        list.push(listener);
        uploadListeners.set(type, list);
      },
    };
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    this.sentBody = body ?? null;
  }

  abort(): void {
    this.aborted = true;
    this.emit("abort", new Event("abort"));
  }

  progress(loaded: number, total: number): void {
    const event = Object.assign(new Event("progress"), { lengthComputable: true, loaded, total });
    for (const listener of this.upload.listeners.get("progress") ?? []) listener(event);
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.emit("load", new Event("load"));
  }

  fail(): void {
    this.emit("error", new Event("error"));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function installXhr(): void {
  FakeXMLHttpRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest as unknown as typeof XMLHttpRequest);
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
