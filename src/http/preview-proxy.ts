import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { PreviewRecord } from "../preview/types.js";
import type { HttpDeps } from "./handler.js";

export interface PreviewTarget {
  host: string;
  port: number;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_REQUEST_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "clear-site-data",
  "service-worker-allowed",
  "strict-transport-security",
  "alt-svc",
  "report-to",
  "reporting-endpoints",
  "nel",
  "www-authenticate",
]);

const ALLOWED_UPGRADE_RESPONSE_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

const MAX_UPGRADE_HEADER_BYTES = 64 * 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The canonical preview base path, always ending with a single trailing slash. */
export function basePathFor(preview: Pick<PreviewRecord, "projectId" | "appKey" | "key">): string {
  return `/preview/${encodeURIComponent(preview.projectId)}/${encodeURIComponent(
    preview.appKey,
  )}/${encodeURIComponent(preview.key)}/`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Prefix a single-slash root-relative `Location` with the preview base path.
 *
 * Query and fragment are preserved verbatim; the path is prefixed only at a segment boundary so a
 * sibling preview (`/preview/p/a/k2`) is never mistaken for this preview's base.
 */
export function rewritePreviewLocation(location: string, basePath: string): string {
  if (location.startsWith("/") === false || location.startsWith("//")) {
    return location;
  }
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const baseWithoutSlash = base.slice(0, -1);

  const queryIndex = location.indexOf("?");
  const fragmentIndex = location.indexOf("#");
  let splitIndex = -1;
  if (queryIndex >= 0 && fragmentIndex >= 0) {
    splitIndex = Math.min(queryIndex, fragmentIndex);
  } else if (queryIndex >= 0) {
    splitIndex = queryIndex;
  } else if (fragmentIndex >= 0) {
    splitIndex = fragmentIndex;
  }
  const pathname = splitIndex >= 0 ? location.slice(0, splitIndex) : location;
  const suffix = splitIndex >= 0 ? location.slice(splitIndex) : "";

  if (pathname === baseWithoutSlash || pathname.startsWith(base)) {
    return location;
  }
  return `${base}${pathname.slice(1)}${suffix}`;
}

/** Copy request headers while stripping credentials and hop-by-hop headers; add forwarding hints. */
export function filterPreviewRequestHeaders(
  headers: IncomingHttpHeaders,
  basePath: string,
): http.OutgoingHttpHeaders {
  const filtered: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = name.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    filtered[lower] = value;
  }

  const host = firstHeader(headers.host);
  if (host !== undefined && host.length > 0) {
    filtered["x-forwarded-host"] = host;
  }
  filtered["x-forwarded-prefix"] = basePath;
  filtered["x-forwarded-proto"] = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  return filtered;
}

/**
 * Copy response headers while dropping origin-wide and hop-by-hop headers; rewrite a relative
 * `Location` into the preview base path.
 */
export function filterPreviewResponseHeaders(
  headers: IncomingHttpHeaders,
  basePath: string,
): http.OutgoingHttpHeaders {
  const filtered: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    filtered[lower] = value;
  }

  const location = headers.location;
  if (typeof location === "string") {
    filtered.location = rewritePreviewLocation(location, basePath);
  }
  return filtered;
}

