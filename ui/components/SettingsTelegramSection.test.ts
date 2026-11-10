import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import type {
  SettingsGitCredentialProps,
  SettingsLabelsProps,
  SettingsProps,
  SettingsRowProps,
  SettingsScope,
  SettingsScopeProps,
  SettingsTelegramSecretProps,
} from "../settings-types.js";
import { useToastStore } from "../stores/toasts.js";
import SettingsTelegramSection from "./SettingsTelegramSection.vue";

const mocks = vi.hoisted(() => ({
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiMutation: mocks.apiMutation };
});

const BOT_TOKEN = "sentinel-bot-token";
const PROXY_URL = "sentinel-proxy-url";

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
      notifications: "Notifications",
      git: "Git",
      restart: "Restart",
    },
  },
  sections: {
    agent: "Agent",
    web: "Web tools",
    context: "Context",
    notifications: "Notifications",
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
    hint: "",
    empty: "",
    addTitle: "",
    keyLabel: "API key",
    providerLabel: "Provider",
    providerPlaceholder: "",
    changeKey: "Change",
    masked: "Not shown",
  },
  modelProviders: {
    title: "",
    hint: "",
    empty: "",
    addTitle: "",
    globalHint: "",
    manage: "",
    name: "",
    baseUrl: "",
    models: "",
    modelsHint: "",
    providerId: "",
    providerIdPlaceholder: "",
    namePlaceholder: "",
    baseUrlPlaceholder: "",
    deleteConfirmPrefix: "",
    modelsCount: "",
    modelRow: "",
    modelId: "",
    modelName: "",
    contextWindow: "",
    outputLimit: "",
    inputLimit: "",
    capabilities: "",
    attachments: "",
    reasoning: "",
    toolCalls: "",
    temperature: "",
    cost: "",
    costInput: "",
    costOutput: "",
    addModel: "",
    removeModel: "",
    modelIdPlaceholder: "",
    modelNamePlaceholder: "",
    contextWindowPlaceholder: "",
    outputLimitPlaceholder: "",
    inputLimitPlaceholder: "",
    costPlaceholder: "",
  },
  git: {
    title: "",
    badge: "",
    noscript: "",
    user: "",
    email: "",
    ssh: "",
    https: "",
    key: {
      overline: "",
      fingerprint: "",
      knownHosts: "",
      knownHostsSet: "",
      knownHostsUnset: "",
      allowedHosts: "",
      username: "",
      cleared: "",
      missing: "",
    },
    testApp: "",
    credentialCheck: "",
    credentialCheckHint: "",
    appSettings: "",
    testHint: "",
    securityNotes: "",
  },
  notifications: {
    title: "Notifications",
    hint: "Telegram delivery for turn completion and attention events.",
    mode: "Notification mode",
    enabled: "Telegram delivery",
    chatId: "Chat id",
    publicBaseUrl: "Public base URL",
    apiBaseUrl: "API base URL",
    includeAnswer: "Include full answer",
    botToken: "Bot token",
    proxyUrl: "Proxy URL",
    secretHint: "A cleared secret suppresses wider scopes.",
    test: "Send test message",
    testHint: "Sends a fixed test message through the effective bot.",
    unconfigured:
      "Telegram notifications are enabled, but the bot token or chat id is not configured.",
  },
  restart: { title: "", badge: "", hint: "", empty: "", profileWarnings: "" },
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

function row(options: {
  id: string;
  key: string;
  title: string;
  kind: SettingsRowProps["kind"];
  scope: SettingsScope;
  own?: SettingsRowProps["own"];
  effectiveText?: string;
  text?: SettingsRowProps["text"];
  select?: SettingsRowProps["select"];
}): SettingsRowProps {
  return {
    id: options.id,
    key: options.key,
    title: options.title,
    hint: null,
    kind: options.kind,
    effective: {
      value: null,
      state: "set",
      source: "global",
      sources: ["global"],
      text: options.effectiveText ?? "",
      sourceLine: "from Global",
    },
    effectiveText: options.effectiveText ?? "",
    sourceLine: "from Global",
    own: options.own ?? { state: "set", value: null },
    warnings: [],
    scopeDetails: [],
    actions: {
      save: action("Save"),
      inherit: options.scope === "global" ? null : action("Inherit"),
      clear: action("Clear", { confirmLabel: options.title }),
    },
    form: formFor(options.scope, scopeProps(options.scope).href),
    text: options.text ?? null,
    select: options.select ?? null,
    number: null,
    driver: null,
    inheritedNote: null,
    errorSlotId: `${options.id}-error`,
  };
}

