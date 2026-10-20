import { describe, expect, it } from "vitest";
import {
  allocateView,
  clipDisplay,
  diffFilesFromView,
  extractToolView,
  HIGHLIGHT_STREAM_CAPS,
  HIGHLIGHT_TIMEOUT_MS,
  MAX_DIFF_DISPLAY_BYTES,
  MAX_DIFF_DISPLAY_TOTAL_BYTES,
  MAX_DIFF_FILES,
  MAX_DIFF_PATH_BYTES,
  MAX_DIFF_PATH_TOTAL_BYTES,
  MAX_HIGHLIGHT_LINE_CHARS,
  MAX_HIGHLIGHT_PAGE_WORK_MS,
  MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT,
  MAX_HIGHLIGHT_VIEW_WORK_MS,
  MAX_INFLIGHT_HIGHLIGHT_STREAMS,
  MAX_PAGE_TOKEN_NODES,
  MAX_PENDING_HIGHLIGHT_FILES,
  MAX_READ_DISPLAY_BYTES,
  MAX_RENDERED_LINES,
  MAX_TIMEOUTS_PER_LANGUAGE,
  MAX_TOKEN_NODES_PER_FILE,
  MAX_TOKEN_NODES_PER_REQUEST,
  MAX_WRITE_DISPLAY_BYTES,
  parseUnifiedDiff,
  patchPartView,
  resolveLanguage,
  sanitizeTokenType,
  streamCapBytes,
  truncationNotice,
  VENDORED_LANGUAGES,
  WORKER_READY_TIMEOUT_MS,
} from "../assets/chat-diff.js";

const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).length;
}

function realPatch(): string {
  return [
    "Index: b.txt",
    "===================================================================",
    "--- a.txt",
    "+++ b.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
  ].join("\n");
}

function editPatch(oldLine = "const a = 1;", newLine = "const a = 2;"): string {
  return ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", `-${oldLine}`, `+${newLine}`].join(
    "\n",
  );
}

function toolData(options: {
  tool: string;
  status?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  output?: string;
  title?: string;
}): Record<string, unknown> {
  return {
    tool: options.tool,
    state: {
      status: options.status ?? "completed",
      title: options.title ?? "",
      input: options.input ?? {},
      metadata: options.metadata ?? {},
      output: options.output ?? "",
    },
  };
}

function allocFile(path: string, patch: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    oldPath: path,
    newPath: path,
    type: "update",
    language: resolveLanguage(path),
    additions: 0,
    deletions: 0,
    statsPartial: false,
    binary: false,
    headerOnly: false,
    truncated: false,
    hunks: [],
    patch,
    countsFromMetadata: false,
    ...extra,
  };
}

function readAllocFile(texts: string[]) {
  return {
    path: "src/read.py",
    language: "python",
    lineStart: 1,
    lineEnd: texts.length,
    lineCount: texts.length,
    totalLines: null,
    statusLine: "",
    sourceTruncated: false,
    truncated: false,
    content: texts.join("\n"),
    lines: texts.map((text, index) => ({ number: index + 1, text })),
  };
}

describe("constants", () => {
  it("matches the design caps", () => {
    expect(MAX_DIFF_DISPLAY_BYTES).toBe(64 * 1024);
    expect(MAX_DIFF_DISPLAY_TOTAL_BYTES).toBe(128 * 1024);
    expect(MAX_WRITE_DISPLAY_BYTES).toBe(64 * 1024);
    expect(MAX_READ_DISPLAY_BYTES).toBe(64 * 1024);
    expect(MAX_RENDERED_LINES).toBe(2_000);
    expect(MAX_DIFF_FILES).toBe(50);
    expect(MAX_DIFF_PATH_BYTES).toBe(1_024);
    expect(MAX_DIFF_PATH_TOTAL_BYTES).toBe(16 * 1024);
    expect(MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT).toBe(64 * 1024);
    expect(MAX_HIGHLIGHT_LINE_CHARS).toBe(1_000);
    expect(MAX_TOKEN_NODES_PER_REQUEST).toBe(10_000);
    expect(MAX_TOKEN_NODES_PER_FILE).toBe(20_000);
    expect(MAX_PAGE_TOKEN_NODES).toBe(120_000);
    expect(MAX_INFLIGHT_HIGHLIGHT_STREAMS).toBe(12);
    expect(MAX_PENDING_HIGHLIGHT_FILES).toBe(50);
    expect(HIGHLIGHT_TIMEOUT_MS).toBe(250);
    expect(WORKER_READY_TIMEOUT_MS).toBe(2_000);
    expect(MAX_HIGHLIGHT_VIEW_WORK_MS).toBe(1_000);
    expect(MAX_HIGHLIGHT_PAGE_WORK_MS).toBe(3_000);
    expect(MAX_TIMEOUTS_PER_LANGUAGE).toBe(2);
    expect(HIGHLIGHT_STREAM_CAPS).toEqual({ markdown: 8 * 1024, markup: 8 * 1024, bash: 8 * 1024 });
  });

  it("shares the vendored language allowlist with the resolver", () => {
    expect(VENDORED_LANGUAGES).toEqual([
      "javascript",
      "typescript",
      "jsx",
      "tsx",
      "json",
      "yaml",
      "bash",
      "markdown",
      "css",
      "markup",
      "python",
      "go",
      "rust",
      "sql",
      "docker",
      "diff",
      "toml",
      "ini",
      "java",
      "c",
      "cpp",
      "csharp",
      "ruby",
      "php",
      "kotlin",
      "swift",
      "scala",
      "lua",
      "makefile",
      "graphql",
      "powershell",
    ]);
    expect(Object.isFrozen(VENDORED_LANGUAGES)).toBe(true);
  });

  it("sanitizes token types for CSS classes", () => {
    expect(sanitizeTokenType("keyword")).toBe("keyword");
    expect(sanitizeTokenType("function-variable")).toBe("function-variable");
    expect(sanitizeTokenType("Bad Type")).toBeNull();
    expect(sanitizeTokenType("token__x")).toBeNull();
    expect(sanitizeTokenType("")).toBeNull();
    expect(sanitizeTokenType(undefined)).toBeNull();
  });
});

