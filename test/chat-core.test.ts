import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  classifyOmo,
  deriveQueue,
  parseMarkdownTable,
  rekeyOptimistic,
} from "../assets/chat-core.js";

interface PartInit {
  id: string;
  type: string;
  text?: string;
  data?: Record<string, unknown>;
  provisional?: boolean;
  sealed?: boolean;
  version?: number;
}

interface MessageInit {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  finish?: string;
  time?: { created?: number; completed?: number };
  optimistic?: "sending" | "queued" | "accepted" | "unknown" | "failed";
  system?: Record<string, unknown>;
  classificationPending?: boolean;
  needsReconcile?: boolean;
  parts?: PartInit[];
}

interface StoreInit {
  messages: MessageInit[];
  activePromptID?: string | null;
  generation?: number;
  turnGeneration?: number;
  openParts?: string[];
  pendingDeltas?: Array<[string, string]>;
  sessionStatusType?: string;
}

function makePart(init: PartInit) {
  const data = init.data ?? (init.text === undefined ? {} : { text: init.text });
  return {
    id: init.id,
    type: init.type,
    data,
    provisional: init.provisional,
    sealed: init.sealed,
    version: init.version ?? 1,
  };
}

function makeMessage(init: MessageInit) {
  const parts = (init.parts ?? []).map(makePart);
  return {
    id: init.id,
    role: init.role,
    parentID: init.parentID,
    finish: init.finish,
    time: init.time,
    optimistic: init.optimistic,
    system: init.system,
    classificationPending: init.classificationPending,
    needsReconcile: init.needsReconcile,
    partOrder: parts.map((part) => part.id),
    parts: new Map(parts.map((part) => [part.id, part])),
    version: 1,
  };
}

function makeStore(init: StoreInit) {
  const records = init.messages.map(makeMessage);
  return {
    sessionID: "ses_1",
    generation: init.generation ?? 1,
    turnGeneration: init.turnGeneration ?? 0,
    order: records.map((record) => record.id),
    messages: new Map(records.map((record) => [record.id, record])),
    activePromptID: init.activePromptID ?? null,
    queue: [] as string[],
    openParts: new Set(init.openParts ?? []),
    lastSeqByStream: new Map<string, number>([["stream", 0]]),
    currentStreamID: "stream",
    pendingDeltas: new Map<string, string>(init.pendingDeltas ?? []),
    agentStatus: { type: init.sessionStatusType ?? "busy" },
    connection: "live" as const,
  };
}

function textPart(id: string, text: string, extra: Record<string, unknown> = {}): PartInit {
  return { id, type: "text", data: { text, ...extra } };
}

function user(id: string, parts: PartInit[] = []): MessageInit {
  return { id, role: "user", parts };
}

function assistant(
  id: string,
  parts: PartInit[],
  extra: Record<string, unknown> = {},
): MessageInit {
  return { id, role: "assistant", parts, ...extra } as MessageInit;
}

function snapPart(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, ...data };
}

function snapMessage(
  id: string,
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
  info: Record<string, unknown> = {},
) {
  return { info: { id, role, ...info }, parts };
}

let omoPartCounter = 0;

function omoText(text: string, extra: Record<string, unknown> = {}): PartInit {
  omoPartCounter++;
  return {
    id: `text_${omoPartCounter}`,
    type: "text",
    data: { text, ...extra },
  };
}

function omoMessage(parts: PartInit[], role: "user" | "assistant" = "user") {
  return {
    role,
    parts: new Map(parts.map((part) => [part.id, makePart(part)])),
  };
}

function rawMessageUpdated(info: Record<string, unknown>) {
  return { type: "message.updated", properties: { sessionID: "ses_1", info } };
}

function rawPartUpdated(part: Record<string, unknown>) {
  return { type: "message.part.updated", properties: { sessionID: "ses_1", part } };
}

