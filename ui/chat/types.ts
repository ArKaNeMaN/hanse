import type { ChatProps } from "../../src/http/props/chat.js";
import type { BootChrome } from "../boot.js";
import type { NoticeView } from "../stores/chat-feed.js";
import type { ChatSessionSummary } from "../stores/chat-session.js";

export interface ChatResponse extends ChatProps {
  readonly chrome: BootChrome;
}

export interface ChatSessionsResponse {
  readonly sessions: readonly ChatSessionSummary[];
}

export interface ChatMessagesResponse {
  readonly messages: readonly unknown[];
  readonly nextCursor?: string | null;
}

export interface ChatNoticesResponse {
  readonly notices: readonly NoticeView[];
  readonly nextCursor?: string | null;
}

export interface ChatRuntimeResponse {
  readonly state: string;
  readonly endpoint?: string | null;
}

export interface ChatCommandsResponse {
  readonly commands?: readonly unknown[];
  readonly warnings?: readonly unknown[];
  [key: string]: unknown;
}

export interface ChatMessagePartView {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly title: string;
  readonly status: string;
  /** Raw part payload. Rendering reads structured fields from here; it is never assigned as HTML. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly provisional: boolean;
  readonly partial: boolean;
  readonly sealed: boolean;
  readonly omitted: boolean;
  readonly truncation?: unknown;
}

export interface ChatOmoView {
  readonly kind: string;
  readonly tone: string;
  readonly title: string;
  readonly body: string;
  readonly headers?: readonly string[];
}

export interface ChatHandoffView {
  readonly id: string;
  readonly direction: "request" | "reply";
  readonly agent: string;
  readonly from: string;
  readonly to: string;
  readonly state?: string;
  readonly summary: string;
  readonly body: string;
  readonly note: string;
  readonly outcome?: "completed" | "blocked" | "failed" | null;
  readonly replyState?: string;
}

export interface ChatMessageView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly optimistic?: "sending" | "queued" | "accepted" | "unknown" | "failed";
  readonly omo: ChatOmoView | null;
  readonly handoff?: ChatHandoffView | null;
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly parts: readonly ChatMessagePartView[];
}

export type ChatThreadItem =
  | { readonly type: "message"; readonly message: ChatMessageView }
  | { readonly type: "notice"; readonly notice: NoticeView };
