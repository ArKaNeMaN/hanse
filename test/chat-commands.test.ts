import { describe, expect, it } from "vitest";
import {
  commandBlockedByPending,
  commandLine,
  filterCommands,
  groupCommands,
  HANSE_ACTIONS,
  hanseFallbackEntries,
  matchCommand,
  parseComposerCommand,
  resolveComposerCommand,
  shellRequiresConfirmation,
  UNKNOWN_ACTION_REASON,
} from "../assets/chat-commands.js";

const commands = [
  {
    name: "new",
    source: "hanse",
    action: "new",
    aliases: ["clear"],
    description: "Start a new session",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "help",
    source: "hanse",
    action: "help",
    aliases: [],
    description: "Show command help",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "editor",
    source: "hanse",
    action: "editor",
    aliases: ["ide"],
    description: "Open the web IDE",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "compact",
    source: "hanse",
    action: "compact",
    aliases: [],
    description: "Compact the current session",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "diff",
    source: "hanse",
    action: "diff",
    aliases: [],
    description: "Open the application changes",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "restart",
    source: "hanse",
    action: "restart",
    aliases: [],
    description: "Restart the application agent",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "deploy",
    source: "opencode",
    origin: "command",
    description: "Deploy the application",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "shellcheck",
    source: "opencode",
    origin: "command",
    description: "Runs a shell block",
    hints: [],
    shell: "present",
    available: true,
  },
  {
    name: "mcp-unknown",
    source: "opencode",
    origin: "mcp",
    description: "MCP prompt with unknown shell",
    hints: [],
    shell: "unknown",
    available: true,
  },
  {
    name: "ide",
    source: "opencode",
    origin: "command",
    description: "Application IDE command",
    hints: [],
    shell: "none",
    available: true,
  },
  {
    name: "disabled",
    source: "opencode",
    origin: "command",
    description: "Disabled command",
    hints: [],
    shell: "none",
    available: false,
    unavailableReason: "Disabled by policy",
  },
];

describe("parseComposerCommand", () => {
  it("recognizes /name without arguments", () => {
    expect(parseComposerCommand("/help")).toEqual({ kind: "command", token: "help", args: "" });
  });

  it("recognizes /name with arguments", () => {
    expect(parseComposerCommand("/help deploy")).toEqual({
      kind: "command",
      token: "help",
      args: "deploy",
    });
  });

  it("preserves multi-line arguments", () => {
    expect(parseComposerCommand("/help first\nsecond")).toEqual({
      kind: "command",
      token: "help",
      args: "first\nsecond",
    });
  });

  it("trims leading and trailing whitespace before recognition", () => {
    expect(parseComposerCommand("   /help   deploy   ")).toEqual({
      kind: "command",
      token: "help",
      args: "deploy",
    });
  });

  it("returns trimmed ordinary text", () => {
    expect(parseComposerCommand("  hello world  ")).toEqual({
      kind: "text",
      text: "hello world",
    });
  });

  it("treats a bare / as ordinary text", () => {
    expect(parseComposerCommand("/")).toEqual({ kind: "text", text: "/" });
    expect(parseComposerCommand("  /  ")).toEqual({ kind: "text", text: "/" });
  });

  it("treats //foo as the unknown token /foo", () => {
    expect(parseComposerCommand("//foo")).toEqual({ kind: "command", token: "/foo", args: "" });
  });

  it("keeps command names case-sensitive", () => {
    expect(parseComposerCommand("/Help")).toEqual({ kind: "command", token: "Help", args: "" });
  });

  it("returns empty text for an empty draft", () => {
    expect(parseComposerCommand("   ")).toEqual({ kind: "text", text: "" });
  });
});

describe("matchCommand", () => {
  it("matches canonical names exactly", () => {
    expect(matchCommand(commands, "help")?.name).toBe("help");
  });

  it("matches Hanse aliases", () => {
    expect(matchCommand(commands, "clear")?.name).toBe("new");
    expect(matchCommand(commands, "ide")?.name).toBe("ide");
  });

  it("does not match a different case", () => {
    expect(matchCommand(commands, "Help")).toBeUndefined();
  });

  it("returns undefined for an unknown token", () => {
    expect(matchCommand(commands, "nope")).toBeUndefined();
    expect(matchCommand([], "help")).toBeUndefined();
  });
});

