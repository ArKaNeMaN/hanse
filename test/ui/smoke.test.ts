import { describe, expect, it } from "vitest";

describe("ui test environment", () => {
  it("provides a jsdom document for component tests", () => {
    expect(typeof document).toBe("object");
    expect(document.body).toBeDefined();
  });
});