describe("deriveQueue", () => {
  it("clears every prompt up to the combined reply parentID", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        user("u2"),
        assistant("a1", [textPart("a1t", "combined answer")], {
          parentID: "u2",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
      ],
      activePromptID: "u1",
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: null,
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: null,
    });
  });

  it("keeps later prompts queued after a consume race", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        user("u2"),
        assistant("a1", [textPart("a1t", "answer to u1")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u3"),
      ],
      activePromptID: "u1",
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.turnContinues).toBe(false);
    expect(derived.activeID).toBe("u2");
    expect(derived.queuedIDs).toEqual(["u3"]);
    expect(derived.nextActivePromptID).toBe("u2");
  });

  it("does not clear prompts for a bare assistant shell", () => {
    const store = makeStore({
      messages: [user("u1"), user("u2"), assistant("a1", [])],
      activePromptID: "u1",
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.activeID).toBe("u1");
    expect(derived.queuedIDs).toEqual(["u2"]);
    expect(derived.turnContinues).toBe(false);
  });

  it("keeps the turn open for a completed assistant with finish tool-calls", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "calling a tool")], {
          parentID: "u1",
          finish: "tool-calls",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
      ],
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.turnContinues).toBe(true);
    expect(derived.activeID).toBeNull();
    expect(derived.queuedIDs).toEqual(["u2"]);
    expect(derived.nextActivePromptID).toBeNull();
  });

  it("ignores a trailing retry part when finding the visible assistant", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        assistant("a2", [{ id: "a2retry", type: "retry", data: { attempt: 1 } }]),
        user("u2"),
      ],
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.activeID).toBe("u2");
    expect(derived.queuedIDs).toEqual([]);
  });

  it("forces turnContinues false when the session is idle", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "aborted")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1 },
        }),
        user("u2"),
      ],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: null,
      queuedIDs: ["u2"],
      turnContinues: true,
      nextActivePromptID: null,
    });
    expect(deriveQueue(store, { sessionStatusType: "idle" })).toEqual({
      activeID: "u2",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u2",
    });
  });

  it("makes a new prompt active after a completed previous turn", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
      ],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: "u2",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u2",
    });
  });

  it("queues prompts while an assistant is streaming", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "streaming")], { parentID: "u1", time: { created: 1 } }),
        user("u2"),
        user("u3"),
      ],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: null,
      queuedIDs: ["u2", "u3"],
      turnContinues: true,
      nextActivePromptID: null,
    });
  });

  it("excludes OMO system rows and rows with pending classification", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
        {
          ...user("sys"),
          system: { kind: "System reminder", tone: "neutral", headers: [], title: "x", body: "" },
        },
        { ...user("classifying"), classificationPending: true },
      ],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: "u2",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u2",
    });

    const onlyOmo = makeStore({
      messages: [
        user("u1"),
        {
          ...user("sys"),
          system: { kind: "System", tone: "neutral", headers: [], title: "x", body: "" },
        },
        { ...user("classifying"), classificationPending: true },
      ],
    });
    expect(deriveQueue(onlyOmo, { sessionStatusType: "busy" })).toEqual({
      activeID: "u1",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u1",
    });
  });

  it("includes optimistic sending and unknown rows", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        { ...user("temp_sending", [textPart("tp1", "one")]), optimistic: "sending" },
        { ...user("temp_unknown", [textPart("tp2", "two")]), optimistic: "unknown" },
      ],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: "temp_sending",
      queuedIDs: ["temp_unknown"],
      turnContinues: false,
      nextActivePromptID: "temp_sending",
    });
  });

  it("ignores a failed user record even when it is the last prompt", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        { ...user("u_failed", [textPart("fp", "boom")]), optimistic: "failed" },
      ],
      activePromptID: "u_failed",
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" })).toEqual({
      activeID: null,
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: null,
    });
  });

  it("reconstructs the same queue from a reloaded snapshot", () => {
    const messages = [
      user("u1"),
      assistant("a1", [textPart("a1t", "done")], {
        parentID: "u1",
        finish: "stop",
        time: { created: 1, completed: 2 },
      }),
      user("u2"),
      user("u3"),
    ];
    const reloaded = makeStore({ messages });
    const first = deriveQueue(reloaded, { sessionStatusType: "busy" });
    expect(first.activeID).toBe("u2");
    expect(first.queuedIDs).toEqual(["u3"]);

    const again = makeStore({
      messages,
      activePromptID: first.nextActivePromptID,
    });
    expect(deriveQueue(again, { sessionStatusType: "busy" })).toEqual(first);
  });

  it("persists a tracked activePromptID that is still pending", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
        user("u3"),
      ],
      activePromptID: "u3",
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.activeID).toBe("u3");
    expect(derived.queuedIDs).toEqual([]);
    expect(derived.nextActivePromptID).toBe("u3");
  });

  it("clears a tracked activePromptID once it leaves pending", () => {
    const store = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "done")], {
          parentID: "u1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
      ],
      activePromptID: "u1",
    });

    const derived = deriveQueue(store, { sessionStatusType: "busy" });
    expect(derived.activeID).toBe("u2");
    expect(derived.nextActivePromptID).toBe("u2");
  });

  it("uses the assistant feed position when parentID is absent or unusable", () => {
    const absent = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "answer")], {
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
      ],
    });
    expect(deriveQueue(absent, { sessionStatusType: "busy" })).toEqual({
      activeID: "u2",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u2",
    });

    const unusable = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "answer")], {
          parentID: "missing",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
        user("u2"),
      ],
    });
    expect(deriveQueue(unusable, { sessionStatusType: "busy" })).toEqual({
      activeID: "u2",
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: "u2",
    });
  });

  it("ignores non-renderable assistant parts when finding the boundary", () => {
    const nonRenderable = [
      { id: "a1s", type: "step-start", data: {} },
      { id: "a1f", type: "step-finish", data: {} },
      { id: "a1c", type: "compaction", data: {} },
      { id: "a1snap", type: "snapshot", data: {} },
      { id: "a1agent", type: "agent", data: {} },
      { id: "a1empty", type: "text", data: { text: "   " } },
      { id: "a1ignored", type: "text", data: { text: "hidden", ignored: true } },
    ];
    const store = makeStore({
      messages: [user("u1"), assistant("a1", nonRenderable), user("u2")],
    });

    expect(deriveQueue(store, { sessionStatusType: "busy" }).activeID).toBe("u1");
    expect(deriveQueue(store, { sessionStatusType: "busy" }).queuedIDs).toEqual(["u2"]);
  });

  it("treats tool, reasoning, patch, file, and subtask parts as visible", () => {
    for (const type of ["tool", "reasoning", "patch", "file", "subtask"]) {
      const store = makeStore({
        messages: [
          user("u1"),
          assistant("a1", [{ id: "a1p", type, data: {} }], {
            parentID: "u1",
            finish: "stop",
            time: { created: 1, completed: 2 },
          }),
          user("u2"),
        ],
      });
      expect(deriveQueue(store, { sessionStatusType: "busy" }).activeID).toBe("u2");
    }
  });
});

