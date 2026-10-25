import { describe, expect, it } from "vitest";
import {
  attachmentModeLabel,
  attachmentModeOptions,
  attachmentModeValue,
  attachmentSendPayload,
  attachmentSupportsInlineMode,
  attachmentViewFromFilePart,
  canRedeliverAsFile,
  normalizeAttachmentWarnings,
  redeliveryAttachmentPayload,
} from "../assets/chat-core.js";

describe("stage C client attachment modes", () => {
  it("offers inline only for image/video/pdf and forces other kinds to file", () => {
    expect(attachmentSupportsInlineMode("image")).toBe(true);
    expect(attachmentSupportsInlineMode("pdf")).toBe(true);
    expect(attachmentSupportsInlineMode("file")).toBe(false);
    expect(attachmentModeOptions("image").map((option) => option.value)).toEqual([
      "auto",
      "inline",
      "file",
    ]);
    expect(attachmentModeOptions("file")).toEqual([]);
    expect(attachmentModeValue("image", "inline")).toBe("inline");
    expect(attachmentModeValue("file", "inline")).toBe("file");
    expect(attachmentModeLabel("image", "inline")).toBe("Inline");
    expect(attachmentModeLabel("file", "auto")).toBe("File only");
  });

  it("omits auto, sends explicit inline/file, and drops non-ready chips", () => {
    expect(
      attachmentSendPayload([
        { id: "att_1", kind: "image", mode: "auto", status: "ready" },
        { id: "att_2", kind: "image", mode: "inline", status: "ready" },
        { id: "att_3", kind: "file", mode: "auto", status: "ready" },
        { id: "att_4", kind: "image", mode: "inline", status: "error" },
        { id: "att_1", kind: "image", mode: "file", status: "ready" },
      ]),
    ).toEqual([{ id: "att_1" }, { id: "att_2", mode: "inline" }, { id: "att_3", mode: "file" }]);
  });

  it("normalizes warning codes into visible non-blocking messages", () => {
    expect(
      normalizeAttachmentWarnings([
        "attachment_context_large",
        { code: "attachment_inline_unsupported" },
        "attachment_capability_unknown",
        "attachment_context_large",
      ]),
    ).toEqual([
      expect.objectContaining({
        code: "attachment_context_large",
        downgrade: false,
      }),
      expect.objectContaining({
        code: "attachment_inline_unsupported",
        downgrade: true,
      }),
      expect.objectContaining({
        code: "attachment_capability_unknown",
        downgrade: true,
      }),
    ]);
  });

  it("redelivers only sent/inline attachments as a new file-only send", () => {
    expect(canRedeliverAsFile({ id: "att_1", state: "sent", inline: false })).toBe(true);
    expect(canRedeliverAsFile({ id: "att_1", state: "draft", inline: true })).toBe(true);
    expect(canRedeliverAsFile({ id: "att_1", state: "in_flight", inline: true })).toBe(false);
    expect(canRedeliverAsFile({ id: "att_1", state: "missing", inline: true })).toBe(false);
    expect(redeliveryAttachmentPayload({ id: "att_1", state: "sent" })).toEqual([
      { id: "att_1", mode: "file" },
    ]);
  });

  it("maps a projected file part without ever accepting a data URL", () => {
    const part = {
      type: "file",
      data: {
        type: "file",
        id: "prt_att_1_del_1",
        mime: "image/png",
        filename: "photo.png",
        url: "/api/apps/app/attachments/att_1?project=p1",
        attachment: { id: "att_1", size: 42, mode: "inline", kind: "image", inline: true },
      },
    };
    expect(attachmentViewFromFilePart(part)).toMatchObject({
      id: "att_1",
      kind: "image",
      inline: true,
      downloadURL: "/api/apps/app/attachments/att_1?project=p1",
    });
    expect(
      attachmentViewFromFilePart({
        type: "file",
        data: { ...part.data, url: "data:image/png;base64,AAAA" },
      }),
    ).toBeNull();
  });
});
