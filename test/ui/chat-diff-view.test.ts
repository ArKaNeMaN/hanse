import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  allocateView,
  extractToolView,
  MAX_DIFF_DISPLAY_BYTES,
  MAX_DIFF_DISPLAY_TOTAL_BYTES,
  MAX_DIFF_FILES,
  MAX_RENDERED_LINES,
  type ToolView,
} from "../../assets/chat-diff.js";
import DiffView from "../../ui/components/chat/DiffView.vue";
import ReadView from "../../ui/components/chat/ReadView.vue";
import WriteView from "../../ui/components/chat/WriteView.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

function diffPatch(index: number, lines = 20): string {
  const body = [
    `--- a/src/f${index}.ts`,
    `+++ b/src/f${index}.ts`,
    `@@ -1,${lines} +1,${lines} @@`,
  ];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`+export const f${index}_${line} = "${"x".repeat(80)}";`);
  }
  return body.join("\n");
}

function shortPatch(index: number, lines: number): string {
  const body = [
    `--- a/src/s${index}.ts`,
    `+++ b/src/s${index}.ts`,
    `@@ -1,${lines} +1,${lines} @@`,
  ];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`+v${line}`);
  }
  return body.join("\n");
}

function editView(index: number, lines = 20): ToolView {
  const view = extractToolView(
    {
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: `src/f${index}.ts` },
        metadata: { filediff: { file: `src/f${index}.ts`, patch: diffPatch(index, lines) } },
      },
    },
    "edit",
    "completed",
  );
  if (view === null) throw new Error("missing edit view");
  return view;
}

describe("diff view caps", () => {
  it("extracts read, write, edit, and apply_patch views", () => {
    const read = extractToolView(
      {
        state: {
          status: "completed",
          input: { filePath: "src/a.ts" },
          output: "<path>src/a.ts</path>\n<content>1: const a = 1;</content>",
        },
      },
      "read",
      "completed",
    );
    expect(read?.kind).toBe("read");

    const write = extractToolView(
      {
        state: {
          status: "completed",
          input: { filePath: "src/w.ts", content: "export const w = 1;" },
          metadata: {},
        },
      },
      "write",
      "completed",
    );
    expect(write?.kind).toBe("write");

    expect(editView(0).kind).toBe("diff");

    const apply = extractToolView(
      {
        state: {
          status: "completed",
          input: { patchText: "*** Begin Patch" },
          metadata: {
            files: [
              {
                type: "update",
                filePath: "src/a.ts",
                relativePath: "src/a.ts",
                patch: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
          },
        },
      },
      "apply_patch",
      "completed",
    );
    expect(apply?.kind).toBe("diff");
  });

  it("caps a file at 64 KiB", () => {
    const allocated = allocateView(editView(1, 900));
    const file = allocated.files?.[0];
    expect(file?.truncated).toBe(true);
    expect(allocated.display?.perFile).toBe(true);
    expect(new TextEncoder().encode(String(file?.patch)).length).toBeLessThanOrEqual(
      MAX_DIFF_DISPLAY_BYTES,
    );
  });

  it("caps the rendered total bytes and drops trailing files", () => {
    const files = Array.from({ length: 3 }, (_, index) => ({
      type: "update",
      filePath: `src/big${index}.ts`,
      relativePath: `src/big${index}.ts`,
      patch: diffPatch(index, 900),
    }));
    const view = extractToolView(
      { state: { status: "completed", input: {}, metadata: { files } } },
      "apply_patch",
      "completed",
    );
    if (view === null) throw new Error("missing apply view");
    const allocated = allocateView(view);
    expect(allocated.files?.length).toBe(2);
    expect(allocated.display?.total).toBe(true);
    expect(allocated.filesTruncated).toBe(true);
    const total = (allocated.files ?? []).reduce(
      (sum, file) => sum + new TextEncoder().encode(String(file.patch)).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_DIFF_DISPLAY_TOTAL_BYTES);
  });

  it("caps at 50 files and 2,000 rendered lines", () => {
    const files = Array.from({ length: 55 }, (_, index) => ({
      type: "update",
      filePath: `src/many${index}.ts`,
      relativePath: `src/many${index}.ts`,
      patch: `@@ -1 +1 @@\n-old${index}\n+new${index}`,
    }));
    const many = extractToolView(
      { state: { status: "completed", input: {}, metadata: { files } } },
      "apply_patch",
      "completed",
    );
    if (many === null) throw new Error("missing many view");
    const limited = allocateView(many);
    expect(limited.files?.length).toBe(MAX_DIFF_FILES);
    expect(limited.display?.files).toBe(true);

    const long = allocateView(
      extractToolView(
        {
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: "src/long.ts" },
            metadata: {
              filediff: { file: "src/long.ts", patch: shortPatch(2, 2_500) },
            },
          },
        },
        "edit",
        "completed",
      ) as ToolView,
    );
    const lines =
      long.files?.[0]?.hunks?.reduce((sum, hunk) => sum + (hunk.lines?.length ?? 0), 0) ?? 0;
    expect(lines).toBeLessThanOrEqual(MAX_RENDERED_LINES);
    expect(long.display?.lines).toBe(true);
  });
});

