import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PART_TYPES } from "../ui/chat/event-reducer.js";

/**
 * Stage 7C parity matrix. The event and part rows are checked against the source-of-truth unions
 * in `src/opencode/events.ts`, so removing a row, renaming an event, or adding an unported event
 * fails the build. Every behavior row names an executable test or a recorded manual check whose
 * referenced file must still contain the marker.
 */

interface Evidence {
  readonly kind: "unit" | "component" | "e2e" | "manual" | "static";
  readonly path: string;
  readonly contains: string;
}

function read(relative: string): string {
  return readFileSync(path.resolve(relative), "utf8");
}

function evidence(kind: Evidence["kind"], file: string, contains: string): Evidence {
  return { kind, path: file, contains };
}

const EVENTS = [
  {
    event: "stream.ready",
    action: "resetStream + ready rehydration",
    store: "chatFeed/chatContext/chatUi",
    stage: "3B",
    evidence: [
      evidence("unit", "test/chat-event-reducer.test.ts", "covers every HanseEvent type"),
      evidence("component", "test/ui/chat-stream.test.ts", "resets on every stream.ready frame"),
    ],
  },
  {
    event: "question.asked",
    action: "prompt/upsert (question)",
    store: "chatPrompts",
    stage: "6A",
    evidence: [evidence("component", "test/ui/chat-prompts.test.ts", "renders the dock")],
  },
  {
    event: "question.replied",
    action: "prompt/resolve answered",
    store: "chatPrompts",
    stage: "6A",
    evidence: [
      evidence(
        "unit",
        "test/chat-state-actions.test.ts",
        "passes prompt requests through as render intents",
      ),
    ],
  },
  {
    event: "question.rejected",
    action: "prompt/resolve dismissed",
    store: "chatPrompts",
    stage: "6A",
    evidence: [evidence("component", "test/ui/chat-prompts.test.ts", "expired question")],
  },
  {
    event: "permission.asked",
    action: "prompt/upsert (permission)",
    store: "chatPrompts",
    stage: "6A",
    evidence: [evidence("component", "test/ui/chat-permissions.test.ts", "risk and scope chips")],
  },
  {
    event: "permission.replied",
    action: "prompt/resolve replied",
    store: "chatPrompts",
    stage: "6A",
    evidence: [evidence("component", "test/ui/chat-permissions.test.ts", "tombstones an expired")],
  },
  {
    event: "todo.updated",
    action: "context/todos",
    store: "chatContext",
    stage: "3A/6B",
    evidence: [evidence("component", "test/ui/chat-context-rail.test.ts", "plan/todo panel")],
  },
  {
    event: "message.updated",
    action: "message/upsert + optimistic reconciliation",
    store: "chatFeed",
    stage: "3A",
    evidence: [evidence("unit", "test/chat-feed-parity.test.ts", "replays feed order")],
  },
  {
    event: "message.part.updated",
    action: "part/upsert + queue recompute + unknown reconcile",
    store: "chatFeed",
    stage: "3A/5A",
    evidence: [evidence("component", "test/ui/chat-message.test.ts", "renders tool, patch, file")],
  },
  {
    event: "message.part.delta",
    action: "part/delta buffered + throttled",
    store: "chatFeed",
    stage: "3A/5A",
    evidence: [
      evidence("component", "test/ui/chat-markdown.test.ts", "throttles streaming renders"),
    ],
  },
  {
    event: "message.part.omitted",
    action: "part/omit + reconcile warning",
    store: "chatFeed/chatUi",
    stage: "3A/5A",
    evidence: [evidence("unit", "test/chat-state-actions.test.ts", "marks an omitted part")],
  },
  {
    event: "session.status",
    action: "session/status + queue/composer state",
    store: "chatFeed/chatComposer",
    stage: "3A/4C",
    evidence: [
      evidence("component", "test/ui/chat-page.test.ts", "session status through the reducer"),
    ],
  },
  {
    event: "session.error",
    action: "session/error + pending/abort settlement",
    store: "chatFeed/chatComposer",
    stage: "3A/4B",
    evidence: [evidence("component", "test/ui/chat-page.test.ts", "shows a session error")],
  },
  {
    event: "session.compacted",
    action: "session/compacted + context refresh",
    store: "chatContext",
    stage: "6B",
    evidence: [
      evidence("component", "test/ui/chat-context-rail.test.ts", "posts a 202 compact request"),
    ],
  },
  {
    event: "notice.created",
    action: "notice/upsert session-filtered",
    store: "chatFeed",
    stage: "3A",
    evidence: [evidence("component", "test/ui/chat-cards.test.ts", "maps agent notices")],
  },
  {
    event: "context.updated",
    action: "context/set",
    store: "chatContext",
    stage: "3A/6B",
    evidence: [
      evidence("component", "test/ui/chat-context-rail.test.ts", "renders the context meter"),
    ],
  },
  {
    event: "session.activity",
    action: "session/activity -> reconcile unless message/status",
    store: "chatUi",
    stage: "3A/3B",
    evidence: [evidence("unit", "test/chat-state-actions.test.ts", "requests reconcile on a gap")],
  },
  {
    event: "stream.warning",
    action: "stream/warning + stream/limit",
    store: "chatUi/chatFeed",
    stage: "3B",
    evidence: [
      evidence("component", "test/ui/chat-page.test.ts", "renders a stream warning notice"),
    ],
  },
] as const;

