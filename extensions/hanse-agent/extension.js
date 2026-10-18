const vscode = require("vscode");
const http = require("http");

const API_HOST = "127.0.0.1";
const API_PORT = 8787;
const TOKEN = process.env.HANSE_OPERATOR_TOKEN || "";

function api(path, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    if (payload) {
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const request = http.request(
      { host: API_HOST, port: API_PORT, path, method, headers },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(data || String(error)));
          }
        });
      },
    );
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:dark}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);margin:0;padding:6px;font-size:12px}
#tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
#tabs button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px}
#tabs button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
#messages{height:calc(100vh - 140px);overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
.msg{margin:4px 0}
.msg.user{opacity:.85}
#input{width:100%;height:52px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px;box-sizing:border-box}
#send{margin-top:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:3px 10px;cursor:pointer;width:100%}
#err{color:var(--vscode-errorForeground);font-size:11px;margin-top:4px}
</style></head><body>
<div id="tabs"></div>
<div id="messages"></div>
<textarea id="input" placeholder="message..."></textarea>
<button id="send">send</button>
<div id="err"></div>
<script>
const vscode = acquireVsCodeApi();
let apps = [];
let current = null;
let sessionId = null;
function post(message) { vscode.postMessage(message); }
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'apps') {
    apps = message.apps || [];
    renderTabs();
    if (!current && apps[0]) select(apps[0].appKey);
  } else if (message.type === 'session') {
    sessionId = message.sessionId;
  } else if (message.type === 'messages') {
    renderMessages(message.messages || []);
  } else if (message.type === 'error') {
    document.getElementById('err').textContent = message.error;
  }
});
function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const app of apps) {
    const button = document.createElement('button');
    button.textContent = app.appKey;
    if (app.appKey === current) button.className = 'active';
    button.onclick = () => select(app.appKey);
    tabs.appendChild(button);
  }
}
function select(app) {
  current = app;
  sessionId = null;
  renderTabs();
  document.getElementById('messages').textContent = '';
  document.getElementById('err').textContent = '';
  post({ type: 'select', app: app });
}
function renderMessages(messages) {
  const box = document.getElementById('messages');
  box.innerHTML = '';
  for (const message of messages) {
    const role = message.info && message.info.role;
    const text = (message.parts || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('\\n');
    if (!text) continue;
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = (role === 'user' ? 'you: ' : 'agent: ') + text;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}
document.getElementById('send').onclick = () => {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || !current || !sessionId) return;
  input.value = '';
  post({ type: 'send', app: current, sessionId: sessionId, text: text });
};
post({ type: 'init' });
</script></body></html>`;
}

class ChatProvider {
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
          view.webview.postMessage({ type: "apps", apps });
        } else if (message.type === "select") {
          const session = await api(
            `/api/apps/${encodeURIComponent(message.app)}/sessions`,
            "POST",
          );
          view.webview.postMessage({ type: "session", sessionId: session.id });
          const messages = await api(
            `/api/apps/${encodeURIComponent(message.app)}/sessions/${session.id}/messages`,
            "GET",
          );
          view.webview.postMessage({ type: "messages", messages: messages.messages });
        } else if (message.type === "send") {
          await api(
            `/api/apps/${encodeURIComponent(message.app)}/sessions/${message.sessionId}/messages`,
            "POST",
            { text: message.text },
          );
          const messages = await api(
            `/api/apps/${encodeURIComponent(message.app)}/sessions/${message.sessionId}/messages`,
            "GET",
          );
          view.webview.postMessage({ type: "messages", messages: messages.messages });
        }
      } catch (error) {
        view.webview.postMessage({
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
  vscode.commands.executeCommand("workbench.view.extension.hanse");
}

function deactivate() {}

module.exports = { activate, deactivate };
