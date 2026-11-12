import { describe, expect, it } from "vitest";
import type {
  SettingsProps,
  SettingsRowProps,
  SettingsScope,
  SettingsScopeDetailProps,
  SettingsScopeSource,
  SettingsScopeState,
} from "./settings-types.js";
import {
  attentionSection,
  pageSummary,
  rowTrace,
  scopeCounts,
  sectionForHash,
  showsRestartMarker,
} from "./settings-view.js";

function writable<T extends object>(value: T): { -readonly [K in keyof T]: T[K] } {
  return value as { -readonly [K in keyof T]: T[K] };
}

function action(label: string) {
  return {
    visible: true,
    enabled: true,
    label,
    confirmLabel: null,
    reason: null,
    warning: null,
  };
}

function detail(
  scope: SettingsScope,
  state: SettingsScopeState,
  valueText: string | null = null,
): SettingsScopeDetailProps {
  return {
    scope,
    label: scope === "global" ? "Global" : scope === "project" ? "Project" : "Application",
    state,
    stateLabel: state === "set" ? "Set" : state === "cleared" ? "Cleared" : "Inherited",
    valueText,
  };
}

interface RowFixture {
  key?: string;
  own?: SettingsScopeState;
  effectiveState?: "set" | "cleared" | "default";
  effectiveSource?: SettingsScopeSource;
  scopeDetails?: readonly SettingsScopeDetailProps[];
  warnings?: readonly string[];
}

function rowFixture(options: RowFixture = {}): SettingsRowProps {
  const own = options.own ?? "absent";
  const effectiveState = options.effectiveState ?? "default";
  const source = options.effectiveSource ?? "default";
  return {
    id: `setting-${options.key ?? "row"}`,
    key: options.key ?? "llm.model",
    title: "Row",
    hint: null,
    kind: "model",
    effective: {
      value: null,
      state: effectiveState,
      source,
      sources: [source],
      text: "",
      sourceLine: "",
    },
    effectiveText: "",
    sourceLine: "",
    own: { state: own, value: null },
    warnings: options.warnings ?? [],
    scopeDetails: options.scopeDetails ?? [],
    actions: {
      save: action("Save override"),
      inherit: null,
      clear: null,
    },
    form: {
      action: "/api/settings",
      method: "post",
      successNotice: "Settings saved.",
      returnTo: "/settings",
      hidden: { scope: "global", projectId: null, appKey: null, returnTo: "/settings" },
    },
    text: null,
    select: null,
    number: null,
    driver: null,
    inheritedNote: null,
    errorSlotId: "row-error",
  };
}

const REGISTRY_KEYS = [
  "llm.model",
  "web.search",
  "web.fetch",
  "context.auto_compact.enabled",
  "context.auto_compact.percent",
  "git.user.name",
  "git.user.email",
  "notifications.mode",
  "notifications.telegram.enabled",
  "notifications.telegram.chat_id",
  "notifications.public_base_url",
  "notifications.telegram.api_base_url",
  "notifications.include_answer",
] as const;

function rowsFixture(): SettingsProps["rows"] {
  const rows = Object.fromEntries(REGISTRY_KEYS.map((key) => [key, rowFixture({ key })])) as Record<
    string,
    SettingsRowProps
  >;
  return {
    model: rows["llm.model"] as SettingsRowProps,
    webSearch: rows["web.search"] as SettingsRowProps,
    webFetch: rows["web.fetch"] as SettingsRowProps,
    contextEnabled: rows["context.auto_compact.enabled"] as SettingsRowProps,
    contextPercent: rows["context.auto_compact.percent"] as SettingsRowProps,
    gitName: rows["git.user.name"] as SettingsRowProps,
    gitEmail: rows["git.user.email"] as SettingsRowProps,
  };
}

