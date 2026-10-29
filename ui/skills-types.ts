/**
 * Structural mirror of `src/http/props/skills.ts` for the client.
 *
 * `GET /api/ui/skills`, `GET /api/ui/skills/:id`, and the skills boot payload share these shapes.
 * Keeping the mirror in `ui/` avoids importing server code into the Vite bundle. Skill content and
 * references are content, not credentials: settings secrets, provider keys, and tokens are never
 * part of these props.
 */

import type { BootChrome } from "./boot.js";

export type SkillScope = "global" | "project" | "app";
export type InventoryState = "enabled" | "inherited" | "disabled" | "invalid";
export type InventoryFilter = "all" | "defined" | "inherited" | "disabled" | "invalid";
export type WorkspaceStateName =
  | "editable"
  | "tombstone"
  | "invalid-owned"
  | "invalid-owned-name"
  | "inherited"
  | "shadowed"
  | "hidden"
  | "invalid-context"
  | "not-effective";

export interface SkillTarget {
  readonly projectId?: string;
  readonly appKey?: string;
}

export interface SkillWarningProps {
  readonly code: "skill_collision" | "skill_disabled_elsewhere";
  readonly name: string | null;
  readonly root: string | null;
  readonly text: string;
}

export interface SkillIssueProps {
  readonly code:
    | "invalid_skill_name"
    | "invalid_skill_metadata"
    | "invalid_skill_reference"
    | "invalid_skill_bundle";
  readonly message: string;
  readonly anchor: string | null;
}

export interface SkillPendingAppProps {
  readonly projectId: string;
  readonly appKey: string;
  readonly href: string;
  readonly restartAction: string;
  readonly returnTo: string;
}

export interface SkillsScopeNavProps {
  readonly ariaLabel: string;
  readonly groupLabel: string;
  readonly globalHref: string;
  readonly projectHref: string | null;
  readonly appHref: string | null;
  readonly currentScope: SkillScope;
}

export interface SkillsScopeOptionProps {
  readonly scope: SkillScope;
  readonly label: string;
  readonly shortLabel: string | null;
  readonly href: string | null;
  readonly current: boolean;
}

export interface SkillsScopeProps {
  readonly scope: SkillScope;
  readonly scopeLabel: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly appKey: string | null;
  readonly appName: string | null;
  readonly target: SkillTarget;
  readonly href: string;
  readonly inventoryHref: string;
  readonly createHref: string;
  readonly settingsHref: string | null;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly nav: SkillsScopeNavProps;
  readonly options: readonly SkillsScopeOptionProps[];
}

export interface SkillsInventoryRowProps {
  readonly id: number;
  readonly primaryId: number;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly state: InventoryState;
  readonly stateLabel: string;
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly shadowed: boolean;
  readonly shadows: readonly SkillScope[];
  readonly originScope: SkillScope;
  readonly originText: string;
  readonly references: number;
  readonly updatedAt: string;
  readonly issues: readonly SkillIssueProps[];
  readonly collisions: readonly SkillWarningProps[];
  readonly repairId: number | null;
  readonly effectiveId: number | null;
  readonly effectiveScope: SkillScope | null;
  readonly href: string;
  readonly effectiveHref: string | null;
  readonly actionLabel: string;
}