describe("filterCommands", () => {
  it("matches names, aliases, and descriptions case-insensitively", () => {
    expect(filterCommands(commands, "HELP").map((entry) => entry.name)).toEqual(["help"]);
    expect(filterCommands(commands, "clear").map((entry) => entry.name)).toEqual(["new"]);
    expect(filterCommands(commands, "application changes").map((entry) => entry.name)).toEqual([
      "diff",
    ]);
  });

  it("returns every command for an empty query and preserves order", () => {
    expect(filterCommands(commands, "").map((entry) => entry.name)).toEqual(
      commands.map((entry) => entry.name),
    );
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});

describe("groupCommands", () => {
  it("puts Hanse rows first and application rows second", () => {
    const groups = groupCommands(commands);
    expect(groups.map((group) => group.label)).toEqual(["Hanse", "Application commands"]);
    expect(groups[0].entries.every((entry) => entry.source === "hanse")).toBe(true);
    expect(groups[1].entries.every((entry) => entry.source === "opencode")).toBe(true);
    expect(groups[0].entries[0].name).toBe("new");
    expect(groups[1].entries.map((entry) => entry.name)).toEqual([
      "deploy",
      "shellcheck",
      "mcp-unknown",
      "ide",
      "disabled",
    ]);
  });
});

describe("commandLine", () => {
  it("appends a trailing space when there are no arguments", () => {
    expect(commandLine("help")).toBe("/help ");
  });

  it("includes the arguments when provided", () => {
    expect(commandLine("help", "deploy")).toBe("/help deploy");
  });

  it("treats an empty argument string like no arguments", () => {
    expect(commandLine("new", "")).toBe("/new ");
  });
});

describe("shellRequiresConfirmation", () => {
  it("requires confirmation for present and unknown", () => {
    expect(shellRequiresConfirmation("present")).toBe(true);
    expect(shellRequiresConfirmation("unknown")).toBe(true);
  });

  it("does not require confirmation for none or missing values", () => {
    expect(shellRequiresConfirmation("none")).toBe(false);
    expect(shellRequiresConfirmation(undefined)).toBe(false);
  });
});

describe("commandBlockedByPending", () => {
  const lookup = (name: string) => commands.find((entry) => entry.name === name);

  it("blocks server commands and the mutating Hanse actions while pending", () => {
    expect(commandBlockedByPending(lookup("deploy"), true)).toBe(true);
    expect(commandBlockedByPending(lookup("new"), true)).toBe(true);
    expect(commandBlockedByPending(lookup("compact"), true)).toBe(true);
    expect(commandBlockedByPending(lookup("restart"), true)).toBe(true);
  });

  it("keeps navigation actions available while pending", () => {
    expect(commandBlockedByPending(lookup("help"), true)).toBe(false);
    expect(commandBlockedByPending(lookup("editor"), true)).toBe(false);
    expect(commandBlockedByPending(lookup("diff"), true)).toBe(false);
  });

  it("blocks nothing when no request is pending", () => {
    for (const entry of commands) {
      expect(commandBlockedByPending(entry, false)).toBe(false);
    }
  });
});

describe("resolveComposerCommand", () => {
  it("resolves an opencode canonical command", () => {
    expect(resolveComposerCommand(commands, "deploy", { listAvailable: true })).toEqual({
      kind: "opencode",
      entry: commands.find((entry) => entry.name === "deploy"),
      shadowed: false,
    });
  });

  it("resolves a Hanse canonical command", () => {
    const resolved = resolveComposerCommand(commands, "new", { listAvailable: true });
    expect(resolved.kind).toBe("hanse");
    if (resolved.kind === "hanse") expect(resolved.action).toBe("new");
  });

  it("resolves a Hanse alias", () => {
    const resolved = resolveComposerCommand(commands, "clear", { listAvailable: true });
    expect(resolved.kind).toBe("hanse");
    if (resolved.kind === "hanse") expect(resolved.entry.name).toBe("new");
  });

  it("reports a direct-typed shadow when opencode wins a Hanse name or alias", () => {
    const resolved = resolveComposerCommand(commands, "ide", { listAvailable: true });
    expect(resolved.kind).toBe("opencode");
    if (resolved.kind === "opencode") {
      expect(resolved.entry.name).toBe("ide");
      expect(resolved.shadowed).toBe(true);
    }
  });

  it("returns a disabled row with the server reason", () => {
    const resolved = resolveComposerCommand(commands, "disabled", { listAvailable: true });
    expect(resolved.kind).toBe("disabled");
    if (resolved.kind === "disabled") {
      expect(resolved.reason).toBe("Disabled by policy");
    }
  });

  it("maps an unknown action id to a disabled row", () => {
    const list = [
      {
        name: "future",
        source: "hanse",
        action: "future",
        aliases: [],
        description: "Future action",
        hints: [],
        shell: "none",
        available: true,
      },
    ];
    const resolved = resolveComposerCommand(list, "future", { listAvailable: true });
    expect(resolved.kind).toBe("disabled");
    if (resolved.kind === "disabled") expect(resolved.reason).toBe(UNKNOWN_ACTION_REASON);
  });

  it("uses the client fallback when the list is unavailable", () => {
    const resolved = resolveComposerCommand([], "clear", { listAvailable: false });
    expect(resolved.kind).toBe("hanse");
    if (resolved.kind === "hanse") expect(resolved.entry.name).toBe("new");

    const help = resolveComposerCommand([], "help", { listAvailable: false });
    expect(help.kind).toBe("hanse");
  });

  it("applies the master flag to the fallback", () => {
    const editor = resolveComposerCommand([], "editor", { listAvailable: false, master: true });
    expect(editor.kind).toBe("disabled");
    const diff = resolveComposerCommand([], "diff", { listAvailable: false, master: true });
    expect(diff.kind).toBe("disabled");
    const restart = resolveComposerCommand([], "restart", { listAvailable: false, master: true });
    expect(restart.kind).toBe("hanse");
  });

  it("applies the master flag defensively to a server list", () => {
    const list = [
      {
        name: "editor",
        source: "hanse",
        action: "editor",
        aliases: [],
        description: "Open the web IDE",
        hints: [],
        shell: "none",
        available: true,
      },
    ];
    expect(resolveComposerCommand(list, "editor", { listAvailable: true, master: true }).kind).toBe(
      "disabled",
    );
  });

  it("returns unknown for an unknown token or an unavailable list", () => {
    expect(resolveComposerCommand(commands, "nope", { listAvailable: true })).toEqual({
      kind: "unknown",
    });
    expect(resolveComposerCommand([], "nope", { listAvailable: false })).toEqual({
      kind: "unknown",
    });
  });
});

describe("HANSE_ACTIONS", () => {
  it("has the six canonical entries with aliases and master availability", () => {
    expect(HANSE_ACTIONS.map((spec) => spec.name)).toEqual([
      "new",
      "help",
      "editor",
      "compact",
      "diff",
      "restart",
    ]);
    expect(HANSE_ACTIONS.find((spec) => spec.action === "new")?.aliases).toEqual(["clear"]);
    expect(HANSE_ACTIONS.find((spec) => spec.action === "editor")?.aliases).toEqual(["ide"]);
    expect(HANSE_ACTIONS.find((spec) => spec.action === "editor")?.masterAvailable).toBe(false);
    expect(HANSE_ACTIONS.find((spec) => spec.action === "diff")?.masterAvailable).toBe(false);
    expect(HANSE_ACTIONS.find((spec) => spec.action === "restart")?.masterAvailable).toBe(true);
  });

  it("builds fallback entries that mirror the server registry", () => {
    const entries = hanseFallbackEntries(false);
    expect(entries.map((entry) => entry.name)).toEqual([
      "new",
      "help",
      "editor",
      "compact",
      "diff",
      "restart",
    ]);
    expect(entries.every((entry) => entry.source === "hanse" && entry.shell === "none")).toBe(true);
    expect(entries.every((entry) => entry.available)).toBe(true);
    const master = hanseFallbackEntries(true);
    expect(master.find((entry) => entry.name === "editor")?.available).toBe(false);
    expect(master.find((entry) => entry.name === "diff")?.available).toBe(false);
    expect(master.find((entry) => entry.name === "restart")?.available).toBe(true);
  });
});
