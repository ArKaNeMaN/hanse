import { authenticate } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import { createSession, listMessages, listSessions, sendPrompt } from "../opencode/client.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function html(status: number, body: string): HttpResponse {
  return { status, contentType: "text/html; charset=utf-8", body };
}

function redirect(location: string): HttpResponse {
  return { status: 303, contentType: "text/plain", body: "", headers: { location } };
}

function cookieValue(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === "hanse_token" && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function principalFrom(deps: HttpDeps, request: HttpRequest): Principal | undefined {
  const token =
    request.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ??
    cookieValue(request.headers.cookie);
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  try {
    return authenticate(deps.db, `Bearer ${token}`);
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findApp(deps: HttpDeps, appKey: string) {
  for (const project of deps.getProjects()) {
    const app = project.service.listApps().find((candidate) => candidate.appKey === appKey);
    if (app !== undefined) {
      return { project, app };
    }
  }
  return undefined;
}

function renderChatPage(deps: HttpDeps, appKey: string | undefined): string {
  const apps = deps
    .getProjects()
    .flatMap((project) =>
      project.service.listApps().map((app) => ({ key: app.appKey, project: project.name })),
    );
  const options = apps
    .map(
      (app) =>
        `<option value="${escapeHtml(app.key)}"${app.key === appKey ? " selected" : ""}>${escapeHtml(app.key)} (${escapeHtml(app.project)})</option>`,
    )
    .join("");
  const selected = appKey ? JSON.stringify(appKey) : "null";
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>hanse chat</title><link rel="stylesheet" href="/assets/app.css"></head>
<body class="flex h-screen flex-col bg-base-100 text-base-content">
<div class="navbar min-h-12 border-b border-base-300 bg-base-200 px-4"><div class="flex flex-1 items-center gap-3"><span class="text-lg font-semibold tracking-tight">hanse</span><a class="btn btn-xs btn-ghost" href="/">dashboard</a><select id="app" class="select select-bordered select-xs" onchange="location.href='/chat?app='+encodeURIComponent(this.value)">${options || '<option value="">(no apps)</option>'}</select></div><div class="flex-none"><span id="err" class="text-xs text-error"></span></div></div>
<div class="flex min-h-0 flex-1 overflow-hidden">
<aside class="w-56 overflow-auto border-r border-base-300 p-2"><div class="mb-1 flex items-center justify-between px-1"><span class="text-xs font-semibold uppercase opacity-60">Sessions</span><button class="btn btn-xs btn-ghost" onclick="newSession()">+</button></div><div id="sessions" class="space-y-1"></div></aside>
<section class="flex min-w-0 flex-1 flex-col"><div id="messages" class="flex-1 space-y-2 overflow-auto p-3"></div><div class="flex items-end gap-2 border-t border-base-300 p-2"><textarea id="prompt" class="textarea textarea-bordered textarea-sm h-16 flex-1" placeholder="message..."></textarea><button id="send" class="btn btn-primary btn-sm" onclick="send()">send</button></div></section>
<aside class="w-64 overflow-auto border-l border-base-300 p-2"><div class="mb-1 px-1 text-xs font-semibold uppercase opacity-60">Handoffs</div><div id="handoffs" class="space-y-1"></div></aside>
</div>
<script>
const APP = ${selected};
const $ = (id) => document.getElementById(id);
async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(await r.text()); return r.json(); }
let sessionId = null;
function showError(e) { $('err').textContent = String(e && e.message ? e.message : e); }
async function newSession() {
  if (!APP) return;
  const s = await j('/api/apps/' + encodeURIComponent(APP) + '/sessions', { method: 'POST' });
  sessionId = s.id; await loadSessions();
}
async function loadSessions() {
  if (!APP) return;
  const data = await j('/api/apps/' + encodeURIComponent(APP) + '/sessions');
  const list = $('sessions'); list.innerHTML = '';
  for (const s of data.sessions) {
    const b = document.createElement('button');
    b.className = 'btn btn-xs btn-ghost w-full justify-start' + (s.id === sessionId ? ' btn-active' : '');
    b.textContent = s.title || s.id.slice(0, 10);
    b.onclick = () => { sessionId = s.id; loadMessages(); loadSessions(); };
    list.appendChild(b);
  }
  if (!sessionId && data.sessions.length > 0) sessionId = data.sessions[0].id;
  if (data.sessions.length === 0) { await newSession(); return; }
  await loadMessages();
}
async function loadMessages() {
  if (!APP || !sessionId) return;
  const data = await j('/api/apps/' + encodeURIComponent(APP) + '/sessions/' + encodeURIComponent(sessionId) + '/messages');
  const box = $('messages'); box.innerHTML = '';
  for (const m of data.messages) {
    const role = m.info.role;
    const text = (m.parts || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('\\n');
    if (!text) continue;
    const wrap = document.createElement('div');
    wrap.className = 'chat ' + (role === 'user' ? 'chat-end' : 'chat-start');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble text-sm' + (role === 'user' ? ' chat-bubble-primary' : '');
    bubble.textContent = text;
    wrap.appendChild(bubble); box.appendChild(wrap);
  }
  box.scrollTop = box.scrollHeight;
}
async function send() {
  if (!APP || !sessionId) return;
  const input = $('prompt'); const text = input.value.trim(); if (!text) return;
  input.value = ''; $('send').disabled = true; $('err').textContent = '';
  try {
    await j('/api/apps/' + encodeURIComponent(APP) + '/sessions/' + encodeURIComponent(sessionId) + '/messages', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) });
    await loadMessages();
  } catch (e) { showError(e); } finally { $('send').disabled = false; }
}
async function loadHandoffs() {
  const data = await j('/api/handoffs');
  const box = $('handoffs'); box.innerHTML = '';
  for (const h of data.handoffs.filter(h => h.fromAppId.endsWith(':' + APP) || h.toAppId.endsWith(':' + APP))) {
    const d = document.createElement('div');
    d.className = 'rounded border border-base-300 bg-base-200 p-2 text-xs';
    d.textContent = h.state + ' · ' + h.summary;
    box.appendChild(d);
  }
}
loadSessions().then(loadHandoffs).catch(showError);
setInterval(() => { loadHandoffs().catch(() => {}); }, 5000);
</script>
</body></html>`;
}

export async function handleChat(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const principal = principalFrom(deps, request);

  if (request.method === "GET" && request.path === "/chat") {
    if (principal === undefined) {
      return redirect("/login");
    }
    return html(200, renderChatPage(deps, request.query?.app));
  }

  const sessionsMatch = /^\/api\/apps\/([^/]+)\/sessions$/.exec(request.path);
  const messagesMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(request.path);
  if (sessionsMatch === null && messagesMatch === null) {
    return json(404, { error: "not found" });
  }
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (deps.manager === undefined) {
    return json(503, { error: "agent runtime is not configured" });
  }

  const appKey = decodeURIComponent((sessionsMatch ?? messagesMatch)?.[1] ?? "");
  const found = findApp(deps, appKey);
  if (found === undefined) {
    return json(404, { error: `unknown application: ${appKey}` });
  }
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure({
      id: found.app.id,
      projectId: found.project.id,
      appKey: found.app.appKey,
      appDir: found.app.path.startsWith("/")
        ? found.app.path
        : `${found.project.rootPath}/${found.app.path}`,
    });
  } catch (error) {
    return json(502, {
      error: `agent failed to start: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    if (sessionsMatch !== null) {
      if (request.method === "GET") {
        return json(200, { sessions: await listSessions(endpoint) });
      }
      if (request.method === "POST") {
        return json(200, await createSession(endpoint));
      }
    }
    if (messagesMatch !== null && request.method === "GET") {
      const sessionId = decodeURIComponent(messagesMatch[2] ?? "");
      return json(200, { messages: await listMessages(endpoint, sessionId) });
    }
    if (messagesMatch !== null && request.method === "POST") {
      const sessionId = decodeURIComponent(messagesMatch[2] ?? "");
      const body = JSON.parse(request.body ?? "{}") as { text?: string };
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length === 0) {
        return json(400, { error: "empty message" });
      }
      return json(200, { message: await sendPrompt(endpoint, sessionId, text) });
    }
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
  return json(405, { error: "method not allowed" });
}
