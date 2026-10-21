import http, { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { cookieToken, isHumanCookie } from "./auth.js";
import type { PageChrome, SiteModel } from "./dashboard.js";
import type { HttpDeps } from "./handler.js";
import { appShell, escapeHtml, icon, pageHeader, runtimePill } from "./ui.js";

function navProjects(site: SiteModel): Array<{ id: string; name: string; appCount: number }> {
  return site.projects.map((project) => ({
    id: project.id,
    name: project.name,
    appCount: project.apps.length,
  }));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = JSON.stringify({ error: message });
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
      "content-type: application/json; charset=utf-8",
      `content-length: ${Buffer.byteLength(payload)}`,
      "cache-control: no-store",
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  );
  socket.end();
}

/** Operator terminal page; only human principals reach this route. */
export function renderTerminalPage(
  site: SiteModel,
  projectId: string,
  appKey: string,
  chrome: PageChrome,
): string | undefined {
  const project = site.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) return undefined;
  const app = project.apps.find((candidate) => candidate.appKey === appKey);
  if (app === undefined) return undefined;

  const runtime = site.runtime.get(app.id) ?? "stopped";
  const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
  const wsPath = `/api/apps/${encodeURIComponent(app.appKey)}/terminal?project=${encodeURIComponent(project.id)}`;
  const header = pageHeader({
    overline: "Operator terminal",
    title: app.appKey,
    description: "Interactive shell attached to this application's managed container.",
    meta: [project.name, app.kind ?? "app", app.path],
    actions: `<a class="btn btn-secondary" href="${escapeHtml(appHref)}">${icon("terminal")}Application</a>`,
  });

  const body = `<section class="card terminal-card" id="terminal" data-terminal-ws="${escapeHtml(wsPath)}" data-app-key="${escapeHtml(app.appKey)}" data-project-id="${escapeHtml(project.id)}">
    <div class="card__head">
      <h2 class="card__title" id="terminal-title">Terminal</h2>
      <div class="cluster">
        ${runtimePill(runtime)}
        <span class="badge" id="terminal-status" role="status" aria-live="polite">Connecting</span>
        <button class="btn btn-secondary btn-sm" type="button" id="terminal-reconnect">${icon("refresh")}Reconnect</button>
        <button class="btn btn-ghost btn-sm" type="button" id="terminal-close">${icon("x")}Close</button>
      </div>
    </div>
    <div class="card__body terminal-card__body">
      <p class="small terminal-card__note">Operator shell in <span class="mono">${escapeHtml(app.appKey)}</span>. Closing this terminal does not stop the application.</p>
      <pre class="terminal" id="terminal-output" role="log" aria-live="polite" aria-label="Terminal output" tabindex="0"></pre>
      <textarea class="terminal__input" id="terminal-input" rows="1" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Terminal input" placeholder="Type to send input to the shell"></textarea>
      <p class="small terminal-card__note">Keys are sent to the shell. Use Ctrl+C to interrupt; resizing the window updates the PTY size.</p>
    </div>
  </section>`;

  return appShell({
    title: `${app.appKey} terminal`,
    active: "project",
    activeProjectId: project.id,
    breadcrumb: [
      { label: "Projects", href: "/projects" },
      { label: project.name, href: `/projects/${encodeURIComponent(project.id)}` },
      { label: app.appKey, href: appHref },
      { label: "Terminal" },
    ],
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    operatorName: chrome.operatorName,
    notice: chrome.notice,
    header,
    scripts: ["/assets/terminal.js"],
    body,
    settingsHref: `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`,
  });
}

/** Proxy an operator terminal WebSocket to the runner with the runtime bearer token. */
export async function proxyTerminalUpgrade(
  deps: HttpDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/api\/apps\/([^/]+)\/terminal$/.exec(parsed.pathname);
  if (match === null) {
    rejectSocket(socket, 404, "not found");
    return;
  }
  if ((request.method ?? "GET") !== "GET") {
    rejectSocket(socket, 405, "method not allowed");
    return;
  }
  if (!isHumanCookie(deps, request.headers.cookie)) {
    rejectSocket(
      socket,
      cookieToken(request.headers.cookie) === undefined ? 401 : 403,
      "forbidden",
    );
    return;
  }

  const projectId = parsed.searchParams.get("project");
  if (projectId === null || projectId.length === 0) {
    rejectSocket(socket, 400, "project query is required");
    return;
  }
  const appKey = safeDecode(match[1] ?? "");
  const app = deps.db
    .prepare("SELECT id FROM apps WHERE project_id = ? AND app_key = ?")
    .get(projectId, appKey) as { id: string } | undefined;
  if (app === undefined) {
    rejectSocket(socket, 404, "application not found");
    return;
  }

  const runner = deps.runner;
  if (runner === undefined || runner.url.trim().length === 0 || runner.token.length === 0) {
    rejectSocket(socket, 503, "terminal runner is not configured");
    return;
  }
  let upstream: URL;
  try {
    upstream = new URL(runner.url);
  } catch {
    rejectSocket(socket, 503, "terminal runner is not configured");
    return;
  }
  if (upstream.protocol !== "http:") {
    rejectSocket(socket, 503, "terminal runner must use http");
    return;
  }

  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (typeof key !== "string" || typeof version !== "string") {
    rejectSocket(socket, 400, "invalid websocket handshake");
    return;
  }

  await new Promise<void>((resolve) => {
    const upstreamRequest = http.request({
      host: upstream.hostname,
      port: upstream.port.length > 0 ? Number(upstream.port) : 80,
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(app.id)}/exec`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": version,
        authorization: `Bearer ${runner.token}`,
      },
    });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };

    upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      if (!socket.writable) {
        upstreamSocket.destroy();
        finish();
        return;
      }
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) {
          lines.push(`${name}: ${value}`);
        }
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      socket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      finish();
    });

    upstreamRequest.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (!socket.writable) {
          socket.destroy();
          finish();
          return;
        }
        const body = Buffer.concat(chunks);
        const lines = [
          `HTTP/1.1 ${response.statusCode ?? 502} ${
            STATUS_CODES[response.statusCode ?? 502] ?? "Error"
          }`,
        ];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            lines.push(`${name}: ${value}`);
          }
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        socket.write(body);
        socket.end();
        finish();
      });
      response.on("error", () => {
        socket.destroy();
        finish();
      });
    });

    upstreamRequest.on("error", () => {
      rejectSocket(socket, 502, "terminal runner is unavailable");
      finish();
    });
    upstreamRequest.end();
  });
}