describe("classifyOmo", () => {
  const initiator = "<!-- OMO_INTERNAL_INITIATOR -->";

  it("classifies a marker-only message as an empty System card", () => {
    expect(classifyOmo(omoMessage([omoText(`\n${initiator}\n`)]))).toEqual({
      kind: "System",
      tone: "neutral",
      headers: [],
      title: "System",
      body: "",
    });
  });

  it("classifies a synthetic-only plain message as System", () => {
    const meta = classifyOmo(omoMessage([omoText("continue the work", { synthetic: true })]));
    expect(meta).toEqual({
      kind: "System",
      tone: "neutral",
      headers: [],
      title: "System",
      body: "continue the work",
    });
  });

  it("maps every recognized header to its kind and tone", () => {
    const cases: Array<[string, string, string]> = [
      ["[BACKGROUND TASK RESULT READY]", "Task result", "success"],
      ["[BACKGROUND TASK COMPLETED]", "Task result", "success"],
      ["[ALL BACKGROUND TASKS COMPLETE]", "Task result", "success"],
      ["[ALL BACKGROUND TASKS FINISHED - 2 FAILED]", "Task result", "error"],
      ["[BACKGROUND TASK ERROR]", "Task result", "error"],
      ["[BACKGROUND TASK CANCELLED]", "Background task", "warning"],
      ["[BACKGROUND TASK INTERRUPTED]", "Background task", "warning"],
      ["[BACKGROUND TASK RETRYING]", "Background task", "warning"],
      ["[BACKGROUND TASK RETRY SESSION READY]", "Background task", "info"],
      ["[BACKGROUND TASK SOMETHING NEW]", "Background task", "info"],
      ["[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]", "Continuation", "neutral"],
      ["[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]", "Continuation", "neutral"],
      ["[SYSTEM DIRECTIVE: OH-MY-OPENCODE - DELEGATION REQUIRED]", "System reminder", "neutral"],
      ["[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]", "System reminder", "neutral"],
      ["[SYSTEM REMINDER - BE NICE]", "System reminder", "neutral"],
      ["[WHAT IS THIS]", "System", "neutral"],
    ];

    for (const [header, kind, tone] of cases) {
      const meta = classifyOmo(omoMessage([omoText(`${header}\nbody`, { synthetic: true })]));
      expect(meta?.kind).toBe(kind);
      expect(meta?.tone).toBe(tone);
      expect(meta?.headers).toEqual([header]);
      expect(meta?.title).toBe(header);
      expect(meta?.body).toBe("body");
    }
  });

  it("recognizes RALPH LOOP and ULTRAWORK content as Continuation", () => {
    for (const token of ["RALPH LOOP", "ULTRAWORK"]) {
      const meta = classifyOmo(omoMessage([omoText(`${token}\nkeep going`, { synthetic: true })]));
      expect(meta?.kind).toBe("Continuation");
      expect(meta?.tone).toBe("neutral");
      expect(meta?.headers).toEqual([]);
      expect(meta?.title).toBe("Continuation");
      expect(meta?.body).toBe(`${token}\nkeep going`);
    }
  });

  it("treats a leading BOULDER COMPLETE line as the title", () => {
    const line = 'BOULDER COMPLETE: plan "demo" is fully checked.';
    const meta = classifyOmo(
      omoMessage([omoText(`${line}\n\nTotal elapsed: 1m`, { synthetic: true })]),
    );
    expect(meta?.kind).toBe("Continuation");
    expect(meta?.headers).toEqual([line]);
    expect(meta?.title).toBe(line);
    expect(meta?.body).toBe("Total elapsed: 1m");
  });

  it("unwraps system-reminder tags and extracts the header block", () => {
    const text = `${initiator}\n<system-reminder>\n[BACKGROUND TASK ERROR]\nboom\n</system-reminder>`;
    const meta = classifyOmo(omoMessage([omoText(text)]));
    expect(meta).toEqual({
      kind: "Task result",
      tone: "error",
      headers: ["[BACKGROUND TASK ERROR]"],
      title: "[BACKGROUND TASK ERROR]",
      body: "boom",
    });
  });

  it("does not classify when a later text part is a real operator part", () => {
    expect(
      classifyOmo(omoMessage([omoText("real prompt"), omoText(initiator, { synthetic: false })])),
    ).toBeNull();
  });

  it("classifies when every text part is synthetic or marked", () => {
    const meta = classifyOmo(
      omoMessage([omoText("first", { synthetic: true }), omoText(initiator)]),
    );
    expect(meta?.body).toBe("first");
    expect(meta?.kind).toBe("System");
  });

  it("excludes ignored parts from the body but includes them in classification", () => {
    const meta = classifyOmo(
      omoMessage([
        omoText("visible", { synthetic: true }),
        {
          id: "ignored_marked",
          type: "text",
          data: { text: "hidden", ignored: true, synthetic: true },
        },
      ]),
    );
    expect(meta?.body).toBe("visible");

    expect(
      classifyOmo(
        omoMessage([
          omoText("visible", { synthetic: true }),
          { id: "ignored_plain", type: "text", data: { text: "hidden", ignored: true } },
        ]),
      ),
    ).toBeNull();
  });

  it("classifies an operator false positive that pastes the marker", () => {
    const meta = classifyOmo(omoMessage([omoText(`do the thing\n${initiator}`)]));
    expect(meta?.kind).toBe("System");
    expect(meta?.body).toBe("do the thing");
  });

  it("returns null for non-user roles, non-text parts, and real operator text", () => {
    expect(classifyOmo(omoMessage([omoText(initiator)], "assistant"))).toBeNull();
    expect(
      classifyOmo(
        omoMessage([{ id: "tool", type: "tool", data: { state: { status: "completed" } } }]),
      ),
    ).toBeNull();
    expect(classifyOmo(omoMessage([omoText("just a prompt")]))).toBeNull();
  });

  it("accepts marker whitespace variants and strips the NOREPLY marker", () => {
    const noSpace = classifyOmo(omoMessage([omoText("<!--OMO_INTERNAL_INITIATOR-->")]));
    expect(noSpace?.kind).toBe("System");

    const noReply = classifyOmo(
      omoMessage([omoText("hello\n<!-- OMO_INTERNAL_NOREPLY -->", { synthetic: true })]),
    );
    expect(noReply?.body).toBe("hello");
  });

  it("stops header extraction at a blank line or non-bracket line", () => {
    const meta = classifyOmo(
      omoMessage([
        omoText("[SYSTEM REMINDER - A]\n[BACKGROUND TASK ERROR]\n\nbody text", {
          synthetic: true,
        }),
      ]),
    );
    expect(meta?.headers).toEqual(["[SYSTEM REMINDER - A]", "[BACKGROUND TASK ERROR]"]);
    expect(meta?.kind).toBe("System reminder");
    expect(meta?.title).toBe("[SYSTEM REMINDER - A] · [BACKGROUND TASK ERROR]");
    expect(meta?.body).toBe("body text");
  });

  it("bounds the title to 240 characters", () => {
    const header = `[${"X".repeat(300)}]`;
    const meta = classifyOmo(omoMessage([omoText(header, { synthetic: true })]));
    expect(meta?.title).toHaveLength(240);
  });

  it("joins multiple rendered text parts with a newline", () => {
    const meta = classifyOmo(
      omoMessage([omoText("one", { synthetic: true }), omoText("two", { synthetic: true })]),
    );
    expect(meta?.body).toBe("one\ntwo");
  });
});