function makeProps(scope: SettingsScope): SettingsProps {
  const rows = rowsFixture();
  const notificationsRows = {
    mode: rowFixture({ key: "notifications.mode", scopeDetails: [] }),
    telegramEnabled: rowFixture({ key: "notifications.telegram.enabled", scopeDetails: [] }),
    chatId: rowFixture({ key: "notifications.telegram.chat_id", scopeDetails: [] }),
    publicBaseUrl: rowFixture({ key: "notifications.public_base_url", scopeDetails: [] }),
    apiBaseUrl: rowFixture({ key: "notifications.telegram.api_base_url", scopeDetails: [] }),
    includeAnswer: rowFixture({ key: "notifications.include_answer", scopeDetails: [] }),
  };
  return {
    scope: {
      scope,
      scopeLabel: scope,
      projectId: scope === "global" ? null : "p",
      projectName: scope === "global" ? null : "Alpha",
      appKey: scope === "app" ? "a" : null,
      appId: scope === "app" ? "p:a" : null,
      href: "/settings",
      settingsHref: "/settings",
      skillsHref: "/skills",
      title: "Settings",
      description: "",
      breadcrumb: [],
      nav: {
        globalHref: "/settings",
        projectHref: null,
        appHref: null,
        projectCurrent: scope === "project",
        appCurrent: scope === "app",
        projectShortLabel: "Project",
        appShortLabel: "Application",
      },
      hrefs: { global: "/settings", project: null, app: null },
      projects: [],
    },
    effective: {},
    scoped: {},
    providerKeys: {},
    gitAuth: {
      ssh: { state: "missing", kind: "ssh" },
      https: { state: "missing", kind: "https" },
    },
    gitAuthScoped: {
      ssh: { global: "absent", project: "absent", app: "absent" },
      https: { global: "absent", project: "absent", app: "absent" },
    },
    telegram: { botToken: { state: "missing" }, proxyUrl: { state: "missing" } },
    warnings: [],
    pendingRestart: [],
    notice: null,
    rows: {
      model: rows.model,
      webSearch: rows.webSearch,
      webFetch: rows.webFetch,
      contextEnabled: rows.contextEnabled,
      contextPercent: rows.contextPercent,
      gitName: rows.gitName,
      gitEmail: rows.gitEmail,
    },
    providers: [],
    modelProviders: {
      providers: [],
      count: 0,
      add: { action: "", returnTo: "", errorId: "" },
      manageHref: "",
    },
    git: {
      identity: [],
      ssh: {
        kind: "ssh",
        title: "",
        status: { state: "missing", kind: "ssh" },
        state: "missing",
        configured: false,
        hasSecret: false,
        masked: "",
        effectiveText: "",
        sourceLine: "",
        scopedState: "absent",
        scoped: { global: "absent", project: "absent", app: "absent" },
        scopeDetails: [],
        allowTest: false,
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
        actions: { action: "", test: null, allowTest: false },
        form: {
          action: "",
          method: "post",
          successNotice: "",
          returnTo: "",
          hidden: { scope: "global", projectId: null, appKey: null, returnTo: "" },
        },
      },
      https: {
        kind: "https",
        title: "",
        status: { state: "missing", kind: "https" },
        state: "missing",
        configured: false,
        hasSecret: false,
        masked: "",
        effectiveText: "",
        sourceLine: "",
        scopedState: "absent",
        scoped: { global: "absent", project: "absent", app: "absent" },
        scopeDetails: [],
        allowTest: false,
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
        actions: { action: "", test: null, allowTest: false },
        form: {
          action: "",
          method: "post",
          successNotice: "",
          returnTo: "",
          hidden: { scope: "global", projectId: null, appKey: null, returnTo: "" },
        },
      },
      testAppPath: null,
      testCheck: { hint: "", href: null },
      securityNotes: "",
    },
    notifications: {
      enabled: false,
      configured: false,
      warning: null,
      rows: notificationsRows,
      secrets: {
        botToken: {
          field: "bot_token",
          label: "Bot token",
          status: { state: "missing" },
          state: "missing",
          configured: false,
          masked: "",
          effectiveText: "",
          sourceLine: "",
          actions: { save: action("Save override"), inherit: null, clear: null },
          form: {
            action: "",
            method: "post",
            successNotice: "",
            returnTo: "",
            hidden: { scope: "global", projectId: null, appKey: null, returnTo: "" },
          },
        },
        proxyUrl: {
          field: "proxy_url",
          label: "Proxy URL",
          status: { state: "missing" },
          state: "missing",
          configured: false,
          masked: "",
          effectiveText: "",
          sourceLine: "",
          actions: { save: action("Save override"), inherit: null, clear: null },
          form: {
            action: "",
            method: "post",
            successNotice: "",
            returnTo: "",
            hidden: { scope: "global", projectId: null, appKey: null, returnTo: "" },
          },
        },
      },
      test: { action: "", returnTo: "", errorId: "", label: "", hint: "" },
    },
    restart: {
      pending: [],
      restartRequired: false,
      profileWarnings: [],
      returnTo: "/settings",
      hint: "",
    },
    labels: {} as SettingsProps["labels"],
    dialogs: {} as SettingsProps["dialogs"],
    dirty: false,
    restartRequired: false,
  } as unknown as SettingsProps;
}

