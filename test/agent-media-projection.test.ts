import { describe, expect, it } from "vitest";
import { type AgentMediaProjector, createMessageProjector } from "../src/attachments/projection.js";
import type { AttachmentView } from "../src/attachments/types.js";
import { EventProjector } from "../src/opencode/events.js";
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
