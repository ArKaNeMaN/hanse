import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  currentTurnPrompt,
  deriveTurn,
  readFinalAnswer,
  readTurnSnapshot,
} from "../src/chat/turn.js";
import {
  assistantMessage,
  busyStatus,
  idleStatus,
  manifestPart,
  omoPart,
  reasoningPart,
  resumePart,
  retryStatus,
  TURN_SESSION_ID,
  textPart,
  toolPart,
  turnFixtures,
  userMessage,
} from "./fixtures/chat-turn.js";

const options = { isSubagent: false, settling: false, queuedTruncated: false };

describe("deriveTurn", () => {
  it("returns idle with no queued prompt for a normal completed turn", () => {
    const snapshot = deriveTurn(turnFixtures.completedTurn, idleStatus, options);
    expect(snapshot).toMatchObject({
      sessionID: TURN_SESSION_ID,
      status: { type: "idle" },
      turnContinues: false,
      runningPromptID: null,
      activePromptID: null,
      queuedPromptIDs: [],
      queuedTruncated: false,
      settling: false,
    });
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes the in-flight head the running prompt before the first visible part", () => {
    const snapshot = deriveTurn(turnFixtures.busyPreFirstPart, busyStatus, options);
    expect(snapshot).toMatchObject({
      status: { type: "busy" },
      turnContinues: false,
      runningPromptID: "msg_u1",
      activePromptID: "msg_u1",
      queuedPromptIDs: ["msg_u1"],
    });
  });

  it("keeps the current turn open and counts only the queued tail while busy", () => {
    const snapshot = deriveTurn(turnFixtures.busyWithQueue, busyStatus, options);
    expect(snapshot).toMatchObject({
      status: { type: "busy" },
      turnContinues: true,
      runningPromptID: null,
      activePromptID: null,
      queuedPromptIDs: ["msg_u2"],
    });
    const displayCount =
      snapshot.queuedPromptIDs.length - (snapshot.runningPromptID === null ? 0 : 1);
    expect(displayCount).toBe(1);
  });

  it("keeps a multi-step turn open on tool-calls until the status is idle", () => {
    const busy = deriveTurn(turnFixtures.multiStep, busyStatus, options);
    expect(busy).toMatchObject({
      status: { type: "busy" },
      turnContinues: true,
      runningPromptID: null,
      queuedPromptIDs: ["msg_u2"],
    });

    const idle = deriveTurn(turnFixtures.multiStep, idleStatus, options);
    expect(idle).toMatchObject({
      status: { type: "idle" },
      turnContinues: false,
      runningPromptID: null,
      activePromptID: "msg_u2",
      queuedPromptIDs: ["msg_u2"],
    });
    expect(idle.queuedPromptIDs.length).toBe(1);
  });

  it("returns unknown for an absent subagent status and never idle", () => {
    const snapshot = deriveTurn(turnFixtures.completedTurn, undefined, {
      ...options,
      isSubagent: true,
    });
    expect(snapshot.status).toEqual({ type: "unknown" });
    expect(snapshot.queuedPromptIDs).toEqual([]);
  });

  it("treats an absent top-level status as idle", () => {
    const snapshot = deriveTurn(turnFixtures.busyPreFirstPart, undefined, options);
    expect(snapshot.status).toEqual({ type: "idle" });
    expect(snapshot.activePromptID).toBe("msg_u1");
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u1"]);
  });

  it("maps an unrecognized status type to unknown and keeps retry details", () => {
    const unknown = deriveTurn(turnFixtures.busyPreFirstPart, { type: "paused" }, options);
    expect(unknown.status).toEqual({ type: "unknown" });
    expect(unknown.runningPromptID).toBeNull();

    const retry = deriveTurn(turnFixtures.completedTurn, retryStatus, options);
    expect(retry.status).toEqual(retryStatus);
    expect(retry.activePromptID).toBeNull();
  });

  it("uses the parent user as the boundary when it is a normal prompt", () => {
    const messages = [
      userMessage("msg_u1", [textPart("first")]),
      assistantMessage("msg_a1", [textPart("answer")], {
        parentID: "msg_u1",
        finish: "stop",
        completed: true,
      }),
      userMessage("msg_u2", [textPart("second")]),
    ];
    const snapshot = deriveTurn(messages, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u2"]);
    expect(snapshot.activePromptID).toBe("msg_u2");
  });

  it("ignores a non-normal parent and bare shells while finding the boundary", () => {
    const messages = [
      userMessage("msg_h", [textPart("handoff")], { hanse: { handoff: { id: "h1" } } }),
      assistantMessage("msg_a1", [textPart("answer")], {
        parentID: "msg_h",
        finish: "stop",
        completed: true,
      }),
      userMessage("msg_empty", [manifestPart()]),
      userMessage("msg_u2", [textPart("second")]),
    ];
    const snapshot = deriveTurn(messages, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u2"]);
  });

  it("counts hidden non-text parts but not synthetic text as a visible assistant", () => {
    const messages = [
      userMessage("msg_u1", [textPart("first")]),
      assistantMessage("msg_syn", [textPart("hidden", { synthetic: true })], {
        parentID: "msg_u1",
        completed: true,
      }),
      assistantMessage("msg_reason", [reasoningPart("thinking")], {
        parentID: "msg_u1",
        completed: true,
      }),
    ];
    const snapshot = deriveTurn(
      [...messages, userMessage("msg_u2", [textPart("next")])],
      idleStatus,
      options,
    );
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u2"]);
  });

  it("treats tool/reasoning/file/subtask parts as visible assistant content", () => {
    for (const part of [
      toolPart(),
      reasoningPart("thinking"),
      { type: "patch" },
      { type: "file", mime: "text/plain" },
      { type: "subtask" },
    ]) {
      const messages = [
        userMessage("msg_u1", [textPart("first")]),
        assistantMessage("msg_a1", [part], { parentID: "msg_u1", completed: true }),
        userMessage("msg_u2", [textPart("next")]),
      ];
      const snapshot = deriveTurn(messages, idleStatus, options);
      expect(snapshot.queuedPromptIDs, JSON.stringify(part)).toEqual(["msg_u2"]);
    }
  });

  it("never queues handoff or OMO internal rows", () => {
    const messages = [
      ...turnFixtures.completedTurn,
      userMessage("msg_hand", [textPart("handoff")], { hanse: { handoff: { id: "h1" } } }),
      userMessage("msg_omo", [omoPart()]),
      userMessage("msg_u2", [textPart("real")]),
    ];
    const snapshot = deriveTurn(messages, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u2"]);
  });

  it("excludes a resume prompt and consumes the interrupted prompt it resumes", () => {
    const snapshot = deriveTurn(turnFixtures.resumeAfterInterrupted, idleStatus, options);
    expect(snapshot).toMatchObject({
      queuedPromptIDs: [],
      runningPromptID: null,
      activePromptID: null,
    });
  });

  it("counts an attachment-only row instead of treating it as empty", () => {
    const snapshot = deriveTurn(turnFixtures.attachmentOnlyQueue, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_att"]);
    expect(snapshot.activePromptID).toBe("msg_att");
  });

  it("ignores bare shells with no content or attachment", () => {
    const messages = [
      ...turnFixtures.completedTurn,
      userMessage("msg_empty", [textPart("   ")]),
      userMessage("msg_u2", [textPart("real")]),
    ];
    const snapshot = deriveTurn(messages, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u2"]);
  });

  it("marks a truncated tail and includes truncation in the revision", () => {
    const normal = deriveTurn(turnFixtures.busyPreFirstPart, idleStatus, options);
    const truncated = deriveTurn(turnFixtures.busyPreFirstPart, idleStatus, {
      ...options,
      queuedTruncated: true,
    });
    expect(truncated.queuedTruncated).toBe(true);
    expect(truncated.revision).not.toBe(normal.revision);
  });

  it("keeps the queue but flags a persistent status/history inconsistency", () => {
    const snapshot = deriveTurn(turnFixtures.busyPreFirstPart, idleStatus, {
      ...options,
      settling: true,
    });
    expect(snapshot.settling).toBe(true);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u1"]);
  });

  it("is deterministic for identical inputs", () => {
    const first = deriveTurn(turnFixtures.busyWithQueue, busyStatus, options);
    const second = deriveTurn(turnFixtures.busyWithQueue, busyStatus, options);
    expect(second).toEqual(first);
  });

  it("drops an empty assistant shell from the boundary and keeps the preceding user queued", () => {
    const messages = [
      userMessage("msg_u1", [textPart("first")]),
      assistantMessage("msg_a1", [], { parentID: "msg_u1", completed: true }),
    ];
    const snapshot = deriveTurn(messages, idleStatus, options);
    expect(snapshot.queuedPromptIDs).toEqual(["msg_u1"]);
    expect(snapshot.activePromptID).toBe("msg_u1");
  });

  it("does not invent a session id when messages do not carry one", () => {
    const messages = [{ info: { id: "msg_u1", role: "user" as const }, parts: [textPart("x")] }];
    expect(deriveTurn(messages, idleStatus, options).sessionID).toBe("");
  });
});

describe("readFinalAnswer", () => {
  it("returns the last visible text answer and ignores a trailing tool-only assistant", () => {
    const messages = [
      userMessage("msg_u1", [textPart("run")], { sessionID: TURN_SESSION_ID }),
      assistantMessage("msg_a1", [textPart("first answer")], {
        sessionID: TURN_SESSION_ID,
        parentID: "msg_u1",
        finish: "tool-calls",
        completed: true,
      }),
      assistantMessage("msg_a2", [toolPart()], {
        sessionID: TURN_SESSION_ID,
        parentID: "msg_u1",
        finish: "tool-calls",
        completed: true,
      }),
    ];
    expect(readFinalAnswer(messages)).toEqual({
      answerMessageId: "msg_a1",
      answerText: "first answer",
    });
  });

  it("does not reuse the previous turn answer for a tool-only new turn", () => {
    const messages = [
      userMessage("msg_u1", [textPart("first")], { sessionID: TURN_SESSION_ID }),
      assistantMessage("msg_a1", [textPart("first answer")], {
        sessionID: TURN_SESSION_ID,
        parentID: "msg_u1",
        finish: "stop",
        completed: true,
      }),
      userMessage("msg_u2", [textPart("second")], { sessionID: TURN_SESSION_ID }),
      assistantMessage("msg_a2", [toolPart()], {
        sessionID: TURN_SESSION_ID,
        parentID: "msg_u2",
        finish: "stop",
        completed: true,
      }),
    ];
    expect(readFinalAnswer(messages)).toEqual({ answerMessageId: null, answerText: "" });
  });

  it("joins visible text parts and skips synthetic, manifest, and reasoning parts", () => {
    const messages = [
      userMessage("msg_u1", [textPart("run")], { sessionID: TURN_SESSION_ID }),
      assistantMessage(
        "msg_a1",
        [textPart("one"), reasoningPart("hidden"), manifestPart(), textPart("two")],
        { sessionID: TURN_SESSION_ID, parentID: "msg_u1", completed: true },
      ),
    ];
    expect(readFinalAnswer(messages)).toEqual({
      answerMessageId: "msg_a1",
      answerText: "one\n\ntwo",
    });
  });
});

describe("currentTurnPrompt", () => {
  it("returns the last normal user prompt and skips handoff, resume, OMO, and empty rows", () => {
    const messages = [
      userMessage("msg_u1", [textPart("first")], {
        sessionID: TURN_SESSION_ID,
        createdAt: 1_000,
      }),
      userMessage("msg_u2", [textPart("second")], {
        sessionID: TURN_SESSION_ID,
        createdAt: 2_000,
      }),
      userMessage("msg_resume", [resumePart()], { sessionID: TURN_SESSION_ID }),
      userMessage("msg_omo", [omoPart()], { sessionID: TURN_SESSION_ID }),
      userMessage("msg_handoff", [textPart("handoff")], {
        sessionID: TURN_SESSION_ID,
        hanse: { handoff: { id: "h1" } },
      }),
    ];
    expect(currentTurnPrompt(messages)).toEqual({ id: "msg_u2", createdAt: 2_000 });
  });
});

describe("readTurnSnapshot", () => {
  async function withUpstream(
    messages: unknown[],
    run: (endpoint: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/session/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ [TURN_SESSION_ID]: { type: "idle" } }));
        return;
      }
      if (url.pathname === `/session/${TURN_SESSION_ID}/message`) {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(messages));
        return;
      }
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("reads status, history, status and returns the snapshot with the same answer", async () => {
    const messages = [
      userMessage("msg_u1", [textPart("run")], { sessionID: TURN_SESSION_ID }),
      assistantMessage("msg_a1", [textPart("done")], {
        sessionID: TURN_SESSION_ID,
        parentID: "msg_u1",
        finish: "stop",
        completed: true,
      }),
    ];
    await withUpstream(messages, async (endpoint) => {
      const read = await readTurnSnapshot(endpoint, TURN_SESSION_ID, {
        isSubagent: false,
      });
      expect(read.snapshot).toMatchObject({
        sessionID: TURN_SESSION_ID,
        status: { type: "idle" },
        activePromptID: null,
        queuedPromptIDs: [],
        queuedTruncated: false,
        settling: false,
      });
      expect(read.answerMessageId).toBe("msg_a1");
      expect(read.answerText).toBe("done");
      expect(read.messages).toEqual(messages);
    });
  });
});
