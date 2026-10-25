const vscode = require("vscode");
const http = require("http");
const os = require("os");
const path = require("path");

const API_URL = new URL(process.env.HANSE_API_BASE || "http://127.0.0.1:8787");
const API_HOST = API_URL.hostname;
const API_PORT = Number(API_URL.port || (API_URL.protocol === "https:" ? 443 : 80));
const TOKEN = process.env.HANSE_OPERATOR_TOKEN || "";

/** The IDE extension reads the same 30-message tail as the web client. */
const HISTORY_LIMIT = 30;
/** Bounded post-202 read schedule; total wait is about 30 s and then it stops. */
const RECOVERY_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000];
const THUMBNAIL_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      authorization: `Bearer ${TOKEN}`,
    };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const request = http.request(
      { host: API_HOST, port: API_PORT, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = text;
          if (text.length > 0) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            data,
          });
        });
      },
    );
    request.on("error", reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

function api(path, method, body) {
  return apiRequest(method, path, body).then((response) => response.data);
}

function apiBinary(path) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        path,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_BINARY_BYTES) {
            request.destroy(new Error("attachment is too large to download"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            data: Buffer.concat(chunks),
          });
        });
      },
    );
    request.setTimeout(60_000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function responseError(response, fallback) {
  const data = response.data;
  let message = fallback;
  if (typeof data === "string" && data.length > 0) {
    message = data;
  } else if (data !== null && typeof data === "object") {
    if (typeof data.error === "string" && data.error.length > 0) {
      message = data.error;
    } else if (typeof data.message === "string" && data.message.length > 0) {
      message = data.message;
    }
  }
  const error = new Error(message);
  error.status = response.status;
  if (data !== null && typeof data === "object" && typeof data.code === "string") {
    error.code = data.code;
  }
  return error;
}

function messagesBase(app, sessionId) {
  return `/api/apps/${encodeURIComponent(app)}/sessions/${encodeURIComponent(sessionId)}/messages`;
}

function messagesPath(app, sessionId, before) {
  const base = `${messagesBase(app, sessionId)}?limit=${HISTORY_LIMIT}`;
  return before === undefined || before === null
    ? base
    : `${base}&before=${encodeURIComponent(before)}`;
}

function sendPath(app, sessionId, asyncSend) {
  return `${messagesBase(app, sessionId)}${asyncSend ? "?async=1" : ""}`;
}

async function fetchMessagesPage(app, sessionId, before) {
  const response = await apiRequest("GET", messagesPath(app, sessionId, before));
  if (response.status < 200 || response.status >= 300) {
    throw responseError(response, "could not load messages");
  }
  const data =
    response.data !== null && typeof response.data === "object" ? response.data : undefined;
  const messages = data !== undefined && Array.isArray(data.messages) ? data.messages : [];
  const nextCursor =
    data !== undefined && typeof data.nextCursor === "string" && data.nextCursor.length > 0
      ? data.nextCursor
      : null;
  return { messages, nextCursor };
}

function hostApiPath(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let url;
  try {
    url = new URL(value, API_URL);
  } catch {
    return undefined;
  }
  if (url.origin !== API_URL.origin) return undefined;
  if (!url.pathname.startsWith("/api/apps/")) return undefined;
  return `${url.pathname}${url.search}`;
}

function safeDownloadName(value) {
  const name = typeof value === "string" && value.length > 0 ? value : "attachment";
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "attachment";
}

function visibleTextPart(part) {
  const data = part.data !== null && typeof part.data === "object" ? part.data : part;
  if (typeof data.text === "string") return data.text.trim().length > 0;
  if (typeof part.text === "string") return part.text.trim().length > 0;
  return false;
}

/** Whether the turn after this user message already produced visible assistant text. */
function recoveryState(messages, messageID) {
  const index = messages.findIndex(
    (message) => message !== null && typeof message === "object" && message.info?.id === messageID,
  );
  if (index < 0) return { seen: false, done: false };
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (message === null || typeof message !== "object") continue;
    if (message.info?.role !== "assistant") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (parts.some((part) => part !== null && typeof part === "object" && visibleTextPart(part))) {
      return { seen: true, done: true };
    }
  }
  return { seen: true, done: false };
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:dark}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);margin:0;padding:6px;font-size:12px}
#tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
#tabs button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px}
#tabs button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
#older{display:block;width:100%;margin-bottom:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px}
#older[hidden]{display:none}
#messages{height:calc(100vh - 176px);overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
.msg{margin:4px 0}
.msg.user{opacity:.85}
.attachments{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;white-space:normal}
.attachment-card{display:flex;gap:6px;align-items:center;max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px;background:var(--vscode-editorWidget-background)}
.attachment-card[data-state=missing]{opacity:.6}
.attachment-card__preview{width:32px;height:32px;flex:0 0 32px;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:3px;background:var(--vscode-input-background)}
.attachment-card__thumb{width:32px;height:32px;object-fit:cover}
.attachment-card__kind{font-size:9px;text-transform:uppercase;opacity:.8}
.attachment-card__body{min-width:0;display:flex;flex-direction:column}
.attachment-card__name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.attachment-card__meta{font-size:10px;opacity:.7;white-space:nowrap}
.attachment-card__action{border:0;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.attachment-card__unavailable{font-size:10px;opacity:.7}
#status{color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:4px;min-height:14px}
#input{width:100%;height:52px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px;box-sizing:border-box}
#send{margin-top:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:3px 10px;cursor:pointer;width:100%}
#err{color:var(--vscode-errorForeground);font-size:11px;margin-top:4px}
</style></head><body>
<div id="tabs"></div>
<button id="older" type="button" hidden>Load older messages</button>
<div id="messages"></div>
<div id="status"></div>
<textarea id="input" placeholder="message..."></textarea>
<button id="send">send</button>
<div id="err"></div>
<script>
const vscode = acquireVsCodeApi();
const THUMB_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let apps = [];
let current = null;
let sessionId = null;
let nextCursor = null;
let olderBusy = false;
let renderedIds = new Set();
const thumbURLs = new Map();
const thumbRequested = new Set();
function post(message) { vscode.postMessage(message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function partData(part) { const data = record(part.data); return data === null ? part : data; }
function partText(part) {
  const data = partData(part);
  if (typeof data.text === 'string') return data.text;
  return typeof part.text === 'string' ? part.text : '';
}
function isSyntheticPart(part) {
  return part.synthetic === true || partData(part).synthetic === true;
}
function isManifestPart(part) {
  if (!isSyntheticPart(part)) return false;
  const metadata = record(partData(part).metadata) || record(part.metadata);
  return metadata !== null && metadata.hanse === 'attachment-manifest';
}
function isSyntheticReadPart(part) {
  if (!isSyntheticPart(part)) return false;
  return partText(part).trim().indexOf('Called the Read tool') === 0;
}
function isHiddenPart(part) { return isManifestPart(part) || isSyntheticReadPart(part); }
function isThumbMime(value) {
  if (typeof value !== 'string') return false;
  return THUMB_MIMES.indexOf(value.split(';')[0].trim().toLowerCase()) >= 0;
}
function attachmentKindFor(mime, kind) {
  if (kind === 'image') return isThumbMime(mime) ? 'image' : 'file';
  if (kind === 'video' || kind === 'pdf' || kind === 'file') return kind;
  const value = typeof mime === 'string' ? mime.toLowerCase() : '';
  if (isThumbMime(value)) return 'image';
  if (value.indexOf('video/') === 0) return 'video';
  if (value === 'application/pdf') return 'pdf';
  return 'file';
}
function safeURL(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (url.length === 0) return null;
  const lower = url.toLowerCase();
  if (lower.indexOf('data:') === 0 || lower.indexOf('javascript:') === 0 || lower.indexOf('blob:') === 0) return null;
  if (url.charAt(0) === '/' && url.charAt(1) !== '/') return url;
  if (lower.indexOf('https://') === 0 || lower.indexOf('http://') === 0) return url;
  return null;
}
function formatSize(value) {
  const bytes = typeof value === 'number' && isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size = size / 1024; index += 1; }
  return (index === 0 && size < 10 ? size.toFixed(1) : Math.round(size)) + ' ' + units[index];
}
function normalizeAttachment(raw) {
  const value = record(raw);
  if (value === null) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  const mime = typeof value.mime === 'string' ? value.mime : '';
  const size = typeof value.size === 'number' && isFinite(value.size) ? Math.max(0, value.size) : 0;
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : 'Attachment',
    mime: mime,
    size: size,
    kind: attachmentKindFor(mime, value.kind),
    state: typeof value.state === 'string' ? value.state : 'sent',
    downloadURL: safeURL(value.downloadURL),
    inline: value.inline === true,
  };
}
function collectAttachments(message) {
  const byId = new Map();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const attachment = normalizeAttachment(raw);
      if (attachment !== null) byId.set(attachment.id, attachment);
    }
  };
  const info = record(message.info);
  const hanse = info === null ? null : record(info.hanse);
  add(hanse === null ? undefined : hanse.attachments);
  add(message.attachments);
  return Array.from(byId.values());
}
function fileCards(message) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const cards = [];
  const ids = new Set();
  for (let index = 0; index < parts.length; index += 1) {
    const part = record(parts[index]);
    if (part === null || part.type !== 'file') continue;
    const data = partData(part);
    const attachment = record(data.attachment);
    const id = attachment !== null && typeof attachment.id === 'string' ? attachment.id : 'part-' + index;
    if (ids.has(id)) continue;
    ids.add(id);
    const mime = typeof data.mime === 'string' ? data.mime : (typeof part.mime === 'string' ? part.mime : '');
    const name = typeof data.filename === 'string' && data.filename.length > 0
      ? data.filename
      : (typeof data.name === 'string' && data.name.length > 0 ? data.name : 'Attachment');
    const url = typeof data.url === 'string' ? data.url : (typeof part.url === 'string' ? part.url : '');
    const size = attachment !== null && typeof attachment.size === 'number' && isFinite(attachment.size)
      ? Math.max(0, attachment.size)
      : 0;
    cards.push({
      key: 'file:' + id,
      name: name,
      mime: mime,
      size: size,
      kind: attachmentKindFor(mime, attachment === null ? undefined : attachment.kind),
      state: 'sent',
      downloadURL: safeURL(url),
    });
  }
  return { cards: cards, ids: ids };
}
function messageCards(message) {
  const files = fileCards(message);
  const attachments = collectAttachments(message);
  for (const attachment of attachments) {
    if (attachment.inline || files.ids.has(attachment.id)) continue;
    files.cards.push({
      key: 'att:' + attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      kind: attachment.kind,
      state: attachment.state,
      downloadURL: attachment.downloadURL,
    });
  }
  return files.cards;
}
function visibleText(message) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && !isHiddenPart(part))
    .map((part) => partText(part))
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .join('\\n');
}
function updateThumbnails(key) {
  const images = document.querySelectorAll('img[data-thumb-key]');
  for (const image of images) {
    if (image.dataset.thumbKey !== key) continue;
    const url = thumbURLs.get(key);
    if (typeof url === 'string') {
      image.src = url;
      image.removeAttribute('data-thumb-pending');
    }
  }
}
function requestThumbnail(card) {
  if (thumbURLs.has(card.key) || thumbRequested.has(card.key)) return;
  if (card.kind !== 'image' || !isThumbMime(card.mime) || card.downloadURL === null) return;
  thumbRequested.add(card.key);
  post({ type: 'thumbnail', key: card.key, mime: card.mime, downloadURL: card.downloadURL });
}
function buildAttachmentCard(card) {
  const article = document.createElement('article');
  article.className = 'attachment-card';
  article.dataset.kind = card.kind;
  article.dataset.state = card.state;
  const preview = document.createElement('div');
  preview.className = 'attachment-card__preview';
  if (card.kind === 'image' && isThumbMime(card.mime) && card.downloadURL !== null) {
    const image = document.createElement('img');
    image.className = 'attachment-card__thumb';
    image.alt = card.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.dataset.thumbKey = card.key;
    const cached = thumbURLs.get(card.key);
    if (typeof cached === 'string') image.src = cached;
    else image.setAttribute('data-thumb-pending', '');
    preview.appendChild(image);
    requestThumbnail(card);
  } else {
    const kind = document.createElement('span');
    kind.className = 'attachment-card__kind';
    kind.textContent = card.kind;
    preview.appendChild(kind);
  }
  const body = document.createElement('div');
  body.className = 'attachment-card__body';
  const name = document.createElement('span');
  name.className = 'attachment-card__name';
  name.textContent = card.name;
  name.title = card.name;
  const meta = document.createElement('span');
  meta.className = 'attachment-card__meta';
  meta.textContent = formatSize(card.size) + (card.mime ? ' · ' + card.mime : '');
  body.appendChild(name);
  body.appendChild(meta);
  article.appendChild(preview);
  article.appendChild(body);
  if (card.state === 'missing') {
    const unavailable = document.createElement('span');
    unavailable.className = 'attachment-card__unavailable';
    unavailable.textContent = 'Unavailable';
    article.appendChild(unavailable);
  } else if (card.downloadURL !== null) {
    const download = document.createElement('button');
    download.className = 'attachment-card__action';
    download.type = 'button';
    download.textContent = 'Download';
    download.onclick = () => post({
      type: 'download',
      downloadURL: card.downloadURL,
      name: card.name,
    });
    article.appendChild(download);
  }
  return article;
}
function messageKey(message) {
  const info = record(message.info);
  if (info !== null && typeof info.id === 'string' && info.id.length > 0) return info.id;
  if (typeof message.id === 'string' && message.id.length > 0) return message.id;
  return null;
}
function buildMessageNode(message) {
  if (record(message) === null) return null;
  const info = record(message.info);
  const role = info !== null && typeof info.role === 'string' ? info.role : '';
  const text = visibleText(message);
  const cards = messageCards(message);
  if (text.length === 0 && cards.length === 0) return null;
  const node = document.createElement('div');
  node.className = 'msg ' + role;
  if (text.length > 0) {
    const textNode = document.createElement('div');
    textNode.className = 'msg-text';
    const prefix = role === 'user' ? 'you: ' : role === 'assistant' ? 'agent: ' : '';
    textNode.textContent = prefix + text;
    node.appendChild(textNode);
  }
  if (cards.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'attachments';
    for (const card of cards) strip.appendChild(buildAttachmentCard(card));
    node.appendChild(strip);
  }
  return node;
}
function setOlder(cursor) {
  nextCursor = typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
  const older = document.getElementById('older');
  olderBusy = false;
  older.disabled = false;
  older.textContent = 'Load older messages';
  older.hidden = nextCursor === null;
}
function renderMessages(messages, replace) {
  const box = document.getElementById('messages');
  const list = Array.isArray(messages) ? messages : [];
  const doReplace = replace !== false;
  if (doReplace) {
    box.replaceChildren();
    renderedIds = new Set();
  }
  for (const message of list) {
    const key = messageKey(message);
    if (key !== null) renderedIds.add(key);
    const node = buildMessageNode(message);
    if (node !== null) box.appendChild(node);
  }
  if (doReplace) box.scrollTop = box.scrollHeight;
}
function prependMessages(messages) {
  const box = document.getElementById('messages');
  const list = Array.isArray(messages) ? messages : [];
  const previousHeight = box.scrollHeight;
  const previousTop = box.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const message of list) {
    const key = messageKey(message);
    if (key !== null && renderedIds.has(key)) continue;
    if (key !== null) renderedIds.add(key);
    const node = buildMessageNode(message);
    if (node !== null) fragment.appendChild(node);
  }
  box.insertBefore(fragment, box.firstChild);
  box.scrollTop = previousTop + (box.scrollHeight - previousHeight);
}
function setStatus(text) {
  document.getElementById('status').textContent = typeof text === 'string' ? text : '';
}
function setError(text) {
  document.getElementById('err').textContent = typeof text === 'string' ? text : '';
}
function select(app) {
  current = app;
  sessionId = null;
  nextCursor = null;
  renderMessages([], true);
  setOlder(null);
  setStatus('');
  setError('');
  renderTabs();
  post({ type: 'select', app: app });
}
function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.replaceChildren();
  for (const app of apps) {
    const button = document.createElement('button');
    button.textContent = app.appKey;
    if (app.appKey === current) button.className = 'active';
    button.onclick = () => select(app.appKey);
    tabs.appendChild(button);
  }
}
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'apps') {
    apps = message.apps || [];
    renderTabs();
    if (!current && apps[0]) select(apps[0].appKey);
  } else if (message.type === 'session') {
    sessionId = message.sessionId;
  } else if (message.type === 'messages') {
    setError('');
    renderMessages(message.messages || [], true);
    setOlder(message.nextCursor);
  } else if (message.type === 'olderMessages') {
    setError('');
    prependMessages(message.messages || []);
    setOlder(message.nextCursor);
  } else if (message.type === 'olderFailed') {
    setOlder(nextCursor);
    setError(message.error || 'could not load older messages');
  } else if (message.type === 'sending') {
    setError('');
    setStatus('Sending...');
  } else if (message.type === 'recovery') {
    if (message.state === 'complete') setStatus('');
    else if (message.state === 'waiting') setStatus(message.text || 'The agent is still working.');
  } else if (message.type === 'thumbnail') {
    if (!isThumbMime(message.mime) || typeof message.data !== 'string') return;
    try {
      const binary = atob(message.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: message.mime }));
      thumbURLs.set(message.key, url);
      thumbRequested.delete(message.key);
      updateThumbnails(message.key);
    } catch (error) {
      thumbRequested.delete(message.key);
    }
  } else if (message.type === 'thumbnailFailed') {
    thumbRequested.delete(message.key);
  } else if (message.type === 'error') {
    setStatus('');
    setError(message.error);
  }
});
document.getElementById('older').onclick = () => {
  if (nextCursor === null || olderBusy) return;
  olderBusy = true;
  const older = document.getElementById('older');
  older.disabled = true;
  older.textContent = 'Loading...';
  post({ type: 'older', cursor: nextCursor });
};
document.getElementById('send').onclick = () => {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = '';
  setError('');
  setStatus('Sending...');
  post({ type: 'send', app: current, sessionId: sessionId, text: text });
};
post({ type: 'init' });
</script></body></html>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pendingSessions = new Map();

