import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_MESSAGES, mountChat } from "./chat-support.js";

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "v1:q1",
    id: "q1",
    sessionID: "s1",
    source: "v1",
    tooLarge: false,
    questions: [
      {
        header: "Fixture question",
        question: "Continue with the fixture?",
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        multiple: false,
        custom: true,
      },
    ],
    ...overrides,
  };
}

function questionMessages(): unknown[] {
  return [
    ...FIXTURE_MESSAGES,
    {
      info: {
        id: "msg_question",
        sessionID: "s1",
        role: "assistant",
        parentID: "msg_user",
        time: { created: 1_760_000_004_000 },
      },
      parts: [
        {
          id: "prt_question",
          sessionID: "s1",
          messageID: "msg_question",
          callID: "call_question",
          type: "tool",
          tool: "question",
          state: {
            status: "running",
            input: {
              questions: [
                {
                  header: "Fixture question",
                  question: "Continue with the fixture?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          },
        },
      ],
    },
  ];
}

function replyFor(
  fetchState: Awaited<ReturnType<typeof mountChat>>["fetchState"],
  suffix: string,
): { body?: string; url: string } | undefined {
  const request = fetchState.requests.find(
    (entry) => entry.method === "POST" && entry.url.includes(suffix),
  );
  return request === undefined ? undefined : { body: request.body, url: request.url };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat prompt questions", () => {
  it("renders the dock, submits a selected answer, and returns focus to the composer", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      questions: [question()],
    });
    await flushPromises();
    const dock = wrapper.find("[data-chat-prompt-dock]");
    expect(dock.exists()).toBe(true);
    expect(dock.text()).toContain("Continue with the fixture?");
    expect(wrapper.find("[data-question-option]").exists()).toBe(true);

    await wrapper.find('[data-question-option][data-label="Yes"]').trigger("click");
    await wrapper.find("[data-question-primary]").trigger("click");
    await flushPromises();

    const reply = replyFor(fetchState, "/questions/q1/reply");
    expect(reply).toBeDefined();
    expect(JSON.parse(reply?.body ?? "{}")).toEqual({ source: "v1", answers: [["Yes"]] });
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("sends a custom answer and advances between multiple questions", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      questions: [
        question({
          key: "v1:q2",
          id: "q2",
          questions: [
            {
              header: "First",
              question: "Pick one",
              options: [{ label: "One", description: "" }],
              multiple: false,
              custom: false,
            },
            {
              header: "Second",
              question: "Explain",
              options: [],
              multiple: false,
              custom: true,
            },
          ],
        }),
      ],
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Pick one");
    await wrapper.find('[data-question-option][data-label="One"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Explain");
    expect(wrapper.text()).toContain("2 of 2");

    const custom = wrapper.find(".chat-question textarea");
    await custom.setValue("Because the fixture says so");
    await wrapper.find("[data-question-primary]").trigger("click");
    await flushPromises();

    const reply = replyFor(fetchState, "/questions/q2/reply");
    expect(JSON.parse(reply?.body ?? "{}").answers).toEqual([
      ["One"],
      ["Because the fixture says so"],
    ]);
    wrapper.unmount();
  });

  it("supports Ctrl/Cmd+Enter submit from the card", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      questions: [question()],
    });
    await flushPromises();
    await wrapper.find('[data-question-option][data-label="No"]').trigger("click");
    await wrapper.find("[data-chat-prompt-dock] article").trigger("keydown", {
      key: "Enter",
      ctrlKey: true,
    });
    await flushPromises();
    expect(replyFor(fetchState, "/questions/q1/reply")?.body).toContain('"No"');
    wrapper.unmount();
  });

  it("rejects only after confirmation and focuses the composer", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      questions: [question()],
    });
    await flushPromises();
    await wrapper.find("[data-question-reject]").trigger("click");
    expect(wrapper.find("[data-question-confirm-dismiss]").exists()).toBe(true);
    await wrapper.find("[data-question-confirm-dismiss]").trigger("click");
    await flushPromises();

    const reply = replyFor(fetchState, "/questions/q1/reject");
    expect(reply).toBeDefined();
    expect(JSON.parse(reply?.body ?? "{}")).toEqual({ source: "v1" });
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("tombstones an expired question and renders the inline outcome", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: questionMessages(),
      questions: [question({ tool: { messageID: "msg_question", callID: "call_question" } })],
      questionReplyStatus: 404,
    });
    await flushPromises();
    expect(wrapper.find(".chat-question--inline").exists()).toBe(true);
    await wrapper
      .find('.chat-question--inline [data-question-option][data-label="Yes"]')
      .trigger("click");
    await wrapper.find(".chat-question--inline [data-question-primary]").trigger("click");
    await flushPromises();

    expect(replyFor(fetchState, "/questions/q1/reply")).toBeDefined();
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    const inline = wrapper.find(".chat-question--inline");
    expect(inline.attributes("data-state")).toBe("expired");
    expect(inline.text()).toContain("Already answered or expired");
    wrapper.unmount();
  });

  it("keeps the question in the inline card and excludes it from the dock", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: questionMessages(),
      questions: [question({ tool: { messageID: "msg_question", callID: "call_question" } })],
    });
    await flushPromises();
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    const inline = wrapper.find(".chat-question--inline");
    expect(inline.exists()).toBe(true);
    expect(inline.text()).toContain("Continue with the fixture?");

    await inline.find('[data-question-option][data-label="Yes"]').trigger("click");
    await inline.find("[data-question-primary]").trigger("click");
    await flushPromises();

    const reply = replyFor(fetchState, "/questions/q1/reply");
    expect(JSON.parse(reply?.body ?? "{}").answers).toEqual([["Yes"]]);
    expect(wrapper.find(".chat-question--inline").attributes("data-state")).toBe("answered");
    wrapper.unmount();
  });
});
