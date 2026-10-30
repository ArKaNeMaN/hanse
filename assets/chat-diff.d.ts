/**
 * Types for the shared diff/highlight view builders. The implementation stays a plain browser ESM
 * module so the SPA and the frozen legacy client share one cap/highlight contract.
 */

export interface ToolViewFile {
  path?: string;
  oldPath?: string;
  newPath?: string;
  type?: string;
  binary?: boolean;
  headerOnly?: boolean;
  additions?: number;
  deletions?: number;
  language?: string | null;
  patch?: string;
  content?: string;
  contentTruncated?: boolean;
  truncated?: boolean;
  hunks?: Array<{ header?: string; lines?: Array<{ kind?: string; text?: string }> }>;
  lines?: Array<{ number?: number; text?: string }>;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number | null;
  statusLine?: string;
  [key: string]: unknown;
}

export interface ToolView {
  kind: string;
  field?: string;
  text?: string;
  files?: ToolViewFile[];
  diagnostics?: string;
  filesTruncated?: boolean;
  display?: Record<string, boolean>;
  [key: string]: unknown;
}

export function extractToolView(
  data: Record<string, unknown>,
  tool: string,
  status: string,
): ToolView | null;
export function patchPartView(data: Record<string, unknown>): ToolView;
export function diffFilesFromView(view: ToolView | null | undefined): ToolViewFile[];
export function allocateView(view: ToolView, options?: Record<string, number>): ToolView;
export function truncationNotice(
  part: Record<string, unknown>,
  status: string,
  view: ToolView | null | undefined,
): string;

export const MAX_DIFF_DISPLAY_BYTES: number;
export const MAX_DIFF_DISPLAY_TOTAL_BYTES: number;
export const MAX_WRITE_DISPLAY_BYTES: number;
export const MAX_READ_DISPLAY_BYTES: number;
export const MAX_RENDERED_LINES: number;
export const MAX_DIFF_FILES: number;
