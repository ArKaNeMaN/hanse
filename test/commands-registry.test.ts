import { describe, expect, it } from "vitest";
import {
  COMMANDS_PER_LIST_MAX,
  type CommandEntry,
  type CommandList,
  type CommandWarning,
  capMergedResponse,
  containsShellBlock,
  detectShell,
  HANSE_COMMANDS,
  type HanseCommand,
  type HanseCommandAction,
  isValidCommandName,
  MASTER_DISABLED_REASON,
  MERGED_RESPONSE_MAX_BYTES,
  mergeCommands,
  resolveCommandToken,
  sanitizeDescription,
  sanitizeHints,
  shellRequiresConfirmation,
  UNKNOWN_ACTION_REASON,
  upstreamCommandSupport,
  WARNINGS_MAX,
  whitelistOpencodeCommands,
} from "../src/opencode/commands.js";

function opencodeEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    name: "cmd",
    source: "opencode",
    shell: "none",
    available: true,
    hints: [],
    ...overrides,
  };
}

function oversizedList(warnings: CommandWarning[] = []): CommandList {
  const hanse = mergeCommands(HANSE_COMMANDS, []).commands;
  const opencode = Array.from({ length: 60 }, (_, index) =>
    opencodeEntry({
      name: `cmd-${String(index).padStart(3, "0")}`,
      description: "x".repeat(20_000),
    }),
  );
  return {
    commands: [...hanse, ...opencode],
    sources: { hanse: "ok", opencode: "ok" },
    warnings,
  };
}

describe("Hanse command registry", () => {
  it("has exactly six commands in order with bounded metadata", () => {
    expect(HANSE_COMMANDS.map((command) => command.name)).toEqual([
      "new",
      "help",
      "editor",
      "compact",
      "diff",
      "restart",
    ]);
    expect(HANSE_COMMANDS).toHaveLength(6);
    expect(HANSE_COMMANDS.find((command) => command.name === "new")?.aliases).toEqual(["clear"]);
    expect(HANSE_COMMANDS.find((command) => command.name === "editor")?.aliases).toEqual(["ide"]);

    for (const command of HANSE_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(500);
      expect(command.hints).toEqual([]);
      expect(command.aliases).toEqual(expect.any(Array));
    }
  });

  it("merges every registry entry as an available, shell-free Hanse entry", () => {
    const list = mergeCommands(HANSE_COMMANDS, []);
    expect(list.commands).toHaveLength(6);
    for (const entry of list.commands) {
      expect(entry.source).toBe("hanse");
      expect(entry.shell).toBe("none");
      expect(entry.available).toBe(true);
    }
    expect(new Set(HANSE_COMMANDS.map((command) => command.action))).toEqual(
      new Set(["new", "help", "editor", "compact", "diff", "restart"]),
    );
  });

  it("declares the probed v1 upstream branch", () => {
    expect(upstreamCommandSupport()).toBe("v1");
  });
});

describe("shell detection", () => {
  it("detects an inline block that does not start a line", () => {
    expect(containsShellBlock("prefix !`echo hi` suffix")).toBe(true);
    expect(detectShell("prefix !`echo hi` suffix")).toBe("present");
  });

  it("detects line-start blocks and multiple blocks", () => {
    expect(containsShellBlock("!`echo hi`")).toBe(true);
    expect(containsShellBlock("one !`a` and two !`b`")).toBe(true);
    expect(containsShellBlock("plain text with `code` only")).toBe(false);
  });

  it("stays deterministic across repeated calls", () => {
    for (let index = 0; index < 25; index += 1) {
      expect(containsShellBlock("prefix !`echo hi` suffix")).toBe(true);
      expect(containsShellBlock("no shell here")).toBe(false);
      expect(detectShell("prefix !`echo hi` suffix")).toBe("present");
    }
  });

  it("treats absent, object, and other non-string templates as unknown", () => {
    expect(detectShell(undefined)).toBe("unknown");
    expect(detectShell(null)).toBe("unknown");
    expect(detectShell({})).toBe("unknown");
    expect(detectShell([])).toBe("unknown");
    expect(detectShell(42)).toBe("unknown");
    expect(detectShell(true)).toBe("unknown");
  });

  it("scans arguments, including a block after $ARGUMENTS", () => {
    expect(containsShellBlock("deploy $ARGUMENTS !`touch marker`")).toBe(true);
    expect(containsShellBlock("deploy $ARGUMENTS")).toBe(false);
    expect(containsShellBlock("first line\n!`echo hi`")).toBe(true);
  });

  it("requires confirmation for present and unknown only", () => {
    expect(shellRequiresConfirmation("present")).toBe(true);
    expect(shellRequiresConfirmation("unknown")).toBe(true);
    expect(shellRequiresConfirmation("none")).toBe(false);
  });
});

