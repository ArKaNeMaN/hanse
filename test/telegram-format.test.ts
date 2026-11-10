import { describe, expect, it } from "vitest";
import {
  buildTelegramLink,
  chunkPlainText,
  chunkTelegramMarkdown,
  countRichBlocks,
  formatNotificationBody,
  formatTelegramMessage,
  MAX_GROUP_CHUNKS,
  PLAIN_CHAR_BUDGET,
  planPlainFallback,
  RICH_BYTE_BUDGET,
  RICH_CHAR_BUDGET,
  sanitizeNotificationText,
  TRUNCATED_MARKER,
} from "../src/notifications/telegram/format.js";

function codePoints(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function plainLength(value: string): number {
  return Math.max(codePoints(value), value.length);
}

function richChunks(markdown: string): string[] {
  return chunkTelegramMarkdown(markdown)
    .chunks.filter((chunk) => chunk.format === "rich")
    .map((chunk) => chunk.text);
}

describe("telegram message bodies", () => {
  it("builds the completion body with the full answer", () => {
    expect(
      formatNotificationBody({
        kind: "turn_completed",
        projectName: "Project",
        appName: "App",
        sessionTitle: "Session",
        answer: "## Answer\n\nbody",
      }),
    ).toBe("Project / App\nSession\n\n## Answer\n\nbody");
  });

  it("uses Done for a status-only completion", () => {
    expect(
      formatNotificationBody({
        kind: "turn_completed",
        projectName: "Project",
        appName: "App",
        sessionTitle: "Session",
        answer: "secret answer",
        includeAnswer: false,
      }),
    ).toBe("Project / App\nSession\n\nDone");
  });

  it("builds the attention bodies without emoji labels", () => {
    expect(
      formatNotificationBody({
        kind: "question",
        projectName: "Project",
        appName: "App",
        sessionTitle: "Session",
        questionHeader: "Choose",
        question: "Which one?",
        options: ["one", "two"],
      }),
    ).toBe("Project / App - needs an answer\nSession\n\n**Choose**\nWhich one?\n- one\n- two");

    expect(
      formatNotificationBody({
        kind: "permission",
        projectName: "Project",
        appName: "App",
        sessionTitle: "Session",
        permission: "Run command",
        tool: "bash",
        command: "ls",
      }),
    ).toBe("Project / App - permission required\nSession\nRun command (bash)\nls");

    expect(
      formatNotificationBody({
        kind: "ssh_approval",
        projectName: "Project",
        appName: "App",
        host: "example.test",
        action: "run",
        commandPreview: "uptime",
        expiresAt: "2026-01-02T03:04:05.000Z",
      }),
    ).toBe(
      "Project / App - SSH approval\nexample.test - run\nuptime\nExpires 2026-01-02T03:04:05.000Z.",
    );

    expect(
      formatNotificationBody({
        kind: "handoff_approval",
        projectName: "Project",
        source: "a",
        target: "b",
        summary: "do it",
      }),
    ).toBe("Project - handoff approval\na -> b\ndo it");

    expect(
      formatNotificationBody({
        kind: "handoff_failed",
        projectName: "Project",
        source: "a",
        target: "b",
        state: "failed",
        reason: "boom",
      }),
    ).toBe("Project - handoff failed\na -> b\nfailed / boom");

    expect(
      formatNotificationBody({
        kind: "agent_interrupted",
        projectName: "Project",
        appName: "App",
        sessionTitle: "Session",
        message: "process exited",
      }),
    ).toBe("Project / App - agent interrupted\nSession\nprocess exited");
  });

  it("sanitizes error text and redacts caller-supplied secrets", () => {
    const token = "123456:SUPER-SECRET-TOKEN";
    const body = formatNotificationBody(
      {
        kind: "agent_interrupted",
        projectName: "Project",
        appName: "App",
        message: `failed with ${token}\nsecond line`,
      },
      { secrets: [token] },
    );
    expect(body).not.toContain(token);
    expect(body).toContain("<redacted>");
    expect(body).not.toContain("second line");
    expect(sanitizeNotificationText(token, [token])).toBe("<redacted>");
  });

  it("builds session, app, and project links with the public base URL", () => {
    expect(
      buildTelegramLink({
        publicBaseUrl: "https://hanse.test/",
        projectId: "p 1",
        appKey: "a/b",
        sessionId: "s 1",
      }),
    ).toEqual({
      text: "Open session",
      url: "https://hanse.test/chat?app=a%2Fb&project=p%201&session=s%201",
    });
    expect(
      buildTelegramLink({ publicBaseUrl: "https://hanse.test", projectId: "p", appKey: "a" }),
    ).toEqual({ text: "Open app", url: "https://hanse.test/chat?app=a&project=p" });
    expect(buildTelegramLink({ publicBaseUrl: "https://hanse.test", projectId: "p" })).toEqual({
      text: "Open project",
      url: "https://hanse.test/projects/p",
    });
    expect(buildTelegramLink({ projectId: "p" })).toBeUndefined();
  });
});

describe("telegram chunking", () => {
  it("keeps rich chunks under 30000 code points and 32768 UTF-8 bytes", () => {
    const ascii = richChunks("word ".repeat(8_000));
    expect(ascii.length).toBeGreaterThan(1);
    for (const chunk of ascii) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(RICH_CHAR_BUDGET);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(RICH_BYTE_BUDGET);
    }

    const emoji = richChunks("🙂".repeat(20_000));
    expect(emoji.length).toBeGreaterThan(1);
    for (const chunk of emoji) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(RICH_BYTE_BUDGET);
      expect(codePoints(chunk)).toBeLessThanOrEqual(RICH_CHAR_BUDGET);
    }
  });

  it("keeps plain chunks under 4000 using the larger of code points and UTF-16 units", () => {
    const chunks = chunkPlainText("x".repeat(9_000));
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(plainLength(chunk)).toBeLessThanOrEqual(PLAIN_CHAR_BUDGET);

    const emoji = chunkPlainText("🙂".repeat(3_000));
    for (const chunk of emoji) expect(plainLength(chunk)).toBeLessThanOrEqual(PLAIN_CHAR_BUDGET);
  });

  it("closes and reopens a fenced code block when a split lands inside it", () => {
    const fence = ["```ts", ...Array.from({ length: 3_000 }, () => "const x = 1;"), "```"].join(
      "\n",
    );
    const chunks = richChunks(fence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
    }
    expect(chunks.slice(1).some((chunk) => chunk.startsWith("```ts"))).toBe(true);
  });

  it("never splits an inline link", () => {
    const link = `[click](https://example.test/${"a".repeat(500)})`;
    const markdown = `${"x".repeat(29_800)} ${link} tail`;
    const chunks = richChunks(markdown);
    expect(chunks.filter((chunk) => chunk.includes(link))).toHaveLength(1);
  });

  it("never splits a table row when a table is larger than one chunk", () => {
    const rows = Array.from(
      { length: 400 },
      (_, index) => `| ${`a${index}`.padEnd(45, "x")} | ${`b${index}`.padEnd(45, "y")} |`,
    );
    const table = ["| left | right |", "|---|---|", ...rows].join("\n");
    const chunks = richChunks(table);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (line.includes("|")) {
          expect(line.trim().startsWith("|")).toBe(true);
          expect(line.trim().endsWith("|")).toBe(true);
        }
      }
    }
  });

  it("forces an oversized table row to plain text and repeats the header", () => {
    const table = `| a | b |\n|---|---|\n| ${"x".repeat(35_000)} | y |`;
    const result = chunkTelegramMarkdown(table);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.format).toBe("plain");
      expect(chunk.text.startsWith("| a | b |\n|---|---|")).toBe(true);
      expect(plainLength(chunk.text)).toBeLessThanOrEqual(PLAIN_CHAR_BUDGET);
    }
  });

  it("forces a table with more than 20 columns to plain text", () => {
    const header = `| ${Array.from({ length: 21 }, (_, index) => `c${index}`).join(" | ")} |`;
    const separator = `|${Array.from({ length: 21 }, () => "---").join("|")}|`;
    const result = chunkTelegramMarkdown(`${header}\n${separator}\n|${" v |".repeat(21)}`);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) expect(chunk.format).toBe("plain");
  });

  it("forces a block with more than 500 blocks to plain text", () => {
    const list = Array.from({ length: 501 }, (_, index) => `- item ${index}`).join("\n");
    expect(countRichBlocks(list)).toBe(501);
    const result = chunkTelegramMarkdown(list);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) expect(chunk.format).toBe("plain");
  });

  it("caps a rich group at 20 chunks with a truncation marker", () => {
    const body = Array.from(
      { length: 25 },
      (_, index) => `paragraph ${index} ${"x".repeat(29_900)}`,
    ).join("\n\n");
    const result = chunkTelegramMarkdown(body);
    expect(result.truncated).toBe(true);
    expect(result.chunks).toHaveLength(MAX_GROUP_CHUNKS);
    expect(result.chunks[result.chunks.length - 1]?.text).toContain(TRUNCATED_MARKER);
  });

  it("re-chunks the plain suffix without applying the 20-chunk cap", () => {
    const suffix = Array.from({ length: 30 }, () => "x".repeat(4_000));
    const chunks = planPlainFallback(suffix, { text: "Open session", url: "https://hanse.test/s" });
    expect(chunks.length).toBeGreaterThan(MAX_GROUP_CHUNKS);
    expect(chunks[chunks.length - 1]?.text).not.toContain(TRUNCATED_MARKER);
    expect(chunks[chunks.length - 1]?.link).toEqual({
      text: "Open session",
      url: "https://hanse.test/s",
    });
    expect(chunks.slice(0, -1).every((chunk) => chunk.link === undefined)).toBe(true);
    for (const chunk of chunks)
      expect(plainLength(chunk.text)).toBeLessThanOrEqual(PLAIN_CHAR_BUDGET);
  });

  it("builds a complete formatted message", () => {
    const message = formatTelegramMessage({
      kind: "turn_completed",
      projectName: "Project",
      appName: "App",
      sessionTitle: "Session",
      answer: "Answer",
      publicBaseUrl: "https://hanse.test",
      projectId: "p",
      appKey: "a",
      sessionId: "s",
    });
    expect(message.body).toBe("Project / App\nSession\n\nAnswer");
    expect(message.link?.text).toBe("Open session");
    expect(message.chunks.length).toBeGreaterThan(0);
    expect(message.truncated).toBe(false);
  });
});