describe("resolveLanguage", () => {
  const cases: Array<[string, string | null]> = [
    ["src/a.js", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.cjs", "javascript"],
    ["src/a.jsx", "jsx"],
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.cts", "typescript"],
    ["src/a.d.ts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["a.json", "json"],
    ["a.jsonc", "json"],
    ["a.json5", "json"],
    ["a.jsonl", "json"],
    ["a.ndjson", "json"],
    ["a.yaml", "yaml"],
    ["a.yml", "yaml"],
    ["a.sh", "bash"],
    ["a.bash", "bash"],
    ["a.zsh", "bash"],
    ["a.ksh", "bash"],
    [".env", "bash"],
    [".env.local", "bash"],
    ["a.md", "markdown"],
    ["a.markdown", "markdown"],
    ["a.mdx", "markdown"],
    ["README", "markdown"],
    ["README.md", "markdown"],
    ["readme", null],
    ["a.css", "css"],
    ["a.html", "markup"],
    ["a.htm", "markup"],
    ["a.xhtml", "markup"],
    ["a.xml", "markup"],
    ["a.svg", "markup"],
    ["a.py", "python"],
    ["a.pyw", "python"],
    ["a.pyi", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["a.sql", "sql"],
    ["Dockerfile", "docker"],
    ["Containerfile", "docker"],
    ["DOCKERFILE", "docker"],
    ["Dockerfile.prod", "docker"],
    ["a.dockerfile", "docker"],
    ["a.diff", "diff"],
    ["a.patch", "diff"],
    ["a.toml", "toml"],
    ["a.ini", "ini"],
    ["a.cfg", "ini"],
    ["a.conf", "ini"],
    ["a.properties", "ini"],
    [".editorconfig", "ini"],
    [".gitconfig", "ini"],
    [".gitmodules", "ini"],
    [".npmrc", "ini"],
    [".yarnrc", "ini"],
    ["a.java", "java"],
    ["a.c", "c"],
    ["a.h", "c"],
    ["a.cpp", "cpp"],
    ["a.cc", "cpp"],
    ["a.cxx", "cpp"],
    ["a.hpp", "cpp"],
    ["a.hh", "cpp"],
    ["a.hxx", "cpp"],
    ["a.cs", "csharp"],
    ["a.csx", "csharp"],
    ["a.rb", "ruby"],
    ["a.rake", "ruby"],
    ["a.gemspec", "ruby"],
    ["Rakefile", "ruby"],
    ["Gemfile", "ruby"],
    ["Podfile", "ruby"],
    ["a.php", "php"],
    ["a.kt", "kotlin"],
    ["a.kts", "kotlin"],
    ["a.swift", "swift"],
    ["a.scala", "scala"],
    ["a.sc", "scala"],
    ["a.lua", "lua"],
    ["Makefile", "makefile"],
    ["GNUmakefile", "makefile"],
    ["makefile", "makefile"],
    ["a.mk", "makefile"],
    ["a.mak", "makefile"],
    ["a.graphql", "graphql"],
    ["a.graphqls", "graphql"],
    ["a.gql", "graphql"],
    ["a.ps1", "powershell"],
    ["a.psm1", "powershell"],
    ["a.psd1", "powershell"],
    ["a.min.js", "javascript"],
    ["no-extension", null],
    ["LICENSE", null],
    ["go.mod", null],
    ["requirements.txt", null],
    ["a.csv", null],
    ["a.vue", null],
  ];

  it.each(cases)("resolves %s", (path, language) => {
    expect(resolveLanguage(path)).toBe(language);
  });

  it("handles Windows separators and query strings", () => {
    expect(resolveLanguage("C:\\work\\src\\file.ts")).toBe("typescript");
    expect(resolveLanguage("src/file.py?raw=1")).toBe("python");
    expect(resolveLanguage("src/file.md#L10")).toBe("markdown");
  });

  it("resolves from the uncapped basename", () => {
    const path = `${"deep/".repeat(500)}component.ts`;
    expect(resolveLanguage(path)).toBe("typescript");
  });

  it("returns null for non-strings and empty paths", () => {
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage("/")).toBeNull();
  });

  it("selects stream caps by language", () => {
    expect(streamCapBytes("markdown")).toBe(8 * 1024);
    expect(streamCapBytes("markup")).toBe(8 * 1024);
    expect(streamCapBytes("bash")).toBe(8 * 1024);
    expect(streamCapBytes("typescript")).toBe(64 * 1024);
    expect(streamCapBytes(null)).toBe(64 * 1024);
    expect(streamCapBytes("unknown")).toBe(64 * 1024);
  });
});

describe("clipDisplay", () => {
  it("does not clip text under the cap", () => {
    expect(clipDisplay("abc", 10)).toEqual({ text: "abc", clipped: false });
  });

  it("keeps the partial last line", () => {
    expect(clipDisplay("alpha\nbeta", 7)).toEqual({ text: "alpha\nb", clipped: true });
  });

  it("never splits a UTF-8 code point", () => {
    const clipped = clipDisplay("ééé", 3);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toBe("é");
    expect(clipped.text).not.toContain("\uFFFD");
  });

  it("handles four-byte code points", () => {
    const clipped = clipDisplay("🙂🙂", 5);
    expect(clipped.text).toBe("🙂");
    expect(clipped.text).not.toContain("\uFFFD");
  });

  it("clips to zero safely", () => {
    expect(clipDisplay("abc", 0)).toEqual({ text: "", clipped: true });
    expect(clipDisplay("", 0)).toEqual({ text: "", clipped: false });
  });
});

describe("parseUnifiedDiff", () => {
  it("parses the real createTwoFilesPatch Index/==== shape", () => {
    const result = parseUnifiedDiff(realPatch());
    expect(result.raw).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file).toMatchObject({
      path: "b.txt",
      oldPath: "a.txt",
      newPath: "b.txt",
      type: "update",
      additions: 1,
      deletions: 1,
      headerOnly: false,
      binary: false,
    });
    expect(file.hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(file.hunks[0].lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "a"],
      ["del", "b"],
      ["add", "B"],
      ["context", "c"],
    ]);
    expect(file.hunks[0].lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ]);
  });

  it("parses ---/+++ only and hunk headers with section text", () => {
    const result = parseUnifiedDiff(
      ["--- src/a.ts", "+++ src/a.ts", "@@ -1 +1,2 @@ function x()", "-a", "+b", "+c"].join("\n"),
    );
    const file = result.files[0];
    expect(file.path).toBe("src/a.ts");
    expect(file.hunks[0].header).toBe("@@ -1 +1,2 @@ function x()");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("infers add and delete from /dev/null", () => {
    const add = parseUnifiedDiff(
      ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
    ).files[0];
    expect(add).toMatchObject({
      path: "new.txt",
      oldPath: null,
      newPath: "new.txt",
      type: "add",
      additions: 2,
      deletions: 0,
    });
    expect(add.hunks[0].lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [null, 1],
      [null, 2],
    ]);

    const remove = parseUnifiedDiff(
      ["--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two"].join("\n"),
    ).files[0];
    expect(remove).toMatchObject({
      path: "gone.txt",
      oldPath: "gone.txt",
      newPath: null,
      type: "delete",
      additions: 0,
      deletions: 2,
    });
    expect(remove.hunks[0].lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it("lets metadata type/path/counts win over inferred same-path add/delete", () => {
    const patch = ["--- same.txt", "+++ same.txt", "@@ -0,0 +1 @@", "+x"].join("\n");
    const result = parseUnifiedDiff(patch, {
      type: "add",
      oldPath: "same.txt",
      newPath: "same.txt",
      additions: 1,
      deletions: 0,
    }).files[0];
    expect(result).toMatchObject({
      path: "same.txt",
      type: "add",
      additions: 1,
      deletions: 0,
    });
  });

  it("infers move from rename headers", () => {
    const result = parseUnifiedDiff(
      [
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to b.txt",
      ].join("\n"),
    ).files[0];
    expect(result).toMatchObject({
      path: "b.txt",
      oldPath: "a.txt",
      newPath: "b.txt",
      type: "move",
      headerOnly: true,
    });
  });

  it("infers add/delete from mode lines", () => {
    const add = parseUnifiedDiff(
      ["diff --git a/a.txt b/a.txt", "new file mode 100644", "--- /dev/null", "+++ b/a.txt"].join(
        "\n",
      ),
    ).files[0];
    expect(add.type).toBe("add");
    const remove = parseUnifiedDiff(
      [
        "diff --git a/a.txt b/a.txt",
        "deleted file mode 100644",
        "--- a/a.txt",
        "+++ /dev/null",
      ].join("\n"),
    ).files[0];
    expect(remove.type).toBe("delete");
  });

  it("handles binary files", () => {
    const result = parseUnifiedDiff(
      ["diff --git a/a.png b/a.png", "Binary files a/a.png and b/a.png differ"].join("\n"),
    ).files[0];
    expect(result).toMatchObject({
      path: "a.png",
      type: "binary",
      binary: true,
      headerOnly: true,
      additions: 0,
      deletions: 0,
    });
  });

  it("skips GIT binary payload lines", () => {
    const result = parseUnifiedDiff(
      [
        "diff --git a/a.bin b/a.bin",
        "GIT binary patch",
        "literal 3",
        "AbCdEf",
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(result.files).toHaveLength(2);
    expect(result.files[0].binary).toBe(true);
    expect(result.files[1].path).toBe("b.txt");
    expect(result.files[1].hunks).toHaveLength(1);
  });

  it("normalizes CRLF", () => {
    const result = parseUnifiedDiff(realPatch().replaceAll("\n", "\r\n"));
    expect(result.files[0].hunks[0].lines.map((line) => line.text)).toEqual(["a", "b", "B", "c"]);
    expect(result.truncated).toBe(false);
  });

  it("keeps two trailing no-newline meta lines after the counts", () => {
    const result = parseUnifiedDiff(
      [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-a",
        "\\ No newline at end of file",
        "+b",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    const file = result.files[0];
    expect(result.truncated).toBe(false);
    expect(file.hunks[0].lines.map((line) => line.kind)).toEqual(["del", "meta", "add", "meta"]);
    expect(file.hunks[0].lines[1].text).toBe("No newline at end of file");
    expect(file.hunks[0].lines[3].text).toBe("No newline at end of file");
  });

  it("treats a bare empty line as context while counts require it", () => {
    const result = parseUnifiedDiff(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " first", "", "-old", "+new"].join("\n"),
    );
    const lines = result.files[0].hunks[0].lines;
    expect(lines[1]).toMatchObject({ kind: "context", text: "", oldNumber: 2, newNumber: 2 });
    expect(result.truncated).toBe(false);
  });

  it("marks an extra body line after the counts as truncated meta", () => {
    const result = parseUnifiedDiff(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-a", "+b", "+extra"].join("\n"),
    );
    const file = result.files[0];
    expect(result.truncated).toBe(true);
    expect(file.truncated).toBe(true);
    expect(file.statsPartial).toBe(true);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0].lines.at(-1)).toMatchObject({ kind: "meta", text: "+extra" });
  });

  it("marks a short hunk tail truncated", () => {
    const result = parseUnifiedDiff(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B"].join("\n"),
    );
    expect(result.truncated).toBe(true);
    expect(result.files[0].truncated).toBe(true);
    expect(result.files[0].statsPartial).toBe(true);
  });

  it("marks an invalid hunk header as a truncated tail", () => {
    const result = parseUnifiedDiff(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1,1 +1,1 @@", "-a", "+b", "@@ broken"].join("\n"),
    );
    expect(result.truncated).toBe(true);
    expect(result.files[0].truncated).toBe(true);
  });

  it("supports zero counts", () => {
    const result = parseUnifiedDiff(["--- a/a.txt", "+++ b/a.txt", "@@ -0,0 +0,0 @@"].join("\n"));
    expect(result.files[0].hunks).toHaveLength(1);
    expect(result.files[0].hunks[0].lines).toEqual([]);
    expect(result.files[0].additions).toBe(0);
    expect(result.files[0].deletions).toBe(0);
  });

  it("uses Index: as a path fallback when ---/+++ are absent", () => {
    const result = parseUnifiedDiff(
      [
        "Index: src/foo.ts",
        "===================================================================",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(result.files[0].path).toBe("src/foo.ts");
    expect(result.files[0].hunks).toHaveLength(1);
  });

  it("uses defaultPath for hunk-only patches", () => {
    const result = parseUnifiedDiff(["@@ -1 +1 @@", "-a", "+b"].join("\n"), {
      defaultPath: "src/only.ts",
    });
    expect(result.files[0]).toMatchObject({
      path: "src/only.ts",
      oldPath: "src/only.ts",
      newPath: "src/only.ts",
      language: "typescript",
    });
  });

  it("strips quotes and timestamps from paths", () => {
    const result = parseUnifiedDiff(
      [
        '--- "a/foo bar.txt"\t2026-10-20 12:00:00 +0000',
        '+++ "b/foo bar.txt"\t2026-10-20 12:00:01 +0000',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(result.files[0]).toMatchObject({
      oldPath: "foo bar.txt",
      newPath: "foo bar.txt",
      path: "foo bar.txt",
    });
  });

  it("applies maxFiles to combined sources", () => {
    const patch = [1, 2, 3]
      .map((index) =>
        [
          `diff --git a/f${index}.txt b/f${index}.txt`,
          `--- a/f${index}.txt`,
          `+++ b/f${index}.txt`,
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      )
      .join("\n");
    const result = parseUnifiedDiff(patch, { maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.filesTruncated).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("applies maxFiles to a per-file source", () => {
    const result = parseUnifiedDiff(realPatch(), { maxFiles: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.filesTruncated).toBe(false);
  });

  it("marks a file with headers but no hunks as headerOnly", () => {
    const result = parseUnifiedDiff(
      ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt"].join("\n"),
    );
    expect(result.files[0].headerOnly).toBe(true);
    expect(result.files[0].hunks).toEqual([]);
  });

  it("falls back to raw text when nothing is recognized", () => {
    for (const text of ["", "just some text", "a\nb\nc"]) {
      const result = parseUnifiedDiff(text);
      expect(result).toMatchObject({ files: [], raw: true, truncated: false });
    }
  });

  it("marks a diff --git section as recognized even without a hunk", () => {
    const result = parseUnifiedDiff("diff --git a/a.txt b/a.txt");
    expect(result.raw).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].headerOnly).toBe(true);
  });

  it("does not render Index:/==== as body text", () => {
    const result = parseUnifiedDiff(realPatch());
    expect(result.files[0].hunks[0].lines.some((line) => line.kind === "meta")).toBe(false);
  });
});

describe("extractToolView", () => {
  it("prefers filediff.patch for standard edit", () => {
    const filediffPatch = editPatch("const a = 1;", "const a = 3;");
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/a.ts" },
        metadata: {
          filediff: { file: "src/a.ts", patch: filediffPatch, additions: 1, deletions: 1 },
          diff: editPatch("const a = 1;", "const a = 9;"),
        },
      }),
      "edit",
      "completed",
    );
    expect(view?.kind).toBe("diff");
    const file = diffFilesFromView(view)[0];
    expect(file.path).toBe("src/a.ts");
    expect(file.language).toBe("typescript");
    expect(file.hunks[0].lines[0].text).toBe("const a = 1;");
    expect(file.hunks[0].lines[1].text).toBe("const a = 3;");
  });

  it("infers add for an edit patch with /dev/null", () => {
    const patch = ["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+hello"].join("\n");
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/new.ts" },
        metadata: { filediff: { file: "src/new.ts", patch, additions: 1, deletions: 0 } },
      }),
      "edit",
      "completed",
    );
    expect(diffFilesFromView(view)[0]).toMatchObject({
      path: "src/new.ts",
      oldPath: null,
      newPath: "src/new.ts",
      type: "add",
    });
  });

  it("falls back to metadata.diff for edit", () => {
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/a.ts" },
        metadata: { diff: editPatch() },
      }),
      "edit",
      "completed",
    );
    expect(view?.kind).toBe("diff");
    expect(diffFilesFromView(view)[0].hunks).toHaveLength(1);
  });

  it("handles a hashline rename with old input path and new filediff path", () => {
    const patch = ["@@ -1 +1 @@", "-old", "+new"].join("\n");
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/old.ts", rename: "src/new.ts" },
        metadata: { filediff: { file: "src/new.ts", patch, additions: 1, deletions: 1 } },
      }),
      "edit",
      "completed",
    );
    const file = diffFilesFromView(view)[0];
    expect(file).toMatchObject({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      type: "move",
      language: "typescript",
    });
  });

  it("returns null for a hashline delete (output fallback)", () => {
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/gone.ts", delete: true },
        metadata: {},
        output: "Successfully deleted",
      }),
      "edit",
      "completed",
    );
    expect(view).toBeNull();
  });

  it("ignores filediff.before/after and returns null without a diff", () => {
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/a.ts" },
        metadata: { filediff: { file: "src/a.ts", before: "a", after: "b" } },
      }),
      "edit",
      "completed",
    );
    expect(view).toBeNull();
  });

  it("returns null for an error status", () => {
    const view = extractToolView(
      toolData({
        tool: "edit",
        status: "error",
        input: { filePath: "src/a.ts" },
        metadata: { diff: editPatch() },
      }),
      "edit",
      "error",
    );
    expect(view).toBeNull();
  });

  it("renders per-file apply_patch records with metadata type/path/counts", () => {
    const addPatch = ["--- p.ts", "+++ p.ts", "@@ -0,0 +1 @@", "+x"].join("\n");
    const deletePatch = ["--- d.ts", "+++ d.ts", "@@ -1 +0,0 @@", "-x"].join("\n");
    const movePatch = ["--- old.ts", "+++ new.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: {
          files: [
            {
              type: "add",
              filePath: "p.ts",
              relativePath: "p.ts",
              diff: addPatch,
              additions: 1,
              deletions: 0,
            },
            {
              type: "delete",
              filePath: "d.ts",
              relativePath: "d.ts",
              diff: deletePatch,
              additions: 0,
              deletions: 1,
            },
            {
              type: "move",
              filePath: "old.ts",
              relativePath: "new.ts",
              movePath: "new.ts",
              diff: movePatch,
              additions: 1,
              deletions: 1,
            },
          ],
        },
      }),
      "apply_patch",
      "completed",
    );
    const files = diffFilesFromView(view);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: "p.ts", type: "add", additions: 1 });
    expect(files[1]).toMatchObject({ path: "d.ts", type: "delete", deletions: 1 });
    expect(files[2]).toMatchObject({
      path: "new.ts",
      oldPath: "old.ts",
      newPath: "new.ts",
      type: "move",
      language: "typescript",
    });
  });

  it("clips an oversized per-file apply_patch patch and reports per-file truncation", () => {
    const lines = Array.from({ length: 8_000 }, (_value, index) => ` line ${index}`);
    const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,8000 +1,8000 @@", ...lines].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: {
          files: [
            {
              type: "update",
              filePath: "a.ts",
              relativePath: "a.ts",
              diff: patch,
              additions: 0,
              deletions: 0,
            },
          ],
        },
      }),
      "apply_patch",
      "completed",
    );
    expect(view?.display.perFile).toBe(true);
    expect(bytes(diffFilesFromView(view)[0].patch)).toBeLessThanOrEqual(MAX_DIFF_DISPLAY_BYTES);
  });

  it("uses input.filePath for a single apply_patch record with no path", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b"].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        input: { filePath: "src/fallback.ts" },
        metadata: { files: [{ type: "update", diff: patch }] },
      }),
      "apply_patch",
      "completed",
    );
    expect(diffFilesFromView(view)[0]).toMatchObject({
      path: "src/fallback.ts",
      language: "typescript",
    });
  });

  it("parses a combined apply_patch metadata.diff and merges metadata by new path", () => {
    const combined = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: {
          diff: combined,
          files: [
            { type: "update", filePath: "a.ts", relativePath: "a.ts", additions: 1, deletions: 1 },
            {
              type: "move",
              filePath: "old.ts",
              relativePath: "new.ts",
              movePath: "new.ts",
              additions: 1,
              deletions: 1,
            },
          ],
        },
      }),
      "apply_patch",
      "completed",
    );
    const files = diffFilesFromView(view);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "a.ts", type: "update" });
    expect(files[1]).toMatchObject({
      path: "new.ts",
      oldPath: "old.ts",
      newPath: "new.ts",
      type: "move",
    });
  });

  it("keeps header-only records for partial per-file apply_patch", () => {
    const patch = ["--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: {
          files: [
            { type: "update", filePath: "a.ts", relativePath: "a.ts", diff: patch },
            { type: "delete", filePath: "b.ts", relativePath: "b.ts", additions: 0, deletions: 2 },
          ],
        },
      }),
      "apply_patch",
      "completed",
    );
    const files = diffFilesFromView(view);
    expect(files).toHaveLength(2);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1]).toMatchObject({
      path: "b.ts",
      type: "delete",
      headerOnly: true,
      statsPartial: true,
    });
  });

  it("renders apply_patch headers-only records", () => {
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: {
          files: [{ type: "add", filePath: "new.ts", relativePath: "new.ts", additions: 3 }],
        },
      }),
      "apply_patch",
      "completed",
    );
    const file = diffFilesFromView(view)[0];
    expect(file).toMatchObject({ path: "new.ts", type: "add", headerOnly: true, additions: 3 });
  });

  it("shows running apply_patch patchText as plain text", () => {
    const patchText = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        status: "running",
        input: { patchText },
        metadata: {},
      }),
      "apply_patch",
      "running",
    );
    expect(view).toMatchObject({ kind: "plain", field: "diff", text: patchText });
  });

  it("shows a write view with create/update inference and exact line counts", () => {
    const created = extractToolView(
      toolData({
        tool: "write",
        input: { filePath: "src/new.ts", content: "a\nb\n" },
        metadata: { exists: false },
      }),
      "write",
      "completed",
    );
    expect(created).toMatchObject({ kind: "write", field: "write" });
    expect(diffFilesFromView(created)[0]).toMatchObject({
      path: "src/new.ts",
      type: "add",
      language: "typescript",
      lineCount: 2,
    });

    const updated = extractToolView(
      toolData({
        tool: "write",
        input: { filePath: "src/a.ts", content: "a\nb" },
        metadata: {},
      }),
      "write",
      "completed",
    );
    expect(diffFilesFromView(updated)[0]).toMatchObject({ type: "update", lineCount: 2 });
  });

  it("renders an empty write as an empty file", () => {
    const view = extractToolView(
      toolData({
        tool: "write",
        input: { filePath: "src/empty.ts", content: "" },
        metadata: { exists: true },
      }),
      "write",
      "completed",
    );
    expect(diffFilesFromView(view)[0]).toMatchObject({ content: "", lineCount: 0 });
  });

  it("returns null when write content is absent or the status is error", () => {
    expect(
      extractToolView(
        toolData({ tool: "write", input: { filePath: "src/a.ts" }, metadata: {} }),
        "write",
        "completed",
      ),
    ).toBeNull();
    expect(
      extractToolView(
        toolData({
          tool: "write",
          status: "error",
          input: { filePath: "src/a.ts", content: "x" },
          metadata: {},
        }),
        "write",
        "error",
      ),
    ).toBeNull();
  });

  it("includes normalized diagnostics text", () => {
    const view = extractToolView(
      toolData({
        tool: "edit",
        input: { filePath: "src/a.ts" },
        metadata: {
          diff: editPatch(),
          diagnostics: { "src/a.ts": [{ message: "unused variable" }] },
        },
      }),
      "edit",
      "completed",
    );
    expect(view?.diagnostics).toBe("src/a.ts: unused variable");
  });

  it("parses a completed read with line numbers, empty lines, and an end status", () => {
    const output = [
      "<path>/workspace/apps/demo-app/tools/analyzer/webui.py</path>",
      "<type>file</type>",
      "<content>",
      "1: #!/usr/bin/env python3",
      "2: ",
      "3: def bundle_bytes(data, drop_index, mins=2.0):",
      "",
      "(End of file - total 3 lines)",
      "</content>",
    ].join("\n");
    const view = extractToolView(
      toolData({ tool: "read", input: { filePath: "/workspace/fallback.py" }, output }),
      "read",
      "completed",
    );
    expect(view).toMatchObject({ kind: "read", field: "read", filesTruncated: false });
    expect(view?.files[0]).toMatchObject({
      path: "/workspace/apps/demo-app/tools/analyzer/webui.py",
      language: "python",
      lineStart: 1,
      lineEnd: 3,
      lineCount: 3,
      totalLines: 3,
      statusLine: "End of file - total 3 lines",
      sourceTruncated: false,
      truncated: false,
      content: "#!/usr/bin/env python3\n\ndef bundle_bytes(data, drop_index, mins=2.0):",
    });
    expect(view?.files[0].lines[1]).toEqual({ number: 2, text: "" });
  });

  it("accepts the capped status form without a total", () => {
    const output = [
      "<path>/workspace/webui.py</path>",
      "<content>",
      "1: alpha",
      "2: beta",
      " ",
      "(Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.)",
      "</content>",
    ].join("\n");
    const view = extractToolView(
      toolData({ tool: "read", input: { filePath: "webui.py" }, output }),
      "read",
      "completed",
    );
    expect(view?.files[0]).toMatchObject({
      lineStart: 1,
      lineEnd: 2,
      totalLines: null,
      sourceTruncated: true,
      statusLine: "Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.",
    });
  });

  it("captures the total from a showing-lines status", () => {
    const output = [
      "<path>/workspace/webui.py</path>",
      "<content>",
      "1400: alpha",
      "1401: beta",
      "",
      "(Showing lines 1400-1401 of 5169. Use offset=1402 to continue.)",
      "</content>",
    ].join("\n");
    const view = extractToolView(
      toolData({ tool: "read", input: { filePath: "webui.py" }, output }),
      "read",
      "completed",
    );
    expect(view?.files[0]).toMatchObject({
      lineStart: 1400,
      lineEnd: 1401,
      totalLines: 5169,
      sourceTruncated: true,
    });
  });

  it("uses the actual offset line numbers from the XML, not the array index", () => {
    const output = [
      "<path>/workspace/webui.py</path>",
      "<content>",
      "1418: alpha",
      "1419: beta",
      "1420: gamma",
      "",
      "(Output capped at 50 KB. Showing lines 1418-1420. Use offset=1421 to continue.)",
      "</content>",
    ].join("\n");
    const view = extractToolView(
      toolData({
        tool: "read",
        input: { filePath: "webui.py", offset: 1418, limit: 3 },
        output,
      }),
      "read",
      "completed",
    );
    expect(view?.files[0].lines.map((line: { number: number }) => line.number)).toEqual([
      1418, 1419, 1420,
    ]);
    expect(view?.files[0]).toMatchObject({ lineStart: 1418, lineEnd: 1420, lineCount: 3 });
  });

  it("falls back to input.filePath when the output has no path tag", () => {
    const output = ["<content>", "1: alpha", "2: beta", "</content>"].join("\n");
    const view = extractToolView(
      toolData({ tool: "read", input: { filePath: "src/fallback.ts" }, output }),
      "read",
      "completed",
    );
    expect(view?.files[0]).toMatchObject({
      path: "src/fallback.ts",
      language: "typescript",
      lineCount: 2,
    });
  });

  it("returns null for malformed read content, errors, running, and missing output", () => {
    const malformed = [
      "<path>/workspace/webui.py</path>",
      "<content>",
      "1: alpha",
      "unexpected free text",
      "3: gamma",
      "</content>",
    ].join("\n");
    const data = toolData({
      tool: "read",
      input: { filePath: "webui.py" },
      output: malformed,
    });
    expect(extractToolView(data, "read", "completed")).toBeNull();
    expect(
      extractToolView({ ...data, state: { ...data.state, status: "running" } }, "read", "running"),
    ).toBeNull();
    expect(
      extractToolView({ ...data, state: { ...data.state, status: "error" } }, "read", "error"),
    ).toBeNull();
    expect(
      extractToolView(
        toolData({ tool: "read", input: { filePath: "webui.py" }, output: "" }),
        "read",
        "completed",
      ),
    ).toBeNull();
  });
});