function ensureSession(app) {
  let pending = pendingSessions.get(app);
  if (pending === undefined) {
    pending = api(`/api/apps/${encodeURIComponent(app)}/sessions`, "POST").finally(() => {
      pendingSessions.delete(app);
    });
    pendingSessions.set(app, pending);
  }
  return pending;
}

class ChatProvider {
  constructor() {
    this.view = undefined;
    this.generation = 0;
    this.recovery = 0;
    this.currentApp = null;
    this.currentSession = null;
  }

  post(message) {
    if (this.view !== undefined) {
      this.view.webview.postMessage(message);
    }
  }

  async handleSelect(app, token) {
    this.currentApp = app;
    this.currentSession = null;
    const data = await api(`/api/apps/${encodeURIComponent(app)}/sessions`, "GET");
    if (token !== this.generation) return;
    const latest = data !== null && typeof data === "object" && Array.isArray(data.sessions)
      ? data.sessions[0]
      : undefined;
    if (latest === undefined || typeof latest.id !== "string") {
      this.post({ type: "session", sessionId: null });
      this.post({ type: "messages", messages: [], nextCursor: null });
      return;
    }
    this.currentSession = latest.id;
    this.post({ type: "session", sessionId: latest.id });
    const page = await fetchMessagesPage(app, latest.id);
    if (token !== this.generation) return;
    this.post({ type: "messages", messages: page.messages, nextCursor: page.nextCursor });
  }

