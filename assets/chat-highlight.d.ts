/**
 * Types for the shared highlight controller. The implementation stays a plain browser ESM module
 * that owns the module worker, the ready timer, and per-part view contexts.
 */

import type { ToolView } from "./chat-diff.js";

export interface MountToolViewOptions {
  partID?: string;
  viewKey?: string;
}

export interface HighlightStats {
  inflightStreams: number;
  reservedNodes: number;
  pageCommitted: number;
  pendingFiles: number;
  disabled: boolean;
  timeouts: number;
}

export function mountToolView(
  view: ToolView | null | undefined,
  options?: MountToolViewOptions,
): HTMLElement | null;

export function setToolViewOpen(
  partID: string,
  viewKey: string,
  view: ToolView | null | undefined,
  body: HTMLElement | null,
  open: boolean,
): boolean;

export function resetHighlightController(options?: { partID?: string; reason?: string }): void;

/** Route-level teardown owner: terminates the worker and returns all module state to baseline. */
export function disposeHighlightController(): void;

export function getHighlightStats(): HighlightStats;
export function isHighlightEligible(language: string | null | undefined, kind: string): boolean;
