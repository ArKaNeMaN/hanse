/** Structural mirror of `src/http/props/targets.ts` for the client. */

export interface TargetAppProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly appKey: string;
  readonly kind: string | null;
  readonly master: boolean;
}

export interface TargetProjectProps {
  readonly id: string;
  readonly name: string;
  readonly apps: readonly TargetAppProps[];
}

export interface TargetsProps {
  readonly projects: readonly TargetProjectProps[];
  readonly master: TargetAppProps | null;
}

export type Target =
  | { kind: "global" }
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "app"; projectId: string; appKey: string; master?: boolean };

export type TargetSelectorConfig =
  | { mode: "scope"; root: "global" | null }
  | { mode: "apps"; root: "master" | "all" | null; fixedProjectId?: string }
  | { mode: "projects" };