function scopeProps(scope: SettingsScope): SettingsScopeProps {
  const href =
    scope === "global"
      ? "/settings"
      : scope === "project"
        ? "/projects/p/settings"
        : "/projects/p/apps/a/settings";
  return {
    scope,
    scopeLabel: scope === "global" ? "Global" : scope === "project" ? "Project" : "Application",
    projectId: scope === "global" ? null : "p",
    projectName: scope === "global" ? null : "Alpha",
    appKey: scope === "app" ? "a" : null,
    appId: scope === "app" ? "p:a" : null,
    href,
    settingsHref: href,
    skillsHref: "/skills",
    title: "Settings",
    description: "Coordinator settings.",
    breadcrumb: [],
    nav: {
      globalHref: "/settings",
      projectHref: scope === "global" ? null : "/projects/p/settings",
      appHref: scope === "app" ? "/projects/p/apps/a/settings" : null,
      projectCurrent: scope === "project",
      appCurrent: scope === "app",
      projectShortLabel: "Project",
      appShortLabel: "Application",
    },
    hrefs: {
      global: "/settings",
      project: scope === "global" ? null : "/projects/p/settings",
      app: scope === "app" ? "/projects/p/apps/a/settings" : null,
    },
    projects: [],
  };
}

function telegramSecret(
  field: "bot_token" | "proxy_url",
  scope: SettingsScope,
): SettingsTelegramSecretProps {
  const label =
    field === "bot_token" ? LABELS.notifications.botToken : LABELS.notifications.proxyUrl;
  return {
    field,
    label,
    status: { state: "set", source: "global" },
    state: "set",
    configured: true,
    masked: "Not shown",
    effectiveText: "Set at Global",
    sourceLine: "from Global",
    actions: {
      save: action("Save"),
      inherit: scope === "global" ? null : action("Inherit"),
      clear: action("Clear", { confirmLabel: label }),
    },
    form: {
      ...formFor(scope, scopeProps(scope).href),
      action: "/api/settings/telegram",
      returnTo: `${scopeProps(scope).href}#telegram-${field}`,
    },
  };
}

function notificationsFor(scope: SettingsScope): SettingsProps["notifications"] {
  const mode = row({
    id: "setting-notifications-mode",
    key: "notifications.mode",
    title: LABELS.notifications.mode,
    kind: "notification-mode",
    scope,
    effectiveText: "All",
    select: {
      options: [
        { value: "off", label: "Off", selected: false, disabled: false },
        { value: "attention", label: "Attention only", selected: false, disabled: false },
        { value: "all", label: "All", selected: false, disabled: false },
      ],
      placeholder: { value: "", label: "Inherited: All", selected: true, disabled: true },
    },
  });
  const telegramEnabled = row({
    id: "setting-notifications-telegram-enabled",
    key: "notifications.telegram.enabled",
    title: LABELS.notifications.enabled,
    kind: "notification-enabled",
    scope,
    own: { state: "absent", value: null },
    effectiveText: "Off",
    select: {
      options: [
        { value: "true", label: "On", selected: false, disabled: false },
        { value: "false", label: "Off", selected: false, disabled: false },
      ],
      placeholder: { value: "", label: "Inherited: Off", selected: true, disabled: true },
    },
  });
  const textRow = (id: string, key: string, title: string, effectiveText: string) =>
    row({
      id,
      key,
      title,
      kind: "notification-text",
      scope,
      own: { state: "absent", value: null },
      effectiveText,
      text: {
        value: "",
        placeholder: `Inherited: ${effectiveText}`,
        required: false,
        autocomplete: "off",
        listId: null,
        options: [],
      },
    });
  const chatId = textRow(
    "setting-notifications-chat-id",
    "notifications.telegram.chat_id",
    LABELS.notifications.chatId,
    "Not set",
  );
  const publicBaseUrl = textRow(
    "setting-notifications-public-base-url",
    "notifications.public_base_url",
    LABELS.notifications.publicBaseUrl,
    "Not set",
  );
  const apiBaseUrl = textRow(
    "setting-notifications-api-base-url",
    "notifications.telegram.api_base_url",
    LABELS.notifications.apiBaseUrl,
    "https://api.telegram.org",
  );
  const includeAnswer = row({
    id: "setting-notifications-include-answer",
    key: "notifications.include_answer",
    title: LABELS.notifications.includeAnswer,
    kind: "notification-include-answer",
    scope,
    effectiveText: "On",
    select: {
      options: [
        { value: "true", label: "On", selected: false, disabled: false },
        { value: "false", label: "Off", selected: false, disabled: false },
      ],
      placeholder: null,
    },
  });
  return {
    enabled: false,
    configured: true,
    warning: null,
    rows: { mode, telegramEnabled, chatId, publicBaseUrl, apiBaseUrl, includeAnswer },
    secrets: {
      botToken: telegramSecret("bot_token", scope),
      proxyUrl: telegramSecret("proxy_url", scope),
    },
    test: {
      action: "/api/settings/telegram/test",
      returnTo: scopeProps(scope).href,
      errorId: "telegram-test-error",
      label: LABELS.notifications.test,
      hint: LABELS.notifications.testHint,
    },
  };
}