describe("rowTrace", () => {
  it("renders G/P/A steps, maps states, and marks the winning scope", () => {
    const row = rowFixture({
      effectiveState: "set",
      effectiveSource: "global",
      scopeDetails: [
        detail("global", "set", "x"),
        detail("project", "absent"),
        detail("app", "absent"),
      ],
    });

    const trace = rowTrace(row, "app");

    expect(trace.steps.map((step) => [step.scope, step.state, step.winning])).toEqual([
      ["global", "filled", true],
      ["project", "hollow", false],
      ["app", "hollow", false],
    ]);
    expect(trace.text).toContain("Scope trace:");
    expect(trace.text).toContain("Global set and wins");
    expect(trace.text).toContain("Project not set");
  });

  it("maps cleared states and the winning tombstone", () => {
    const row = rowFixture({
      effectiveState: "cleared",
      effectiveSource: "project",
      scopeDetails: [
        detail("global", "set", "x"),
        detail("project", "cleared"),
        detail("app", "absent"),
      ],
    });

    const trace = rowTrace(row, "app");

    expect(trace.steps.map((step) => step.state)).toEqual(["filled", "cleared", "hollow"]);
    expect(trace.steps[1]?.winning).toBe(true);
    expect(trace.text).toContain("Project cleared and wins");
  });

  it("synthesizes one current-scope step on the global page", () => {
    const row = rowFixture({
      own: "set",
      effectiveState: "set",
      effectiveSource: "global",
      scopeDetails: [],
    });

    const trace = rowTrace(row, "global");

    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({ scope: "global", state: "filled", winning: true });
    expect(trace.text).toBe("Scope trace: Global set and wins.");
  });

  it("does not invent a winner when the global page resolves from a default", () => {
    const row = rowFixture({ own: "absent", effectiveState: "default", scopeDetails: [] });

    const trace = rowTrace(row, "global");

    expect(trace.steps[0]).toMatchObject({ scope: "global", state: "hollow", winning: false });
    expect(trace.text).toBe("Scope trace: Global not set.");
  });
});

describe("pageSummary", () => {
  it("counts set, inherited, attention, and restart values without inventing scope state", () => {
    const props = makeProps("app");
    const setRow = (key: string) => ({
      ...rowFixture({ key, own: "set", effectiveState: "set", effectiveSource: "app" }),
    });
    writable(props.rows).model = setRow("llm.model");
    writable(props.rows).webSearch = rowFixture({
      key: "web.search",
      effectiveState: "set",
      effectiveSource: "global",
    });
    writable(props.rows).webFetch = rowFixture({
      key: "web.fetch",
      effectiveState: "set",
      effectiveSource: "global",
    });
    writable(props.rows).contextEnabled = rowFixture({ key: "context.auto_compact.enabled" });
    writable(props.rows).contextPercent = rowFixture({
      key: "context.auto_compact.percent",
      own: "cleared",
    });
    writable(props.rows).gitName = setRow("git.user.name");
    writable(props.rows).gitEmail = rowFixture({ key: "git.user.email" });
    writable(props.notifications.rows).mode = rowFixture({
      key: "notifications.mode",
      effectiveState: "set",
      effectiveSource: "global",
    });
    writable(props.notifications.rows).telegramEnabled = setRow("notifications.telegram.enabled");
    writable(props.notifications.rows).chatId = rowFixture({
      key: "notifications.telegram.chat_id",
      effectiveState: "cleared",
      effectiveSource: "global",
    });
    writable(props.notifications.rows).publicBaseUrl = rowFixture({
      key: "notifications.public_base_url",
    });
    writable(props.notifications.rows).apiBaseUrl = rowFixture({
      key: "notifications.telegram.api_base_url",
    });
    writable(props.notifications.rows).includeAnswer = setRow("notifications.include_answer");
    writable(props.gitAuthScoped.ssh).app = "set";
    writable(props.notifications.secrets).botToken = {
      ...props.notifications.secrets.botToken,
      status: { state: "set", source: "global" },
    };
    writable(props.rows.model).warnings = ["row warning"];
    writable(props).warnings = ["storage warning"];
    writable(props.notifications).warning = "notify warning";
    writable(props).providers = [
      {
        provider: "deepseek",
        warning: "provider warning",
      } as unknown as SettingsProps["providers"][number],
    ];
    writable(props.modelProviders).providers = [
      {
        warnings: ["model provider warning", "row warning"],
      } as unknown as SettingsProps["modelProviders"]["providers"][number],
    ];
    writable(props.restart).profileWarnings = ["profile warning"];
    writable(props.restart).pending = [
      {
        appId: "p:a",
        appKey: "a",
        projectId: "p",
        reasons: [],
        reasonLabels: [],
        href: "",
        restartAction: "",
        returnTo: "",
      },
      {
        appId: "p:b",
        appKey: "b",
        projectId: "p",
        reasons: [],
        reasonLabels: [],
        href: "",
        restartAction: "",
        returnTo: "",
      },
    ];

    const summary = pageSummary(props);

    expect(summary.setHere).toBe(5);
    expect(summary.inherited).toBe(4);
    expect(summary.attention).toBe(6);
    expect(summary.restartPending).toBe(2);
  });

  it("counts one pending restart when only restartRequired is set", () => {
    const props = makeProps("global");
    writable(props).restartRequired = true;
    writable(props.restart).pending = [];

    expect(pageSummary(props).restartPending).toBe(1);
  });
});

