import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  attachmentIsMutable,
  attachmentKindForMime,
  attachmentSendPayload,
  attachmentsUploading,
  classifyOmo,
  formatAttachmentSize,
  isAttachmentManifestPart,
  normalizeAttachment,
  normalizeAttachmentRefs,
  normalizeAttachments,
  normalizePendingSends,
  pendingSendLabel,
  rekeyOptimistic,
  safeAttachmentUrl,
} from "../assets/chat-core.js";

const PNG = {
  id: "att_1",
  name: "design.png",
  mime: "image/png",
  size: 123456,
  kind: "image",
  mode: "auto",
  state: "draft",
  downloadURL: "/api/apps/app/attachments/att_1",
  inline: false,
} as const;

const CSV = {
  id: "att_2",
  name: "data.csv",
  mime: "text/csv",
  size: 4096,
  kind: "file",
  mode: "file",
  state: "draft",
  downloadURL: "/api/apps/app/attachments/att_2",
  inline: false,
} as const;

interface StoreInit {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    optimistic?: "sending" | "queued" | "accepted" | "unknown" | "failed";
    attachments?: Array<Record<string, unknown>>;
    parts?: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
  }>;
}

function makeStore(init: StoreInit) {
  const records = init.messages.map((message) => {
    const parts = (message.parts ?? []).map((part) => ({
      id: part.id,
      type: part.type,
      data: part.data ?? {},
      version: 1,
    }));
    return {
      id: message.id,
      role: message.role,
      optimistic: message.optimistic,
      attachments: message.attachments,
      partOrder: parts.map((part) => part.id),
      parts: new Map(parts.map((part) => [part.id, part])),
      version: 1,
    };
  });
  return {
    sessionID: "ses_1",
    generation: 1,
    turnGeneration: 0,
    order: records.map((record) => record.id),
    messages: new Map(records.map((record) => [record.id, record])),
    activePromptID: null,
    queue: [] as string[],
    openParts: new Set<string>(),
    lastSeqByStream: new Map<string, number>([["stream", 0]]),
    currentStreamID: "stream",
    pendingDeltas: new Map<string, string>(),
    agentStatus: { type: "busy" },
    connection: "live" as const,
  };
}

function textPart(id: string, text: string) {
  return { id, type: "text", data: { text } };
}

describe("attachment normalization", () => {
  it("keeps the server AttachmentView shape and defaults", () => {
    expect(normalizeAttachment(PNG)).toEqual(PNG);
    expect(normalizeAttachment({ id: "att_x" })).toEqual({
      id: "att_x",
      name: "",
      mime: "",
      size: 0,
      kind: "file",
      mode: "auto",
      state: "draft",
      downloadURL: "",
      inline: false,
    });
  });

  it("drops entries without a non-empty id", () => {
    expect(normalizeAttachment(null)).toBeNull();
    expect(normalizeAttachment({})).toBeNull();
    expect(normalizeAttachment({ id: "" })).toBeNull();
    expect(normalizeAttachments([PNG, { id: "" }, CSV, { ...PNG }])).toHaveLength(2);
  });

  it("infers the kind from the MIME when the server value is unknown", () => {
    expect(attachmentKindForMime("image/png")).toBe("image");
    expect(attachmentKindForMime("image/svg+xml")).toBe("file");
    expect(attachmentKindForMime("application/pdf")).toBe("pdf");
    expect(attachmentKindForMime("video/mp4")).toBe("video");
    expect(attachmentKindForMime("text/csv")).toBe("file");
    expect(normalizeAttachment({ id: "att_i", mime: "image/webp", kind: "nope" })?.kind).toBe(
      "image",
    );
  });

  it("normalizes pending-send attachment refs and attachmentIDs", () => {
    expect(normalizeAttachmentRefs([{ id: "a", mode: "file" }, { id: "a" }, { id: "" }])).toEqual([
      { id: "a", mode: "file" },
    ]);
  });
});

