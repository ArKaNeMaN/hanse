import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import type {
  SettingsGitCredentialProps,
  SettingsLabelsProps,
  SettingsProps,
  SettingsRowProps,
  SettingsScope,
  SettingsScopeProps,
} from "../settings-types.js";
import { useToastStore } from "../stores/toasts.js";
import SettingsPage from "./SettingsPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU e2e@example.test";
const PROVIDER_SECRET = "sentinel-provider-secret";
const HTTPS_TOKEN = "sentinel-https-token";
const PRIVATE_KEY = "sentinel-private-key";

const LABELS: SettingsLabelsProps = {
  nav: {
    ariaLabel: "Settings",
    scopeLabel: "Settings scope",
    sectionsLabel: "Settings sections",
    scopes: { global: "Global", project: "Project", app: "Application", applicationShort: "App" },
    sections: {
      agent: "Agent",
      web: "Web tools",
      context: "Context",
      git: "Git",
      restart: "Restart",
    },
  },
  sections: {
    agent: "Agent",
    web: "Web tools",
    context: "Context",
    git: "Git",
    restart: "Restart & pending",
  },
  actions: {
    save: "Save",
    inherit: "Inherit",
    clear: "Clear",
    clearTitle: "Clear setting at this scope?",
    clearBody: "Wider scopes will no longer apply.",
    clearConfirm: "Clear setting",
    cancel: "Cancel",
    restartAgent: "Restart agent",
    testConnection: "Test connection",
  },
  providers: {
    title: "Providers",
    hint: "Keys are encrypted at rest and never shown again.",
    empty: "No providers are referenced.",
    addTitle: "Add provider key",
    keyLabel: "API key",
    providerLabel: "Provider",
    providerPlaceholder: "deepseek",
    changeKey: "Change key",
    masked: "Not shown",
  },
  modelProviders: {
    title: "Custom model providers",
    hint: "Global OpenAI-compatible endpoints.",
    empty: "No custom providers yet.",
    addTitle: "Add custom provider",
    globalHint: "Custom model providers are global.",
    manage: "Manage in Global settings",
    name: "Name",
    baseUrl: "Base URL",
    models: "Models",
    modelsHint: "One row per model. Context and max output are required token limits.",
    providerId: "Provider id",
    providerIdPlaceholder: "llm-lan",
    namePlaceholder: "LLM LAN",
    baseUrlPlaceholder: "http://gateway.example:4000/v1",
    deleteConfirmPrefix: "Delete provider",
    modelsCount: "models",
    modelRow: "Model",
    modelId: "Model id",
    modelName: "Display name",
    contextWindow: "Context window (tokens)",
    outputLimit: "Max output (tokens)",
    inputLimit: "Max input (tokens)",
    capabilities: "Capabilities",
    attachments: "Attachments (image, PDF, video)",
    reasoning: "Reasoning output",
    toolCalls: "Tool calls",
    temperature: "Temperature parameter",
    cost: "Cost (USD per 1M tokens)",
    costInput: "Input cost",
    costOutput: "Output cost",
    addModel: "Add model",
    removeModel: "Remove model",
    modelIdPlaceholder: "deepseek-chat",
    modelNamePlaceholder: "DeepSeek Chat",
    contextWindowPlaceholder: "1000000",
    outputLimitPlaceholder: "64000",
    inputLimitPlaceholder: "Optional",
    costPlaceholder: "0.00",
  },
  git: {
    title: "Git",
    badge: "Identity and credentials",
    noscript: "Git credential changes require JavaScript.",
    user: "User name",
    email: "User email",
    ssh: "SSH credential",
    https: "HTTPS credential",
    key: {
      overline: "Public key",
      fingerprint: "Fingerprint",
      knownHosts: "known_hosts",
      knownHostsSet: "Set — strict host checking.",
      knownHostsUnset: "Not set — accept-new (TOFU) on first connection.",
      allowedHosts: "Allowed hosts",
      username: "Username",
      cleared: "A tombstone at this scope suppresses wider credentials.",
      missing: "No credential is set or inherited.",
    },
    testApp: "Test connection checks the draft values.",
    credentialCheck: "Credential check",
    credentialCheckHint: "Run the remote check from an application settings page.",
    appSettings: "Application settings",
    testHint: "Test connection checks the draft values against the remote.",
    securityNotes: "Use scoped deploy keys.",
  },
  restart: {
    title: "Restart & pending",
    badge: "Restart",
    hint: "Settings changes apply only on an explicit restart.",
    empty: "No running agents are waiting for a restart.",
    profileWarnings: "OMO profile warnings",
  },
  warnings: "Warnings",
};