describe("scopeCounts", () => {
  it("counts set values per applicable scope and leaves unavailable scopes null", () => {
    const props = makeProps("app");
    writable(props).scoped = {};
    for (const key of REGISTRY_KEYS) {
      props.scoped[`app:${key}`] = { state: "absent", value: null };
      props.scoped[`project:${key}`] = { state: "absent", value: null };
      props.scoped[`global:${key}`] = { state: "absent", value: null };
    }
    for (const key of REGISTRY_KEYS.slice(0, 3)) {
      props.scoped[`global:${key}`] = { state: "set", value: "x" };
    }
    for (const key of REGISTRY_KEYS.slice(3, 5)) {
      props.scoped[`project:${key}`] = { state: "set", value: "x" };
    }
    props.scoped[`app:${REGISTRY_KEYS[5]}`] = { state: "set", value: "x" };
    writable(props.gitAuthScoped.ssh).global = "set";
    writable(props.gitAuthScoped.https).project = "set";
    writable(props.notifications.secrets).botToken = {
      ...props.notifications.secrets.botToken,
      status: { state: "set", source: "app" },
    };
    writable(props.notifications.secrets).proxyUrl = {
      ...props.notifications.secrets.proxyUrl,
      status: { state: "set", source: "global" },
    };

    expect(scopeCounts(props)).toEqual({ global: 5, project: 3, app: 2 });

    const projectProps = makeProps("project");
    writable(projectProps).scoped = {};
    expect(scopeCounts(projectProps)).toEqual({ global: 0, project: 0, app: null });
  });
});

describe("showsRestartMarker", () => {
  it("marks only launch-effective keys while a restart is pending", () => {
    const props = makeProps("app");
    writable(props).restartRequired = true;
    const model = rowFixture({ key: "llm.model", own: "set" });
    const inheritedModel = rowFixture({ key: "llm.model", own: "absent" });
    const notifications = rowFixture({ key: "notifications.mode", own: "set" });

    expect(showsRestartMarker(props, model)).toBe(true);
    expect(showsRestartMarker(props, inheritedModel)).toBe(false);
    expect(showsRestartMarker(props, notifications)).toBe(false);

    writable(props).restartRequired = false;
    expect(showsRestartMarker(props, model)).toBe(false);
  });
});

describe("attentionSection", () => {
  it("routes to the owning section for the first warning", () => {
    const props = makeProps("app");
    writable(props.rows.model).warnings = ["model warning"];
    expect(attentionSection(props)).toBe("agent");

    const notifications = makeProps("app");
    writable(notifications.notifications).warning = "telegram warning";
    expect(attentionSection(notifications)).toBe("notifications");

    const generic = makeProps("app");
    writable(generic).warnings = ["storage warning"];
    expect(attentionSection(generic)).toBe("restart");
  });
});

describe("sectionForHash", () => {
  it("maps section and legacy detail hashes", () => {
    expect(sectionForHash("#settings-git")).toBe("git");
    expect(sectionForHash("#git-ssh-public-key")).toBe("git");
    expect(sectionForHash("#telegram-bot_token")).toBe("notifications");
    expect(sectionForHash("#restart-pending")).toBe("restart");
    expect(sectionForHash("#providers")).toBe("agent");
    expect(sectionForHash("#unknown")).toBeUndefined();
    expect(sectionForHash("")).toBeUndefined();
  });
});
