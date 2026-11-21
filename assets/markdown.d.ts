/**
 * Types for the shared browser Markdown renderer. The implementation stays a plain browser ESM
 * module so legacy pages and the Vue client both use the same `textContent`-only DOM builder.
 */

export function element(tag: string, className?: string, text?: string): HTMLElement;

export interface RenderMarkdownOptions {
  /** Enable ```mermaid fences when a diagram renderer is registered. Defaults to false. */
  diagrams?: boolean;
  /** Delay before asking the diagram renderer (typing coalescing). Defaults to 0. */
  diagramDelayMs?: number;
}

export type DiagramRenderer = (source: string, isCancelled?: () => boolean) => Promise<string> | null;

export function setDiagramRenderer(renderer: DiagramRenderer | null): void;
export function hasDiagramRenderer(): boolean;
export function hasDiagramFence(text: string): boolean;
export function frontmatterTitle(text: string): string | undefined;
export function renderMarkdown(container: Element, text: string, options?: RenderMarkdownOptions): void;
