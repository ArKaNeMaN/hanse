import { describe, expect, it } from "vitest";
import {
  MAX_FEEDBACK_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_METADATA_ARRAY,
  MAX_METADATA_DEPTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_STRING,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTIONS,
  MAX_PROMPTS_PER_KIND,
  MAX_QUESTION_LENGTH,
  MAX_QUESTIONS,
  MAX_TODO_CONTENT,
  MAX_TODOS,
  normalizeMetadata,
  normalizePermissionList,
  normalizePermissionRequest,
  normalizeQuestionList,
  normalizeQuestionRequest,
  normalizeSavedPermissions,
  normalizeTodos,
} from "../src/opencode/prompts.js";

function question(index = 0) {
  return {
    id: `que_${index}`,
    sessionID: "ses_1",
    questions: [
      {
        header: "Pick one",
        question: "Which option?",
        options: [{ label: "A", description: "first" }],
      },
    ],
  };
}

describe("normalizeQuestionRequest", () => {
  it("defaults custom to true and multiple to false", () => {
    const normalized = normalizeQuestionRequest(question(), "v1");
    expect(normalized).toBeDefined();
    expect(normalized?.source).toBe("v1");
    expect(normalized?.key).toBe("v1:que_0");
    expect(normalized?.questions[0]?.custom).toBe(true);
    expect(normalized?.questions[0]?.multiple).toBe(false);
    expect(normalized?.tooLarge).toBe(false);
  });

  it("keeps explicit multiple, custom, and tool values", () => {
    const normalized = normalizeQuestionRequest(
      {
        ...question(),
        tool: { messageID: "msg_1", callID: "call_1" },
        questions: [
          {
            header: "H",
            question: "Q",
            options: [],
            multiple: true,
            custom: false,
          },
        ],
      },
      "v2",
    );
    expect(normalized?.source).toBe("v2");
    expect(normalized?.key).toBe("v2:que_0");
    expect(normalized?.questions[0]?.multiple).toBe(true);
    expect(normalized?.questions[0]?.custom).toBe(false);
    expect(normalized?.tool).toEqual({ messageID: "msg_1", callID: "call_1" });
  });

  it("returns undefined without identity fields", () => {
    expect(normalizeQuestionRequest({ questions: [] }, "v1")).toBeUndefined();
    expect(normalizeQuestionRequest("nope", "v1")).toBeUndefined();
  });

  it("marks oversized text without truncating it", () => {
    const text = "x".repeat(MAX_QUESTION_LENGTH + 1);
    const normalized = normalizeQuestionRequest(
      {
        ...question(),
        questions: [
          {
            header: "h".repeat(201),
            question: text,
            options: [
              {
                label: "l".repeat(MAX_LABEL_LENGTH + 1),
                description: "d".repeat(MAX_OPTION_DESCRIPTION_LENGTH + 1),
              },
            ],
          },
        ],
      },
      "v1",
    );
    expect(normalized?.tooLarge).toBe(true);
    expect(normalized?.tooLargeReason).toBeDefined();
    expect(normalized?.tooLargeReason?.length).toBeLessThanOrEqual(200);
    expect(normalized?.questions[0]?.question).toBe(text);
    expect(normalized?.questions[0]?.options[0]?.label.length).toBe(MAX_LABEL_LENGTH + 1);
  });

  it("marks more than 100 questions or options but keeps every entry", () => {
    const manyQuestions = Array.from({ length: MAX_QUESTIONS + 1 }, () => ({
      header: "H",
      question: "Q",
      options: [],
    }));
    const tooManyQuestions = normalizeQuestionRequest(
      { ...question(), questions: manyQuestions },
      "v1",
    );
    expect(tooManyQuestions?.tooLarge).toBe(true);
    expect(tooManyQuestions?.questions).toHaveLength(MAX_QUESTIONS + 1);

    const manyOptions = Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => ({
      label: `option ${index}`,
      description: "",
    }));
    const tooManyOptions = normalizeQuestionRequest(
      { ...question(), questions: [{ header: "H", question: "Q", options: manyOptions }] },
      "v1",
    );
    expect(tooManyOptions?.tooLarge).toBe(true);
    expect(tooManyOptions?.questions[0]?.options).toHaveLength(MAX_OPTIONS + 1);
  });

  it("caps the prompt list at 50 and reports truncation", () => {
    const list = Array.from({ length: MAX_PROMPTS_PER_KIND + 1 }, (_, index) => question(index));
    const normalized = normalizeQuestionList(list, "v1");
    expect(normalized.items).toHaveLength(MAX_PROMPTS_PER_KIND);
    expect(normalized.truncated).toBe(true);
    expect(normalized.items[0]?.key).toBe("v1:que_0");
  });
});

