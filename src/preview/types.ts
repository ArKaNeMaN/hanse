/** Input accepted by `PreviewService.open`; the MCP layer supplies the app identity and target. */
export interface PreviewOpenInput {
  appId: string;
  projectId: string;
  appKey: string;
  key: string;
  name: string;
  port: number;
  targetHost: string;
}

/** A stored preview with absolute epoch-millisecond lifetimes. */
export interface PreviewRecord extends PreviewOpenInput {
  createdAt: number;
  expiresAt: number;
}

/** Public projection of a preview; timestamps are ISO strings. */
export interface PreviewView {
  key: string;
  name: string;
  port: number;
  url: string;
  basePath: string;
  basePathWithoutTrailingSlash: string;
  createdAt: string;
  expiresAt: string;
}

/** The latest human chat-page host for an app, normalized for framework allowlists. */
export interface PreviewOperatorHost {
  host: string;
  hostname: string;
}

/** The manager-facing lifecycle interface; the preview service implements it. */
export interface PreviewCleanup {
  clearApp(appId: string): void;
}

export type PreviewFailureCode =
  | "preview_invalid_key"
  | "preview_invalid_name"
  | "preview_invalid_port"
  | "preview_reserved_port"
  | "preview_limit"
  | "preview_app_not_running"
  | "preview_unavailable"
  | "preview_internal_error";

/** The `{code, message}` failure shape surfaced through the MCP envelope. */
export interface PreviewFailure {
  code: PreviewFailureCode;
  message: string;
}

/** A preview failure carrying a stable machine-readable code. */
export class PreviewError extends Error {
  readonly code: PreviewFailureCode;

  constructor(code: PreviewFailureCode, message: string) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
  }
}