describe("whitelist", () => {
  it("builds an explicit DTO and never retains a template", () => {
    const secret = "TEMPLATE_SECRET !`touch /tmp/marker`";
    const result = whitelistOpencodeCommands([
      {
        name: "deploy",
        description: "Deploy it",
        source: "command",
        template: secret,
        hints: ["[env]"],
        agent: "build",
        model: { providerID: "deepseek", modelID: "flash" },
        subtask: true,
      },
      { name: "mcp:prompt", description: "Prompt", source: "mcp", template: {}, hints: ["$1"] },
      { name: "skill-helper", source: "skill", template: "no shell here" },
    ]);

    expect(result.commands.map((command) => command.name)).toEqual([
      "deploy",
      "mcp:prompt",
      "skill-helper",
    ]);
    const deploy = result.commands.find((command) => command.name === "deploy");
    expect(deploy).toMatchObject({
      source: "opencode",
      origin: "command",
      description: "Deploy it",
      hints: ["[env]"],
      agent: "build",
      model: "deepseek/flash",
      subtask: true,
      shell: "present",
      available: true,
    });
    const mcp = result.commands.find((command) => command.name === "mcp:prompt");
    expect(mcp?.origin).toBe("mcp");
    expect(mcp?.shell).toBe("unknown");
    expect(mcp?.hints).toEqual(["$1"]);
    expect(mcp?.agent).toBeUndefined();
    expect(mcp?.model).toBeUndefined();
    const skill = result.commands.find((command) => command.name === "skill-helper");
    expect(skill?.origin).toBe("skill");
    expect(skill?.shell).toBe("none");

    expect(JSON.stringify(result)).not.toContain("TEMPLATE_SECRET");
    expect(JSON.stringify(result)).not.toContain("template");
    for (const command of result.commands) {
      expect(command).not.toHaveProperty("template");
    }
  });

  it("defaults the origin and normalizes string, object, and omitted models", () => {
    const result = whitelistOpencodeCommands([
      { name: "string-model", model: "openai/gpt" },
      { name: "object-model", model: { providerID: "p", modelID: "m" } },
      { name: "bad-model", model: { providerID: "p" } },
      { name: "weird-source", source: "other" },
    ]);
    expect(result.commands.find((command) => command.name === "string-model")?.model).toBe(
      "openai/gpt",
    );
    expect(result.commands.find((command) => command.name === "object-model")?.model).toBe("p/m");
    expect(result.commands.find((command) => command.name === "bad-model")?.model).toBeUndefined();
    expect(result.commands.find((command) => command.name === "weird-source")?.origin).toBe(
      "command",
    );
    expect(result.commands.find((command) => command.name === "string-model")?.origin).toBe(
      "command",
    );
  });

  it("caps descriptions and hints and strips control characters", () => {
    const result = whitelistOpencodeCommands([
      {
        name: "bounded",
        description: `a\u0000b${"x".repeat(600)}`,
        hints: Array.from({ length: 15 }, (_, index) => `h${index}\u001f${"y".repeat(300)}`),
      },
    ]);
    const entry = result.commands[0];
    expect(entry?.description).toBeDefined();
    expect(entry?.description?.length).toBe(500);
    expect(entry?.description?.includes("\u0000")).toBe(false);
    expect(entry?.hints).toHaveLength(10);
    for (const hint of entry?.hints ?? []) {
      expect(hint.length).toBeLessThanOrEqual(200);
      expect(hint.includes("\u001f")).toBe(false);
    }
  });

  it("drops invalid names, non-object entries, and duplicate names with first winning", () => {
    const result = whitelistOpencodeCommands([
      { name: "bad name", description: "invalid" },
      { name: "dup", description: "first" },
      { name: "dup", description: "second" },
      null,
      "not-an-object",
      [],
      { name: 42 },
    ]);
    expect(result.commands.map((command) => command.name)).toEqual(["dup"]);
    expect(result.commands[0]?.description).toBe("first");
    expect(result.warnings.length).toBe(6);
    for (const warning of result.warnings) {
      expect(warning.code).toBe("command_dropped");
    }
    expect(result.warnings.some((warning) => warning.command === "dup")).toBe(true);
  });

  it("returns an empty list plus one warning for a non-array source", () => {
    for (const raw of [null, {}, "nope", 42]) {
      const result = whitelistOpencodeCommands(raw);
      expect(result.commands).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe("command_dropped");
    }
  });

  it("caps the source at 500 commands with command_dropped extras", () => {
    const raw = Array.from({ length: COMMANDS_PER_LIST_MAX + 1 }, (_, index) => ({
      name: `cmd-${index}`,
    }));
    const result = whitelistOpencodeCommands(raw);
    expect(result.commands).toHaveLength(COMMANDS_PER_LIST_MAX);
    expect(result.commands.at(-1)?.name).toBe(`cmd-${COMMANDS_PER_LIST_MAX - 1}`);
    expect(result.warnings.some((warning) => warning.code === "command_dropped")).toBe(true);
    expect(result.warnings.length).toBeLessThanOrEqual(WARNINGS_MAX);
  });

  it("enforces the documented name shape", () => {
    expect(isValidCommandName("a")).toBe(true);
    expect(isValidCommandName("A-1._:/x")).toBe(true);
    expect(isValidCommandName("a".repeat(128))).toBe(true);
    expect(isValidCommandName("a".repeat(129))).toBe(false);
    expect(isValidCommandName("-bad")).toBe(false);
    expect(isValidCommandName("bad name")).toBe(false);
    expect(isValidCommandName("")).toBe(false);
  });

  it("sanitizes descriptions and hints independently", () => {
    expect(sanitizeDescription(42)).toBeUndefined();
    expect(sanitizeDescription("\u0000 \u001f")).toBeUndefined();
    expect(sanitizeDescription("  hello\u0000  ")).toBe("hello");
    expect(sanitizeHints("not-an-array")).toEqual([]);
    expect(sanitizeHints([" a\u0000 ", "", 42, "b"])).toEqual(["a", "b"]);
  });
});