describe("normalizePermissionRequest", () => {
  it("maps v2 action/resources/save/source to v1 field names", () => {
    const normalized = normalizePermissionRequest(
      {
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["ls*", "cat *"],
        save: ["ls*"],
        metadata: { command: "ls" },
        source: { type: "tool", messageID: "msg_1", callID: "call_1" },
      },
      "v2",
    );
    expect(normalized).toEqual({
      key: "v2:per_1",
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["ls*", "cat *"],
      metadata: { command: "ls" },
      always: ["ls*"],
      source: "v2",
      tool: { type: "tool", messageID: "msg_1", callID: "call_1" },
    });
  });

  it("keeps v1 fields and defaults missing collections", () => {
    const normalized = normalizePermissionRequest(
      { id: "per_2", sessionID: "ses_2", permission: "edit" },
      "v1",
    );
    expect(normalized?.permission).toBe("edit");
    expect(normalized?.patterns).toEqual([]);
    expect(normalized?.always).toEqual([]);
    expect(normalized?.metadata).toEqual({});
    expect(normalized?.key).toBe("v1:per_2");
  });

  it("caps the permission list at 50", () => {
    const list = Array.from({ length: MAX_PROMPTS_PER_KIND + 1 }, (_, index) => ({
      id: `per_${index}`,
      sessionID: "ses_1",
      action: "read",
      resources: ["*"],
    }));
    const normalized = normalizePermissionList(list, "v2");
    expect(normalized.items).toHaveLength(MAX_PROMPTS_PER_KIND);
    expect(normalized.truncated).toBe(true);
  });
});

describe("normalizeMetadata", () => {
  it("bounds depth", () => {
    const normalized = normalizeMetadata({
      a: { b: { c: { d: { e: "deep" } } } },
    });
    const a = normalized.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    expect(c.d).toBe("[truncated]");
    expect(MAX_METADATA_DEPTH).toBe(3);
  });

  it("bounds keys, array length, and string length", () => {
    const input: Record<string, unknown> = {};
    for (let index = 0; index < MAX_METADATA_KEYS + 10; index += 1) {
      input[`k${index}`] = index;
    }
    const normalized = normalizeMetadata(input);
    expect(Object.keys(normalized)).toHaveLength(MAX_METADATA_KEYS);
    expect(normalized.k49).toBe(49);
    expect(normalized.k50).toBeUndefined();

    const array = normalizeMetadata({ list: Array.from({ length: 60 }, (_, index) => index) });
    expect(array.list as unknown[]).toHaveLength(MAX_METADATA_ARRAY);

    const text = normalizeMetadata({ text: "s".repeat(MAX_METADATA_STRING + 10) });
    expect((text.text as string).length).toBe(MAX_METADATA_STRING);
  });

  it("drops non-JSON values and keeps JSON primitives", () => {
    const normalized = normalizeMetadata({
      nil: null,
      yes: true,
      no: false,
      n: 1,
      fn: () => undefined,
      undef: undefined,
      big: Number.POSITIVE_INFINITY,
    });
    expect(normalized).toEqual({
      nil: null,
      yes: true,
      no: false,
      n: 1,
      big: "Infinity",
    });
  });
});

describe("normalizeTodos", () => {
  it("normalizes unknown status and priority values", () => {
    const normalized = normalizeTodos([
      { content: "a", status: "pending", priority: "high" },
      { content: "b", status: "in_progress", priority: "medium" },
      { content: "c", status: "completed", priority: "low" },
      { content: "d", status: "cancelled", priority: "low" },
      { content: "e", status: "blocked", priority: "urgent" },
    ]);
    expect(normalized.todos.map((todo) => todo.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "cancelled",
      "unknown",
    ]);
    expect(normalized.todos[4]?.priority).toBe("unknown");
    expect(normalized.truncated).toBe(false);
  });

  it("caps the list and truncates long content", () => {
    const list = Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      content: index === 0 ? "x".repeat(MAX_TODO_CONTENT + 1) : "task",
      status: "pending",
      priority: "medium",
    }));
    const normalized = normalizeTodos(list);
    expect(normalized.todos).toHaveLength(MAX_TODOS);
    expect(normalized.todos[0]?.content).toHaveLength(MAX_TODO_CONTENT);
    expect(normalized.truncated).toBe(true);
  });
});

describe("normalizeSavedPermissions", () => {
  it("accepts a wrapped v2 list and keeps id/action/resource/projectID", () => {
    const normalized = normalizeSavedPermissions({
      data: [{ id: "psv_1", projectID: "prj_1", action: "bash", resource: "ls*" }],
    });
    expect(normalized).toEqual([
      { id: "psv_1", projectID: "prj_1", action: "bash", resource: "ls*" },
    ]);
  });

  it("drops entries without an id", () => {
    expect(normalizeSavedPermissions([{ action: "bash" }])).toEqual([]);
    expect(normalizeSavedPermissions(undefined)).toEqual([]);
  });
});

describe("limits", () => {
  it("exposes the feedback cap", () => {
    expect(MAX_FEEDBACK_LENGTH).toBe(4_000);
  });
});