export interface SkillsFilterProps {
  readonly value: InventoryFilter;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface SkillsSearchProps {
  readonly action: string;
  readonly query: string;
  readonly hiddenFilter: InventoryFilter | null;
  readonly clearHref: string;
}

export interface SkillsEmptyProps {
  readonly kind: "none" | "search" | "filter";
  readonly iconName: "code" | "search" | "inbox";
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly actionHref: string;
  readonly actionStyle: "primary" | "secondary";
  readonly actionIcon: "plus" | null;
}

export interface SkillsCountsProps {
  readonly enabled: number;
  readonly inherited: number;
  readonly disabled: number;
  readonly invalid: number;
}

export interface SkillsLabelsProps {
  readonly navAriaLabel: string;
  readonly scopeGroupLabel: string;
  readonly title: string;
  readonly createTitle: string;
  readonly detailTitle: string;
  readonly create: string;
  readonly backToSkills: string;
  readonly override: string;
  readonly disable: string;
  readonly editAtSource: string;
  readonly openEffective: string;
  readonly openTombstone: string;
  readonly revert: string;
  readonly openRepair: string;
  readonly openSource: string;
  readonly save: string;
  readonly discard: string;
  readonly delete: string;
}

export interface SkillsInventoryProps {
  readonly scope: SkillsScopeProps;
  readonly title: string;
  readonly description: string;
  readonly overline: string;
  readonly meta: readonly string[];
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly rows: readonly SkillsInventoryRowProps[];
  readonly allCount: number;
  readonly matchedCount: number;
  readonly counts: SkillsCountsProps;
  readonly filter: InventoryFilter;
  readonly filters: readonly SkillsFilterProps[];
  readonly search: SkillsSearchProps;
  readonly createHref: string;
  readonly createLabel: string;
  readonly empty: SkillsEmptyProps | null;
  readonly error: { readonly message: string } | null;
  readonly warnings: readonly SkillWarningProps[];
  readonly truncated: number | null;
  readonly pending: readonly SkillPendingAppProps[];
  readonly returnTo: string;
  readonly labels: SkillsLabelsProps;
}

export interface SkillMetadata {
  readonly [key: string]: string;
}

export interface SkillReferenceProps {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

export interface SkillBundleProps {
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: SkillMetadata;
  readonly metadataRaw: string | null;
  readonly references: readonly SkillReferenceProps[];
}

export interface SkillStateProps {
  readonly name: WorkspaceStateName;
  readonly label: string;
  readonly note: string;
  readonly editable: boolean;
  readonly contextScope: SkillScope;
  readonly contextTarget: SkillTarget;
  readonly effectiveHere: boolean;
}

export interface SkillVisibilityProps {
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly shadowed: boolean;
  readonly shadows: readonly SkillScope[];
}

export interface SkillActionFormProps {
  readonly action: string;
  readonly returnTo: string;
  readonly fromId: number | null;
  readonly enabled: "1" | "0" | null;
  readonly confirm: string | null;
  readonly label: string;
  readonly style: "primary" | "secondary";
}

export interface SkillActionLinkProps {
  readonly href: string;
  readonly label: string;
  readonly style: "primary" | "secondary" | "ghost";
}

export interface SkillTargetFieldsProps {
  readonly scope: SkillScope;
  readonly projectId: string | null;
  readonly appKey: string | null;
  readonly returnTo: string;
}

export interface SkillActionsProps {
  readonly target: SkillTargetFieldsProps;
  readonly override: SkillActionFormProps | null;
  readonly disable: SkillActionFormProps | null;
  readonly revert: SkillActionFormProps | null;
  readonly editAtSource: SkillActionLinkProps | null;
  readonly openEffective: SkillActionLinkProps | null;
  readonly openTombstone: SkillActionLinkProps | null;
  readonly openRepair: SkillActionLinkProps | null;
  readonly openSource: SkillActionLinkProps | null;
}

export interface SkillFormFieldProps {
  readonly value: string;
  readonly hintId: string;
  readonly error: string | null;
}

export interface SkillNameFieldProps {
  readonly value: string;
  readonly required: boolean;
  readonly maxlength: number;
  readonly pattern: string;
  readonly hint: string;
  readonly error: string | null;
}

export interface SkillFormProps {
  readonly action: string;
  readonly method: "post";
  readonly mode: "create" | "update";
  readonly name: string;
  readonly returnTo: string;
  readonly target: SkillTargetFieldsProps;
  readonly bundleSnapshot: string;
  readonly saveLabel: string;
  readonly discardLabel: string;
  readonly nameField: SkillNameFieldProps | null;
  readonly description: SkillFormFieldProps;
  readonly enabled: {
    readonly checked: boolean;
    readonly hint: string;
    readonly error: string | null;
  };
}

export interface SkillDangerProps {
  readonly action: string;
  readonly returnTo: string;
  readonly label: string;
  readonly explanation: string;
  readonly expectedName: string;
  readonly invalidName: boolean;
}

export interface SkillRestartProps {
  readonly kind: "none" | "required";
  readonly hint: string;
  readonly entries: readonly SkillPendingAppProps[];
}

export interface SkillWorkspaceRowProps {
  readonly id: number;
  readonly name: string;
  readonly scope: SkillScope;
  readonly description: string;
  readonly enabled: boolean;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: SkillMetadata;
  readonly metadataRaw: string | null;
  readonly updatedAt: string;
  readonly storedIssues: readonly SkillIssueProps[];
}

export interface SkillWorkspaceProps {
  readonly create: boolean;
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly title: string;
  readonly overline: string;
  readonly meta: readonly string[];
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly contextPage: string;
  readonly projectId: string | null;
  readonly scope: SkillsScopeProps;
  readonly row: SkillWorkspaceRowProps;
  readonly values: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly enabled: boolean;
    readonly bundle: SkillBundleProps;
  };
  readonly state: SkillStateProps;
  readonly visibility: SkillVisibilityProps;
  readonly stateBadge: {
    readonly name: WorkspaceStateName | "draft";
    readonly label: string;
    readonly tone: "success" | "warning" | "error" | "info";
  };
  readonly actions: SkillActionsProps;
  readonly header: {
    readonly overline: string;
    readonly title: string;
    readonly description: string;
    readonly meta: readonly string[];
    readonly backHref: string | null;
  };
  readonly form: SkillFormProps | null;
  readonly danger: SkillDangerProps | null;
  readonly issues: readonly SkillIssueProps[];
  readonly collisions: readonly SkillWarningProps[];
  readonly warnings: readonly SkillWarningProps[];
  readonly restart: SkillRestartProps | null;
  readonly error: { readonly message: string; readonly field: string | null } | null;
  readonly conflict: { readonly id: number; readonly href: string } | null;
  readonly labels: SkillsLabelsProps;
}

export interface SkillsResponse extends SkillsInventoryProps {
  readonly chrome?: BootChrome;
}

export interface SkillDetailResponse extends SkillWorkspaceProps {
  readonly chrome?: BootChrome;
}

/** Mutable editor model; the server bundle snapshot is rebuilt from it on save. */
export interface SkillReferenceDraft {
  path: string;
  content: string;
}

export interface SkillCustomMetadataDraft {
  key: string;
  value: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  license: string;
  compatibility: string;
  /** Only the eight known metadata keys; empty values are dropped on save. */
  knownMetadata: Record<string, string>;
  /** Extra key/value rows preserved for tooling the operator controls. */
  customMetadata: SkillCustomMetadataDraft[];
  metadataRaw: string | null;
  references: SkillReferenceDraft[];
}

export interface KnownMetadataField {
  readonly key: string;
  readonly label: string;
  readonly group: "classification" | "discovery" | "version";
  readonly hint: string;
  readonly datalist?: readonly string[];
}

/** Mirrors `KNOWN_METADATA` in `src/http/skills.ts`; no server import crosses the client boundary. */
export const KNOWN_SKILL_METADATA: readonly KnownMetadataField[] = [
  {
    key: "domain",
    label: "Domain",
    group: "classification",
    hint: "The broad area the skill belongs to, such as engineering or operations.",
  },
  {
    key: "role",
    label: "Role",
    group: "classification",
    hint: "The role the agent plays while using the skill.",
  },
  {
    key: "scope",
    label: "Operating scope",
    group: "classification",
    hint: "What part of the work it covers, such as one repository or a whole project.",
  },
  {
    key: "output-format",
    label: "Output format",
    group: "classification",
    hint: "The expected result shape: mixed, code, report, document, plan, or decision.",
    datalist: ["mixed", "code", "report", "document", "plan", "decision"],
  },
  {
    key: "triggers",
    label: "Triggers",
    group: "discovery",
    hint: "Comma-separated cues that tell the agent when to load the skill.",
  },
  {
    key: "related-skills",
    label: "Related skills",
    group: "discovery",
    hint: "Comma-separated skill names worth loading alongside this one.",
  },
  {
    key: "version",
    label: "Version",
    group: "version",
    hint: "A short version label, such as 1.0.0.",
  },
  {
    key: "author",
    label: "Author",
    group: "version",
    hint: "The person or team responsible for the skill.",
  },
];

/** Mirrors `SKILL_LIMITS` in `src/skills/validation.ts` for client-side validation only. */
export const SKILL_LIMITS = {
  name: 64,
  description: 1024,
  content: 48000,
  license: 256,
  compatibility: 512,
  metadataEntries: 32,
  metadataKey: 64,
  metadataValue: 1024,
  references: 20,
  referencePath: 78,
  referenceContent: 48000,
  referenceAggregate: 192000,
} as const;

export const SKILL_REFERENCE_PATH = /^references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
export const SKILL_METADATA_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