function action(label: string, overrides: Partial<SettingsRowProps["actions"]["save"]> = {}) {
  return {
    visible: true,
    enabled: true,
    label,
    confirmLabel: null,
    reason: null,
    warning: null,
    ...overrides,
  };
}

function formFor(scope: SettingsScope, returnTo: string): SettingsRowProps["form"] {
  return {
    action: "/api/settings",
    method: "post",
    successNotice: "Settings saved.",
    returnTo,
    hidden: {
      scope,
      projectId: scope === "global" ? null : "p",
      appKey: scope === "app" ? "a" : null,
      returnTo,
    },
  };
}

function row(
  options: {
    id: string;
    key: string;
    title: string;
    kind: SettingsRowProps["kind"];
    scope: SettingsScope;
    own?: SettingsRowProps["own"];
    effectiveText?: string;
    sourceLine?: string;
    clearable?: boolean;
    text?: SettingsRowProps["text"];
    select?: SettingsRowProps["select"];
    number?: SettingsRowProps["number"];
    driver?: SettingsRowProps["driver"];
    inheritedNote?: string | null;
  } & Partial<SettingsRowProps>,
): SettingsRowProps {
  const own = options.own ?? { state: "set", value: options.text?.value ?? null };
  const base: SettingsRowProps = {
    id: options.id,
    key: options.key,
    title: options.title,
    hint: null,
    kind: options.kind,
    effective: {
      value: null,
      state: "set",
      source: options.scope === "global" ? "global" : "global",
      sources: ["global"],
      text: options.effectiveText ?? "",
      sourceLine: options.sourceLine ?? "from Global",
    },
    effectiveText: options.effectiveText ?? "",
    sourceLine: options.sourceLine ?? "from Global",
    own,
    warnings: [],
    scopeDetails:
      options.scope === "global"
        ? []
        : [
            {
              scope: "global",
              label: "Global",
              state: "set",
              stateLabel: "Set",
              valueText: options.effectiveText ?? "",
            },
            ...(options.scope === "app"
              ? [
                  {
                    scope: "project" as const,
                    label: "Project",
                    state: "absent" as const,
                    stateLabel: "Inherited",
                    valueText: null,
                  },
                ]
              : []),
          ],
    actions: {
      save: action("Save"),
      inherit:
        options.scope === "global"
          ? null
          : action(
              "Inherit",
              own.state === "absent" ? { enabled: false, reason: "Already inherited." } : {},
            ),
      clear: options.clearable === false ? null : action("Clear", { confirmLabel: options.title }),
    },
    form: formFor(options.scope, options.scope === "global" ? "/settings" : "/projects/p/settings"),
    text: options.text ?? null,
    select: options.select ?? null,
    number: options.number ?? null,
    driver: options.driver ?? null,
    inheritedNote: options.inheritedNote ?? null,
    errorSlotId: `${options.id}-error`,
  };
  return { ...base, ...options };
}

