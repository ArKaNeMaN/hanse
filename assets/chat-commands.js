/**
 * Pure slash-command helpers for the chat palette.
 *
 * This module has no DOM, network, timer, or storage access so it can be unit-tested directly.
 * It deliberately never reads an upstream `template`: the only shell signal is the server's
 * tri-state `shell` field.
 */

/** @typedef {"none" | "present" | "unknown"} ShellPresence */
/** @typedef {"new" | "help" | "editor" | "compact" | "restart" | "diff"} HanseAction */
/** @typedef {"opencode" | "hanse"} CommandSource */
/** @typedef {"command" | "mcp" | "skill"} CommandOrigin */

/**
 * @typedef {Object} CommandEntry
 * @property {string} name
 * @property {CommandSource} source
 * @property {HanseAction} [action]
 * @property {string[]} [aliases]
 * @property {CommandOrigin} [origin]
 * @property {string} [description]
 * @property {string[]} [hints]
 * @property {ShellPresence} shell
 * @property {boolean} available
 * @property {string} [unavailableReason]
 */

/**
 * @typedef {Object} HanseActionSpec
 * @property {string} name
 * @property {string[]} aliases
 * @property {HanseAction} action
 * @property {string} description
 * @property {boolean} masterAvailable
 * @property {string} [masterReason]
 */

export const UNKNOWN_ACTION_REASON = "Not available in this build";
export const MASTER_EDITOR_REASON =
  "The master workspace is coordinator-managed; the existing IDE link is unchanged.";
export const MASTER_DIFF_REASON = "The master has no worktree view.";

/**
 * Client fallback for the six Hanse actions, in server registry order. It is used only when the
 * merged list fetch fails; the server's list is authoritative otherwise.
 * @type {readonly HanseActionSpec[]}
 */
export const HANSE_ACTIONS = [
  {
    name: "new",
    aliases: ["clear"],
    action: "new",
    description: "Start a new session",
    masterAvailable: true,
  },
  {
    name: "help",
    aliases: [],
    action: "help",
    description: "Show command help",
    masterAvailable: true,
  },
  {
    name: "editor",
    aliases: ["ide"],
    action: "editor",
    description: "Open the web IDE",
    masterAvailable: false,
    masterReason: MASTER_EDITOR_REASON,
  },
  {
    name: "compact",
    aliases: [],
    action: "compact",
    description: "Compact the current session",
    masterAvailable: true,
  },
  {
    name: "diff",
    aliases: [],
    action: "diff",
    description: "Open the application changes",
    masterAvailable: false,
    masterReason: MASTER_DIFF_REASON,
  },
  {
    name: "restart",
    aliases: [],
    action: "restart",
    description: "Restart the application agent",
    masterAvailable: true,
  },
];

/**
 * Build fallback command entries for the six Hanse actions.
 * @param {boolean} master
 * @returns {CommandEntry[]}
 */
export function hanseFallbackEntries(master) {
  return HANSE_ACTIONS.map((spec) => {
    const available = master !== true || spec.masterAvailable;
    return {
      name: spec.name,
      source: "hanse",
      action: spec.action,
      aliases: [...spec.aliases],
      description: spec.description,
      hints: [],
      shell: "none",
      available,
      ...(available ? {} : { unavailableReason: spec.masterReason ?? "Not available in the master chat" }),
    };
  });
}

const COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/**
 * Parse a composer draft. The draft is trimmed exactly like the existing send path.
 * A bare `/` is ordinary text; `//foo` yields the token `/foo` and is treated as an unknown
 * command by the caller, which sends it verbatim.
 * @param {string} text
 * @returns {{ kind: "text", text: string } | { kind: "command", token: string, args: string }}
 */
export function parseComposerCommand(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) return { kind: "text", text: "" };
  const match = COMMAND_PATTERN.exec(trimmed);
  if (match === null) return { kind: "text", text: trimmed };
  return { kind: "command", token: match[1], args: match[2] ?? "" };
}

/**
 * Exact, case-sensitive lookup by canonical name first, then by Hanse alias. An upstream canonical
 * name always wins over a Hanse alias because canonical names are checked before aliases.
 * @param {readonly CommandEntry[]} commands
 * @param {string} token
 * @returns {CommandEntry | undefined}
 */
export function matchCommand(commands, token) {
  if (!Array.isArray(commands) || typeof token !== "string" || token.length === 0) return undefined;
  const canonical = commands.find((entry) => entry.name === token);
  if (canonical !== undefined) return canonical;
  return commands.find(
    (entry) => entry.source === "hanse" && entry.aliases?.includes(token) === true,
  );
}

/**
 * Case-insensitive substring filter over name, aliases, and description. Input order is preserved.
 * @param {readonly CommandEntry[]} commands
 * @param {string} query
 * @returns {CommandEntry[]}
 */