const PART_ROWS = [
  {
    part: "text",
    render: "MarkdownBlock / renderMarkdown",
    stage: "5A",
    file: "test/ui/chat-markdown.test.ts",
    contains: "renders GFM tables",
  },
  {
    part: "reasoning",
    render: "ReasoningPart + elapsed timer",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "renders text and reasoning",
  },
  {
    part: "tool",
    render: "ToolPart status/summary",
    stage: "5A/5B",
    file: "test/ui/chat-tools.test.ts",
    contains: "bash tail",
  },
  {
    part: "step-start",
    render: "step divider/no-op",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "step-finish",
    render: "step divider/no-op",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "patch",
    render: "DiffView",
    stage: "5B",
    file: "test/ui/chat-diff-view.test.ts",
    contains: "extracts read, write, edit",
  },
  {
    part: "file",
    render: "ReadView/WriteView/file card",
    stage: "5B",
    file: "test/ui/chat-diff-view.test.ts",
    contains: "extracts read, write, edit",
  },
  {
    part: "subtask",
    render: "subagent/task row",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "renders tool, patch, file",
  },
  {
    part: "retry",
    render: "retry status row",
    stage: "5A/6B",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "compaction",
    render: "compaction row + context refresh",
    stage: "5A/6B",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "snapshot",
    render: "snapshot marker/no-op",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "agent",
    render: "agent marker/no-op",
    stage: "5A",
    file: "test/ui/chat-message.test.ts",
    contains: "keeps step/retry",
  },
  {
    part: "<unknown>",
    render: "unknown reconcile + plain text",
    stage: "3A/5A",
    file: "test/chat-event-reducer.test.ts",
    contains: "flags unknown part types for reconcile",
  },
] as const;

const DESIGN_SECTIONS = [
  "2.1",
  "2.2",
  "2.3",
  "2.4",
  "2.5",
  "2.6",
  "2.7",
  "2.8",
  "2.9",
  "7.1",
  "7.2",
  "7.3",
  "7.4",
] as const;
type DesignSection = (typeof DESIGN_SECTIONS)[number];

interface BehaviorRow {
  readonly section: DesignSection;
  readonly behavior: string;
  readonly evidence: readonly Evidence[];
}

