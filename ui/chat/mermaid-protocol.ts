/**
 * Messages exchanged between the parent page and the sandboxed Mermaid frame.
 *
 * The frame runs in an opaque origin, so the parent uses a transferred MessageChannel port rather
 * than origin checks. The version field lets a stale frame refuse new messages after an upgrade.
 */

export const MERMAID_PROTOCOL_VERSION = 1;

export interface ConnectMessage {
  v: 1;
  type: "connect";
}

export interface ReadyMessage {
  v: 1;
  type: "ready";
}

export interface RenderMessage {
  v: 1;
  type: "render";
  id: string;
  source: string;
  theme: "dark" | "light";
  tokens: Record<string, string>;
}

export interface ResultMessage {
  v: 1;
  type: "result";
  id: string;
  svg: string;
}

export interface ErrorMessage {
  v: 1;
  type: "error";
  id: string;
  message: string;
}

export type FrameMessage = ReadyMessage | ResultMessage | ErrorMessage;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  const message = record(value);
  return message?.v === 1 && message.type === "ready";
}

export function isResultMessage(value: unknown): value is ResultMessage {
  const message = record(value);
  return (
    message?.v === 1 &&
    message.type === "result" &&
    typeof message.id === "string" &&
    typeof message.svg === "string"
  );
}

export function isErrorMessage(value: unknown): value is ErrorMessage {
  const message = record(value);
  return (
    message?.v === 1 &&
    message.type === "error" &&
    typeof message.id === "string" &&
    typeof message.message === "string"
  );
}

export function isRenderMessage(value: unknown): value is RenderMessage {
  const message = record(value);
  return (
    message?.v === 1 &&
    message.type === "render" &&
    typeof message.id === "string" &&
    typeof message.source === "string" &&
    (message.theme === "dark" || message.theme === "light")
  );
}