describe("applySnapshot", () => {
  it("seals completed messages and leaves only the last uncompleted assistant open", () => {
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "hi" })], {
        time: { completed: 1 },
      }),
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "done" })], {
        parentID: "u1",
        time: { created: 1, completed: 2 },
        finish: "stop",
      }),
      snapMessage("u2", "user", [snapPart("u2p", "text", { text: "next" })], {
        time: { completed: 3 },
      }),
      snapMessage(
        "a2",
        "assistant",
        [
          snapPart("a2p", "text", { text: "working" }),
          snapPart("a2r", "reasoning", { text: "think" }),
        ],
        { parentID: "u2" },
      ),
    ];

    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    expect(store.messages.get("u1")?.parts.get("u1p")?.sealed).toBe(true);
    expect(store.messages.get("a1")?.parts.get("a1p")?.sealed).toBe(true);
    expect(store.messages.get("u2")?.parts.get("u2p")?.sealed).toBe(true);
    expect(store.messages.get("a2")?.parts.get("a2p")?.sealed).toBe(false);
    expect(store.messages.get("a2")?.parts.get("a2r")?.sealed).toBe(false);
  });

  it("seals older uncompleted assistants and leaves only the last one unsealed", () => {
    const snapshot = [
      snapMessage("a0", "assistant", [snapPart("a0p", "text", { text: "old" })]),
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "new" })]),
    ];

    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    expect(store.messages.get("a0")?.parts.get("a0p")?.sealed).toBe(true);
    expect(store.messages.get("a1")?.parts.get("a1p")?.sealed).toBe(false);
  });

  it("seals every part when the last assistant is complete and no tool is running", () => {
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "hi" })], {
        time: { completed: 1 },
      }),
      snapMessage(
        "a1",
        "assistant",
        [
          snapPart("a1p", "text", { text: "done" }),
          snapPart("a1tool", "tool", { state: { status: "completed" } }),
        ],
        { parentID: "u1", time: { created: 1, completed: 2 }, finish: "stop" },
      ),
    ];

    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    expect(store.messages.get("a1")?.parts.get("a1p")?.sealed).toBe(true);
    expect(store.messages.get("a1")?.parts.get("a1tool")?.sealed).toBe(true);
  });

  it("does not seal a running tool or the completed turn around it", () => {
    const snapshot = [
      snapMessage(
        "a1",
        "assistant",
        [
          snapPart("a1p", "text", { text: "done" }),
          snapPart("a1tool", "tool", { state: { status: "running" } }),
        ],
        { time: { created: 1, completed: 2 }, finish: "tool-calls" },
      ),
    ];

    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    expect(store.messages.get("a1")?.parts.get("a1p")?.sealed).toBe(true);
    expect(store.messages.get("a1")?.parts.get("a1tool")?.sealed).toBe(false);
  });

  it("discards a pending delta already included in the snapshot without duplicating text", () => {
    const current = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [{ id: "p1", type: "text", text: "hello", provisional: true }]),
      ],
      pendingDeltas: [["p1", " world"]],
    });
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "hi" })]),
      snapMessage("a1", "assistant", [snapPart("p1", "text", { text: "hello world" })]),
    ];

    const result = applySnapshot(current, snapshot);
    expect(result.contentDiscarded).toBe(true);
    expect(result.store.messages.get("a1")?.parts.get("p1")?.data.text).toBe("hello world");
    expect(result.store.pendingDeltas.has("p1")).toBe(false);
    expect(result.store.order).toEqual(["u1", "a1"]);
  });

  it("applies snapshot-only growth", () => {
    const current = makeStore({ messages: [] });
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "hi" })]),
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "hello" })]),
    ];

    const result = applySnapshot(current, snapshot);
    expect(result.contentDiscarded).toBe(false);
    expect(result.store.order).toEqual(["u1", "a1"]);
    expect(result.store.generation).toBe(2);
  });

  it("seals a completion snapshot", () => {
    const current = makeStore({
      messages: [assistant("a1", [textPart("a1p", "partial")], { parentID: "u1" })],
    });
    const snapshot = [
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "complete" })], {
        parentID: "u1",
        time: { created: 1, completed: 2 },
        finish: "stop",
      }),
    ];

    const { store } = applySnapshot(current, snapshot);
    const part = store.messages.get("a1")?.parts.get("a1p");
    expect(part?.data.text).toBe("complete");
    expect(part?.sealed).toBe(true);
  });

  it("merges a local optimistic row by server message ID without a duplicate", () => {
    const current = makeStore({
      messages: [
        {
          ...user("msg_a", [{ id: "local_part", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
      ],
    });
    const snapshot = [
      snapMessage("msg_a", "user", [snapPart("server_part", "text", { text: "hi" })]),
    ];

    const { store } = applySnapshot(current, snapshot);
    expect(store.order).toEqual(["msg_a"]);
    expect(store.messages.size).toBe(1);
    expect(store.messages.get("msg_a")?.optimistic).toBe("accepted");
    expect(store.messages.get("msg_a")?.partOrder).toEqual(["server_part"]);
    expect(store.messages.get("msg_a")?.parts.has("local_part")).toBe(false);
  });

  it("keeps an absent in-flight/unknown row and resolves one present in the snapshot", () => {
    const current = makeStore({
      messages: [{ ...user("msg_u", [textPart("lp", "pending")]), optimistic: "unknown" }],
    });

    const absent = applySnapshot(current, []);
    expect(absent.store.messages.get("msg_u")?.optimistic).toBe("unknown");
    expect(absent.store.order).toEqual(["msg_u"]);

    const present = applySnapshot(current, [
      snapMessage("msg_u", "user", [snapPart("sp", "text", { text: "pending" })]),
    ]);
    expect(present.store.messages.get("msg_u")?.optimistic).toBe("accepted");
    expect(present.store.messages.size).toBe(1);
    expect(present.store.messages.get("msg_u")?.parts.has("sp")).toBe(true);
  });

  it("preserves a failed user row across snapshot reconciliation", () => {
    const local = makeStore({
      messages: [{ ...user("local_failed", [textPart("lf", "boom")]), optimistic: "failed" }],
    });
    const kept = applySnapshot(local, []).store;
    expect(kept.messages.get("local_failed")?.optimistic).toBe("failed");
    expect(kept.order).toEqual(["local_failed"]);
    expect(kept.queue).toEqual([]);
    expect(deriveQueue(kept, { sessionStatusType: "idle" }).activeID).toBeNull();

    const adopted = applySnapshot(local, [
      snapMessage("local_failed", "user", [snapPart("sf", "text", { text: "boom" })]),
    ]).store;
    expect(adopted.messages.get("local_failed")?.optimistic).toBe("failed");
    expect(adopted.queue).toEqual([]);
    expect(deriveQueue(adopted, { sessionStatusType: "idle" }).activeID).toBeNull();
  });

  it("keeps a local synthetic error card when the snapshot is empty", () => {
    const errorID = "local_error_stream_1";
    const partID = `${errorID}:part:text`;
    const current = makeStore({
      messages: [
        {
          id: errorID,
          role: "assistant",
          time: { created: 1 },
          parts: [{ id: partID, type: "text", text: "**Agent error:** boom", sealed: true }],
        },
      ],
    });

    const { store } = applySnapshot(current, []);
    expect(store.order).toEqual([errorID]);
    expect(store.messages.get(errorID)?.role).toBe("assistant");
    expect(store.messages.get(errorID)?.parts.get(partID)?.data.text).toBe("**Agent error:** boom");
  });

  it("derives queued presentation for a kept optimistic row during a streaming turn", () => {
    const current = makeStore({
      messages: [
        user("u1"),
        assistant("a1", [textPart("a1t", "streaming")], { parentID: "u1", time: { created: 1 } }),
        { ...user("msg_q", [textPart("qp", "queued")]), optimistic: "queued" },
      ],
    });
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "hi" })]),
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "streaming" })], {
        parentID: "u1",
        time: { created: 1 },
      }),
    ];

    const { store } = applySnapshot(current, snapshot);
    expect(store.queue).toEqual(["msg_q"]);
    expect(store.messages.get("msg_q")?.optimistic).toBe("queued");
  });

  it("preserves openParts by part ID and clears needsReconcile", () => {
    const current = makeStore({
      messages: [assistant("a1", [textPart("a1p", "old")], { needsReconcile: true })],
      openParts: ["a1p", "gone"],
    });
    const snapshot = [snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "new" })])];

    const { store } = applySnapshot(current, snapshot);
    expect(store.openParts).toEqual(new Set(["a1p"]));
    expect(store.messages.get("a1")?.needsReconcile).toBeUndefined();
  });

  it("increments generation and reports a captured turn change", () => {
    const current = makeStore({ messages: [], generation: 5, turnGeneration: 3 });

    const changed = applySnapshot(current, [], { capturedTurnGeneration: 2 });
    expect(changed.turnChanged).toBe(true);
    expect(changed.store.generation).toBe(6);

    const unchanged = applySnapshot(current, [], { capturedTurnGeneration: 3 });
    expect(unchanged.turnChanged).toBe(false);
  });

  it("recomputes the queue and active prompt from the snapshot", () => {
    const current = makeStore({
      messages: [user("u1")],
      activePromptID: "u1",
    });
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "one" })], {
        time: { completed: 1 },
      }),
      snapMessage("a1", "assistant", [snapPart("a1p", "text", { text: "done" })], {
        parentID: "u1",
        time: { created: 1, completed: 2 },
        finish: "stop",
      }),
      snapMessage("u2", "user", [snapPart("u2p", "text", { text: "two" })], {
        time: { completed: 3 },
      }),
    ];

    const { store } = applySnapshot(current, snapshot);
    expect(store.activePromptID).toBe("u2");
    expect(store.queue).toEqual([]);
  });

  it("classifies OMO from a complete snapshot and excludes it from the queue", () => {
    const snapshot = [
      snapMessage("u1", "user", [snapPart("u1p", "text", { text: "operator" })], {
        time: { completed: 1 },
      }),
      snapMessage(
        "sys",
        "user",
        [
          snapPart("sysp", "text", {
            text: "<!-- OMO_INTERNAL_INITIATOR -->\n[BACKGROUND TASK ERROR]\nboom",
          }),
        ],
        { time: { completed: 2 } },
      ),
    ];

    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    const system = store.messages.get("sys")?.system;
    expect(system?.kind).toBe("Task result");
    expect(system?.tone).toBe("error");
    expect(deriveQueue(store, { sessionStatusType: "busy" }).queuedIDs).toEqual([]);
    expect(deriveQueue(store, { sessionStatusType: "busy" }).activeID).toBe("u1");
  });

  it("keeps content for a provisional local row absent from the snapshot", () => {
    const current = makeStore({
      messages: [
        {
          ...user("msg_local", [{ id: "local_p", type: "text", text: "hi" }]),
          optimistic: "sending",
        },
      ],
      pendingDeltas: [["local_p", " there"]],
    });

    const result = applySnapshot(current, []);
    expect(result.store.messages.get("msg_local")?.parts.get("local_p")?.data.text).toBe("hi");
    expect(result.store.pendingDeltas.get("local_p")).toBe(" there");
    expect(result.contentDiscarded).toBe(false);
  });

  it("drops non-optimistic local rows that are absent from the snapshot", () => {
    const current = makeStore({ messages: [user("old")] });
    const { store } = applySnapshot(current, []);
    expect(store.order).toEqual([]);
    expect(store.messages.size).toBe(0);
  });

  it("honors an explicit discarded-content signal", () => {
    const result = applySnapshot(makeStore({ messages: [] }), [], { contentDiscarded: true });
    expect(result.contentDiscarded).toBe(true);
  });
});