function rowsFor(scope: SettingsScope): SettingsProps["rows"] {
  const model = row({
    id: "setting-llm-model",
    key: "llm.model",
    title: "Model",
    kind: "model",
    scope,
    effectiveText: "test-provider/test-model",
    text: {
      value: scope === "global" ? "test-provider/test-model" : "",
      placeholder: "Inherited: test-provider/test-model",
      required: true,
      autocomplete: "off",
      listId: "model-options",
      options: ["test-provider/test-model"],
    },
  });
  const webSearch = row({
    id: "setting-web-search",
    key: "web.search",
    title: "Web search",
    kind: "web",
    scope,
    own: { state: "absent", value: null },
    effectiveText: "builtin",
    driver: {
      options: [
        { value: "builtin", label: "Built-in", selected: false, disabled: false },
        { value: "deepseek", label: "DeepSeek", selected: false, disabled: false },
      ],
      placeholder: { value: "", label: "Choose a driver", selected: true, disabled: true },
      fields: [
        {
          name: "provider",
          label: "Provider",
          type: "text",
          min: null,
          max: null,
          placeholder: "deepseek",
          value: "",
          checked: false,
          required: true,
        },
      ],
      showFields: false,
    },
    inheritedNote:
      scope === "global"
        ? null
        : "This scope inherits builtin from Global. Saving creates an override.",
  });
  const webFetch = row({
    id: "setting-web-fetch",
    key: "web.fetch",
    title: "Web fetch",
    kind: "web",
    scope,
    own: { state: "absent", value: null },
    effectiveText: "builtin",
    driver: {
      options: [
        { value: "builtin", label: "Built-in", selected: true, disabled: false },
        { value: "deepseek", label: "DeepSeek", selected: false, disabled: false },
      ],
      placeholder: null,
      fields: [],
      showFields: false,
    },
  });
  const contextEnabled = row({
    id: "setting-context-auto-compact",
    key: "context.auto_compact.enabled",
    title: "Auto-compaction",
    kind: "context-enabled",
    scope,
    effectiveText: "On",
    select: {
      options: [
        { value: "true", label: "On", selected: false, disabled: false },
        { value: "false", label: "Off", selected: false, disabled: false },
      ],
      placeholder: { value: "", label: "Inherited: On", selected: true, disabled: true },
    },
  });
  const contextPercent = row({
    id: "setting-context-auto-compact-percent",
    key: "context.auto_compact.percent",
    title: "Auto-compaction threshold",
    kind: "context-percent",
    scope,
    effectiveText: "75%",
    number: { value: "", placeholder: "Inherited: 75%", min: 1, max: 99, step: 1, required: true },
  });
  const gitName = row({
    id: "setting-git-user-name",
    key: "git.user.name",
    title: "User name",
    kind: "git-identity",
    scope,
    own: { state: "absent", value: null },
    effectiveText: "E2E Operator",
    text: {
      value: "",
      placeholder: "Inherited: E2E Operator",
      required: false,
      autocomplete: "off",
      listId: null,
      options: [],
    },
  });
  const gitEmail = row({
    id: "setting-git-user-email",
    key: "git.user.email",
    title: "User email",
    kind: "git-identity",
    scope,
    own: { state: "absent", value: null },
    effectiveText: "e2e@example.test",
    text: {
      value: "",
      placeholder: "Inherited: e2e@example.test",
      required: false,
      autocomplete: "off",
      listId: null,
      options: [],
    },
  });
  return { model, webSearch, webFetch, contextEnabled, contextPercent, gitName, gitEmail };
}

function scopeProps(scope: SettingsScope): SettingsScopeProps {
  const href =
    scope === "global"
      ? "/settings"
      : scope === "project"
        ? "/projects/p/settings"
        : "/projects/p/apps/a/settings";
  const projectHref = "/projects/p/settings";
  const appHref = "/projects/p/apps/a/settings";
  return {
    scope,
    scopeLabel: scope === "global" ? "Global" : scope === "project" ? "Project" : "Application",
    projectId: scope === "global" ? null : "p",
    projectName: scope === "global" ? null : "Alpha",
    appKey: scope === "app" ? "a" : null,
    appId: scope === "app" ? "p:a" : null,
    href,
    settingsHref: href,
    skillsHref:
      scope === "global"
        ? "/skills"
        : scope === "project"
          ? "/projects/p/skills"
          : "/projects/p/apps/a/skills",
    title: scope === "global" ? "Settings" : scope === "project" ? "Alpha settings" : "a settings",
    description: "Coordinator settings.",
    breadcrumb: [],
    nav: {
      globalHref: "/settings",
      projectHref: scope === "global" ? null : projectHref,
      appHref: scope === "app" ? appHref : null,
      projectCurrent: scope === "project",
      appCurrent: scope === "app",
      projectShortLabel: "Project",
      appShortLabel: "Application",
    },
    hrefs: {
      global: "/settings",
      project: scope === "global" ? null : projectHref,
      app: scope === "app" ? appHref : null,
    },
    projects: [
      {
        value: "p",
        label: "Alpha",
        href: projectHref,
        current: scope === "project",
        projectId: "p",
        apps: [
          {
            value: "p:a",
            label: "Alpha / a",
            href: appHref,
            current: scope === "app",
            appKey: "a",
          },
        ],
      },
    ],
  };
}

