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
}

export interface ChatMessageView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly optimistic?: "sending" | "queued" | "accepted" | "unknown" | "failed";
  readonly omo: { readonly title: string; readonly body: string } | null;
  readonly parts: readonly ChatMessagePartView[];
}

export type ChatThreadItem =
  | { readonly type: "message"; readonly message: ChatMessageView }
  | { readonly type: "notice"; readonly notice: NoticeView };
