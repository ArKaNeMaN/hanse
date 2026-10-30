/**
 * Types for the pure slash-command helpers shared with the frozen legacy client. The
 * implementation stays a plain browser ESM module with no DOM, network, timer, or storage access.
 */

import type { CommandEntry, HanseCommandAction, ShellPresence } from "../src/opencode/commands.js";

export type { CommandEntry, HanseCommandAction, ShellPresence };

export interface HanseActionSpec {
  name: string;
  aliases: string[];
  action: HanseCommandAction;
  description: string;
  masterAvailable: boolean;
  masterReason?: string;
}

export interface ParsedComposerText {
  kind: "text";
  text: string;
}

export interface ParsedComposerCommand {
  kind: "command";
  token: string;
  args: string;
}

export type ResolvedComposerCommand =
  | { kind: "opencode"; entry: CommandEntry; shadowed: boolean }
  | { kind: "hanse"; entry: CommandEntry; action: HanseCommandAction }
  | { kind: "disabled"; entry: CommandEntry; reason: string }
  | { kind: "unknown" };

export const UNKNOWN_ACTION_REASON: string;
export const MASTER_EDITOR_REASON: string;
export const MASTER_DIFF_REASON: string;
export const HANSE_ACTIONS: readonly HanseActionSpec[];

export function hanseFallbackEntries(master: boolean): CommandEntry[];
export function parseComposerCommand(text: string): ParsedComposerText | ParsedComposerCommand;
export function matchCommand(
  commands: readonly CommandEntry[],
  token: string,
): CommandEntry | undefined;
export function filterCommands(
  commands: readonly CommandEntry[],
  query: string,
): CommandEntry[];
export function groupCommands(
  commands: readonly CommandEntry[],
): Array<{ label: string; entries: CommandEntry[] }>;
export function commandLine(name: string, args?: string): string;
export function shellRequiresConfirmation(shell: ShellPresence | string | undefined): boolean;
export function commandBlockedByPending(entry: CommandEntry | undefined, pending: boolean): boolean;
export function resolveComposerCommand(
  commands: readonly CommandEntry[] | null | undefined,
  token: string,
  options?: { listAvailable?: boolean; master?: boolean },
): ResolvedComposerCommand;
