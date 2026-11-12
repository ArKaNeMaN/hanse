import { describe, expect, it } from "vitest";
import {
  type AgentMediaProjector,
  createEventAttachmentResolver,
  createMessageProjector,
} from "../src/attachments/projection.js";
import type { AttachmentView } from "../src/attachments/types.js";
import { EventProjector, projectRawEnvelope } from "../src/opencode/events.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

function view(state: "sent" | "missing" = "sent"): AttachmentView {
  return {
    id: "amed_1234567890",
    name: "ui.png",
    mime: "image/png",
    size: 42,
    kind: "image",
    mode: "inline",
    state,
    downloadURL: "/api/apps/alpha/agent-media/amed_1234567890?project=p",
    inline: true,
    origin: "agent",
    caption: "Settings",
  };
}

function attach(viewState: "sent" | "missing" = "sent"): AgentMediaProjector {
  return {
    attach: () => ({
      status: viewState === "missing" ? "missing" : "attached",
      view: view(viewState),
    }),
  };
}

function toolPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prt_tool_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: "hanse_show_image",
    state: {
      status: "completed",
      input: { path: "/host/secret/ui.png" },
      output: JSON.stringify({ ok: true, id: "amed_1234567890" }),
      attachments: [{ type: "file", url: "data:image/png;base64,AAAA" }],
    },
    ...overrides,
  };
}

describe("agent media projection", () => {
  it("emits a synthetic file part in live events and strips payloads", () => {
    const projector = new EventProjector({ appId: "p:a", agentMedia: attach() });
    const events = projector.project({
      type: "message.part.updated",
      properties: { part: toolPart() },
    });
    expect(events).toHaveLength(2);
    const tool = events[0] as { part: Record<string, unknown> };
    expect(JSON.stringify(tool.part)).not.toContain("data:image");
    expect(JSON.stringify(tool.part)).not.toContain("/host/secret");
    const synthetic = events[1] as { partType: string; part: Record<string, unknown> };
    expect(synthetic.partType).toBe("file");
    expect(synthetic.part.id).toBe("prt_amed_1234567890");
    expect(synthetic.part.url).toContain("/agent-media/");
  });

  it("emits a missing placeholder in live events", () => {
    const projector = new EventProjector({ appId: "p:a", agentMedia: attach("missing") });
    const events = projector.project({
      type: "message.part.updated",
      properties: { part: toolPart() },
    });
    const synthetic = events[1] as { part: Record<string, unknown> };
    expect((synthetic.part.attachment as Record<string, unknown>).state).toBe("missing");
  });

  it("appends the synthetic part in history after the tool part", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    const project = createMessageProjector({
      db,
      appId: "p:a",
      appKey: "alpha",
      projectId: "p",
      sessionID: "ses_1",
      agentMedia: attach(),
    });
    const messages = [
      {
        info: { id: "msg_1", sessionID: "ses_1" },
        parts: [toolPart()],
      },
    ];
    project(messages);
    expect(messages[0]?.parts).toHaveLength(2);
    expect(messages[0]?.parts[1]?.id).toBe("prt_amed_1234567890");
    expect(JSON.stringify(messages[0]?.parts[0])).not.toContain("data:image");
    expect(JSON.stringify(messages[0]?.parts[0])).not.toContain("/host/secret");
    db.close();
  });
});

const INLINE_IMAGE_URL = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`;

function inlinePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prt_inline",
    type: "file",
    sessionID: "ses_1",
    messageID: "msg_1",
    mime: "image/png",
    filename: "shot.png",
    url: INLINE_IMAGE_URL,
    ...overrides,
  };
}

function inlineResolver() {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return createEventAttachmentResolver({
    db,
    appId: "p:a",
    appKey: "alpha",
    projectId: "p",
  });
}

function partOf(events: unknown[]): Record<string, unknown> {
  for (const event of events) {
    const record = event as { type?: string; part?: unknown };
    if (
      record.type === "message.part.updated" &&
      typeof record.part === "object" &&
      record.part !== null
    ) {
      return record.part as Record<string, unknown>;
    }
  }
  throw new Error("missing message.part.updated event");
}

function rawPart(value: unknown): Record<string, unknown> {
  return (value as { properties: { part: Record<string, unknown> } }).properties.part;
}

describe("live inline image projection", () => {
  it("emits the same inline URL as history for the same part", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    const messages = [{ info: { id: "msg_1" }, parts: [inlinePart()] }];
    createMessageProjector({
      db,
      appId: "p:a",
      appKey: "alpha",
      projectId: "p",
      sessionID: "ses_1",
    })(messages);
    const history = messages[0]?.parts[0];
    const projector = new EventProjector({ attachments: inlineResolver() });
    const live = partOf(
      projector.project({ type: "message.part.updated", properties: { part: inlinePart() } }),
    );
    expect(live.url).toBe(history?.url);
    expect(live.attachment).toMatchObject({ id: "prt_inline", size: 5, inline: true });
    expect(JSON.stringify(live)).not.toContain("data:");
    db.close();
  });

  it("derives ids from the envelope for both the typed and raw paths", () => {
    const resolver = inlineResolver();
    const part = inlinePart({ sessionID: undefined, messageID: undefined });
    const projector = new EventProjector({ attachments: resolver });
    const typed = projector.project({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", messageID: "msg_1", part },
    });
    const typedEvent = typed.find(
      (event) => (event as { type?: string }).type === "message.part.updated",
    ) as { sessionID: string; messageID: string; part: Record<string, unknown> };
    expect(typedEvent.sessionID).toBe("ses_1");
    expect(typedEvent.messageID).toBe("msg_1");
    expect(typedEvent.part.url).toBe(
      "/api/apps/alpha/sessions/ses_1/messages/msg_1/parts/prt_inline/inline?project=p",
    );

    const raw = projectRawEnvelope(
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_1", messageID: "msg_1", part },
      },
      resolver,
    );
    expect(rawPart(raw).url).toBe(typedEvent.part.url);
  });

  it("drops an unaddressable typed part but raw forwards it stripped", () => {
    const resolver = inlineResolver();
    const part = inlinePart({ sessionID: undefined, messageID: undefined });
    const projector = new EventProjector({ attachments: resolver });
    const typed = projector.project({ type: "message.part.updated", properties: { part } });
    expect(
      typed.some((event) => (event as { type?: string }).type === "message.part.updated"),
    ).toBe(false);

    const raw = projectRawEnvelope(
      { type: "message.part.updated", properties: { part } },
      resolver,
    );
    expect(rawPart(raw)).toMatchObject({ url: "", truncated: true });
    expect(JSON.stringify(raw)).not.toContain("data:");
  });

  it("synthesizes a later data URL for a part id after an empty first event", async () => {
    const resolver = inlineResolver();
    const projector = new EventProjector({ attachments: resolver });
    const empty = inlinePart({ url: "" });
    const first = partOf(
      projector.project({ type: "message.part.updated", properties: { part: empty } }),
    );
    expect(first.url).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 110));
    const second = partOf(
      projector.project({ type: "message.part.updated", properties: { part: inlinePart() } }),
    );
    expect(second.url).toBe(
      "/api/apps/alpha/sessions/ses_1/messages/msg_1/parts/prt_inline/inline?project=p",
    );
  });
});