describe("rekeyOptimistic", () => {
  it("moves the temp row, applies only matching buffered events, and adopts the text part", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
      ],
    });

    const { store, consumed } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [
        rawMessageUpdated({ id: "other", role: "user" }),
        rawPartUpdated({ id: "other_p", messageID: "other", type: "text", text: "no" }),
        rawPartUpdated({ id: "p_up", messageID: "msg_1", type: "text", text: "hi" }),
        rawMessageUpdated({ id: "msg_1", role: "user" }),
      ],
    });

    expect(consumed).toBe(false);
    expect(store.order).toEqual(["msg_1"]);
    expect(store.messages.size).toBe(1);
    expect(store.messages.has("local_1")).toBe(false);
    const record = store.messages.get("msg_1");
    expect(record?.partOrder).toEqual(["p_up"]);
    expect(record?.parts.get("p_up")?.data.text).toBe("hi");
    expect(record?.optimistic).toBe("accepted");
  });

  it("keeps the placeholder part ID until a text snapshot arrives", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
      ],
    });

    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [rawMessageUpdated({ id: "msg_1", role: "user" })],
    });

    const record = store.messages.get("msg_1");
    expect(record?.partOrder).toEqual(["local_p"]);
    expect(record?.parts.get("local_p")?.provisional).toBe(true);
  });

  it("reports consumed when an assistant parentID covers the rekeyed row", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
        assistant("a1", [textPart("a1p", "answer")], {
          parentID: "msg_1",
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
      ],
    });

    const { store, consumed } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [rawMessageUpdated({ id: "msg_1", role: "user" })],
    });

    expect(consumed).toBe(true);
    expect(store.order).toEqual(["msg_1", "a1"]);
    expect(store.messages.get("msg_1")?.optimistic).toBe("accepted");
    expect(store.queue).toEqual([]);
    expect(store.activePromptID).toBeNull();
  });

  it("does not report consumed for a bare assistant shell parentID", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
        assistant("a1", [], { parentID: "msg_1" }),
      ],
    });

    const { consumed } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [rawMessageUpdated({ id: "msg_1", role: "user" })],
    });

    expect(consumed).toBe(false);
  });

  it("keeps the optimistic row feed position", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
        assistant("a2", [textPart("a2p", "older")], {
          finish: "stop",
          time: { created: 1, completed: 2 },
        }),
      ],
    });

    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [rawMessageUpdated({ id: "msg_1", role: "user" })],
    });

    expect(store.order).toEqual(["msg_1", "a2"]);
  });

  it("merges with an existing server row without a second row or duplicate text", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
        user("msg_1", [textPart("p_server", "hi")]),
      ],
    });

    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [
        rawPartUpdated({ id: "p_server", messageID: "msg_1", type: "text", text: "hi" }),
        rawMessageUpdated({ id: "msg_1", role: "user" }),
      ],
    });

    expect(store.order).toEqual(["msg_1"]);
    expect(store.messages.size).toBe(1);
    expect(store.messages.get("msg_1")?.partOrder).toEqual(["p_server"]);
    expect(store.messages.get("msg_1")?.parts.get("p_server")?.data.text).toBe("hi");
  });

  it("marks a rekeyed row queued while the turn continues", () => {
    const current = makeStore({
      messages: [
        user("u1"),
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "sending",
        },
        assistant("a1", [textPart("a1p", "streaming")], {
          parentID: "u1",
          time: { created: 1 },
        }),
      ],
      activePromptID: "u1",
    });

    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [rawMessageUpdated({ id: "msg_1", role: "user" })],
    });

    expect(store.messages.get("msg_1")?.optimistic).toBe("queued");
    expect(store.queue).toEqual(["msg_1"]);
  });

  it("preserves an unknown acceptance state", () => {
    const current = makeStore({
      messages: [
        {
          ...user("local_1", [{ id: "local_p", type: "text", text: "hi", provisional: true }]),
          optimistic: "unknown",
        },
      ],
    });

    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [],
    });

    expect(store.messages.get("msg_1")?.optimistic).toBe("unknown");
  });
});