function gitCredential(kind: "ssh" | "https"): SettingsGitCredentialProps {
  const allowTest = false;
  return {
    kind,
    title: kind === "ssh" ? "SSH credential" : "HTTPS credential",
    status: { state: "missing", kind },
    state: "missing",
    configured: false,
    hasSecret: false,
    masked: "Not shown",
    effectiveText: "Not set",
    sourceLine: "default",
    scopedState: "absent",
    scoped: { global: "absent", project: "absent", app: "absent" },
    scopeDetails: [],
    allowTest,
    inheritReason: null,
    clearReason: null,
    details: {
      publicKey: null,
      fingerprint: null,
      hasKnownHosts: null,
      hosts: null,
      username: null,
      error: null,
    },
    actions: { action: "/api/settings/git", test: null, allowTest },
    form: formFor("global", "/settings"),
  };
}

function settings(scope: SettingsScope = "global", warning: string | null = null): SettingsProps {
  const notifications = { ...notificationsFor(scope), warning };
  return {
    scope: scopeProps(scope),
    effective: {},
    scoped: {},
    providerKeys: {},
    gitAuth: {
      ssh: gitCredential("ssh").status,
      https: gitCredential("https").status,
    },
    gitAuthScoped: {
      ssh: { global: "absent", project: "absent", app: "absent" },
      https: { global: "absent", project: "absent", app: "absent" },
    },
    telegram: {
      botToken: { state: "set", source: "global" },
      proxyUrl: { state: "missing" },
    },
    warnings: [],
    pendingRestart: [],
    notice: null,
    rows: {
      model: row({
        id: "setting-llm-model",
        key: "llm.model",
        title: "Model",
        kind: "model",
        scope,
      }),
      webSearch: row({
        id: "setting-web-search",
        key: "web.search",
        title: "Web search",
        kind: "web",
        scope,
      }),
      webFetch: row({
        id: "setting-web-fetch",
        key: "web.fetch",
        title: "Web fetch",
        kind: "web",
        scope,
      }),
      contextEnabled: row({
        id: "setting-context-auto-compact",
        key: "context.auto_compact.enabled",
        title: "Auto-compaction",
        kind: "context-enabled",
        scope,
      }),
      contextPercent: row({
        id: "setting-context-auto-compact-percent",
        key: "context.auto_compact.percent",
        title: "Auto-compaction threshold",
        kind: "context-percent",
        scope,
      }),
      gitName: row({
        id: "setting-git-user-name",
        key: "git.user.name",
        title: "User name",
        kind: "git-identity",
        scope,
      }),
      gitEmail: row({
        id: "setting-git-user-email",
        key: "git.user.email",
        title: "User email",
        kind: "git-identity",
        scope,
      }),
    },
    providers: [],
    modelProviders: {
      providers: [],
      count: 0,
      add: { action: "/api/settings/model-providers", returnTo: "/settings", errorId: "add-error" },
      manageHref: "/settings#custom-providers",
    },
    git: {
      identity: [],
      ssh: gitCredential("ssh"),
      https: gitCredential("https"),
      testAppPath: null,
      testCheck: { hint: "", href: null },
      securityNotes: "",
    },
    notifications,
    restart: {
      pending: [],
      restartRequired: false,
      profileWarnings: [],
      returnTo: scopeProps(scope).href,
      hint: "",
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
    restartRequired: false,
  };
}

function mountSection(scope: SettingsScope = "global", warning: string | null = null): VueWrapper {
  return mount(SettingsTelegramSection, {
    props: { settings: settings(scope, warning) },
    global: { plugins: [createPinia()] },
  });
}

function toasts() {
  return useToastStore().toasts;
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

describe("SettingsTelegramSection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.apiMutation.mockReset();
  });

  it("renders the six rows, both secrets, the warning, and never a secret value", () => {
    const wrapper = mountSection("global", LABELS.notifications.unconfigured);

    expect(wrapper.get("#setting-notifications-mode").text()).toContain("Notification mode");
    expect(wrapper.get("#setting-notifications-telegram-enabled").text()).toContain(
      "Telegram delivery",
    );
    expect(wrapper.get("#setting-notifications-chat-id").text()).toContain("Chat id");
    expect(wrapper.get("#setting-notifications-public-base-url").text()).toContain(
      "Public base URL",
    );
    expect(wrapper.get("#setting-notifications-api-base-url").text()).toContain("API base URL");
    expect(wrapper.get("#setting-notifications-include-answer").text()).toContain(
      "Include full answer",
    );
    expect(wrapper.get("#telegram-bot_token").text()).toContain("Bot token");
    expect(wrapper.get("#telegram-proxy_url").text()).toContain("Proxy URL");
    expect(wrapper.text()).toContain(LABELS.notifications.unconfigured);
    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain(BOT_TOKEN);
    expect(wrapper.html()).not.toContain(PROXY_URL);
  });

  it("hides the warning when it is null", () => {
    const wrapper = mountSection();
    expect(wrapper.find("#settings-notifications-warning-title").exists()).toBe(false);
  });

  it("submits the notification mode as an enum value", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("global");

    await wrapper.get("#setting-notifications-mode select[name='value']").setValue("attention");
    await wrapper.get("#setting-notifications-mode form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings", {
      json: expect.objectContaining({
        scope: "global",
        key: "notifications.mode",
        action: "set",
        value: "attention",
      }),
    });
  });

  it("submits a boolean row through the native SettingsRow path", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("global");

    await wrapper
      .get("#setting-notifications-telegram-enabled select[name='value']")
      .setValue("true");
    await wrapper.get("#setting-notifications-telegram-enabled form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings", {
      json: expect.objectContaining({
        key: "notifications.telegram.enabled",
        action: "set",
        value: true,
      }),
    });
  });

  it("submits a secret set and never leaves the value in the DOM", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("global");

    await wrapper.get("#telegram-bot_token input[name='value']").setValue(BOT_TOKEN);
    await wrapper.get("#telegram-bot_token form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/telegram", {
      json: expect.objectContaining({
        scope: "global",
        field: "bot_token",
        action: "set",
        value: BOT_TOKEN,
      }),
    });
    expect(wrapper.html()).not.toContain(BOT_TOKEN);
  });

  it("inherits a secret at project scope", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("project");

    await wrapper
      .get("#telegram-proxy_url")
      .findAll("button")
      .find((button) => button.text() === "Inherit")
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/telegram", {
      json: expect.objectContaining({
        scope: "project",
        projectId: "p",
        field: "proxy_url",
        action: "inherit",
      }),
    });
  });

  it("clears a secret after confirmation", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("global");

    await wrapper
      .get("#telegram-bot_token")
      .findAll("button")
      .find((button) => button.text() === "Clear")
      ?.trigger("click");
    await flushPromises();
    await openDialog(wrapper).get("form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/telegram", {
      json: expect.objectContaining({
        scope: "global",
        field: "bot_token",
        action: "clear",
      }),
    });
  });

  it("sends a test message with the scope target body", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection("project");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === LABELS.notifications.test)
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/settings/telegram/test", {
      json: { scope: "project", projectId: "p" },
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Test message sent.", tone: "success" }),
    );
  });

  it("reports a failed test as an error toast", async () => {
    mocks.apiMutation.mockRejectedValue(new ApiError("Telegram test failed.", 502));
    const wrapper = mountSection("global");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === LABELS.notifications.test)
      ?.trigger("click");
    await flushPromises();

    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Telegram test failed.", tone: "error" }),
    );
  });
});
