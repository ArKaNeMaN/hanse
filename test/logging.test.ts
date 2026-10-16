import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging/logger.js";

describe("logger", () => {
  it("emits structured JSON lines with level, message, and base fields", () => {
    const lines: string[] = [];
    const logger = createLogger(
      (line) => {
        lines.push(line);
      },
      { component: "test" },
    );
    logger.info("hello", { a: 1 });
    logger.error("boom");
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.level).toBe("info");
    expect(first.message).toBe("hello");
    expect(first.component).toBe("test");
    expect(first.a).toBe(1);
    expect((JSON.parse(lines[1] ?? "{}") as Record<string, unknown>).level).toBe("error");
  });
});
