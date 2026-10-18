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
  for (const project of deps.projects) {
    const app = project.service.listApps().find((candidate) => candidate.appKey === appKey);
    if (app !== undefined) {
      return { project, app };
    }
  }
  return undefined;
}

function renderChatPage(deps: HttpDeps, appKey: string | undefined): string {
  const apps = deps.projects.flatMap((project) =>
    project.service.listApps().map((app) => ({ key: app.appKey, project: project.name })),
  );
  const options = apps
    .map(
      (app) =>
        `<option value="${escapeHtml(app.key)}"${app.key === appKey ? " selected" : ""}>${escapeHtml(app.key)} (${escapeHtml(app.project)})</option>`,
    )
    .join("");
  const selected = appKey ? JSON.stringify(appKey) : "null";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>hanse chat</title>
<style>
body{font-family:ui-monospace,monospace;margin:0;background:#fafafa;color:#111}
header{padding:.6rem 1rem;border-bottom:1px solid #ddd;display:flex;gap:1rem;align-items:center}
main{display:grid;grid-template-columns:220px 1fr 300px;height:calc(100vh - 48px)}
aside,section{overflow:auto;border-right:1px solid #ddd;padding:.5rem}
#messages{flex:1;overflow:auto;padding:.5rem}
#messages .msg{margin:.4rem 0;padding:.4rem;border-radius:4px;white-space:pre-wrap}
#messages .user{background:#e8f0fe}
#messages .assistant{background:#fff;border:1px solid #eee}
#prompt{width:calc(100% - 80px);height:60px}
a{color:#0645ad}
.h{font-weight:bold;margin:.4rem 0}
.handoff{font-size:.8rem;margin:.2rem 0;padding:.2rem;border-left:3px solid #888}
</style></head><body>
<header><b>hanse</b> <a href="/">dashboard</a>
<select id="app" onchange="location.href='/chat?app='+encodeURIComponent(this.value)">${options || '<option value="">(no apps)</option>'}</select>
<span id="err" style="color:#b00020"></span></header>
<main>
<aside><div class="h">Sessions</div><div id="sessions"></div><button onclick="newSession()">+ new</button></aside>
<section style="display:flex;flex-direction:column"><div id="messages"></div><div><textarea id="prompt" placeholder="message..."></textarea><button id="send" onclick="send()">send</button></div></section>
<aside><div class="h">Handoffs</div><div id="handoffs"></div></aside>
</main>
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
    const div = document.createElement('div');
    div.textContent = s.title || s.id.slice(0, 10);
    div.style.cursor = 'pointer'; div.style.padding = '2px';
    if (s.id === sessionId) { div.style.background = '#ddd'; }
    div.onclick = () => { sessionId = s.id; loadMessages(); loadSessions(); };
    list.appendChild(div);
  }
  if (!sessionId && data.sessions.length > 0) { sessionId = data.sessions[0].id; }
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
    const div = document.createElement('div'); div.className = 'msg ' + role; div.textContent = text; box.appendChild(div);
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
    const div = document.createElement('div'); div.className = 'handoff';
    div.textContent = h.state + ' · ' + h.summary; box.appendChild(div);
  }
}
loadSessions().then(loadHandoffs).catch(showError);
</script></body></html>`;
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
