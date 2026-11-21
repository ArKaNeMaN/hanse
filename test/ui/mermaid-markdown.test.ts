import { afterEach, describe, expect, it } from "vitest";
import {
  frontmatterTitle,
  hasDiagramFence,
  renderMarkdown,
  setDiagramRenderer,
} from "../../assets/markdown.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>';

function fence(body = "flowchart LR\n  A-->B", language = "mermaid"): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function mount(
  text: string,
  options: { diagrams?: boolean; diagramDelayMs?: number } = {},
): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);
  renderMarkdown(node, text, { diagrams: true, ...options });
  return node;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  setDiagramRenderer(null);
  document.body.innerHTML = "";
});

describe("Mermaid markdown branch", () => {
  it("renders a sealed fence as an inert image and keeps the source", async () => {
    setDiagramRenderer(async () => SVG);
    const node = mount(fence("---\ntitle: Flow\n---\nflowchart LR\n  A-->B"));
    await settle();
    const frame = node.querySelector<HTMLElement>("[data-mermaid='ready']");
    expect(frame).not.toBeNull();
    const image = frame?.querySelector<HTMLImageElement>("img[data-mermaid-image]");
    expect(image?.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(image?.alt).toBe("Flow");
    expect(frame?.querySelector(".message__diagram-source pre")?.textContent).toContain(
      "flowchart LR",
    );
    expect(node.querySelector("pre + img")).toBeNull();
  });

  it("keeps the fence as code before the part is sealed", () => {
    setDiagramRenderer(async () => SVG);
    const node = mount(fence(), { diagrams: false });
    expect(node.querySelector("[data-mermaid]")).toBeNull();
    expect(node.querySelector("pre code")?.getAttribute("data-language")).toBe("mermaid");
  });

  it("rejects a source over the cap without calling the renderer", async () => {
    let calls = 0;
    setDiagramRenderer(async () => {
      calls += 1;
      return SVG;
    });
    const node = mount(fence("x".repeat(32_001)));
    await settle();
    expect(calls).toBe(0);
    expect(node.querySelector("[data-mermaid='too-large']")).not.toBeNull();
    expect(node.textContent).toContain("Diagram is too large to render.");
  });

  it("keeps the source and captions a renderer failure", async () => {
    setDiagramRenderer(async () => {
      throw new Error("boom");
    });
    const node = mount(fence());
    await settle();
    expect(node.querySelector("[data-mermaid='error']")).not.toBeNull();
    expect(node.querySelector(".message__diagram pre")?.textContent).toContain("flowchart LR");
    expect(node.textContent).toContain("Diagram could not be rendered.");
  });

  it("drops a stale render after the container is re-rendered", async () => {
    let resolve: ((svg: string) => void) | undefined;
    setDiagramRenderer(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const node = mount(fence());
    await settle();
    const oldFrame = node.querySelector("[data-mermaid='pending']");
    expect(oldFrame).not.toBeNull();
    node.replaceChildren();
    renderMarkdown(node, "after", { diagrams: true });
    resolve?.(SVG);
    await settle();
    expect(node.querySelector("[data-mermaid-image]")).toBeNull();
    expect(node.textContent).toContain("after");
  });

  it("keeps the first eight diagrams and captions the rest", async () => {
    let calls = 0;
    setDiagramRenderer(async () => {
      calls += 1;
      return SVG;
    });
    const node = mount(Array.from({ length: 9 }, () => fence()).join("\n\n"));
    await settle();
    expect(calls).toBe(8);
    expect(node.querySelectorAll("[data-mermaid='ready']")).toHaveLength(8);
    expect(node.querySelectorAll("[data-mermaid='too-many']")).toHaveLength(1);
    expect(node.textContent).toContain("Too many diagrams in this message; showing source.");
  });

  it("falls back to code when the renderer is unregistered", () => {
    setDiagramRenderer(null);
    const node = mount(fence());
    expect(node.querySelector("[data-mermaid]")).toBeNull();
    expect(node.querySelector("pre code")).not.toBeNull();
  });

  it("extracts the frontmatter title and recognizes the fence", () => {
    expect(frontmatterTitle("---\ntitle: Flow\n---\nflowchart LR")).toBe("Flow");
    expect(frontmatterTitle("---\ntitle: 'Quoted'\n---")).toBe("Quoted");
    expect(frontmatterTitle("flowchart LR")).toBeUndefined();
    expect(hasDiagramFence(fence())).toBe(true);
    expect(hasDiagramFence("```mermaid title\nA-->B\n```")).toBe(false);
  });
});