  async handleOlder(token, cursor) {
    if (this.currentApp === null || this.currentSession === null) return;
    if (typeof cursor !== "string" || cursor.length === 0) return;
    const app = this.currentApp;
    const sessionId = this.currentSession;
    try {
      const page = await fetchMessagesPage(app, sessionId, cursor);
      if (token !== this.generation) return;
      this.post({
        type: "olderMessages",
        messages: page.messages,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (token !== this.generation) return;
      this.post({
        type: "olderFailed",
        error: String(error && error.message ? error.message : error),
      });
    }
  }

  async recoverAccepted(app, sessionId, messageID, token, recovery) {
    let lastError;
    let seen = false;
    for (const delay of RECOVERY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      if (token !== this.generation || recovery !== this.recovery) return;
      if (this.currentApp !== app || this.currentSession !== sessionId) return;
      try {
        const page = await fetchMessagesPage(app, sessionId);
        if (token !== this.generation || recovery !== this.recovery) return;
        lastError = undefined;
        const state = recoveryState(page.messages, messageID);
        seen = seen || state.seen;
        this.post({ type: "messages", messages: page.messages, nextCursor: page.nextCursor });
        if (state.done) {
          this.post({ type: "recovery", state: "complete", messageID });
          return;
        }
      } catch (error) {
        if (error && error.status === 404) {
          this.post({
            type: "error",
            error: "the session is gone; the message was not delivered",
          });
          return;
        }
        lastError = error;
      }
    }
    if (token !== this.generation || recovery !== this.recovery) return;
    if (seen) {
      this.post({
        type: "recovery",
        state: "waiting",
        messageID,
        text: "The agent is still working. Select the app again to refresh.",
      });
      return;
    }
    this.post({
      type: "error",
      error: lastError
        ? `the message was accepted but could not be read: ${
            lastError.message ?? String(lastError)
          }`
        : "the message was accepted but has not appeared yet; reload to check",
    });
  }

  async handleSend(message, token) {
    const app = message.app;
    let sessionId = message.sessionId;
    if (!sessionId) {
      const session = await ensureSession(app);
      if (token !== this.generation) return;
      if (session === null || typeof session !== "object" || typeof session.id !== "string") {
        throw new Error("could not create a session");
      }
      sessionId = session.id;
      this.currentApp = app;
      this.currentSession = sessionId;
      this.post({ type: "session", sessionId });
    } else {
      this.currentApp = app;
      this.currentSession = sessionId;
    }
    const recovery = ++this.recovery;
    const response = await apiRequest("POST", sendPath(app, sessionId, true), {
      text: message.text,
    });
    if (token !== this.generation || recovery !== this.recovery) return;
    if (response.status === 202 && response.data?.accepted === true) {
      const messageID = response.data.messageID;
      const warnings = Array.isArray(response.data.warnings) ? response.data.warnings : [];
      this.post({ type: "sending", messageID });
      if (warnings.length > 0) {
        this.post({ type: "recovery", state: "waiting", text: warnings.join(" ") });
      }
      await this.recoverAccepted(app, sessionId, messageID, token, recovery);
      return;
    }
    if (
      response.status === 502 &&
      response.data?.code === "async_unavailable"
    ) {
      const blocking = await apiRequest("POST", sendPath(app, sessionId, false), {
        text: message.text,
      });
      if (token !== this.generation || recovery !== this.recovery) return;
      if (blocking.status < 200 || blocking.status >= 300) {
        throw responseError(blocking, "could not send the message");
      }
      const page = await fetchMessagesPage(app, sessionId);
      if (token !== this.generation || recovery !== this.recovery) return;
      this.post({ type: "messages", messages: page.messages, nextCursor: page.nextCursor });
      this.post({ type: "recovery", state: "complete" });
      return;
    }
    if (
      response.status === 502 &&
      response.data?.code === "agent_unavailable" &&
      response.data?.outcome === "unknown" &&
      typeof response.data?.messageID === "string"
    ) {
      this.post({ type: "sending", messageID: response.data.messageID });
      await this.recoverAccepted(
        app,
        sessionId,
        response.data.messageID,
        token,
        recovery,
      );
      return;
    }
    if (response.status >= 200 && response.status < 300 && response.data?.message) {
      const page = await fetchMessagesPage(app, sessionId);
      if (token !== this.generation || recovery !== this.recovery) return;
      this.post({ type: "messages", messages: page.messages, nextCursor: page.nextCursor });
      this.post({ type: "recovery", state: "complete" });
      return;
    }
    throw responseError(response, "could not send the message");
  }

  async handleDownload(message) {
    const requestPath = hostApiPath(message.downloadURL);
    if (requestPath === undefined) throw new Error("invalid attachment URL");
    const response = await apiBinary(requestPath);
    if (response.status !== 200) throw responseError(response, "could not download the attachment");
    const name = safeDownloadName(message.name);
    const folder =
      Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri
        : undefined;
    const defaultUri =
      folder === undefined
        ? vscode.Uri.file(path.join(os.tmpdir(), name))
        : vscode.Uri.joinPath(folder, name);
    const target = await vscode.window.showSaveDialog({ defaultUri, saveLabel: "Download" });
    if (target === undefined) return;
    await vscode.workspace.fs.writeFile(target, response.data);
    vscode.window.showInformationMessage(`Saved ${name}`);
  }

  async handleThumbnail(message) {
    const requestedMime = String(message.mime).split(";")[0].trim().toLowerCase();
    if (!THUMBNAIL_MIMES.has(requestedMime)) {
      this.post({ type: "thumbnailFailed", key: message.key });
      return;
    }
    const requestPath = hostApiPath(message.downloadURL);
    if (requestPath === undefined) {
      this.post({ type: "thumbnailFailed", key: message.key });
      return;
    }
    try {
      const response = await apiBinary(requestPath);
      const contentType = String(response.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (
        response.status !== 200 ||
        response.data.length > MAX_THUMBNAIL_BYTES ||
        !THUMBNAIL_MIMES.has(contentType)
      ) {
        this.post({ type: "thumbnailFailed", key: message.key });
        return;
      }
      this.post({
        type: "thumbnail",
        key: message.key,
        mime: contentType,
        data: response.data.toString("base64"),
      });
    } catch {
      this.post({ type: "thumbnailFailed", key: message.key });
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "init") {
          const data = await api("/api/projects", "GET");
          const apps = [];
          for (const project of data.projects || []) {
            for (const app of project.apps || []) {
              apps.push({ appKey: app.appKey, project: project.name });
            }
          }
          this.post({ type: "apps", apps });
        } else if (message.type === "select") {
          this.generation += 1;
          this.recovery += 1;
          await this.handleSelect(message.app, this.generation);
        } else if (message.type === "older") {
          await this.handleOlder(this.generation, message.cursor);
        } else if (message.type === "send") {
          await this.handleSend(message, this.generation);
        } else if (message.type === "download") {
          await this.handleDownload(message);
        } else if (message.type === "thumbnail") {
          await this.handleThumbnail(message);
        }
      } catch (error) {
        this.post({
          type: "error",
          error: String(error && error.message ? error.message : error),
        });
      }
    });
  }
}

function activate(context) {
  const provider = new ChatProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("hanse.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("hanse.open", () => {
      vscode.commands.executeCommand("workbench.view.extension.hanse");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("hanse.moveToRight", async () => {
      await vscode.commands.executeCommand("hanse.chat.focus");
      await vscode.commands.executeCommand("workbench.action.moveFocusedView");
    }),
  );
  vscode.commands.executeCommand("workbench.view.extension.hanse");
}

function deactivate() {}

module.exports = { activate, deactivate };