describe("merge and collisions", () => {
  it("keeps Hanse order first and sorts opencode by name", () => {
    const list = mergeCommands(HANSE_COMMANDS, [
      opencodeEntry({ name: "zeta" }),
      opencodeEntry({ name: "alpha" }),
    ]);
    expect(list.commands.map((command) => command.name)).toEqual([
      "new",
      "help",
      "editor",
      "compact",
      "diff",
      "restart",
      "alpha",
      "zeta",
    ]);
    expect(list.sources).toEqual({ hanse: "ok", opencode: "ok" });
  });

  it("hides the Hanse entry when opencode owns the canonical name", () => {
    const list = mergeCommands(HANSE_COMMANDS, [
      opencodeEntry({ name: "help" }),
      opencodeEntry({ name: "alpha" }),
    ]);
    const helpEntries = list.commands.filter((command) => command.name === "help");
    expect(helpEntries).toHaveLength(1);
    expect(helpEntries[0]?.source).toBe("opencode");
    expect(list.commands.map((command) => command.name)).toEqual([
      "new",
      "editor",
      "compact",
      "diff",
      "restart",
      "alpha",
      "help",
    ]);
    expect(list.warnings).toContainEqual({ code: "command_shadowed", command: "help" });
  });

  it("removes only the colliding alias and keeps the canonical Hanse entry", () => {
    const list = mergeCommands(HANSE_COMMANDS, [opencodeEntry({ name: "clear" })]);
    const newEntry = list.commands.find((command) => command.name === "new");
    const clearEntry = list.commands.find((command) => command.name === "clear");
    expect(newEntry?.source).toBe("hanse");
    expect(newEntry?.aliases).toEqual([]);
    expect(clearEntry?.source).toBe("opencode");
    expect(list.warnings).toContainEqual({ code: "command_shadowed", command: "clear" });
  });

  it("resolves canonical names and Hanse aliases exactly and case-sensitively", () => {
    const list = mergeCommands(HANSE_COMMANDS, [opencodeEntry({ name: "help" })]);
    expect(resolveCommandToken(list, "help")?.source).toBe("opencode");
    expect(resolveCommandToken(list, "clear")?.name).toBe("new");
    expect(resolveCommandToken(list, "ide")?.name).toBe("editor");
    expect(resolveCommandToken(list, "HELP")).toBeUndefined();
    expect(resolveCommandToken(list, "missing")).toBeUndefined();
  });

  it("disables editor and diff for the master only", () => {
    const list = mergeCommands(HANSE_COMMANDS, [], { master: true });
    const editor = list.commands.find((command) => command.name === "editor");
    const diff = list.commands.find((command) => command.name === "diff");
    expect(editor?.available).toBe(false);
    expect(editor?.unavailableReason).toBe(MASTER_DISABLED_REASON);
    expect(diff?.available).toBe(false);
    expect(diff?.unavailableReason).toBe(MASTER_DISABLED_REASON);
    for (const name of ["new", "help", "compact", "restart"]) {
      const entry = list.commands.find((command) => command.name === name);
      expect(entry?.available).toBe(true);
    }
  });

  it("keeps an unknown Hanse action as disabled-ready metadata", () => {
    const future: HanseCommand = {
      name: "future",
      aliases: [],
      action: "future" as unknown as HanseCommandAction,
      description: "Future action",
      hints: [],
    };
    const list = mergeCommands([...HANSE_COMMANDS, future], []);
    const entry = list.commands.find((command) => command.name === "future");
    expect(entry?.action).toBe("future");
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toBe(UNKNOWN_ACTION_REASON);
  });

  it("bounds merge warnings to 20", () => {
    const warnings = Array.from(
      { length: 30 },
      (_, index): CommandWarning => ({ code: "command_dropped", command: `c${index}` }),
    );
    const list = mergeCommands(HANSE_COMMANDS, [], { warnings });
    expect(list.warnings).toHaveLength(WARNINGS_MAX);
  });
});

