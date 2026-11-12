import { describe, expect, it } from "vitest";
import { INLINE_MAX_BYTES } from "../src/attachments/inline.js";
import {
  decodeInlineDataUrl,
  INLINE_READ_BUDGET_WAIT_MS,
  inlineImagePart,
  inlineMediaRoute,
  parseInlineDataUrl,
} from "../src/attachments/inline-media.js";

const TARGET = { appKey: "storefront", projectId: "p1" };
const IDS = { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" };
const DATA_URL = "data:image/png;base64,AAAA";

function imagePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prt_1",
    type: "file",
    mime: "image/png",
    filename: "shot.png",
    url: DATA_URL,
    ...overrides,
  };
}

const OVER_CAP_BASE64_LENGTH = (Math.floor(INLINE_MAX_BYTES / 3) + 2) * 4;

describe("parseInlineDataUrl", () => {
  it("accepts the four inline-safe image MIMEs", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(parseInlineDataUrl(`data:${mime};base64,AAAA`)).toMatchObject({
        mime,
        base64: "AAAA",
        base64Length: 4,
        size: 3,
      });
    }
  });

  it("estimates the decoded size without decoding and counts padding", () => {
    expect(parseInlineDataUrl("data:image/png;base64,AA==")).toMatchObject({ size: 1 });
    expect(parseInlineDataUrl("data:image/png;base64,AAA=")).toMatchObject({ size: 2 });
    expect(parseInlineDataUrl("data:image/png;base64,AAAA")).toMatchObject({
      size: 3,
      base64Length: 4,
    });
  });

  it("rejects empty, non-base64, and non-image payloads", () => {
    expect(parseInlineDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseInlineDataUrl("data:image/png;base64,!!!!")).toBeNull();
    expect(parseInlineDataUrl("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(parseInlineDataUrl("data:text/plain;base64,AAAA")).toBeNull();
    expect(parseInlineDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseInlineDataUrl("data:image/png,AAAA")).toBeNull();
    expect(parseInlineDataUrl(undefined)).toBeNull();
    expect(parseInlineDataUrl({})).toBeNull();
  });

  it("rejects malformed length and padding", () => {
    expect(parseInlineDataUrl("data:image/png;base64,AAA")).toBeNull();
    expect(parseInlineDataUrl("data:image/png;base64,AAAA=")).toBeNull();
    expect(parseInlineDataUrl("data:image/png;base64,A===")).toBeNull();
    expect(parseInlineDataUrl("data:image/png;base64,=====")).toBeNull();
    expect(parseInlineDataUrl("data:image/png;base64,AAAA\n")).toBeNull();
  });
});

describe("decodeInlineDataUrl", () => {
  it("decodes the whole payload by default", () => {
    const parsed = parseInlineDataUrl("data:image/png;base64,AAAAAAAAAAAA");
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(decodeInlineDataUrl(parsed)).toHaveLength(9);
  });

  it("decodes only the sniff window when maxBytes is given", () => {
    const parsed = parseInlineDataUrl("data:image/png;base64,AAAAAAAAAAAA");
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(decodeInlineDataUrl(parsed, 2)).toHaveLength(3);
    expect(decodeInlineDataUrl(parsed, 3)).toHaveLength(3);
    expect(decodeInlineDataUrl(parsed, 4)).toHaveLength(6);
    expect(decodeInlineDataUrl(parsed, 5)).toHaveLength(6);
  });
});

describe("inlineMediaRoute", () => {
  it("builds the same-origin inline route", () => {
    expect(inlineMediaRoute(TARGET, IDS)).toBe(
      "/api/apps/storefront/sessions/ses_1/messages/msg_1/parts/prt_1/inline?project=p1",
    );
  });

  it("encodes every path segment and the project query", () => {
    expect(
      inlineMediaRoute(
        { appKey: "a b/c", projectId: "p&1" },
        { sessionID: "ses/1", messageID: "msg 2", partID: "prt#3" },
      ),
    ).toBe(
      "/api/apps/a%20b%2Fc/sessions/ses%2F1/messages/msg%202/parts/prt%233/inline?project=p%261",
    );
  });
});

describe("inlineImagePart", () => {
  it("rewrites a qualifying image part to an inline attachment view", () => {
    const projected = inlineImagePart(imagePart(), IDS, TARGET);
    expect(projected).toMatchObject({
      id: "prt_1",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "/api/apps/storefront/sessions/ses_1/messages/msg_1/parts/prt_1/inline?project=p1",
      attachment: { id: "prt_1", size: 3, mode: "inline", kind: "image", inline: true },
    });
    expect(JSON.stringify(projected)).not.toContain("data:");
  });

  it("falls back to the name image when the filename is missing or not a string", () => {
    expect(inlineImagePart(imagePart({ filename: "" }), IDS, TARGET)?.filename).toBe("image");
    expect(inlineImagePart(imagePart({ filename: 42 }), IDS, TARGET)?.filename).toBe("image");
  });

  it("sanitizes a hostile filename", () => {
    const projected = inlineImagePart(
      imagePart({ filename: "../../etc/passwd\u0000.png" }),
      IDS,
      TARGET,
    );
    expect(projected?.filename).toBe("etc-passwd.png");
    expect(String(projected?.filename)).not.toContain("/");
  });

  it("rejects a non-image MIME", () => {
    expect(inlineImagePart(imagePart({ mime: "application/pdf" }), IDS, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart({ mime: "image/svg+xml" }), IDS, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart({ mime: undefined }), IDS, TARGET)).toBeNull();
  });

  it("rejects missing part, session, and message ids", () => {
    expect(inlineImagePart(imagePart({ id: undefined }), IDS, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart({ id: "" }), IDS, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart(), { ...IDS, sessionID: "" }, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart(), { ...IDS, messageID: "" }, TARGET)).toBeNull();
  });

  it("rejects an over-cap payload", () => {
    const overCap = `data:image/png;base64,${"A".repeat(OVER_CAP_BASE64_LENGTH)}`;
    const parsed = parseInlineDataUrl(overCap);
    expect(parsed?.size).toBeGreaterThan(INLINE_MAX_BYTES);
    expect(inlineImagePart(imagePart({ url: overCap }), IDS, TARGET)).toBeNull();
  });

  it("rejects a file: URL and malformed data URLs", () => {
    expect(inlineImagePart(imagePart({ url: "file:///tmp/shot.png" }), IDS, TARGET)).toBeNull();
    expect(inlineImagePart(imagePart({ url: "data:image/png;base64," }), IDS, TARGET)).toBeNull();
    expect(
      inlineImagePart(imagePart({ url: "data:image/png;base64,AAA" }), IDS, TARGET),
    ).toBeNull();
  });

  it("projects only eligible parts; delivery ownership is the projector's concern", () => {
    expect(inlineImagePart(imagePart({ id: "prt_delivery_owned" }), IDS, TARGET)).toMatchObject({
      attachment: { id: "prt_delivery_owned" },
    });
  });

  it("exports the inline read budget wait", () => {
    expect(INLINE_READ_BUDGET_WAIT_MS).toBe(10_000);
  });
});
