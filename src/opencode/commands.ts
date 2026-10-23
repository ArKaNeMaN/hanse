/**
 * Pure command registry, upstream whitelist, merge policy, and response cap for the merged
 * opencode/Hanse slash-command palette.
 *
 * This module is deliberately free of I/O, networking, environment reads, and HTTP imports. It is
 * the security boundary that withholds upstream templates and classifies shell blocks, so every
 * exported function must stay deterministic and unit-testable.
 *
 * The v1 branch is selected from `docs/design/artifacts/slash-commands/probe.md` (`Decision: v1`).
 */

export type ShellPresence = "none" | "present" | "unknown";

export type HanseCommandAction = "new" | "help" | "editor" | "compact" | "restart" | "diff";

export interface HanseCommand {
  name: string;
  aliases: string[];
  action: HanseCommandAction;
  description: string;
  hints: string[];
}

export type CommandWarningCode =
  | "agent_stopped"
  | "agent_runtime_unconfigured"
  | "commands_unavailable"
  | "command_shadowed"
  | "command_dropped"
  | "command_cap_reached";

export interface CommandWarning {
  code: CommandWarningCode;
  message?: string;
  command?: string;
}

export type CommandSourceStatus = "ok" | "stopped" | "unconfigured" | "unavailable";

export interface CommandEntry {
  name: string;
  source: "opencode" | "hanse";
  action?: HanseCommandAction;
  aliases?: string[];
  origin?: "command" | "mcp" | "skill";
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
  hints?: string[];
  shell: ShellPresence;
  available: boolean;
  unavailableReason?: string;
}

export interface CommandList {
  commands: CommandEntry[];
  sources: { hanse: "ok"; opencode: CommandSourceStatus };
  warnings: CommandWarning[];
}

export interface CommandWhitelistResult {
  commands: CommandEntry[];
  warnings: CommandWarning[];
}

export interface MergeCommandsOptions {
  master?: boolean;
  opencodeStatus?: CommandSourceStatus;
  warnings?: CommandWarning[];
}

export const COMMAND_NAME_MAX_CHARS = 128;
export const DESCRIPTION_MAX_CHARS = 500;
export const HINTS_MAX_ENTRIES = 10;
export const HINT_MAX_CHARS = 200;
export const COMMANDS_PER_LIST_MAX = 500;
export const WARNINGS_MAX = 20;
export const MERGED_RESPONSE_MAX_BYTES = 1024 * 1024;
export const MASTER_DISABLED_REASON = "Not available in the master chat";
export const UNKNOWN_ACTION_REASON = "Not available in this build";