function gitCredential(kind: "ssh" | "https"): SettingsGitCredentialProps {
  const allowTest = true;
  if (kind === "ssh") {
    return {
      kind,
      title: "SSH credential",
      status: {
        state: "set",
        kind: "ssh",
        source: "app",
        publicKey: PUBLIC_KEY,
        fingerprint: "SHA256:fixture",
        hasKnownHosts: true,
      },
      state: "set",
      configured: true,
      hasSecret: true,
      masked: "Not shown",
      effectiveText: PUBLIC_KEY,
      sourceLine: "from Application",
      scopedState: "set",
      scoped: { global: "absent", project: "absent", app: "set" },
      scopeDetails: [],
      allowTest,
      inheritReason: null,
      clearReason: null,
      details: {
        publicKey: PUBLIC_KEY,
        fingerprint: "SHA256:fixture",
        hasKnownHosts: true,
        hosts: null,
        username: null,
        error: null,
      },
      actions: { action: "/api/settings/git", test: "/api/settings/git", allowTest },
      form: formFor("app", "/projects/p/apps/a/settings"),
    };
  }
  return {
    kind,
    title: "HTTPS credential",
    status: {
      state: "set",
      kind: "https",
      source: "app",
      hosts: ["git.example.test"],
      username: "x-access-token",
    },
    state: "set",
    configured: true,
    hasSecret: true,
    masked: "Not shown",
    effectiveText: "git.example.test",
    sourceLine: "from Application",
    scopedState: "set",
    scoped: { global: "absent", project: "absent", app: "set" },
    scopeDetails: [],
    allowTest,
    inheritReason: null,
    clearReason: null,
    details: {
      publicKey: null,
      fingerprint: null,
      hasKnownHosts: null,
      hosts: ["git.example.test"],
      username: "x-access-token",
      error: null,
    },
    actions: { action: "/api/settings/git", test: "/api/settings/git", allowTest },
    form: formFor("app", "/projects/p/apps/a/settings"),
  };
}

function props(scope: SettingsScope = "global"): SettingsProps {
  return {
    scope: scopeProps(scope),
    effective: {},
    scoped: {},
    providerKeys: {},
    gitAuth: { ssh: gitCredential("ssh").status, https: gitCredential("https").status },
    gitAuthScoped: {
      ssh: { global: "absent", project: "absent", app: "set" },
      https: { global: "absent", project: "absent", app: "set" },
    },
    warnings: [],
    pendingRestart: [],
    notice: null,
    rows: rowsFor(scope),
    providers: [
      {
        provider: "deepseek",
        status: { state: "set", source: "global" },
        state: "set",
        configured: true,
        usable: true,
        masked: "Not shown",
        effectiveText: "Set at global",
        sourceLine: "from Global",
        warning: null,
        rowId: "provider-deepseek",
        errorSlotId: "provider-error-0",
        actions: {
          save: action("Save"),
          inherit: scope === "global" ? null : action("Inherit", { enabled: false }),
          clear: action("Clear", { confirmLabel: "deepseek key" }),
        },
        form: formFor(scope, "/settings#providers"),
      },
    ],
    modelProviders: {
      providers: [
        {
          id: "e2e-llm",
          name: "E2E LLM",
          baseUrl: "http://llm.example.test/v1",
          models: [
            {
              id: "e2e-model",
              name: "E2E Model",
              limit: { context: 1000, output: 256 },
              attachment: true,
              reasoning: true,
              toolCall: false,
              temperature: true,
              cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.2 },
            },
          ],
          warnings: [],
          key: {
            status: { state: "missing" },
            state: "missing",
            label: "Missing",
            masked: "Not shown",
          },
          rowId: "custom-provider-e2e-llm",
          nameInputId: "custom-provider-name-0",
          urlInputId: "custom-provider-url-0",
          errorId: "custom-provider-error-0",
          actions: {
            update: "/api/settings/model-providers",
            delete: "/api/settings/model-providers",
            returnTo: "/settings#custom-providers",
          },
        },
      ],
      count: 1,
      add: {
        action: "/api/settings/model-providers",
        returnTo: "/settings#custom-providers",
        errorId: "custom-provider-add-error",
      },
      manageHref: "/settings#custom-providers",
    },
    git: {
      identity: [],
      ssh: gitCredential("ssh"),
      https: gitCredential("https"),
      testAppPath: null,
      testCheck: {
        hint: scope === "app" ? LABELS.git.testHint : LABELS.git.credentialCheckHint,
        href: scope === "app" ? null : "/projects/p/apps/a/settings",
      },
      securityNotes: LABELS.git.securityNotes,
    },
    restart: {
      pending:
        scope === "global"
          ? [
              {
                appId: "p:a",
                appKey: "a",
                projectId: "p",
                reasons: ["settings_changed"],
                reasonLabels: ["Settings changed"],
                href: "/projects/p/apps/a",
                restartAction: "/api/apps/a/restart?project=p",
                returnTo: scopeProps(scope).href,
              },
            ]
          : [],
      restartRequired: scope === "global",
      profileWarnings: [],
      returnTo: scopeProps(scope).href,
      hint: LABELS.restart.hint,
    },
    labels: LABELS,
    dialogs: {
      clear: {
        id: "settings-clear-dialog",
        titleId: "settings-clear-title",
        metaId: "settings-clear-meta",
        bodyId: "settings-clear-body",
        formId: "settings-clear-form",
        action: "/api/settings",
        title: LABELS.actions.clearTitle,
        body: LABELS.actions.clearBody,
        fieldError: "field-error",
        cancel: "Cancel",
        submit: LABELS.actions.clearConfirm,
      },
    },
    dirty: false,
    restartRequired: scope === "global",
  };
}