describe("attachment URLs and sizes", () => {
  it("only allows same-origin paths and http(s) URLs", () => {
    expect(safeAttachmentUrl("/api/apps/app/attachments/att_1")).toBe(
      "/api/apps/app/attachments/att_1",
    );
    expect(safeAttachmentUrl("https://example.test/file")).toBe("https://example.test/file");
    expect(safeAttachmentUrl("http://example.test/file")).toBe("http://example.test/file");
    expect(safeAttachmentUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeAttachmentUrl("javascript:alert(1)")).toBeNull();
    expect(safeAttachmentUrl("blob:https://example.test/id")).toBeNull();
    expect(safeAttachmentUrl("//evil.test/file")).toBeNull();
    expect(safeAttachmentUrl(undefined)).toBeNull();
  });

  it("formats file sizes for chips and cards", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(1023)).toBe("1023 B");
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatAttachmentSize(undefined)).toBe("0 B");
  });
});

describe("attachment chip state", () => {
  it("sends only ready ids with a mode", () => {
    expect(
      attachmentSendPayload([
        { ...PNG, status: "ready" },
        { ...CSV, status: "ready" },
        { id: "att_missing", state: "missing", status: "ready" },
        { ...PNG, id: "att_error", status: "error" },
        { ...PNG, id: "att_uploading", status: "uploading" },
      ]),
    ).toEqual([{ id: "att_1" }, { id: "att_2", mode: "file" }, { id: "att_missing" }]);
  });

  it("treats only draft attachments as mutable", () => {
    expect(attachmentIsMutable({ state: "draft" })).toBe(true);
    expect(attachmentIsMutable({ state: "sent" })).toBe(false);
    expect(attachmentIsMutable({ state: "in_flight" })).toBe(false);
    expect(attachmentIsMutable({ state: "missing" })).toBe(false);
  });

  it("detects an in-flight upload", () => {
    expect(attachmentsUploading([{ status: "ready" }])).toBe(false);
    expect(attachmentsUploading([{ status: "uploading" }])).toBe(true);
    expect(attachmentsUploading([{ state: "in_flight" }])).toBe(true);
    expect(attachmentsUploading(undefined)).toBe(false);
  });
});

describe("attachment manifest", () => {
  it("matches only the synthetic attachment-manifest marker", () => {
    expect(
      isAttachmentManifestPart({
        type: "text",
        synthetic: true,
        metadata: { hanse: "attachment-manifest" },
        text: "Attached files",
      }),
    ).toBe(true);
    expect(
      isAttachmentManifestPart({
        type: "text",
        data: { synthetic: true, metadata: { hanse: "attachment-manifest" } },
      }),
    ).toBe(true);
    expect(isAttachmentManifestPart({ type: "text", synthetic: true, text: "plain" })).toBe(false);
    expect(
      isAttachmentManifestPart({ type: "text", metadata: { hanse: "attachment-manifest" } }),
    ).toBe(false);
    expect(isAttachmentManifestPart({ type: "text", text: "hello" })).toBe(false);
  });

  it("never classifies an attachment-only user row as an OMO system reminder", () => {
    const manifestOnly = {
      role: "user",
      parts: [
        {
          type: "text",
          synthetic: true,
          metadata: { hanse: "attachment-manifest" },
          text: "Attached files",
        },
      ],
    };
    expect(classifyOmo(manifestOnly)).toBeNull();

    const textAndManifest = {
      role: "user",
      parts: [
        { type: "text", text: "Look" },
        {
          type: "text",
          synthetic: true,
          metadata: { hanse: "attachment-manifest" },
          text: "Attached files",
        },
      ],
    };
    expect(classifyOmo(textAndManifest)).toBeNull();
  });
});