/** The exact upstream shell-block grammar; a line-start match is only a subset of it. */
const SHELL_BLOCK_PATTERN = /!`([^`]+)`/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODEL_MAX_CHARS = 200;
const AGENT_MAX_CHARS = 200;
const CAP_WARNING: CommandWarning = {
  code: "command_cap_reached",
  message: "Command list was truncated to fit the response size limit.",
};

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<HanseCommandAction>([
  "new",
  "help",
  "editor",
  "compact",
  "restart",
  "diff",
]);

/**
 * The six Hanse-native commands, in palette order. Aliases are match keys only and are never posted
 * upstream; `shell` and availability are attached by `mergeCommands`.
 */
export const HANSE_COMMANDS: readonly HanseCommand[] = [
  {
    name: "new",
    aliases: ["clear"],
    action: "new",
    description: "Start a new session",
    hints: [],
  },
  {
    name: "help",
    aliases: [],
    action: "help",
    description: "Show command help",
    hints: [],
  },
  {
    name: "editor",
    aliases: ["ide"],
    action: "editor",
    description: "Open the web IDE",
    hints: [],
  },
  {
    name: "compact",
    aliases: [],
    action: "compact",
    description: "Compact the current session",
    hints: [],
  },
  {
    name: "diff",
    aliases: [],
    action: "diff",
    description: "Open the application changes",
    hints: [],
  },
  {
    name: "restart",
    aliases: [],
    action: "restart",
    description: "Restart the application agent",
    hints: [],
  },
];

/** The v1 branch chosen by the phase-0 probe; a future v2 adapter is additive. */
export function upstreamCommandSupport(): "v1" | "v2" | "none" {
  return "v1";
}

/** True when `text` contains the upstream shell-block pattern anywhere (not only at line start). */
export function containsShellBlock(text: string): boolean {
  return SHELL_BLOCK_PATTERN.test(text);
}

/** Classify an upstream template. Any non-string or absent value is `unknown`, never `none`. */
export function detectShell(template: unknown): ShellPresence {
  if (typeof template !== "string") return "unknown";
  return containsShellBlock(template) ? "present" : "none";
}

/** `present` and `unknown` both require the client's explicit confirmation before dispatch. */
export function shellRequiresConfirmation(shell: ShellPresence): boolean {
  return shell === "present" || shell === "unknown";
}

export function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripControlCharacters(value).trim();
}

export function isValidCommandName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripControlCharacters(value).trim().slice(0, DESCRIPTION_MAX_CHARS);
  return cleaned.length === 0 ? undefined : cleaned;
}

export function sanitizeHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hints: string[] = [];
  for (const raw of value) {
    if (hints.length >= HINTS_MAX_ENTRIES) break;
    if (typeof raw !== "string") continue;
    const cleaned = stripControlCharacters(raw).trim().slice(0, HINT_MAX_CHARS);
    if (cleaned.length > 0) hints.push(cleaned);
  }
  return hints;
}

/**
 * Build the explicit upstream DTO. The upstream object is never spread, `template` is never copied,
 * and invalid or duplicate names are dropped with `command_dropped`.
 */
export function whitelistOpencodeCommands(raw: unknown): CommandWhitelistResult {
  const commands: CommandEntry[] = [];
  const warnings: CommandWarning[] = [];
  const pushWarning = (warning: CommandWarning): void => {
    if (warnings.length < WARNINGS_MAX) warnings.push(warning);
  };

  if (!Array.isArray(raw)) {
    pushWarning({ code: "command_dropped", message: "Upstream command list is not an array." });
    return { commands, warnings };
  }

  const seen = new Set<string>();
  for (const item of raw) {
    if (commands.length >= COMMANDS_PER_LIST_MAX) {
      pushWarning({ code: "command_dropped" });
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      pushWarning({ code: "command_dropped" });
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = sanitizeName(record.name);
    if (!isValidCommandName(name)) {
      pushWarning(
        name.length === 0
          ? { code: "command_dropped" }
          : { code: "command_dropped", command: name.slice(0, COMMAND_NAME_MAX_CHARS) },
      );
      continue;
    }
    if (seen.has(name)) {
      pushWarning({ code: "command_dropped", command: name });
      continue;
    }
    seen.add(name);

    const entry: CommandEntry = {
      name,
      source: "opencode",
      origin: sanitizeOrigin(record.source),
      shell: detectShell(record.template),
      available: true,
      hints: sanitizeHints(record.hints),
    };
    const description = sanitizeDescription(record.description);
    if (description !== undefined) entry.description = description;
    const agent = sanitizeBoundedText(record.agent, AGENT_MAX_CHARS);
    if (agent !== undefined) entry.agent = agent;
    const model = sanitizeModel(record.model);
    if (model !== undefined) entry.model = model;
    if (typeof record.subtask === "boolean") entry.subtask = record.subtask;
    commands.push(entry);
  }

  return { commands, warnings };
}

/**
 * Merge the static Hanse registry with whitelisted upstream entries. Hanse order is first, opencode
 * entries follow sorted by name, and upstream canonical names/aliases shadow Hanse names visibly.
 */
export function mergeCommands(
  hanse: readonly HanseCommand[],
  opencode: readonly CommandEntry[],
  options: MergeCommandsOptions = {},
): CommandList {
  const warnings: CommandWarning[] = (options.warnings ?? []).slice(0, WARNINGS_MAX);
  const pushWarning = (warning: CommandWarning): void => {
    if (warnings.length < WARNINGS_MAX) warnings.push(warning);
  };
  const sortedOpencode = [...opencode].sort(compareCommandNames);
  const opencodeNames = new Set(sortedOpencode.map((entry) => entry.name));
  const commands: CommandEntry[] = [];

  for (const command of hanse) {
    if (opencodeNames.has(command.name)) {
      pushWarning({ code: "command_shadowed", command: command.name });
      continue;
    }
    const aliases: string[] = [];
    for (const alias of command.aliases) {
      if (opencodeNames.has(alias)) {
        pushWarning({ code: "command_shadowed", command: alias });
      } else {
        aliases.push(alias);
      }
    }
    const entry: CommandEntry = {
      name: command.name,
      source: "hanse",
      action: command.action,
      aliases,
      hints: sanitizeHints(command.hints),
      shell: "none",
      available: true,
    };
    const description = sanitizeDescription(command.description);
    if (description !== undefined) entry.description = description;
    applyAvailability(entry, command.action, options.master === true);
    commands.push(entry);
  }

  commands.push(...sortedOpencode);

  return {
    commands,
    sources: { hanse: "ok", opencode: options.opencodeStatus ?? "ok" },
    warnings,
  };
}

/**
 * Resolve a directly typed token through the merged list so shadows behave like palette rows.
 * Matching is exact and case-sensitive; canonical names win over aliases.
 */
export function resolveCommandToken(list: CommandList, token: string): CommandEntry | undefined {
  const canonical = list.commands.find((entry) => entry.name === token);
  if (canonical !== undefined) return canonical;
  return list.commands.find(
    (entry) => entry.source === "hanse" && entry.aliases?.includes(token) === true,
  );
}

/**
 * Enforce the merged-response cap by dropping trailing opencode entries only. Hanse entries are
 * never dropped, and exactly one `command_cap_reached` summary is added when anything was dropped.
 */
export function capMergedResponse(list: CommandList): CommandList {
  const commands = [...list.commands];
  const baseWarnings = list.warnings.filter((warning) => warning.code !== "command_cap_reached");
  let dropped = 0;

  const warningsFor = (droppedCount: number): CommandWarning[] => {
    const limit = droppedCount > 0 ? WARNINGS_MAX - 1 : WARNINGS_MAX;
    const bounded = baseWarnings.slice(0, Math.max(0, limit));
    if (droppedCount > 0) bounded.push(CAP_WARNING);
    return bounded;
  };

  const fits = (): boolean =>
    Buffer.byteLength(
      JSON.stringify({ ...list, commands, warnings: warningsFor(dropped) }),
      "utf8",
    ) <= MERGED_RESPONSE_MAX_BYTES;

  while (!fits()) {
    const last = commands[commands.length - 1];
    if (last === undefined || last.source !== "opencode") break;
    commands.pop();
    dropped += 1;
  }

  return { ...list, commands, warnings: warningsFor(dropped) };
}

function stripControlCharacters(value: string): string {
  let cleaned = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && (code < 0x7f || code > 0x9f)) cleaned += character;
  }
  return cleaned;
}

function sanitizeBoundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripControlCharacters(value).trim().slice(0, maxChars);
  return cleaned.length === 0 ? undefined : cleaned;
}

function sanitizeModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return sanitizeBoundedText(value, MODEL_MAX_CHARS);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const providerID = sanitizeBoundedText(record.providerID, MODEL_MAX_CHARS);
  const modelID = sanitizeBoundedText(record.modelID, MODEL_MAX_CHARS);
  if (providerID === undefined || modelID === undefined) return undefined;
  return `${providerID}/${modelID}`.slice(0, MODEL_MAX_CHARS);
}

function sanitizeOrigin(value: unknown): "command" | "mcp" | "skill" {
  if (value === "mcp" || value === "skill") return value;
  return "command";
}

function compareCommandNames(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function applyAvailability(entry: CommandEntry, action: HanseCommandAction, master: boolean): void {
  if (!KNOWN_ACTIONS.has(action)) {
    entry.available = false;
    entry.unavailableReason = UNKNOWN_ACTION_REASON;
    return;
  }
  if (master && (action === "editor" || action === "diff")) {
    entry.available = false;
    entry.unavailableReason = MASTER_DISABLED_REASON;
  }
}
