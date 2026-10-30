import type { BootChrome } from "../boot.js";
import type { RuntimeState } from "../status.js";

export interface TerminalCrumb {
  readonly label: string;
  readonly href?: string;
}

export interface TerminalAppProps {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly appKey: string;
  readonly href: string;
  readonly folder: string;
}

export interface TerminalLinksProps {
  readonly app: string;
  readonly chat: string;
  readonly ide: string;
}

export interface TerminalRuntimeProps {
  readonly state: RuntimeState;
  readonly wsPath: string;
  readonly runtimeUrl: string;
}

export interface TerminalTopbarProps {
  readonly ideHref: string;
}

/** Structural mirror of `src/http/props/terminal.ts`; the client never imports server code. */
export interface TerminalPageProps {
  readonly app: TerminalAppProps;
  readonly links: TerminalLinksProps;
  readonly runtime: TerminalRuntimeProps;
  readonly deleting: boolean;
  readonly breadcrumb: readonly TerminalCrumb[];
  readonly title: string;
  readonly topbar: TerminalTopbarProps;
}

export interface TerminalResponse extends TerminalPageProps {
  readonly chrome: BootChrome;
}
