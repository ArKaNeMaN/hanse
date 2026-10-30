import type { ChatMessagePartView, ChatMessageView } from "../../ui/chat/types.js";

export function part(
  input: Partial<ChatMessagePartView> & Pick<ChatMessagePartView, "id" | "type">,
): ChatMessagePartView {
  return {
    text: "",
    title: input.type,
    status: "",
    data: { id: input.id, type: input.type },
    provisional: false,
    partial: false,
    sealed: true,
    omitted: false,
    ...input,
  };
}

export function message(
  input: Partial<ChatMessageView> & Pick<ChatMessageView, "id" | "role" | "parts">,
): ChatMessageView {
  return {
    omo: null,
    handoff: null,
    ...input,
  };
}