describe("pending sends with attachments", () => {
  it("normalizes refs and labels attachment-only rows", () => {
    const rows = normalizePendingSends([
      {
        id: "p1",
        messageID: "m1",
        text: "",
        attachments: [{ id: "att_1", mode: "file" }],
        state: "failed",
        updatedAt: 1,
      },
      { id: "p2", text: "", attachmentIDs: ["att_2"], state: "unknown" },
    ]);
    expect(rows[0]?.attachments).toEqual([{ id: "att_1", mode: "file" }]);
    expect(rows[0]?.attachmentIDs).toEqual(["att_1"]);
    expect(rows[1]?.attachments).toEqual([{ id: "att_2" }]);
    expect(pendingSendLabel(rows[0] ?? null)).toBe("Failed to send: 1 attachment");
    expect(pendingSendLabel(rows[1] ?? null)).toBe("Delivery unknown: 1 attachment");
  });
});

describe("attachments through snapshots", () => {
  it("reads history attachments from info.hanse.attachments", () => {
    const snapshot = [
      {
        info: {
          id: "u1",
          role: "user",
          hanse: { attachments: [PNG, CSV] },
        },
        parts: [
          {
            id: "u1_manifest",
            type: "text",
            synthetic: true,
            metadata: { hanse: "attachment-manifest" },
            text: "Attached files",
          },
        ],
      },
    ];
    const { store } = applySnapshot(makeStore({ messages: [] }), snapshot);
    expect(store.messages.get("u1")?.attachments).toEqual([PNG, CSV]);
  });

  it("keeps local optimistic attachments when the server row has none yet", () => {
    const current = makeStore({
      messages: [
        {
          id: "local_1",
          role: "user",
          optimistic: "sending",
          attachments: [PNG],
          parts: [
            {
              id: "local_1:part:text",
              type: "text",
              data: { text: "", provisional: true, placeholder: true },
            },
          ],
        },
      ],
    });
    const snapshot = [
      {
        info: { id: "local_1", role: "user" },
        parts: [{ id: "server_p", type: "text", text: "hi" }],
      },
    ];
    const { store } = applySnapshot(current, snapshot, { position: "tail" });
    expect(store.messages.get("local_1")?.attachments).toEqual([PNG]);
  });
});

describe("attachments through live/buffered and rekey", () => {
  it("preserves local attachments when rekeying to the server id", () => {
    const current = makeStore({
      messages: [
        {
          id: "local_1",
          role: "user",
          optimistic: "sending",
          attachments: [PNG],
          parts: [textPart("local_p", "")],
        },
      ],
    });
    const { store } = rekeyOptimistic(current, { tempID: "local_1", serverID: "msg_1" });
    expect(store.messages.get("msg_1")?.attachments).toEqual([PNG]);
    expect(store.messages.has("local_1")).toBe(false);
  });

  it("merges top-level typed-event attachments over the buffered optimistic row", () => {
    const current = makeStore({
      messages: [
        {
          id: "local_1",
          role: "user",
          optimistic: "sending",
          attachments: [PNG],
          parts: [textPart("local_p", "")],
        },
      ],
    });
    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [
        {
          type: "message.updated",
          messageID: "msg_1",
          role: "user",
          attachments: [{ ...PNG, state: "sent" }],
        },
      ],
    });
    expect(store.messages.get("msg_1")?.attachments).toEqual([{ ...PNG, state: "sent" }]);
  });

  it("does not let a server row replace local attachments with an empty list", () => {
    const current = makeStore({
      messages: [
        {
          id: "local_1",
          role: "user",
          optimistic: "sending",
          attachments: [CSV],
          parts: [textPart("local_p", "")],
        },
      ],
    });
    const { store } = rekeyOptimistic(current, {
      tempID: "local_1",
      serverID: "msg_1",
      bufferedEvents: [
        { type: "message.updated", messageID: "msg_1", role: "user", attachments: [] },
      ],
    });
    expect(store.messages.get("msg_1")?.attachments).toEqual([CSV]);
  });
});
