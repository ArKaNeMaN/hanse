import { createHash } from "node:crypto";
import type { SshStore } from "./store.js";
import { APPROVAL_WAIT_MS, COMMAND_MAX_BYTES, type SshAction, type SshApproval } from "./types.js";

export function actionHash(action: SshAction, parts: readonly (string | number)[]): string {
  return createHash("sha256").update(action).update("\0").update(parts.join("\0")).digest("hex");
}

function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 && character !== "\n" && character !== "\t" ? " " : character;
  }
  return out;
}

export function actionPreview(value: string): string {
  const stripped = stripControl(value);
  return stripped.length > COMMAND_MAX_BYTES ? stripped.slice(0, COMMAND_MAX_BYTES) : stripped;
}

export function commandBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function waitForApproval(
  store: SshStore,
  id: string,
  timeoutMs = APPROVAL_WAIT_MS,
  pollMs = 250,
): Promise<SshApproval> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const current = store.getApproval(id);
      if (current === undefined) {
        reject(new Error("approval disappeared"));
        return;
      }
      if (current.status === "approved" || current.status === "rejected") {
        resolve(current);
        return;
      }
      if (current.status !== "pending" || Date.now() >= deadline) {
        resolve(current);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}