export function filterCommands(commands, query) {
  if (!Array.isArray(commands)) return [];
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return [...commands];
  return commands.filter((entry) => {
    if (entry.name.toLowerCase().includes(needle)) return true;
    if (entry.aliases?.some((alias) => alias.toLowerCase().includes(needle)) === true) return true;
    return typeof entry.description === "string" &&
      entry.description.toLowerCase().includes(needle);
  });
}

/**
 * Split filtered commands into the palette groups. Hanse rows keep registry order; application rows
 * follow in server order (already sorted by name).
 * @param {readonly CommandEntry[]} commands
 * @returns {Array<{ label: string, entries: CommandEntry[] }>}
 */
export function groupCommands(commands) {
  const list = Array.isArray(commands) ? commands : [];
  return [
    { label: "Hanse", entries: list.filter((entry) => entry.source === "hanse") },
    { label: "Application commands", entries: list.filter((entry) => entry.source === "opencode") },
  ];
}

/**
 * The composer line for a command. A trailing space is intentional so typing can continue.
 * @param {string} name
 * @param {string} [args]
 * @returns {string}
 */
export function commandLine(name, args) {
  const line = `/${name}`;
  return typeof args === "string" && args.length > 0 ? `${line} ${args}` : `${line} `;
}

/**
 * `present` and `unknown` both require the client's explicit confirmation before dispatch.
 * @param {ShellPresence | string | undefined} shell
 * @returns {boolean}
 */
export function shellRequiresConfirmation(shell) {
  return shell === "present" || shell === "unknown";
}

/**
 * The pending-question lock blocks server commands and the mutating session actions
 * (`new`, `compact`, `restart`). Navigation actions stay available.
 * @param {CommandEntry | undefined} entry
 * @param {boolean} pending
 * @returns {boolean}
 */
export function commandBlockedByPending(entry, pending) {
  if (pending !== true || entry === undefined || entry === null) return false;
  if (entry.source === "opencode") return true;
  return entry.action !== "help" && entry.action !== "editor" && entry.action !== "diff";
}

/**
 * Resolve a directly typed token through the merged list, with the client fallback for a failed
 * fetch and the master flag applied defensively.
 *
 * @param {readonly CommandEntry[] | null | undefined} commands
 * @param {string} token
 * @param {{ listAvailable?: boolean, master?: boolean }} [options]
 * @returns {
 *   | { kind: "opencode", entry: CommandEntry, shadowed: boolean }
 *   | { kind: "hanse", entry: CommandEntry, action: HanseAction }
 *   | { kind: "disabled", entry: CommandEntry, reason: string }
 *   | { kind: "unknown" }
 * }
 */
export function resolveComposerCommand(commands, token, options) {
  const settings = options ?? {};
  const master = settings.master === true;
  const listAvailable = settings.listAvailable !== false && Array.isArray(commands);
  const list = listAvailable ? commands : [];

  const matched = matchCommand(list, token);
  if (matched !== undefined) {
    if (matched.available === false) {
      return {
        kind: "disabled",
        entry: matched,
        reason: matched.unavailableReason ?? UNKNOWN_ACTION_REASON,
      };
    }
    if (matched.source === "opencode") {
      return { kind: "opencode", entry: matched, shadowed: isHanseToken(token) };
    }
    return resolveHanseEntry(matched, master);
  }

  if (!listAvailable) {
    const fallback = matchCommand(hanseFallbackEntries(master), token);
    if (fallback !== undefined) return resolveHanseEntry(fallback, master);
  }

  return { kind: "unknown" };
}

/**
 * @param {CommandEntry} entry
 * @param {boolean} master
 * @returns {{ kind: "hanse", entry: CommandEntry, action: HanseAction } | { kind: "disabled", entry: CommandEntry, reason: string }}
 */
function resolveHanseEntry(entry, master) {
  const action = entry.action;
  if (action === undefined || !isKnownAction(action)) {
    return { kind: "disabled", entry, reason: UNKNOWN_ACTION_REASON };
  }
  if (master && (action === "editor" || action === "diff")) {
    const spec = HANSE_ACTIONS.find((candidate) => candidate.action === action);
    return {
      kind: "disabled",
      entry,
      reason: entry.unavailableReason ?? spec?.masterReason ?? "Not available in the master chat",
    };
  }
  if (entry.available === false) {
    return {
      kind: "disabled",
      entry,
      reason: entry.unavailableReason ?? UNKNOWN_ACTION_REASON,
    };
  }
  return { kind: "hanse", entry, action };
}

/** @param {string} action */
function isKnownAction(action) {
  return (
    action === "new" ||
    action === "help" ||
    action === "editor" ||
    action === "compact" ||
    action === "restart" ||
    action === "diff"
  );
}

/** @param {string} token */
function isHanseToken(token) {
  return HANSE_ACTIONS.some(
    (spec) => spec.name === token || spec.aliases.includes(token),
  );
}