const BEHAVIORS: readonly BehaviorRow[] = [
  {
    section: "2.1",
    behavior: "chat page composition: one body, workspace shell, no page header, chat viewport",
    evidence: [
      evidence("component", "test/ui/chat-page.test.ts", "one chat body, the workspace shell"),
      evidence("e2e", "e2e/chat.spec.ts", "SPA direct load renders the chat shell"),
    ],
  },
  {
    section: "2.2",
    behavior: "one EventSource, every stream.ready resets, duplicate/gap sequence handling",
    evidence: [
      evidence("unit", "test/ui/chat-stream.test.ts", "opens one EventSource and resets"),
      evidence("unit", "test/chat-event-reducer.test.ts", "drops duplicate sequences"),
    ],
  },
  {
    section: "2.2",
    behavior: "bounded reconnect, hidden no-counter/no-probe, stream-limit and auth probe",
    evidence: [
      evidence("unit", "test/ui/chat-stream.test.ts", "pauses after three visible failures"),
      evidence(
        "unit",
        "test/ui/chat-stream.test.ts",
        "keeps hidden failures out of the client counter",
      ),
    ],
  },
  {
    section: "2.2",
    behavior: "bfcache pagehide/pageshow and online/visibility reconnect ownership",
    evidence: [
      evidence(
        "component",
        "test/ui/chat-readonly.test.ts",
        "reconnects exactly once after a bfcache",
      ),
      evidence(
        "component",
        "test/ui/chat-runtime-resources.test.ts",
        "online reconnect keeps one source",
      ),
    ],
  },
  {
    section: "2.3",
    behavior: "terminal WebSocket lifecycle remains owned by the Vue terminal adapter",
    evidence: [evidence("unit", "test/ui/terminal-socket.test.ts", "dispose")],
  },
  {
    section: "2.4",
    behavior: "route.query is the sole app/project/session source; deep link and back/forward",
    evidence: [
      evidence(
        "component",
        "test/ui/chat-route-state.test.ts",
        "reads the deep link query as the sole source",
      ),
      evidence(
        "e2e",
        "e2e/spa-chat.spec.ts",
        "deep link, refresh, and back/forward keep one chat host",
      ),
    ],
  },
  {
    section: "2.4",
    behavior: "app switch flushes the draft and remounts; session switch is last-wins",
    evidence: [
      evidence("component", "test/ui/chat-app-menu.test.ts", "switches apps through the router"),
      evidence(
        "component",
        "test/ui/chat-route-state.test.ts",
        "last-wins for rapid session selections",
      ),
    ],
  },
  {
    section: "2.4",
    behavior: "session tree, search, disclosure, create, subtree delete",
    evidence: [
      evidence(
        "component",
        "test/ui/chat-sessions.test.ts",
        "confirms and deletes a whole subtree",
      ),
    ],
  },
  {
    section: "2.5",
    behavior: "composer send, drafts, pending delivery, queue, and abort",
    evidence: [
      evidence("component", "test/ui/chat-composer.test.ts", "sends on Enter"),
      evidence(
        "component",
        "test/ui/chat-draft.test.ts",
        "saves a draft after the 500 ms debounce",
      ),
      evidence("component", "test/ui/chat-queue.test.ts", "derives strip rows"),
      evidence("component", "test/ui/chat-abort.test.ts", "keeps last-wins when Stop"),
    ],
  },
  {
    section: "2.5",
    behavior: "questions, permissions, saved permissions, SSH approvals, OMO/handoff cards",
    evidence: [
      evidence("component", "test/ui/chat-prompts.test.ts", "submits a selected answer"),
      evidence("component", "test/ui/chat-permissions.test.ts", "revokes a saved permission"),
      evidence("component", "test/ui/chat-ssh-approvals.test.ts", "approves and rejects"),
      evidence("component", "test/ui/chat-cards.test.ts", "renders an OMO card"),
    ],
  },
  {
    section: "2.6",
    behavior: "attachment upload limits, progress/abort/retry, quota, drop/paste, payload",
    evidence: [
      evidence("component", "test/ui/chat-attachments.test.ts", "runs at most two uploads"),
      evidence(
        "component",
        "test/ui/chat-attachments-drop.test.ts",
        "adds clipboard image/file items",
      ),
    ],
  },
  {
    section: "2.7",
    behavior: "safe Markdown/tables, diff caps, syntax-highlight worker teardown",
    evidence: [
      evidence("component", "test/ui/chat-markdown.test.ts", "keeps adversarial HTML/XML as text"),
      evidence("component", "test/ui/chat-diff-view.test.ts", "caps a file at 64 KiB"),
      evidence("component", "test/ui/chat-highlight-teardown.test.ts", "terminates the worker"),
    ],
  },
  {
    section: "2.8",
    behavior: "scroll ownership, prepend anchor, new-messages, keyboard paths, polling",
    evidence: [
      evidence("component", "test/ui/chat-scroll.test.ts", "preserves the prepend anchor"),
      evidence("component", "test/ui/chat-composer.test.ts", "keeps Shift+Enter for a newline"),
      evidence("component", "test/ui/chat-ssh-approvals.test.ts", "uses one interval per mount"),
    ],
  },
  {
    section: "2.9",
    behavior: "workspace shell, boot route set, SmartLink membership, focus/announcer",
    evidence: [
      evidence(
        "component",
        "test/ui/workspace-shell.test.ts",
        "applies and restores the workspace",
      ),
      evidence("component", "test/ui/boot.test.ts", "round-trips the resolved spaRoutes"),
      evidence("component", "ui/components/SmartLink.test.ts", "renders a router link"),
    ],
  },
  {
    section: "7.1",
    behavior: "risk mitigations are covered by the event/part/behavior rows above",
    evidence: [evidence("unit", "test/chat-parity.test.ts", "covers every HanseEvent type")],
  },
  {
    section: "7.2",
    behavior: "lazy chat chunk, entry budget unchanged, no eager Prism/xterm, CLS no worse",
    evidence: [
      evidence(
        "e2e",
        "e2e/spa-chat.spec.ts",
        "SPA chat first paint stays within the recorded legacy CLS",
      ),
      evidence("static", "ui/router.ts", 'import("./pages/ChatPage.vue")'),
      evidence("static", "scripts/check-ui.mjs", "ChatPage must stay a lazy chunk"),
    ],
  },
  {
    section: "7.3",
    behavior: "no v-html, safe text-only Markdown, cookie-only reads, no secrets in URLs",
    evidence: [
      evidence("static", "ui/components/chat/MarkdownBlock.vue", "renderMarkdown"),
      evidence("component", "test/ui/chat-markdown.test.ts", "never creates script/image nodes"),
    ],
  },
  {
    section: "7.4",
    behavior: "role=log feed, live status, composer description, focus and drawer keyboard paths",
    evidence: [
      evidence("static", "ui/components/chat/ChatThread.vue", 'role="log"'),
      evidence("static", "ui/pages/ChatPage.vue", 'role="status"'),
      evidence("e2e", "e2e/spa-chat.spec.ts", "SPA chat mobile drawers open and close"),
    ],
  },
];