function boot(
  payload: SettingsProps | null,
  routeId: BootPayload["route"]["id"] = "settings-global",
  params: Record<string, string> = {},
): BootPayload {
  return {
    route: { id: routeId, params },
    props: payload,
    spaRoutes: [routeId],
    topbar: { ideHref: "/ide/" },
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Settings",
      active: "settings",
      pendingCount: 0,
      sshPendingCount: 0,
    },
  };
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/settings", name: "settings-global", component: { template: "<div />" } },
      {
        path: "/projects/:id/settings",
        name: "settings-project",
        component: { template: "<div />" },
      },
      {
        path: "/projects/:id/apps/:app/settings",
        name: "settings-app",
        component: { template: "<div />" },
      },
      { path: "/projects/:id", name: "project", component: { template: "<div />" } },
      { path: "/", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(
  payload: BootPayload,
  path = "/settings",
  router = testRouter(),
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(SettingsPage, {
    props: { boot: payload },
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
  });
}

function toasts() {
  return useToastStore().toasts;
}

function button(wrapper: VueWrapper, selector: string, label: string) {
  return wrapper
    .get(selector)
    .findAll("button")
    .find((entry) => entry.text().includes(label));
}

function openDialog(wrapper: VueWrapper) {
  const dialog = wrapper
    .findAll("dialog.dialog")
    .find((entry) => entry.attributes("open") !== undefined);
  if (dialog === undefined) {
    throw new Error("no open dialog");
  }
  return dialog;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
  });

  it("renders the global boot payload without fetching and without secrets", async () => {
    const wrapper = await mountPage(boot(props("global")));

    expect(wrapper.get("h1").text()).toBe("Settings");
    expect(wrapper.get("#settings-agent").text()).toContain("Model");
    expect(wrapper.get("#setting-llm-model").text()).toContain("test-provider/test-model");
    expect(wrapper.get("#provider-deepseek").text()).toContain("Not shown");
    expect(wrapper.get("#custom-provider-e2e-llm").text()).toContain("E2E LLM");
    expect(wrapper.get("#settings-git").text()).toContain("SSH credential");
    expect(wrapper.text()).toContain("Restart required");
    expect(wrapper.text()).toContain("Settings changed");
    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain(PROVIDER_SECRET);
    expect(wrapper.html()).not.toContain(HTTPS_TOKEN);
    expect(wrapper.html()).not.toContain(PRIVATE_KEY);
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("hides the target selector at global scope", async () => {
    const wrapper = await mountPage(boot(props("global")));

    expect(wrapper.find("#settings-target").exists()).toBe(false);
    expect(wrapper.get(".page-header").text()).toContain("Global");
  });

  it("selects the current application target", async () => {
    const wrapper = await mountPage(
      boot(props("app"), "settings-app", { id: "p", app: "a" }),
      "/projects/p/apps/a/settings",
    );
    const select = wrapper.get("#settings-target").element as HTMLSelectElement;

    expect(select.selectedIndex).toBeGreaterThan(0);
    expect(select.value).toBe("/projects/p/apps/a/settings");
    expect(select.selectedOptions[0]?.textContent).toContain("Alpha / a");
  });

  it("marks the first section current and follows a section-link click", async () => {
    const wrapper = await mountPage(boot(props("global")));
    const links = wrapper.findAll(".settings-nav__sections a");

    expect(links).toHaveLength(5);
    expect(links[0]?.attributes("aria-current")).toBe("page");
    expect(links[0]?.text()).toBe("Agent");

    await links[3]?.trigger("click");

    expect(links[0]?.attributes("aria-current")).toBeUndefined();
    expect(links[3]?.attributes("aria-current")).toBe("page");
    expect(links[3]?.text()).toBe("Git");
  });

  it("renders inherited project rows and scope details", async () => {
    const wrapper = await mountPage(
      boot(props("project"), "settings-project", { id: "p" }),
      "/projects/p/settings",
    );

    expect(wrapper.get("h1").text()).toBe("Alpha settings");
    expect(wrapper.find("#settings-target").exists()).toBe(true);
    expect(wrapper.get("#setting-web-search").text()).toContain("Inherited");
    expect(wrapper.get("#setting-web-search").text()).toContain("Scope details");
    expect(wrapper.text()).toContain("Global settings");
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("renders app git credentials masked with public metadata only", async () => {
    const wrapper = await mountPage(
      boot(props("app"), "settings-app", { id: "p", app: "a" }),
      "/projects/p/apps/a/settings",
    );

    expect(wrapper.get("#git-ssh-public-key").text()).toBe(PUBLIC_KEY);
    expect(wrapper.get("#git-ssh-fingerprint").text()).toBe("SHA256:fixture");
    expect(wrapper.get("#git-https-allowed-hosts").text()).toBe("git.example.test");
    expect(wrapper.get("#git-https-username-value").text()).toBe("x-access-token");
    expect(wrapper.html()).not.toContain(PRIVATE_KEY);
    expect(wrapper.html()).not.toContain(HTTPS_TOKEN);
    expect(wrapper.get("#setting-git-ssh").text()).toContain("Not shown");
  });

  it("switches the target through the router and refetches props", async () => {
    const router = testRouter();
    const wrapper = await mountPage(
      boot(props("app"), "settings-app", { id: "p", app: "a" }),
      "/projects/p/apps/a/settings",
      router,
    );
    mocks.apiQuery.mockResolvedValue(props("project"));

    await wrapper.get("#settings-target").setValue("/projects/p/settings");
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/projects/p/settings");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/settings?scope=project&project=p");
    expect(wrapper.get("h1").text()).toBe("Alpha settings");
  });

  it("saves a setting and refreshes props plus chrome", async () => {
    const wrapper = await mountPage(boot(props("global")));
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const refreshed = { ...props("global"), chrome: { ...boot(null).chrome } };
    mocks.apiQuery.mockResolvedValue(refreshed);

    await wrapper.get("#setting-llm-model > summary").trigger("click");
    await wrapper.get("#setting-llm-model input[name='value']").setValue("next/model");
    await wrapper.get("#setting-llm-model form").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "global",
        key: "llm.model",
        action: "set",
        value: "next/model",
      }),
    });
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/settings?scope=global");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Settings saved.", tone: "success" }),
    );
  });

  it("reports a setting save error as an error toast", async () => {
    const wrapper = await mountPage(boot(props("global")));
    mocks.apiMutation.mockRejectedValue(new ApiError("Model is not allowed.", 400));

    await wrapper.get("#setting-llm-model > summary").trigger("click");
    await wrapper.get("#setting-llm-model input[name='value']").setValue("bad/model");
    await wrapper.get("#setting-llm-model form").trigger("submit");
    await flushPromises();

    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Model is not allowed.", tone: "error" }),
    );
  });

  it("submits web-driver and numeric setting payloads", async () => {
    const wrapper = await mountPage(
      boot(props("project"), "settings-project", { id: "p" }),
      "/projects/p/settings",
    );
    mocks.apiMutation.mockResolvedValue({ ok: true });
    mocks.apiQuery.mockResolvedValue({ ...props("project") });

    await wrapper.get("#setting-web-search > summary").trigger("click");
    await wrapper.get("#setting-web-search select[name='driver']").setValue("deepseek");
    await wrapper.get("#setting-web-search input[name='provider']").setValue("deepseek");
    await wrapper.get("#setting-web-search form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "project",
        key: "web.search",
        action: "set",
        value: { driver: "deepseek", options: { provider: "deepseek" } },
      }),
    });

    await wrapper.get("#setting-context-auto-compact-percent > summary").trigger("click");
    await wrapper.get("#setting-context-auto-compact-percent input[name='value']").setValue("55");
    await wrapper.get("#setting-context-auto-compact-percent form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "project",
        key: "context.auto_compact.percent",
        action: "set",
        value: 55,
      }),
    });
  });

  it("inherits and clears a setting after confirmation", async () => {
    const wrapper = await mountPage(
      boot(props("project"), "settings-project", { id: "p" }),
      "/projects/p/settings",
    );
    mocks.apiMutation.mockResolvedValue({ ok: true });
    mocks.apiQuery.mockResolvedValue({ ...props("project") });

    await wrapper.get("#setting-context-auto-compact-percent > summary").trigger("click");
    await button(wrapper, "#setting-context-auto-compact-percent", "Inherit")?.trigger("click");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "project",
        key: "context.auto_compact.percent",
        action: "inherit",
      }),
    });

    await button(wrapper, "#setting-context-auto-compact-percent", "Clear")?.trigger("click");
    await flushPromises();
    const dialog = openDialog(wrapper);
    await dialog.get("form").trigger("submit");
    await flushPromises();
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "project",
        key: "context.auto_compact.percent",
        action: "clear",
      }),
    });
  });

  it("saves a provider key without leaving the key in the DOM", async () => {
    const wrapper = await mountPage(boot(props("global")));
    mocks.apiMutation.mockResolvedValue({ ok: true });
    mocks.apiQuery.mockResolvedValue(props("global"));

    await wrapper.get("#provider-deepseek > summary").trigger("click");
    await wrapper.get("#provider-key-deepseek").setValue("new-provider-secret");
    await wrapper.get("#provider-deepseek form").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/provider", {
      json: expect.objectContaining({
        provider: "deepseek",
        action: "set",
        key: "new-provider-secret",
      }),
    });
    expect(wrapper.html()).not.toContain("new-provider-secret");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Provider key updated.", tone: "success" }),
    );

    await wrapper.get("#provider-deepseek form button.btn-danger").trigger("click");
    await flushPromises();
    await openDialog(wrapper).get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings/provider", {
      json: expect.objectContaining({ provider: "deepseek", action: "clear" }),
    });
  });

  it("updates, deletes, and creates custom model providers", async () => {
    const wrapper = await mountPage(boot(props("global")));
    mocks.apiMutation.mockResolvedValue({ ok: true });
    mocks.apiQuery.mockResolvedValue(props("global"));

    await wrapper.get("#custom-provider-e2e-llm > summary").trigger("click");
    await wrapper.get("#custom-provider-name-0").setValue("Renamed LLM");
    await wrapper.get("#custom-provider-model-0-0-context").setValue("2048");
    await wrapper.get("#custom-provider-e2e-llm form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/model-providers", {
      json: expect.objectContaining({
        action: "update",
        id: "e2e-llm",
        name: "Renamed LLM",
        models: [
          expect.objectContaining({
            id: "e2e-model",
            limit: { context: 2048, output: 256 },
            attachment: true,
            reasoning: true,
            toolCall: false,
            temperature: true,
          }),
        ],
      }),
    });

    await wrapper.get("#custom-provider-e2e-llm form button.btn-danger").trigger("click");
    await flushPromises();
    await openDialog(wrapper).get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings/model-providers", {
      json: { action: "delete", id: "e2e-llm" },
    });

    const add = wrapper.get("#custom-providers details.provider-add");
    await add.get("input[name='id']").setValue("e2e-new");
    await add.get("input[name='baseUrl']").setValue("http://new.example.test/v1");
    await add.get("#custom-provider-model-new-0-id").setValue("m");
    await add.get("#custom-provider-model-new-0-context").setValue("1000");
    await add.get("#custom-provider-model-new-0-output").setValue("100");
    await add.get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings/model-providers", {
      json: expect.objectContaining({
        action: "create",
        id: "e2e-new",
        models: [expect.objectContaining({ id: "m", limit: { context: 1000, output: 100 } })],
      }),
    });
  });

  it("saves and tests a git credential without leaving secret text", async () => {
    const wrapper = await mountPage(
      boot(props("app"), "settings-app", { id: "p", app: "a" }),
      "/projects/p/apps/a/settings",
    );
    mocks.apiMutation.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: true,
      kind: "https",
      remote: "origin",
      refs: 2,
      head: "main",
      warnings: ["Host key is not pinned."],
    });
    mocks.apiQuery.mockResolvedValue(props("app"));

    await wrapper.get("#setting-git-https > summary").trigger("click");
    await wrapper.get("#git-https-hosts").setValue("git.example.test");
    await wrapper.get("#git-https-username").setValue("token-user");
    await wrapper.get("#git-https-token").setValue("new-https-token");
    await wrapper.get("#setting-git-https form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/git", {
      json: expect.objectContaining({
        kind: "https",
        action: "set",
        value: expect.objectContaining({ token: "new-https-token" }),
      }),
    });
    expect(wrapper.html()).not.toContain("new-https-token");

    await wrapper.get("#git-https-token").setValue("draft-token");
    await button(wrapper, "#setting-git-https", "Test connection")?.trigger("click");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/projects/p/apps/a/git/test", {
      json: expect.objectContaining({ kind: "https" }),
    });
    expect(wrapper.get("#setting-git-https").text()).toContain("Connected: 2 refs");
    expect(wrapper.get("#setting-git-https").text()).toContain("git.example.test");
    expect(wrapper.html()).not.toContain("draft-token");

    await button(wrapper, "#setting-git-https", "Clear")?.trigger("click");
    await flushPromises();
    await openDialog(wrapper).get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenLastCalledWith("/api/settings/git", {
      json: expect.objectContaining({ kind: "https", action: "clear" }),
    });
  });

  it("restarts a pending agent", async () => {
    const wrapper = await mountPage(boot(props("global")));
    mocks.apiMutation.mockResolvedValue({ restarted: true });
    mocks.apiQuery.mockResolvedValue(props("global"));

    await wrapper
      .findAll("button")
      .find((entry) => entry.text().includes("Restart agent"))
      ?.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/apps/a/restart?project=p", { json: {} });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Agent restarted.", tone: "success" }),
    );
  });

  it("renders empty provider, model-provider, and restart sections plus a cleared row", async () => {
    const base = props("global");
    const cleared = {
      ...base.rows.webSearch,
      own: { state: "cleared" as const, value: null },
      effectiveText: "Cleared",
      sourceLine: "Cleared at Global",
    };
    const wrapper = await mountPage(
      boot({
        ...base,
        providers: [],
        modelProviders: { ...base.modelProviders, providers: [], count: 0 },
        restart: { ...base.restart, pending: [], restartRequired: false },
        restartRequired: false,
        rows: { ...base.rows, webSearch: cleared },
      }),
    );

    expect(wrapper.text()).toContain(LABELS.providers.empty);
    expect(wrapper.text()).toContain(LABELS.modelProviders.empty);
    expect(wrapper.text()).toContain(LABELS.restart.empty);
    expect(wrapper.get("#setting-web-search").text()).toContain("Cleared");
  });

  it("fetches when boot belongs to another route, then shows loading", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(
      boot(props("global"), "settings-project", { id: "p" }),
      "/projects/p/settings",
    );

    expect(wrapper.text()).toContain("Loading settings…");
    expect(wrapper.text()).not.toContain("test-provider/test-model");

    resolve?.(props("project"));
    await flushPromises();
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("Alpha settings");
  });

  it("renders a not-found state and a generic error with retry", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new ApiError("not found", 404));
    const wrapper = await mountPage(
      boot(null, "settings-project", { id: "missing" }),
      "/projects/missing/settings",
    );
    await flushPromises();

    expect(wrapper.text()).toContain("Settings not found");
    expect(wrapper.get("a[href='?legacy=1']").text()).toBe("Use the classic interface");

    mocks.apiQuery.mockRejectedValueOnce(new ApiError("Settings are unavailable.", 503));
    const second = await mountPage(
      boot(null, "settings-project", { id: "p" }),
      "/projects/p/settings",
    );
    await flushPromises();
    expect(second.text()).toContain("Settings could not be loaded");
    expect(second.text()).toContain("Settings are unavailable.");

    mocks.apiQuery.mockResolvedValue(props("project"));
    await second.get("section[aria-labelledby='settings-error-title'] button").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(second.get("h1").text()).toBe("Alpha settings");
  });
});
