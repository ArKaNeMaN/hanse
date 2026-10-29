/**
 * Structural mirror of `src/http/props/settings.ts` for the client.
 *
 * `GET /api/ui/settings` and the settings boot payload share this shape. Keeping the mirror in the
 * client avoids importing server code into the Vite bundle. The contract is intentionally
 * write-only for secrets: the props carry only status metadata and the literal "Not shown" marker,
 * never provider keys, git tokens, private keys, or known-hosts content.
 */

import type { BootChrome } from "./boot.js";

export type SettingsScope = "global" | "project" | "app";
export type SettingsScopeSource = SettingsScope | "default";
export type SettingsScopeState = "absent" | "set" | "cleared";
export type GitAuthKind = "ssh" | "https";
export type GitAuthScopedState = "absent" | "set" | "cleared";

export interface ScopedValue {
  readonly state: SettingsScopeState;
  readonly value: unknown;
}

export interface EffectiveValue {
  readonly value: unknown;
  readonly state: "set" | "cleared" | "default";
  readonly source: SettingsScopeSource;
  readonly sources: readonly SettingsScopeSource[];
}

export type ProviderKeyStatus =
  | { readonly state: "set"; readonly source: SettingsScope }
  | { readonly state: "cleared"; readonly source: SettingsScope }
  | { readonly state: "missing" }
  | { readonly state: "host"; readonly source: "host-auth"; readonly authType: string }
  | { readonly state: "error"; readonly message: string };

export type GitAuthStatus =
  | {
      readonly state: "set";
      readonly kind: "ssh";
      readonly source: SettingsScope;
      readonly publicKey: string;
      readonly fingerprint: string;
      readonly hasKnownHosts: boolean;
    }
  | {
      readonly state: "set";
      readonly kind: "https";
      readonly source: SettingsScope;
      readonly hosts: readonly string[];
      readonly username: string;
    }
  | { readonly state: "cleared"; readonly kind: GitAuthKind; readonly source: SettingsScope }
  | { readonly state: "error"; readonly kind: GitAuthKind; readonly message: string }
  | { readonly state: "missing"; readonly kind: GitAuthKind };