describe("parseMarkdownTable", () => {
  it("parses a basic table with alignment and outer pipes", () => {
    const lines = ["| Name | Score |", "| :--- | ---: |", "| Ada | 10 |", "| Bob | 9 |"];
    expect(parseMarkdownTable(lines, 0)).toEqual({
      headers: [
        { text: "Name", align: "left" },
        { text: "Score", align: "right" },
      ],
      rows: [
        ["Ada", "10"],
        ["Bob", "9"],
      ],
      truncated: false,
      nextIndex: 4,
    });
  });

  it("parses a table without outer pipes and honors center alignment", () => {
    expect(parseMarkdownTable(["a | b | c", "--- | :---: | ---:"], 0)).toEqual({
      headers: [
        { text: "a", align: "left" },
        { text: "b", align: "center" },
        { text: "c", align: "right" },
      ],
      rows: [],
      truncated: false,
      nextIndex: 2,
    });
  });

  it("handles escaped pipes without splitting the cell", () => {
    const table = parseMarkdownTable(["| a \\| b | c |", "| --- | --- |", "| x \\| y | z |"], 0);
    expect(table?.headers).toEqual([
      { text: "a | b", align: "left" },
      { text: "c", align: "left" },
    ]);
    expect(table?.rows).toEqual([["x | y", "z"]]);
  });

  it("ignores pipes inside backtick code spans", () => {
    const table = parseMarkdownTable(["| `a | b` | c |", "| --- | --- |", "| `x | y` | z |"], 0);
    expect(table?.headers).toEqual([
      { text: "`a | b`", align: "left" },
      { text: "c", align: "left" },
    ]);
    expect(table?.rows).toEqual([["`x | y`", "z"]]);
  });

  it("pads ragged rows and discards extra cells without shifting", () => {
    const table = parseMarkdownTable(
      ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 |", "| 3 | 4 | 5 | 6 |"],
      0,
    );
    expect(table?.rows).toEqual([
      ["1", "2", ""],
      ["3", "4", "5"],
    ]);
  });

  it("accepts a one-column table with one dash and pipes on both lines", () => {
    expect(parseMarkdownTable(["| a |", "| - |", "| x |"], 0)).toEqual({
      headers: [{ text: "a", align: "left" }],
      rows: [["x"]],
      truncated: false,
      nextIndex: 3,
    });
  });

  it("rejects a prose pipe followed by a delimiter line with a different count", () => {
    expect(parseMarkdownTable(["the pipe | is nice", "---"], 0)).toBeNull();
    expect(parseMarkdownTable(["a | b", "---"], 0)).toBeNull();
    expect(parseMarkdownTable(["a | b | c", "--- | ---"], 0)).toBeNull();
  });

  it("rejects invalid delimiter cells", () => {
    expect(parseMarkdownTable(["| a |", "| : |"], 0)).toBeNull();
    expect(parseMarkdownTable(["| a |", "| -x- |"], 0)).toBeNull();
  });

  it("rejects a table over the column cap", () => {
    const columns = Array.from({ length: 17 }, (_, index) => `h${index}`);
    const header = `| ${columns.join(" | ")} |`;
    const delimiter = `| ${columns.map(() => "---").join(" | ")} |`;
    expect(parseMarkdownTable([header, delimiter], 0)).toBeNull();
  });

  it("truncates body rows at 200", () => {
    const lines = [
      "| a |",
      "| --- |",
      ...Array.from({ length: 201 }, (_, index) => `| ${index} |`),
    ];
    const table = parseMarkdownTable(lines, 0);
    expect(table?.rows).toHaveLength(200);
    expect(table?.rows[0]).toEqual(["0"]);
    expect(table?.rows[199]).toEqual(["199"]);
    expect(table?.truncated).toBe(true);
    expect(table?.nextIndex).toBe(203);
  });

  it("caps each cell at 2000 characters", () => {
    const long = "x".repeat(2500);
    const table = parseMarkdownTable([`| ${long} |`, "| --- |", `| ${long} |`], 0);
    expect(table?.headers[0]?.text).toHaveLength(2000);
    expect(table?.rows[0]?.[0]).toHaveLength(2000);
  });

  it("supports a non-zero start index and stops at a blank or non-pipe line", () => {
    const lines = ["intro", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "after"];
    const table = parseMarkdownTable(lines, 1);
    expect(table?.rows).toEqual([["1", "2"]]);
    expect(table?.nextIndex).toBe(4);
  });

  it("supports leading-only and trailing-only outer pipes", () => {
    expect(parseMarkdownTable(["| a | b", "--- | ---"], 0)?.headers).toHaveLength(2);
    expect(parseMarkdownTable(["a | b |", "--- | ---"], 0)?.headers).toHaveLength(2);
  });

  it("does not start on a line without a separator pipe", () => {
    expect(parseMarkdownTable(["a b", "--- | ---"], 0)).toBeNull();
    expect(parseMarkdownTable(["a \\| b", "---"], 0)).toBeNull();
  });
});