describe("patchPartView", () => {
  it("parses a patch string as a diff", () => {
    const view = patchPartView({ patch: realPatch() });
    expect(view.kind).toBe("diff");
    expect(view.field).toBe("patch");
    expect(diffFilesFromView(view)[0].path).toBe("b.txt");
  });

  it("does not assume an arbitrary patch string is a diff", () => {
    const view = patchPartView({ patch: "not a unified diff" });
    expect(view).toMatchObject({ kind: "plain", field: "patch", text: "not a unified diff" });
  });

  it("renders a files string list", () => {
    const view = patchPartView({ files: ["a.ts", "b.ts"] });
    expect(view.kind).toBe("files");
    expect(diffFilesFromView(view).map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("parses a text body last", () => {
    const view = patchPartView({
      text: ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    });
    expect(view.kind).toBe("diff");
    expect(patchPartView({ text: "not a diff" })).toMatchObject({
      kind: "plain",
      text: "not a diff",
    });
  });

  it("prefers patch over files and text", () => {
    const view = patchPartView({
      patch: ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
      files: ["ignored.ts"],
      text: "ignored",
    });
    expect(view.kind).toBe("diff");
    expect(diffFilesFromView(view).map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("returns the no-body fallback only when nothing exists", () => {
    expect(patchPartView({})).toMatchObject({ kind: "plain", text: "No patch body" });
  });
});

describe("allocateView", () => {
  it("keeps two full 64 KiB records and drops the third whole record", () => {
    const patch = "a".repeat(MAX_DIFF_DISPLAY_BYTES);
    const view = {
      kind: "diff",
      field: "diff",
      files: [allocFile("a.txt", patch), allocFile("b.txt", patch), allocFile("c.txt", patch)],
      filesTruncated: false,
      display: {},
    };
    const allocated = allocateView(view);
    expect(allocated.files).toHaveLength(2);
    expect(allocated.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(allocated.filesTruncated).toBe(true);
    expect(allocated.display.total).toBe(true);
    expect(allocated.files.map((file) => file.path)).not.toContain("c.txt");
  });

  it("keeps at most 50 records and never turns a dropped record into a header", () => {
    const files = Array.from({ length: 200 }, (_value, index) => allocFile(`f${index}.txt`, "x"));
    const allocated = allocateView({ kind: "diff", field: "diff", files, display: {} });
    expect(allocated.files).toHaveLength(MAX_DIFF_FILES);
    expect(allocated.files.at(-1).path).toBe("f49.txt");
    expect(allocated.filesTruncated).toBe(true);
    expect(allocated.display.files).toBe(true);
  });

  it("caps paths and the 16 KiB path total", () => {
    const path = "p".repeat(MAX_DIFF_PATH_BYTES);
    const files = Array.from({ length: 50 }, (_value, index) => allocFile(`${index}-${path}`, "x"));
    const allocated = allocateView({ kind: "diff", field: "diff", files, display: {} });
    const total = allocated.files.reduce((sum, file) => sum + bytes(file.path), 0);
    expect(allocated.files[0].path).toHaveLength(MAX_DIFF_PATH_BYTES);
    expect(total).toBeLessThanOrEqual(MAX_DIFF_PATH_TOTAL_BYTES);
    expect(allocated.files.at(-1).path).toBe("");
  });

  it("preserves file order", () => {
    const files = ["c", "a", "b"].map((path) => allocFile(path, "x"));
    const allocated = allocateView({ kind: "diff", field: "diff", files, display: {} });
    expect(allocated.files.map((file) => file.path)).toEqual(["c", "a", "b"]);
  });

  it("clips a per-file patch above 64 KiB and marks it truncated", () => {
    const lines = Array.from({ length: 8_000 }, (_value, index) => ` line ${index}`);
    const patch = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,8000 +1,8000 @@", ...lines].join("\n");
    const view = { kind: "diff", field: "diff", files: [allocFile("a.txt", patch)], display: {} };
    const allocated = allocateView(view);
    const file = allocated.files[0];
    expect(bytes(file.patch)).toBeLessThanOrEqual(MAX_DIFF_DISPLAY_BYTES);
    expect(allocated.display.perFile).toBe(true);
    expect(file.truncated).toBe(true);
    expect(file.statsPartial).toBe(true);
  });

  it("caps rendered lines at 2,000", () => {
    const lines = Array.from({ length: 2_001 }, (_value, index) => ({
      kind: "context",
      text: String(index),
      oldNumber: index + 1,
      newNumber: index + 1,
    }));
    const file = allocFile("a.txt", "x", {
      hunks: [
        {
          header: "@@ -1,2001 +1,2001 @@",
          oldStart: 1,
          oldCount: 2_001,
          newStart: 1,
          newCount: 2_001,
          lines,
        },
      ],
    });
    const allocated = allocateView({ kind: "diff", field: "diff", files: [file], display: {} });
    expect(allocated.files[0].hunks[0].lines).toHaveLength(MAX_RENDERED_LINES);
    expect(allocated.display.lines).toBe(true);
    expect(allocated.files[0].truncated).toBe(true);
  });

  it("caps write content at 64 KiB and the line cap", () => {
    const content = "x".repeat(MAX_WRITE_DISPLAY_BYTES + 10);
    const view = {
      kind: "write",
      field: "write",
      files: [{ ...allocFile("a.ts", ""), content }],
      display: {},
    };
    const allocated = allocateView(view);
    expect(bytes(allocated.files[0].content)).toBeLessThanOrEqual(MAX_WRITE_DISPLAY_BYTES);
    expect(allocated.display.write).toBe(true);
    expect(allocated.files[0].lineCount).toBe(1);

    const manyLines = Array.from({ length: MAX_RENDERED_LINES + 1 }, () => "x").join("\n");
    const lineView = {
      kind: "write",
      field: "write",
      files: [{ ...allocFile("a.ts", ""), content: manyLines }],
      display: {},
    };
    const lineAllocated = allocateView(lineView);
    expect(lineAllocated.files[0].lineCount).toBe(MAX_RENDERED_LINES);
    expect(lineAllocated.display.lines).toBe(true);
  });

  it("caps read content at 64 KiB without cutting a line", () => {
    const texts = Array.from({ length: 900 }, () => "x".repeat(100));
    const allocated = allocateView({
      kind: "read",
      field: "read",
      files: [readAllocFile(texts)],
      display: {},
    });
    const file = allocated.files[0];
    expect(allocated.display.write).toBe(true);
    expect(allocated.display.lines).toBe(false);
    expect(file.truncated).toBe(true);
    expect(file.lineCount).toBeLessThan(texts.length);
    expect(bytes(file.content)).toBeLessThanOrEqual(MAX_READ_DISPLAY_BYTES);
    expect(file.lines.every((line: { text: string }) => line.text === "x".repeat(100))).toBe(true);
    expect(file.content).toBe(file.lines.map((line: { text: string }) => line.text).join("\n"));
  });

  it("caps read content at 2,000 lines and keeps the XML line numbers", () => {
    const texts = Array.from({ length: MAX_RENDERED_LINES + 50 }, () => "x");
    const allocated = allocateView({
      kind: "read",
      field: "read",
      files: [readAllocFile(texts)],
      display: {},
    });
    const file = allocated.files[0];
    expect(allocated.display.lines).toBe(true);
    expect(allocated.display.write).toBe(false);
    expect(file.lineCount).toBe(MAX_RENDERED_LINES);
    expect(file.lines).toHaveLength(MAX_RENDERED_LINES);
    expect(file.lineStart).toBe(1);
    expect(file.lineEnd).toBe(MAX_RENDERED_LINES);
    expect(file.lines.at(-1)).toEqual({ number: MAX_RENDERED_LINES, text: "x" });
    expect(file.content.split("\n")).toHaveLength(MAX_RENDERED_LINES);
  });

  it("caps a file-list view and its paths", () => {
    const files = Array.from({ length: 60 }, (_value, index) => ({ path: `f${index}.ts` }));
    const allocated = allocateView({ kind: "files", field: "patch", files, display: {} });
    expect(allocated.files).toHaveLength(MAX_DIFF_FILES);
    expect(allocated.display.files).toBe(true);
  });

  it("keeps header-only records supplied without a patch (not a budget drop)", () => {
    const files = [allocFile("a.txt", "x"), { ...allocFile("b.txt", ""), headerOnly: true }];
    const allocated = allocateView({ kind: "diff", field: "diff", files, display: {} });
    expect(allocated.files).toHaveLength(2);
    expect(allocated.files[1].headerOnly).toBe(true);
  });

  it("produces identical results for live and hydrated fixtures", () => {
    const files = [
      allocFile("a.ts", ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")),
      allocFile("b.md", ["--- a/b.md", "+++ b/b.md", "@@ -1 +1 @@", "-a", "+b"].join("\n")),
    ];
    const live = allocateView({ kind: "diff", field: "diff", files, display: {} });
    const hydrated = allocateView({
      kind: "diff",
      field: "diff",
      files: files.map((file) => ({ ...file })),
      display: {},
    });
    expect(hydrated.files).toEqual(live.files);
    expect(hydrated.display).toEqual(live.display);
  });

  it("clips a combined diff source above 128 KiB and marks total", () => {
    const hugeLine = `+${"x".repeat(MAX_DIFF_DISPLAY_TOTAL_BYTES)}`;
    const combined = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -0,0 +1 @@",
      hugeLine,
    ].join("\n");
    const view = extractToolView(
      toolData({
        tool: "apply_patch",
        metadata: { diff: combined, files: [] },
      }),
      "apply_patch",
      "completed",
    );
    expect(view?.display.total).toBe(true);
    expect(view?.filesTruncated).toBe(true);
  });

  it("returns an empty diffFilesFromView for non-views", () => {
    expect(diffFilesFromView(null)).toEqual([]);
    expect(diffFilesFromView({})).toEqual([]);
  });
});

describe("truncationNotice", () => {
  const noDisplay = {};

  it("returns an empty string when nothing is truncated", () => {
    expect(truncationNotice({}, "completed", { field: "diff", display: noDisplay })).toBe("");
    expect(truncationNotice({}, "completed", null)).toBe("");
  });

  it("uses the omitted notice first", () => {
    expect(
      truncationNotice({ omitted: true }, "completed", {
        display: { write: true },
        omitted: true,
      }),
    ).toBe("Result omitted; it exceeded the 256 KiB stream budget.");
  });

  it("uses live notices for running and pending parts", () => {
    expect(
      truncationNotice({ partial: true }, "running", { field: "diff", display: noDisplay }),
    ).toBe("Diff truncated for live view; the full result may load when the turn ends.");
    expect(
      truncationNotice({ partial: true }, "pending", {
        field: "write",
        serverFields: ["state.input.content"],
        display: noDisplay,
      }),
    ).toBe("Content truncated for live view; the full result may load when the turn ends.");
    expect(
      truncationNotice({ partial: true }, "running", {
        field: "output",
        serverFields: ["state.output"],
        display: noDisplay,
      }),
    ).toBe("Output truncated for live view; the full result may load when the turn ends.");
    expect(
      truncationNotice({ partial: true }, "running", { field: "read", display: noDisplay }),
    ).toBe("File content truncated for live view; the full result may load when the turn ends.");
  });

  it("uses snapshot notices for completed parts", () => {
    expect(
      truncationNotice({ sessionSnapshotTooLarge: true }, "completed", {
        field: "diff",
        display: noDisplay,
      }),
    ).toBe("Full diff unavailable; session snapshot exceeds 8 MiB.");
    expect(
      truncationNotice({}, "completed", {
        field: "write",
        sessionSnapshotTooLarge: true,
        display: noDisplay,
      }),
    ).toBe("Full content unavailable; session snapshot exceeds 8 MiB.");
    expect(
      truncationNotice({}, "completed", {
        field: "output",
        sessionSnapshotTooLarge: true,
        display: noDisplay,
      }),
    ).toBe("Full output unavailable; session snapshot exceeds 8 MiB.");
    expect(
      truncationNotice({}, "completed", {
        field: "read",
        sessionSnapshotTooLarge: true,
        display: noDisplay,
      }),
    ).toBe("Full file content unavailable; session snapshot exceeds 8 MiB.");
  });

  it("uses display flags in precedence order", () => {
    expect(truncationNotice({}, "completed", { field: "diff", display: { write: true } })).toBe(
      "Content truncated at 64 KiB.",
    );
    expect(truncationNotice({}, "completed", { field: "diff", display: { total: true } })).toBe(
      "Diff truncated at the 128 KiB total limit.",
    );
    expect(truncationNotice({}, "completed", { field: "diff", display: { perFile: true } })).toBe(
      "Diff truncated at 64 KiB per file.",
    );
    expect(truncationNotice({}, "completed", { field: "diff", display: { lines: true } })).toBe(
      "Diff truncated at 2,000 lines.",
    );
    expect(truncationNotice({}, "completed", { field: "write", display: { lines: true } })).toBe(
      "Content truncated at 2,000 lines.",
    );
    expect(
      truncationNotice({}, "completed", {
        field: "read",
        display: { write: true },
      }),
    ).toBe("File content truncated at 64 KiB.");
    expect(
      truncationNotice({}, "completed", {
        field: "read",
        display: { lines: true },
      }),
    ).toBe("File content truncated at 2,000 lines.");
    expect(truncationNotice({}, "completed", { field: "diff", display: { files: true } })).toBe(
      "Additional files omitted from the view.",
    );
  });

  it("maps server limits and fields", () => {
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["state.metadata.diff"],
        serverLimit: "per-file",
        display: noDisplay,
      }),
    ).toBe("Diff truncated at 64 KiB per file.");
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["state.metadata.filediff.patch"],
        serverLimit: "total",
        display: noDisplay,
      }),
    ).toBe("Diff truncated at the 128 KiB total limit.");
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["state.input.content"],
        serverLimit: "content",
        display: noDisplay,
      }),
    ).toBe("Content truncated at 64 KiB.");
    expect(
      truncationNotice({ truncated: true }, "completed", {
        field: "patch",
        serverFields: ["patch"],
        display: noDisplay,
      }),
    ).toBe("Patch truncated at 64 KiB.");
    expect(
      truncationNotice({ truncated: true }, "completed", {
        field: "output",
        serverFields: ["state.output"],
        display: noDisplay,
      }),
    ).toBe("Output truncated at 64 KiB.");
  });

  it("lets diff/content fields outrank output regardless of server field order", () => {
    expect(
      truncationNotice({}, "completed", {
        field: "output",
        serverFields: ["state.output", "state.metadata.diff"],
        serverLimit: "total",
        display: noDisplay,
      }),
    ).toBe("Diff truncated at the 128 KiB total limit.");
    expect(
      truncationNotice({}, "completed", {
        field: "output",
        serverFields: ["state.output", "state.input.content"],
        serverLimit: "content",
        display: noDisplay,
      }),
    ).toBe("Content truncated at 64 KiB.");
  });

  it("maps patchText to diff and the more sentinel to diff", () => {
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["state.input.patchText"],
        serverLimit: "total",
        display: noDisplay,
      }),
    ).toBe("Diff truncated at the 128 KiB total limit.");
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["more"],
        serverLimit: "per-file",
        display: noDisplay,
      }),
    ).toBe("Diff truncated at 64 KiB per file.");
  });

  it("maps metadata.files fields to diff", () => {
    for (const field of [
      "state.metadata.files[3].patch",
      "state.metadata.files.length",
      "state.metadata.files",
    ]) {
      expect(
        truncationNotice({}, "completed", {
          field: "diff",
          serverFields: [field],
          serverLimit: "total",
          display: noDisplay,
        }),
      ).toBe("Diff truncated at the 128 KiB total limit.");
    }
  });

  it("seeds display flags from serverLimit", () => {
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverLimit: "files",
        display: noDisplay,
      }),
    ).toBe("Additional files omitted from the view.");
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverLimit: "content",
        display: noDisplay,
      }),
    ).toBe("Content truncated at 64 KiB.");
  });

  it("lets display flags win over serverLimit", () => {
    expect(
      truncationNotice({}, "completed", {
        field: "diff",
        serverFields: ["state.metadata.diff"],
        serverLimit: "per-file",
        display: { total: true },
      }),
    ).toBe("Diff truncated at the 128 KiB total limit.");
  });

  it("falls back to the view field when serverFields is absent", () => {
    expect(
      truncationNotice({ truncated: true }, "completed", { field: "write", display: noDisplay }),
    ).toBe("Content truncated at 64 KiB.");
    expect(
      truncationNotice({ truncated: true }, "completed", { field: "patch", display: noDisplay }),
    ).toBe("Patch truncated at 64 KiB.");
    expect(
      truncationNotice({ truncated: true }, "completed", { field: "output", display: noDisplay }),
    ).toBe("Output truncated at 64 KiB.");
  });
});
