import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryReadBudget, RawStreamBudget } from "../src/attachments/budget.js";
import { findCatalogEntry, resolveModelCapabilities } from "../src/attachments/capabilities.js";
import { planDeliveries } from "../src/attachments/delivery.js";
import {
  base64Bytes,
  contextAdvisory,
  INLINE_BASE64_BUDGET_BYTES,
  INLINE_MAX_BYTES,
  inlinePartId,
  planInlineDelivery,
} from "../src/attachments/inline.js";
import {
  createMessageProjector,
  defaultMessageProjector,
  type ProjectableMessage,
} from "../src/attachments/projection.js";
import { AppStreamRegistry } from "../src/attachments/streams.js";
import type { AttachmentRow, DeliveryRow } from "../src/attachments/types.js";
import { APP_STREAM_MAX_FRAME_BYTES, EventProjector, SseParser } from "../src/opencode/events.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbFixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-inline-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  return db;
}

const NOW = "2026-10-25T00:00:00.000Z";

function row(overrides: Partial<AttachmentRow> & { id: string }): AttachmentRow {
  return {
    id: overrides.id,
    appId: "p1:storefront",
    sessionId: "ses_1",
    originalName: "file.bin",
    storedName: "file.bin",
    relPath: "attachments/ses_1/file.bin",
    tempRelPath: null,
    mime: "application/octet-stream",
    size: 100,
    declaredSize: null,
    kind: "file",
    mode: "auto",
    state: "available",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function catalog(input: {
  image?: boolean;
  video?: boolean;
  pdf?: boolean;
  attachment?: boolean;
  limit?: { context?: number; input?: number };
}) {
  return {
    providers: [
      {
        id: "provider",
        models: {
          model: {
            capabilities: {
              input: { image: input.image, video: input.video, pdf: input.pdf },
              attachment: input.attachment,
            },
            limit: input.limit,
          },
        },
      },
    ],
  };
}

function entry(value: Parameters<typeof findCatalogEntry>[0]) {
  const found = findCatalogEntry(value, "provider/model");
  if (found === undefined) throw new Error("missing catalog entry");
  return found;
}

function request(rows: AttachmentRow[], mode?: "auto" | "inline" | "file") {
  return rows.map((entry) => ({
    id: entry.id,
    ...(mode === undefined ? {} : { mode }),
    explicitMode: mode !== undefined,
  }));
}

describe("capability gating", () => {
  it("reads true/false/unknown modality support from the provider catalog", async () => {
    expect(
      findCatalogEntry(catalog({ image: true, attachment: true }), "provider/model")?.capabilities,
    ).toMatchObject({
      input: { image: true },
      attachment: true,
    });
    const falseRow = row({ id: "att_false", kind: "image", mime: "image/png" });
    expect(
      planInlineDelivery({
        rows: [falseRow],
        requested: request([falseRow]),
        capability: { status: "known", entry: entry(catalog({ image: false, attachment: true })) },
      }),
    ).toMatchObject({ ok: true, plan: { modes: new Map([["att_false", "file"]]) } });

    const unknown = await resolveModelCapabilities("http://unused", "provider/model", {
      loadCatalog: async () => {
        throw new Error("offline");
      },
    });
    expect(unknown).toEqual({ status: "unknown" });
    const unknownPlan = planInlineDelivery({
      rows: [falseRow],
      requested: request([falseRow]),
      capability: unknown,
    });
    expect(unknownPlan).toMatchObject({
      ok: true,
      plan: { modes: new Map([["att_false", "file"]]) },
    });
    expect(unknownPlan.ok && unknownPlan.plan.warnings).toContain("attachment_capability_unknown");
  });

  it("retries the catalog once before reporting unknown", async () => {
    let calls = 0;
    const result = await resolveModelCapabilities("http://unused", "provider/model", {
      loadCatalog: async () => {
        calls += 1;
        if (calls === 1) throw new Error("flaky");
        return catalog({ image: true, attachment: true });
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("known");
  });

  it("inlines only a supported modality with attachment capability, otherwise warns and files", () => {
    const image = row({ id: "att_img", kind: "image", mime: "image/png", size: 1024 });
    const supported = planInlineDelivery({
      rows: [image],
      requested: request([image]),
      capability: { status: "known", entry: entry(catalog({ image: true, attachment: true })) },
    });
    expect(supported.ok && supported.plan.modes.get("att_img")).toBe("inline");

    const noAttachment = planInlineDelivery({
      rows: [image],
      requested: request([image]),
      capability: { status: "known", entry: entry(catalog({ image: true, attachment: false })) },
    });
    expect(noAttachment.ok && noAttachment.plan.modes.get("att_img")).toBe("file");
    expect(noAttachment.ok && noAttachment.plan.warnings).toContain(
      "attachment_inline_unsupported",
    );

    const explicitFile = planInlineDelivery({
      rows: [image],
      requested: request([image], "file"),
      capability: { status: "unknown" },
    });
    expect(explicitFile.ok && explicitFile.plan.modes.get("att_img")).toBe("file");
    expect(explicitFile.ok && explicitFile.plan.warnings).toEqual([]);
  });

  it("falls back with a warning above the 20 MiB per-file inline cap", () => {
    const big = row({
      id: "att_big",
      kind: "pdf",
      mime: "application/pdf",
      size: INLINE_MAX_BYTES + 1,
    });
    const plan = planInlineDelivery({
      rows: [big],
      requested: request([big]),
      capability: { status: "known", entry: entry(catalog({ pdf: true, attachment: true })) },
    });
    expect(plan.ok && plan.plan.modes.get("att_big")).toBe("file");
    expect(plan.ok && plan.plan.warnings).toContain("attachment_inline_too_large");
  });

  it("uses the raw base64 bound for the 40 MiB inline budget", () => {
    const pdf20 = row({ id: "p20", kind: "pdf", size: 20 * 1024 * 1024 });
    const image5 = row({ id: "i5", kind: "image", size: 5 * 1024 * 1024 });
    const valid = planInlineDelivery({
      rows: [pdf20, image5],
      requested: request([pdf20, image5]),
      capability: {
        status: "known",
        entry: entry(catalog({ pdf: true, image: true, attachment: true })),
      },
    });
    expect(valid.ok).toBe(true);
    expect(base64Bytes(pdf20.size ?? 0) + base64Bytes(image5.size ?? 0)).toBe(
      33 * 1024 * 1024 + 349_528,
    );

    const exactly40 = [
      row({ id: "a", kind: "pdf", size: 15 * 1024 * 1024 }),
      row({ id: "b", kind: "pdf", size: 15 * 1024 * 1024 }),
    ];
    expect(
      planInlineDelivery({
        rows: exactly40,
        requested: request(exactly40),
        capability: { status: "known", entry: entry(catalog({ pdf: true, attachment: true })) },
      }).ok,
    ).toBe(true);
    expect(base64Bytes(15 * 1024 * 1024) * 2).toBe(INLINE_BASE64_BUDGET_BYTES);

    const overFirst = row({ id: "c", kind: "pdf", size: 15 * 1024 * 1024 });
    const overSecond = row({ id: "d", kind: "pdf", size: 15 * 1024 * 1024 + 1 });
    const over = [overFirst, overSecond];
    expect(
      planInlineDelivery({
        rows: over,
        requested: request([overFirst, overSecond]),
        capability: { status: "known", entry: entry(catalog({ pdf: true, attachment: true })) },
      }),
    ).toMatchObject({ ok: false, error: { status: 409, code: "inline_budget_exceeded" } });

    const huge = [
      row({ id: "e", kind: "pdf", size: 20 * 1024 * 1024 }),
      row({ id: "f", kind: "pdf", size: 20 * 1024 * 1024 }),
      row({ id: "g", kind: "image", size: 5 * 1024 * 1024 }),
      row({ id: "h", kind: "image", size: 5 * 1024 * 1024 }),
    ];
    expect(
      planInlineDelivery({
        rows: huge,
        requested: request(huge),
        capability: {
          status: "known",
          entry: entry(catalog({ pdf: true, image: true, attachment: true })),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "inline_budget_exceeded" } });
  });

  it("rejects more than four effective inline attachments", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) =>
      row({ id: `att_${id}`, kind: "image", size: 1024 }),
    );
    expect(
      planInlineDelivery({
        rows,
        requested: request(rows),
        capability: { status: "known", entry: entry(catalog({ image: true, attachment: true })) },
      }),
    ).toMatchObject({ ok: false, error: { status: 400, code: "too_many_inline_attachments" } });
  });

  it("emits the non-blocking context advisory from input or context limits and images", () => {
    expect(contextAdvisory({ inlineBytes: 100, imageCount: 4 }, { input: 10 })).toBe(true);
    expect(contextAdvisory({ inlineBytes: 100, imageCount: 3 }, { input: 10_000 })).toBe(false);
    expect(contextAdvisory({ inlineBytes: 1_000 }, { context: 500 })).toBe(true);
    expect(contextAdvisory({ inlineBytes: 1_000 }, {})).toBe(false);
  });
});

describe("per-attempt ids and deliveries", () => {
  it("creates a unique part id for every delivery attempt", () => {
    const attachment = row({ id: "att_1", kind: "image" });
    const first = planDeliveries([{ row: attachment, mode: "inline", partId: null }]);
    const second = planDeliveries([{ row: attachment, mode: "inline", partId: null }]);
    expect(first[0]?.partId).toMatch(/^prt_att_att_1_del_[0-9a-f]+$/);
    expect(first[0]?.partId).not.toBe(second[0]?.partId);
    expect(inlinePartId("att_1", "del_x")).toBe("prt_att_att_1_del_x");
  });
});

describe("history projection", () => {
  function insertAttachment(db: SqliteDatabase, id: string): void {
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main','/tmp/p1',?,?)",
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p1:storefront','p1','storefront','apps/storefront','AGENTS.md',?)",
    ).run(NOW);
    db.prepare(
      `INSERT INTO app_attachments
         (id, app_id, session_id, original_name, stored_name, rel_path, temp_rel_path, mime, size,
          declared_size, kind, mode, state, created_at, updated_at)
       VALUES (?, 'p1:storefront', 'ses_1', 'photo.png', 'att_1-photo.png',
               'attachments/ses_1/att_1-photo.png', NULL, 'image/png', 42, NULL, 'image',
               'auto', 'available', ?, ?)`,
    ).run(id, NOW, NOW);
  }

  function insertDelivery(db: SqliteDatabase, partId: string, messageId: string): DeliveryRow {
    db.prepare(
      `INSERT INTO attachment_deliveries
         (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code,
          created_at, updated_at)
       VALUES ('del_1', 'att_1', 'p1:storefront', 'ses_1', ?, ?, 'sent', NULL, ?, ?)`,
    ).run(partId, messageId, NOW, NOW);
    return {
      id: "del_1",
      attachmentId: "att_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      partId,
      messageId,
      state: "sent",
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  it("rewrites known parts, strips unknown data URLs, and adds message attachments", () => {
    const db = dbFixture();
    insertAttachment(db, "att_1");
    insertDelivery(db, "prt_known", "msg_1");
    const messages: ProjectableMessage[] = [
      {
        info: { id: "msg_1" },
        parts: [
          { type: "file", id: "prt_known", url: "data:image/png;base64,AAAA" },
          { type: "file", id: "prt_unknown", url: `data:image/png;base64,${"A".repeat(100)}` },
          { type: "text", text: "hi" },
        ],
      },
    ];
    createMessageProjector({
      db,
      appId: "p1:storefront",
      appKey: "storefront",
      projectId: "p1",
    })(messages);
    const [known, unknown] = messages[0]?.parts ?? [];
    expect(known).toMatchObject({
      url: "/api/apps/storefront/attachments/att_1?project=p1",
      mime: "image/png",
      filename: "photo.png",
      attachment: { id: "att_1", size: 42, mode: "inline", kind: "image", inline: true },
    });
    expect(JSON.stringify(known)).not.toContain("data:");
    expect(unknown).toMatchObject({ url: "", truncated: true });
    expect(messages[0]?.info.hanse).toMatchObject({
      attachments: [{ id: "att_1", state: "sent", inline: true, mode: "inline" }],
    });
  });

  it("projects typed message attachments and file parts for the app stream", () => {
    const db = dbFixture();
    insertAttachment(db, "att_1");
    insertDelivery(db, "prt_known", "msg_1");
    const projector = new EventProjector({
      attachments: {
        projectFilePart: (part) =>
          part.id === "prt_known"
            ? { ...part, url: "/api/apps/storefront/attachments/att_1?project=p1" }
            : { ...part, url: "", truncated: true },
        attachmentsForMessage: (messageId) =>
          messageId === "msg_1"
            ? [
                {
                  id: "att_1",
                  name: "photo.png",
                  mime: "image/png",
                  size: 42,
                  kind: "image",
                  mode: "auto",
                  state: "sent",
                  downloadURL: "/api/apps/storefront/attachments/att_1?project=p1",
                  inline: true,
                },
              ]
            : undefined,
      },
    });
    const updated = projector.project({
      type: "message.updated",
      properties: {
        info: { id: "msg_1", role: "user", sessionID: "ses_1" },
      },
    });
    expect(updated[0]).toMatchObject({
      type: "message.updated",
      attachments: [{ id: "att_1" }],
    });
    expect(JSON.stringify(updated[0])).not.toContain("data:");
    const part = projector.project({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_known",
          type: "file",
          sessionID: "ses_1",
          messageID: "msg_1",
          url: "data:image/png;base64,AAAA",
        },
      },
    });
    expect(part[0]).toMatchObject({
      type: "message.part.updated",
      part: { url: "/api/apps/storefront/attachments/att_1?project=p1" },
    });
  });

  it("strips every data URL with the default projector", () => {
    const messages: ProjectableMessage[] = [
      {
        info: { id: "msg_1" },
        parts: [{ type: "file", url: `data:application/pdf;base64,${"A".repeat(10)}` }],
      },
    ];
    defaultMessageProjector(messages);
    expect(messages[0]?.parts[0]).toMatchObject({ url: "", truncated: true });
  });
});

describe("read budgets and frames", () => {
  it("waits up to the timeout for the 192 MiB history budget and then gives up", async () => {
    const budget = new HistoryReadBudget(192, 30);
    const first = await budget.acquire(192);
    expect(first).toBeTypeOf("function");
    await expect(budget.acquire(16)).resolves.toBeUndefined();
    first?.();
    const second = await budget.acquire(16);
    expect(second).toBeTypeOf("function");
    second?.();
  });

  it("admits a 31.9 MiB frame and drops a 32.1 MiB frame", () => {
    const accepted = new SseParser({ maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES });
    const below = `data: ${"x".repeat(31.9 * 1024 * 1024)}\n\n`;
    expect(accepted.push(below).frames).toHaveLength(1);

    const rejected = new SseParser({ maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES });
    const above = `data: ${"x".repeat(32.1 * 1024 * 1024)}\n\n`;
    const batch = rejected.push(above);
    expect(batch.frames).toHaveLength(0);
    expect(batch.warnings[0]?.code).toBe("frame_too_large");
  });

  it("enforces the 32 MiB raw stream budget across chunks", () => {
    const budget = new RawStreamBudget(32 * 1024 * 1024);
    expect(budget.tryReserve(31.9 * 1024 * 1024)).toBe(true);
    expect(budget.tryReserve(0.2 * 1024 * 1024)).toBe(false);
    budget.release(31.9 * 1024 * 1024);
    expect(budget.tryReserve(0.2 * 1024 * 1024)).toBe(true);
  });

  it("refuses a ninth browser stream and keeps internal streams out of the slot cap", () => {
    const registry = new AppStreamRegistry(8);
    const releases = Array.from({ length: 8 }, () => registry.acquireBrowser("app"));
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    expect(registry.acquireBrowser("app")).toBeUndefined();
    releases[0]?.();
    expect(registry.acquireBrowser("app")).toBeTypeOf("function");
  });
});
