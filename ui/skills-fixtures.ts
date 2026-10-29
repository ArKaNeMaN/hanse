/**
 * Test-only builders for the skills props. They mirror the server shapes in
 * `src/http/props/skills.ts` without importing server code.
 */
import type { BootPayload } from "./boot.js";
import type {
  SkillIssueProps,
  SkillPendingAppProps,
  SkillsInventoryProps,
  SkillsInventoryRowProps,
  SkillsLabelsProps,
  SkillsScopeProps,
  SkillWarningProps,
  SkillWorkspaceProps,
} from "./skills-types.js";

export const LABELS: SkillsLabelsProps = {
  navAriaLabel: "Skills",
  scopeGroupLabel: "Skills scope",
  title: "Skills",
  createTitle: "New skill",
  detailTitle: "Skill",
  create: "New skill",
  backToSkills: "Back to skills",
  override: "Override here",
  disable: "Disable here",
  editAtSource: "Edit at source",
  openEffective: "Open effective source",
  openTombstone: "Open tombstone",
  revert: "Revert to inherited",
  openRepair: "Open/repair at context",
  openSource: "Open source",
  save: "Save changes",
  discard: "Discard changes",
  delete: "Delete skill",
};

export function scope(overrides: Partial<SkillsScopeProps> = {}): SkillsScopeProps {
  const value = overrides.scope ?? "global";
  const projectId = overrides.projectId ?? (value === "global" ? null : "p");
  const appKey = overrides.appKey ?? (value === "app" ? "a" : null);
  const base =
    value === "global"
      ? "/skills"
      : value === "project"
        ? `/projects/${projectId}/skills`
        : `/projects/${projectId}/apps/${appKey}/skills`;
  return {
    scope: value,
    scopeLabel: value === "app" ? "Application" : value === "project" ? "Project" : "Global",
    projectId,
    projectName: value === "global" ? null : "Alpha",
    appKey,
    appName: value === "app" ? appKey : null,
    target: {
      ...(projectId === null ? {} : { projectId }),
      ...(appKey === null ? {} : { appKey }),
    },
    href: base,
    inventoryHref: base,
    createHref:
      value === "global"
        ? "/skills/new?scope=global"
        : value === "project"
          ? `/skills/new?scope=project&project=${projectId}`
          : `/skills/new?scope=app&project=${projectId}&app=${appKey}`,
    settingsHref:
      value === "global"
        ? "/settings"
        : value === "project"
          ? `/projects/${projectId}/settings`
          : `/projects/${projectId}/apps/${appKey}/settings`,
    breadcrumb: [{ label: "Skills" }],
    nav: {
      ariaLabel: "Skills",
      groupLabel: "Skills scope",
      globalHref: "/skills",
      projectHref: projectId === null ? null : `/projects/${projectId}/skills`,
      appHref:
        projectId === null || appKey === null
          ? null
          : `/projects/${projectId}/apps/${appKey}/skills`,
      currentScope: value,
    },
    options: [
      {
        scope: "global",
        label: "Global",
        shortLabel: null,
        href: "/skills",
        current: value === "global",
      },
      {
        scope: "project",
        label: "Project",
        shortLabel: null,
        href: projectId === null ? null : `/projects/${projectId}/skills`,
        current: value === "project",
      },
      {
        scope: "app",
        label: "Application",
        shortLabel: "App",
        href:
          projectId === null || appKey === null
            ? null
            : `/projects/${projectId}/apps/${appKey}/skills`,
        current: value === "app",
      },
    ],
    ...overrides,
  };
}

export function issue(overrides: Partial<SkillIssueProps> = {}): SkillIssueProps {
  return {
    code: "invalid_skill_metadata",
    message: "The stored metadata is not valid JSON: bad",
    anchor: "#skill-metadata-raw",
    ...overrides,
  };
}

export function warning(overrides: Partial<SkillWarningProps> = {}): SkillWarningProps {
  return {
    code: "skill_collision",
    name: "alpha-skill",
    root: "/repo/.opencode/skill",
    text: '"alpha-skill" also exists at /repo/.opencode/skill',
    ...overrides,
  };
}

export function pending(overrides: Partial<SkillPendingAppProps> = {}): SkillPendingAppProps {
  return {
    projectId: "p",
    appKey: "a",
    href: "/projects/p/apps/a",
    restartAction: "/api/apps/a/restart?project=p",
    returnTo: "/skills/7",
    ...overrides,
  };
}

export function row(overrides: Partial<SkillsInventoryRowProps> = {}): SkillsInventoryRowProps {
  return {
    id: 7,
    primaryId: 7,
    name: "alpha-skill",
    description: "Alpha skill used by the fixture.",
    scope: "global",
    state: "enabled",
    stateLabel: "Enabled here",
    enabled: true,
    overridden: false,
    shadowed: false,
    shadows: [],
    originScope: "global",
    originText: "Defined here",
    references: 1,
    updatedAt: "2026-10-28T10:00:00.000Z",
    issues: [],
    collisions: [],
    repairId: null,
    effectiveId: null,
    effectiveScope: null,
    href: "/skills/7?from=%2Fskills",
    effectiveHref: null,
    actionLabel: "Open alpha-skill",
    ...overrides,
  };
}