export interface SettingsScopeOptionProps {
  readonly value: string;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface SettingsAppOptionProps extends SettingsScopeOptionProps {
  readonly appKey: string;
}

export interface SettingsProjectOptionProps extends SettingsScopeOptionProps {
  readonly projectId: string;
  readonly apps: readonly SettingsAppOptionProps[];
}

export interface SettingsScopeProps {
  readonly scope: SettingsScope;
  readonly scopeLabel: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly appKey: string | null;
  readonly appId: string | null;
  readonly href: string;
  readonly settingsHref: string;
  readonly skillsHref: string;
  readonly title: string;
  readonly description: string;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly nav: {
    readonly globalHref: string;
    readonly projectHref: string | null;
    readonly appHref: string | null;
    readonly projectCurrent: boolean;
    readonly appCurrent: boolean;
    readonly projectShortLabel: string;
    readonly appShortLabel: string;
  };
  readonly hrefs: {
    readonly global: string;
    readonly project: string | null;
    readonly app: string | null;
  };
  readonly projects: readonly SettingsProjectOptionProps[];
}

export interface SettingsEffectiveProps {
  readonly value: unknown;
  readonly state: "set" | "cleared" | "default";
  readonly source: SettingsScopeSource;
  readonly sources: readonly SettingsScopeSource[];
  readonly text: string;
  readonly sourceLine: string;
}

export interface SettingsScopeDetailProps {
  readonly scope: SettingsScope;
  readonly label: string;
  readonly state: SettingsScopeState;
  readonly stateLabel: string;
  readonly valueText: string | null;
}

export interface SettingsRowActionProps {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly label: string;
  readonly confirmLabel: string | null;
  readonly reason: string | null;
  readonly warning: string | null;
}

export interface SettingsRowActionsProps {
  readonly save: SettingsRowActionProps;
  readonly inherit: SettingsRowActionProps | null;
  readonly clear: SettingsRowActionProps | null;
}

export interface SettingsFormProps {
  readonly action: string;
  readonly method: "post";
  readonly successNotice: string;
  readonly returnTo: string;
  readonly hidden: {
    readonly scope: SettingsScope;
    readonly projectId: string | null;
    readonly appKey: string | null;
    readonly returnTo: string;
  };
}

export interface SettingsSelectOptionProps {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface SettingsDriverFieldProps {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "number" | "checkbox";
  readonly min: number | null;
  readonly max: number | null;
  readonly placeholder: string | null;
  readonly value: string;
  readonly checked: boolean;
  readonly required: boolean;
}

export interface SettingsDriverControlProps {
  readonly options: readonly SettingsSelectOptionProps[];
  readonly placeholder: SettingsSelectOptionProps | null;
  readonly fields: readonly SettingsDriverFieldProps[];
  readonly showFields: boolean;
}

export interface SettingsNumberControlProps {
  readonly value: string;
  readonly placeholder: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly required: boolean;
}

export interface SettingsSelectControlProps {
  readonly options: readonly SettingsSelectOptionProps[];
  readonly placeholder: SettingsSelectOptionProps | null;
}

export interface SettingsTextControlProps {
  readonly value: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly autocomplete: string | null;
  readonly listId: string | null;
  readonly options: readonly string[];
}

export type SettingsRowKind =
  | "model"
  | "web"
  | "context-enabled"
  | "context-percent"
  | "git-identity";

export interface SettingsRowProps {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly hint: string | null;
  readonly kind: SettingsRowKind;
  readonly effective: SettingsEffectiveProps;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly own: ScopedValue;
  readonly warnings: readonly string[];
  readonly scopeDetails: readonly SettingsScopeDetailProps[];
  readonly actions: SettingsRowActionsProps;
  readonly form: SettingsFormProps;
  readonly text: SettingsTextControlProps | null;
  readonly select: SettingsSelectControlProps | null;
  readonly number: SettingsNumberControlProps | null;
  readonly driver: SettingsDriverControlProps | null;
  readonly inheritedNote: string | null;
  readonly errorSlotId: string;
}

export interface SettingsProviderRowProps {
  readonly provider: string;
  readonly status: ProviderKeyStatus;
  readonly state: "set" | "cleared" | "missing" | "host" | "error";
  readonly configured: boolean;
  readonly usable: boolean;
  readonly masked: string;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly warning: string | null;
  readonly rowId: string;
  readonly errorSlotId: string;
  readonly actions: SettingsRowActionsProps;
  readonly form: SettingsFormProps;
}

export interface SettingsModelProviderRowProps {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly {
    readonly id: string;
    readonly name?: string;
    readonly limit: { readonly context: number; readonly output: number };
  }[];
  readonly modelsText: string;
  readonly warnings: readonly string[];
  readonly key: {
    readonly status: ProviderKeyStatus;
    readonly state: "set" | "cleared" | "missing" | "host" | "error";
    readonly label: string;
    readonly masked: string;
  };
  readonly rowId: string;
  readonly nameInputId: string;
  readonly urlInputId: string;
  readonly modelsInputId: string;
  readonly errorId: string;
  readonly actions: {
    readonly update: string;
    readonly delete: string;
    readonly returnTo: string;
  };
}

export interface SettingsModelProvidersProps {
  readonly providers: readonly SettingsModelProviderRowProps[];
  readonly count: number;
  readonly add: {
    readonly action: string;
    readonly returnTo: string;
    readonly errorId: string;
  };
  readonly manageHref: string;
}

export interface SettingsGitCredentialProps {
  readonly kind: GitAuthKind;
  readonly title: string;
  readonly status: GitAuthStatus;
  readonly state: "set" | "cleared" | "missing" | "error";
  readonly configured: boolean;
  readonly hasSecret: boolean;
  readonly masked: string;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly scopedState: GitAuthScopedState;
  readonly scoped: Record<SettingsScope, GitAuthScopedState>;
  readonly scopeDetails: readonly SettingsScopeDetailProps[];
  readonly allowTest: boolean;
  readonly inheritReason: string | null;
  readonly clearReason: string | null;
  readonly details: {
    readonly publicKey: string | null;
    readonly fingerprint: string | null;
    readonly hasKnownHosts: boolean | null;
    readonly hosts: readonly string[] | null;
    readonly username: string | null;
    readonly error: string | null;
  };
  readonly actions: {
    readonly action: string;
    readonly test: string | null;
    readonly allowTest: boolean;
  };
  readonly form: SettingsFormProps;
}

export interface SettingsGitProps {
  readonly identity: readonly SettingsRowProps[];
  readonly ssh: SettingsGitCredentialProps;
  readonly https: SettingsGitCredentialProps;
  readonly testAppPath: string | null;
  readonly testCheck: {
    readonly hint: string;
    readonly href: string | null;
  };
  readonly securityNotes: string;
}

export interface SettingsPendingRowProps {
  readonly appId: string;
  readonly appKey: string;
  readonly projectId: string;
  readonly reasons: readonly string[];
  readonly reasonLabels: readonly string[];
  readonly href: string;
  readonly restartAction: string;
  readonly returnTo: string;
}

export interface SettingsRestartProps {
  readonly pending: readonly SettingsPendingRowProps[];
  readonly restartRequired: boolean;
  readonly profileWarnings: readonly string[];
  readonly returnTo: string;
  readonly hint: string;
}

export interface SettingsLabelsProps {
  readonly nav: {
    readonly ariaLabel: string;
    readonly scopeLabel: string;
    readonly sectionsLabel: string;
    readonly scopes: Readonly<Record<SettingsScope | "applicationShort", string>>;
    readonly sections: {
      readonly agent: string;
      readonly web: string;
      readonly context: string;
      readonly git: string;
      readonly restart: string;
    };
  };
  readonly sections: {
    readonly agent: string;
    readonly web: string;
    readonly context: string;
    readonly git: string;
    readonly restart: string;
  };
  readonly actions: {
    readonly save: string;
    readonly inherit: string;
    readonly clear: string;
    readonly clearTitle: string;
    readonly clearBody: string;
    readonly clearConfirm: string;
    readonly cancel: string;
    readonly restartAgent: string;
    readonly testConnection: string;
  };
  readonly providers: {
    readonly title: string;
    readonly hint: string;
    readonly empty: string;
    readonly addTitle: string;
    readonly keyLabel: string;
    readonly providerLabel: string;
    readonly providerPlaceholder: string;
    readonly changeKey: string;
    readonly masked: string;
  };
  readonly modelProviders: {
    readonly title: string;
    readonly hint: string;
    readonly empty: string;
    readonly addTitle: string;
    readonly globalHint: string;
    readonly manage: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly models: string;
    readonly modelsHint: string;
    readonly providerId: string;
    readonly providerIdPlaceholder: string;
    readonly namePlaceholder: string;
    readonly baseUrlPlaceholder: string;
    readonly modelsPlaceholder: string;
    readonly deleteConfirmPrefix: string;
    readonly modelsCount: string;
  };
  readonly git: {
    readonly title: string;
    readonly badge: string;
    readonly noscript: string;
    readonly user: string;
    readonly email: string;
    readonly ssh: string;
    readonly https: string;
    readonly key: {
      readonly overline: string;
      readonly fingerprint: string;
      readonly knownHosts: string;
      readonly knownHostsSet: string;
      readonly knownHostsUnset: string;
      readonly allowedHosts: string;
      readonly username: string;
      readonly cleared: string;
      readonly missing: string;
    };
    readonly testApp: string;
    readonly credentialCheck: string;
    readonly credentialCheckHint: string;
    readonly appSettings: string;
    readonly testHint: string;
    readonly securityNotes: string;
  };
  readonly restart: {
    readonly title: string;
    readonly badge: string;
    readonly hint: string;
    readonly empty: string;
    readonly profileWarnings: string;
  };
  readonly warnings: string;
}

export interface SettingsDialogsProps {
  readonly clear: {
    readonly id: string;
    readonly titleId: string;
    readonly metaId: string;
    readonly bodyId: string;
    readonly formId: string;
    readonly action: string;
    readonly title: string;
    readonly body: string;
    readonly fieldError: string;
    readonly cancel: string;
    readonly submit: string;
  };
}

export interface SettingsProps {
  readonly scope: SettingsScopeProps;
  readonly effective: unknown;
  readonly scoped: Record<string, ScopedValue>;
  readonly providerKeys: Record<string, ProviderKeyStatus>;
  readonly gitAuth: { readonly ssh: GitAuthStatus; readonly https: GitAuthStatus };
  readonly gitAuthScoped: {
    readonly ssh: Record<SettingsScope, GitAuthScopedState>;
    readonly https: Record<SettingsScope, GitAuthScopedState>;
  };
  readonly warnings: readonly string[];
  readonly pendingRestart: readonly {
    readonly appId: string;
    readonly appKey: string;
    readonly projectId: string;
    readonly reasons: readonly string[];
  }[];
  readonly notice: { readonly message: string; readonly tone: "success" | "error" } | null;
  readonly rows: {
    readonly model: SettingsRowProps;
    readonly webSearch: SettingsRowProps;
    readonly webFetch: SettingsRowProps;
    readonly contextEnabled: SettingsRowProps;
    readonly contextPercent: SettingsRowProps;
    readonly gitName: SettingsRowProps;
    readonly gitEmail: SettingsRowProps;
  };
  readonly providers: readonly SettingsProviderRowProps[];
  readonly modelProviders: SettingsModelProvidersProps;
  readonly git: SettingsGitProps;
  readonly restart: SettingsRestartProps;
  readonly labels: SettingsLabelsProps;
  readonly dialogs: SettingsDialogsProps;
  readonly dirty: boolean;
  readonly restartRequired: boolean;
}

export interface SettingsResponse extends SettingsProps {
  readonly chrome?: BootChrome;
}

export interface GitTestResult {
  readonly ok: true;
  readonly kind: GitAuthKind;
  readonly remote: string;
  readonly refs: number;
  readonly head?: string;
  readonly warnings: readonly string[];
}
