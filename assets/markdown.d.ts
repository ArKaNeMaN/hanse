/**
 * Types for the shared browser Markdown renderer. The implementation stays a plain browser ESM
 * module so legacy pages and the Vue client both use the same `textContent`-only DOM builder.
 */

export function element(tag: string, className?: string, text?: string): HTMLElement;

export function renderMarkdown(container: Element, text: string): void;