export function inventory(overrides: Partial<SkillsInventoryProps> = {}): SkillsInventoryProps {
  const currentScope = scope(overrides.scope ?? {});
  const rows = overrides.rows ?? [
    row(),
    row({
      id: 8,
      primaryId: 8,
      name: "inherited-skill",
      state: "inherited",
      stateLabel: "Inherited",
      originScope: "project",
      originText: "Inherited from Project",
      href: "/skills/8?from=%2Fskills",
    }),
    row({
      id: 9,
      primaryId: 9,
      name: "disabled-skill",
      state: "disabled",
      stateLabel: "Disabled here",
      enabled: false,
      href: "/skills/9?from=%2Fskills",
    }),
    row({
      id: 10,
      primaryId: 10,
      name: "invalid-skill",
      state: "invalid",
      stateLabel: "Invalid here",
      issues: [issue()],
      repairId: 10,
      href: "/skills/10?from=%2Fskills",
    }),
  ];
  return {
    scope: currentScope,
    title: "Skills",
    description: "Reusable procedures every application can load.",
    overline: currentScope.scopeLabel,
    meta: [],
    breadcrumb: currentScope.breadcrumb,
    rows,
    allCount: rows.length,
    matchedCount: rows.length,
    counts: { enabled: 1, inherited: 1, disabled: 1, invalid: 1 },
    filter: "all",
    filters: [
      { value: "all", label: "All", href: currentScope.href, current: true },
      {
        value: "defined",
        label: "Defined here",
        href: `${currentScope.href}?filter=defined`,
        current: false,
      },
      {
        value: "inherited",
        label: "Inherited",
        href: `${currentScope.href}?filter=inherited`,
        current: false,
      },
      {
        value: "disabled",
        label: "Disabled",
        href: `${currentScope.href}?filter=disabled`,
        current: false,
      },
      {
        value: "invalid",
        label: "Invalid",
        href: `${currentScope.href}?filter=invalid`,
        current: false,
      },
    ],
    search: {
      action: currentScope.href,
      query: "",
      hiddenFilter: null,
      clearHref: currentScope.href,
    },
    createHref: currentScope.createHref,
    createLabel: "New skill",
    empty: null,
    error: null,
    warnings: [],
    truncated: null,
    pending: [],
    returnTo: currentScope.href,
    labels: LABELS,
    ...overrides,
  };
}

export function workspace(overrides: Partial<SkillWorkspaceProps> = {}): SkillWorkspaceProps {
  const currentScope = scope(overrides.scope ?? {});
  const base: SkillWorkspaceProps = {
    create: false,
    id: 7,
    name: "alpha-skill",
    description: "Alpha skill used by the fixture.",
    title: "alpha-skill",
    overline: "GLOBAL SKILL",
    meta: ["MIT", "1 references"],
    breadcrumb: currentScope.breadcrumb,
    contextPage: currentScope.href,
    projectId: currentScope.projectId,
    scope: currentScope,
    row: {
      id: 7,
      name: "alpha-skill",
      scope: "global",
      description: "Alpha skill used by the fixture.",
      enabled: true,
      license: "MIT",
      compatibility: null,
      metadata: {},
      metadataRaw: null,
      updatedAt: "2026-10-28T10:00:00.000Z",
      storedIssues: [],
    },
    values: {
      name: "alpha-skill",
      description: "Alpha skill used by the fixture.",
      content: "## Body\n\nSynthetic content only.",
      enabled: true,
      bundle: {
        license: "MIT",
        compatibility: null,
        metadata: { domain: "engineering" },
        metadataRaw: null,
        references: [
          { path: "references/notes.md", content: "# Notes\n\nReference body.", size: 22 },
        ],
      },
    },
    state: {
      name: "editable",
      label: "Enabled here",
      note: "Defined at this scope. Saving changes applies to this row only.",
      editable: true,
      contextScope: "global",
      contextTarget: {},
      effectiveHere: true,
    },
    visibility: { enabled: true, overridden: false, shadowed: false, shadows: [] },
    stateBadge: { name: "editable", label: "Enabled here", tone: "success" },
    actions: {
      target: { scope: "global", projectId: null, appKey: null, returnTo: currentScope.href },
      override: null,
      disable: null,
      revert: null,
      editAtSource: null,
      openEffective: null,
      openTombstone: null,
      openRepair: null,
      openSource: null,
    },
    header: {
      overline: "GLOBAL SKILL",
      title: "alpha-skill",
      description: "Alpha skill used by the fixture.",
      meta: ["MIT", "1 references"],
      backHref: null,
    },
    form: {
      action: "/api/skills/7",
      method: "post",
      mode: "update",
      name: "alpha-skill",
      returnTo: "/skills/7",
      target: { scope: "global", projectId: null, appKey: null, returnTo: "/skills/7" },
      bundleSnapshot: "{}",
      saveLabel: "Save changes",
      discardLabel: "Discard changes",
      nameField: null,
      description: {
        value: "Alpha skill used by the fixture.",
        hintId: "skill-description-hint",
        error: null,
      },
      enabled: { checked: true, hint: "Uncheck to hide this skill.", error: null },
    },
    danger: {
      action: "/api/skills/7/delete",
      returnTo: "/skills",
      label: "Delete skill",
      explanation: "Delete this skill permanently. This cannot be undone.",
      expectedName: "alpha-skill",
      invalidName: false,
    },
    issues: [],
    collisions: [],
    warnings: [],
    restart: null,
    error: null,
    conflict: null,
    labels: LABELS,
  };
  return { ...base, ...overrides };
}

export function boot(
  payload: unknown,
  routeId: BootPayload["route"]["id"] = "skills-global",
  params: Record<string, string> = {},
): BootPayload {
  return {
    route: { id: routeId, params },
    props: payload,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Skills",
      active: "skills",
      pendingCount: 0,
      sshPendingCount: 0,
    },
  };
}