function standalonePage(title: string, body: string, action = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e6e8eb; font-family: system-ui, -apple-system, sans-serif; }
main { max-width: 32rem; padding: 2rem; }
h1 { margin: 0 0 0.75rem; font-size: 1.25rem; font-weight: 600; }
p { margin: 0; color: #a4abb6; line-height: 1.5; }
a { color: #8ab4f8; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${body}</p>
${action}
</main>
</body>
</html>
`;
}

/** Minimal standalone 404 page for an unknown, expired, or mismatched preview. */
export function previewNotFoundPage(): string {
  return standalonePage(
    "Preview not found",
    "This preview has expired or was closed. Open it again from the agent's message.",
  );
}

/** Minimal standalone 502 page for a preview whose dev server is not answering. */
export function previewUnavailablePage(): string {
  return standalonePage(
    "Preview unavailable",
    "The dev server is not responding. Start it in the agent, then reload.",
    '<p><a href="">Reload</a></p>',
  );
}

/** Reject a WebSocket upgrade with a bare status line and close the client socket. */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.end();
}

function resolvePreviewTarget(
  preview: PreviewRecord,
  resolveTarget?: (preview: PreviewRecord) => PreviewTarget,
): PreviewTarget {
  if (resolveTarget !== undefined) {
    return resolveTarget(preview);
  }
  return { host: preview.targetHost, port: preview.port };
}

/**
 * Proxy an authenticated preview HTTP request to the app container.
 *
 * The full `/preview/...` path and query are forwarded unchanged; both bodies stream. Credential
 * and origin-wide response headers are filtered. A `101` on the normal path is never forwarded.
 */
export function proxyPreviewHttp(
  _deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  preview: PreviewRecord,
  resolveTarget?: (preview: PreviewRecord) => PreviewTarget,
): void {
  const target = resolvePreviewTarget(preview, resolveTarget);
  const basePath = basePathFor(preview);

  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.url ?? "/",
      headers: filterPreviewRequestHeaders(request.headers, basePath),
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        filterPreviewResponseHeaders(upstreamResponse.headers, basePath),
      );
      upstreamResponse.on("error", () => {
        if (response.headersSent) {
          response.destroy();
        }
      });
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("upgrade", (_upstreamResponse, upstreamSocket) => {
    upstreamSocket.destroy();
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      response.end(previewUnavailablePage());
      return;
    }
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  });

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      response.end(previewUnavailablePage());
      return;
    }
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  });

  request.on("aborted", () => upstream.destroy());
  request.on("error", () => upstream.destroy());
  request.on("close", () => {
    if (!request.complete) {
      upstream.destroy();
    }
  });
  response.on("close", () => {
    if (!response.writableEnded) {
      upstream.destroy();
    }
  });
  request.pipe(upstream);
}

interface ParsedUpgradeResponse {
  status: number;
  headers: string[];
}

function parseUpgradeResponse(headerBlock: string): ParsedUpgradeResponse | undefined {
  const lines = headerBlock.split("\r\n");
  const statusLine = lines[0];
  if (statusLine === undefined) {
    return undefined;
  }
  const statusMatch = /^HTTP\/\d\.\d (\d{3})(?: .*)?$/.exec(statusLine);
  if (statusMatch === null || statusMatch[1] === undefined) {
    return undefined;
  }
  const status = Number.parseInt(statusMatch[1], 10);
  const headers: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) {
      continue;
    }
    // Reject obs-fold continuations and any stray CR/LF inside a header line.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      return undefined;
    }
    if (line.includes("\r") || line.includes("\n")) {
      return undefined;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return undefined;
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      return undefined;
    }
    const lower = name.toLowerCase();
    if (!ALLOWED_UPGRADE_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    headers.push(`${lower}: ${value}`);
  }
  return { status, headers };
}

/**
 * Proxy a WebSocket upgrade to the app container.
 *
 * The upstream handshake is buffered up to a 64 KiB cap and parsed; only a filtered `101` is
 * forwarded, and the response header block is regenerated from an allowlist. Unfiltered upstream
 * bytes never reach the client.
 */
export function proxyPreviewUpgrade(
  _deps: HttpDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  preview: PreviewRecord,
  resolveTarget?: (preview: PreviewRecord) => PreviewTarget,
): void {
  const target = resolvePreviewTarget(preview, resolveTarget);
  const upstream = net.connect(target.port, target.host);
  let buffered = Buffer.alloc(0);
  let decided = false;

  const fail = (): void => {
    if (decided) {
      return;
    }
    decided = true;
    upstream.destroy();
    rejectUpgrade(socket, 502, "Bad Gateway");
  };

  upstream.on("connect", () => {
    const lines = [
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion ?? "1.1"}`,
    ];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name === undefined || value === undefined) {
        continue;
      }
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) {
        continue;
      }
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
  });

  const onData = (chunk: Buffer): void => {
    if (decided) {
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const delimiter = buffered.indexOf("\r\n\r\n");
    if (delimiter === -1) {
      if (buffered.length > MAX_UPGRADE_HEADER_BYTES) {
        upstream.removeListener("data", onData);
        fail();
      }
      return;
    }
    if (delimiter > MAX_UPGRADE_HEADER_BYTES) {
      upstream.removeListener("data", onData);
      fail();
      return;
    }

    const parsed = parseUpgradeResponse(buffered.subarray(0, delimiter).toString("latin1"));
    if (parsed === undefined || parsed.status !== 101) {
      upstream.removeListener("data", onData);
      fail();
      return;
    }

    decided = true;
    upstream.removeListener("data", onData);
    upstream.pause();

    const remainder = buffered.subarray(delimiter + 4);
    const responseLines = ["HTTP/1.1 101 Switching Protocols", ...parsed.headers];
    socket.write(`${responseLines.join("\r\n")}\r\n\r\n`);
    if (remainder.length > 0) {
      socket.write(remainder);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  };

  upstream.on("data", onData);
  upstream.on("end", () => {
    if (!decided) {
      fail();
    }
  });
  upstream.on("error", () => {
    if (!decided) {
      fail();
      return;
    }
    socket.destroy();
  });
}