describe("structured read/write views", () => {
  it("renders read fields and per-line text nodes without raw HTML", async () => {
    const view = extractToolView(
      {
        state: {
          status: "completed",
          input: { filePath: "src/read.ts" },
          output:
            "<path>src/read.ts</path>\n<content>1: const ok = true;\n2: <script>bad()</script></content>",
        },
      },
      "read",
      "completed",
    );
    if (view === null) throw new Error("missing read view");
    const wrapper = mount(ReadView, {
      props: { view: allocateView(view), partId: "read", viewKey: "read-key", open: false },
    });
    await nextTick();
    expect(wrapper.find(".tool-code__meta").text()).toContain("1–2");
    expect(wrapper.text()).toContain("src/read.ts");
    expect(wrapper.text()).toContain("<script>bad()</script>");
    expect(wrapper.findAll("script")).toHaveLength(0);
    wrapper.unmount();
  });

  it("renders write fields and per-line text nodes", async () => {
    const view = extractToolView(
      {
        state: {
          status: "completed",
          input: { filePath: "src/write.ts", content: "const a = 1;\n<img src=x>" },
          metadata: {},
        },
      },
      "write",
      "completed",
    );
    if (view === null) throw new Error("missing write view");
    const wrapper = mount(WriteView, {
      props: { view: allocateView(view), partId: "write", viewKey: "write-key", open: false },
    });
    await nextTick();
    expect(wrapper.find(".tool-code__meta").text()).toBe("2 lines");
    expect(wrapper.text()).toContain("<img src=x>");
    expect(wrapper.findAll("img")).toHaveLength(0);
    wrapper.unmount();
  });
});

describe("DiffView", () => {
  it("renders diff lines from the shared view and never injects XML", async () => {
    const view = extractToolView(
      {
        state: {
          status: "completed",
          input: { filePath: "src/x.ts" },
          metadata: {
            filediff: {
              file: "src/x.ts",
              patch: "@@ -1 +1 @@\n-const old = 1;\n+const next = <script>bad()</script>;",
            },
          },
        },
      },
      "edit",
      "completed",
    );
    if (view === null) throw new Error("missing diff view");
    const wrapper = mount(DiffView, {
      props: { view: allocateView(view), partId: "p1", viewKey: "k1", open: false },
    });
    await nextTick();
    expect(wrapper.find(".tool-diff__file").exists()).toBe(true);
    expect(wrapper.text()).toContain("<script>bad()</script>");
    expect(wrapper.findAll("script")).toHaveLength(0);
    wrapper.unmount();
  });
});
