import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SSH chat surface assets", () => {
  it("renders the approval slot and polls the app-scoped approval list", () => {
    const chatPage = readFileSync("src/http/chat.ts", "utf8");
    const chatScript = readFileSync("assets/chat.js", "utf8");
    expect(chatPage).toContain('id="chat-ssh-approvals"');
    expect(chatScript).toContain("/ssh/approvals");
    expect(chatScript).toContain("SSH approval required");
    expect(chatScript).toContain("decision");
    expect(chatScript).toContain("ssh-command");
  });
});
