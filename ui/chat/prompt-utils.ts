/** Pure helpers shared by the prompt dock, inline question cards, and permission cards. */

import type {
  NormalizedPermissionRequest,
  NormalizedQuestion,
} from "../../src/opencode/prompts.js";
import type { ChatMessagePartView } from "./types.js";

export type PermissionRisk = "high" | "medium" | "low";

const HIGH_RISK = new Set([
  "external_directory",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "task",
  "doom_loop",
]);
const MEDIUM_RISK = new Set(["webfetch", "websearch", "read", "glob", "grep", "list"]);

export function permissionRisk(request: NormalizedPermissionRequest): PermissionRisk {
  if (HIGH_RISK.has(request.permission)) return "high";
  if (MEDIUM_RISK.has(request.permission)) return "medium";
  return "medium";
}

export function permissionRiskLabel(risk: PermissionRisk): string {
  if (risk === "high") return "High risk";
  if (risk === "low") return "Low risk";
  return "Medium risk";
}

export function permissionTitle(permission: string): string {
  const titles: Readonly<Record<string, string>> = {
    bash: "Allow the agent to run this command?",
    edit: "Allow the agent to edit this file?",
    write: "Allow the agent to write this file?",
    apply_patch: "Allow the agent to apply this patch?",
    read: "Allow the agent to read this file?",
    glob: "Allow the agent to search these files?",
    grep: "Allow the agent to search file contents?",
    external_directory: "Allow the agent to reach outside the app?",
    webfetch: "Allow the agent to fetch this URL?",
    websearch: "Allow the agent to search the web?",
    doom_loop: "Allow the agent to repeat this tool call?",
  };
  return titles[permission] ?? `Allow the agent to use ${permission}?`;
}

export function questionLabel(question: NormalizedQuestion, index: number): string {
  const text = question.question.trim();
  if (text.length > 0) return text;
  const header = question.header.trim();
  if (header.length > 0) return header;
  return `Question ${index + 1}`;
}

export function answersForQuestion(selected: readonly string[], custom: string): readonly string[] {
  const trimmed = custom.trim();
  if (trimmed.length === 0 || selected.includes(trimmed)) return [...selected];
  return [...selected, trimmed];
}

export function questionNeedsReview(questions: readonly NormalizedQuestion[]): boolean {
  return questions.length > 1 || questions[0]?.multiple === true;
}

export function partCorrelationKey(
  part: ChatMessagePartView,
  sessionID: string | null,
  messageID?: string,
): string | null {
  const data = part.data;
  const source =
    typeof data.source === "string" && data.source.length > 0 ? data.source : "history";
  const session =
    typeof data.sessionID === "string" && data.sessionID.length > 0
      ? data.sessionID
      : (sessionID ?? "");
  const message =
    typeof data.messageID === "string" && data.messageID.length > 0
      ? data.messageID
      : (messageID ?? "");
  const callID = typeof data.callID === "string" && data.callID.length > 0 ? data.callID : part.id;
  if (session.length === 0 || message.length === 0 || callID.length === 0) return null;
  return `${source}:${session}:${message}:${callID}`;
}

export function isQuestionToolPart(part: ChatMessagePartView): boolean {
  const tool = part.data.tool;
  return part.type === "tool" && typeof tool === "string" && tool === "question";
}

export function partState(part: ChatMessagePartView): Record<string, unknown> {
  const state = part.data.state;
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
}

export function partQuestions(part: ChatMessagePartView): NormalizedQuestion[] {
  const input = partState(part).input;
  if (typeof input !== "object" || input === null) return [];
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const record = raw as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option !== "object" || option === null) return [];
          const value = option as Record<string, unknown>;
          return [
            {
              label: typeof value.label === "string" ? value.label : "",
              description: typeof value.description === "string" ? value.description : "",
            },
          ];
        })
      : [];
    return [
      {
        header: typeof record.header === "string" ? record.header : "",
        question: typeof record.question === "string" ? record.question : "",
        options,
        multiple: record.multiple === true,
        custom: record.custom !== false,
      },
    ];
  });
}

export function partAnswers(part: ChatMessagePartView): readonly string[][] | null {
  const metadata = partState(part).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const answers = (metadata as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) return null;
  return answers.map((answer) =>
    Array.isArray(answer)
      ? answer.filter((value): value is string => typeof value === "string")
      : [],
  );
}

export function partTerminal(part: ChatMessagePartView): boolean {
  const status = partState(part).status;
  return typeof status === "string" && status !== "running" && status !== "pending";
}