describe("merged response cap", () => {
  it("drops trailing opencode entries only and preserves every Hanse entry", () => {
    const list = oversizedList();
    const capped = capMergedResponse(list);
    const hanseEntries = capped.commands.filter((command) => command.source === "hanse");
    const opencodeEntries = capped.commands.filter((command) => command.source === "opencode");
    const originalOpencode = list.commands.filter((command) => command.source === "opencode");

    expect(hanseEntries).toHaveLength(HANSE_COMMANDS.length);
    expect(opencodeEntries.length).toBeLessThan(originalOpencode.length);
    expect(opencodeEntries.map((command) => command.name)).toEqual(
      originalOpencode.slice(0, opencodeEntries.length).map((command) => command.name),
    );
    expect(
      capped.warnings.filter((warning) => warning.code === "command_cap_reached"),
    ).toHaveLength(1);
    expect(capped.warnings.length).toBeLessThanOrEqual(WARNINGS_MAX);
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(
      MERGED_RESPONSE_MAX_BYTES,
    );
  });

  it("keeps exactly one cap warning that survives the warning cap", () => {
    const warnings: CommandWarning[] = [
      { code: "command_cap_reached" },
      ...Array.from(
        { length: 25 },
        (_, index): CommandWarning => ({ code: "command_dropped", command: `c${index}` }),
      ),
    ];
    const capped = capMergedResponse(oversizedList(warnings));
    expect(
      capped.warnings.filter((warning) => warning.code === "command_cap_reached"),
    ).toHaveLength(1);
    expect(capped.warnings).toHaveLength(WARNINGS_MAX);
    expect(capped.warnings.at(-1)?.code).toBe("command_cap_reached");
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(
      MERGED_RESPONSE_MAX_BYTES,
    );
  });

  it("adds no cap warning when nothing is dropped", () => {
    const list = mergeCommands(HANSE_COMMANDS, []);
    const capped = capMergedResponse(list);
    expect(capped.commands).toEqual(list.commands);
    expect(capped.warnings).toEqual([]);
  });
});