function eventTypesFromSource(): string[] {
  const source = read("src/opencode/events.ts");
  const start = source.indexOf("export type HanseEvent =");
  const end = source.indexOf("/** Wire form:", start);
  const union = source.slice(start, end);
  return [...union.matchAll(/\|\s*\{\s*type:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function partTypesFromSource(): string[] {
  const source = read("src/opencode/events.ts");
  const start = source.indexOf("export type PartType =");
  const end = source.indexOf("export type TruncationLimit", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function vueSources(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...vueSources(resolved));
    } else if (entry.isFile() && entry.name.endsWith(".vue")) {
      files.push(resolved);
    }
  }
  return files;
}

describe("chat parity matrix", () => {
  it("covers every HanseEvent in src/opencode/events.ts exactly once", () => {
    const source = eventTypesFromSource();
    expect(source.length).toBeGreaterThan(0);
    expect(new Set(source).size).toBe(source.length);
    const matrix = EVENTS.map((row) => row.event);
    expect(new Set(matrix).size, "duplicate event row").toBe(matrix.length);
    for (const event of source) {
      expect(matrix, `missing HanseEvent row: ${event}`).toContain(event);
    }
    for (const event of matrix) {
      expect(source, `stale HanseEvent row: ${event}`).toContain(event);
    }
  });

  it("covers all twelve PartTypes plus the unknown reconcile path", () => {
    const source = partTypesFromSource();
    expect(source).toHaveLength(12);
    expect(new Set(source)).toEqual(new Set(PART_TYPES as readonly string[]));
    for (const part of source) {
      expect(
        PART_ROWS.some((row) => row.part === part),
        `missing PartType row: ${part}`,
      ).toBe(true);
    }
    expect(PART_ROWS.some((row) => row.part === "<unknown>")).toBe(true);
    expect(new Set(PART_ROWS.map((row) => row.part)).size).toBe(PART_ROWS.length);
  });

  it("resolves every event and part evidence marker to a real protecting test", () => {
    for (const row of [...EVENTS, ...PART_ROWS]) {
      const evidenceRows =
        "evidence" in row ? row.evidence : [evidence("component", row.file, row.contains)];
      for (const item of evidenceRows) {
        const source = read(item.path);
        expect(source.length, `${item.path} is empty`).toBeGreaterThan(0);
        expect(source, `${item.path} lost marker: ${item.contains}`).toContain(item.contains);
      }
    }
  });

  it("covers every design §2 and §7 subsection with executable or recorded evidence", () => {
    const design = read("docs/design/chat-terminal-migration.md");
    for (const section of DESIGN_SECTIONS) {
      expect(design, `design heading missing: ${section}`).toContain(`### ${section} `);
      expect(
        BEHAVIORS.some((row) => row.section === section),
        `missing behavior row for §${section}`,
      ).toBe(true);
    }
    for (const row of BEHAVIORS) {
      expect(DESIGN_SECTIONS).toContain(row.section);
      for (const item of row.evidence) {
        const source = read(item.path);
        expect(source, `${item.path} lost marker: ${item.contains}`).toContain(item.contains);
      }
    }
  });

  it("keeps the Markdown renderer text-only and the Vue tree free of v-html", () => {
    const markdown = read("ui/components/chat/MarkdownBlock.vue");
    expect(markdown).toContain("renderMarkdown");
    for (const file of vueSources("ui")) {
      expect(read(file), `${file} uses v-html`).not.toMatch(/\bv-html\b/);
    }
  });

  it("keeps chat and terminal chunks lazy and Prism/xterm out of the entry", () => {
    const router = read("ui/router.ts");
    expect(router).toContain('import("./pages/ChatPage.vue")');
    expect(router).toContain('import("./pages/TerminalPage.vue")');
    const main = read("ui/main.ts");
    expect(main).not.toContain("ChatPage");
    expect(main).not.toContain("TerminalPage");
  });
});
