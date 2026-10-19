(function () {
  const shell = document.getElementById("chat-shell");
  if (shell === null) {
    return;
  }

  const appKey = shell.dataset.appKey || "";
  const projectId = shell.dataset.projectId || "";
  const appInitials = shell.dataset.appInitials || "AP";
  const operatorInitials = shell.dataset.operatorInitials || "OP";
  const sessionsList = document.getElementById("session-list");
  const sessionSearch = document.getElementById("session-search");
  const sessionError = document.getElementById("session-error");
  const messagesEl = document.getElementById("chat-messages");
  const scrollEl = document.getElementById("chat-scroll");
  const composer = document.getElementById("chat-composer");
  const promptEl = document.getElementById("chat-prompt");
  const sendButton = document.getElementById("chat-send");
  const sendError = document.getElementById("chat-send-error");
  const liveEl = document.getElementById("chat-live");
  const countEl = document.getElementById("chat-message-count");
  const workingEl = document.getElementById("chat-working");
  const streamRetry = document.getElementById("chat-stream-retry");
  const newMessages = document.getElementById("chat-new-messages");
  const appSelect = document.getElementById("chat-app-select");
  const sessionTitleEl = document.getElementById("chat-session-title");
  const sessionIdEl = document.getElementById("chat-session-id");
  const runtimeEl = document.getElementById("chat-runtime");
  const contextClose = document.querySelector("[data-chat-context-close]");
  const sessionsClose = document.querySelector("[data-chat-sessions-close]");
  const contextToggles = Array.from(
    document.querySelectorAll("[data-chat-context-toggle]"),
  );
  const sessionsToggles = Array.from(
    document.querySelectorAll("[data-chat-sessions-toggle]"),
  );
  const scrim = document.querySelector("[data-chat-scrim]");
  const promptDock = document.getElementById("chat-prompt-dock");
  const policyWarning = document.getElementById("chat-policy-warning");
  const policyChip = document.getElementById("chat-policy-chip");
  const policyChipLabel = document.getElementById("chat-policy-chip-label");
  const inputNeeded = document.getElementById("chat-input-needed");
  const inputNeededCount = document.getElementById("chat-input-needed-count");
  const queueEl = document.getElementById("chat-queue");
  const queueList = document.getElementById("chat-queue-list");
  const queueClose = document.querySelector("[data-chat-queue-close]");
  const announcer = document.getElementById("chat-announcer");
  const planList = document.getElementById("chat-plan-list");
  const planEmpty = document.getElementById("chat-plan-empty");
  const planSummary = document.getElementById("chat-plan-summary");
  const planChip = document.getElementById("chat-plan-chip");
  const planChipLabel = document.getElementById("chat-plan-chip-label");
  const planSection = document.getElementById("chat-plan-section");
  const planHeading = document.getElementById("context-plan-title");
  const savedSection = document.getElementById("chat-saved-section");
  const savedList = document.getElementById("chat-saved-list");
  const savedBadge = document.getElementById("chat-saved-badge");
  const waitingEl = document.getElementById("chat-waiting");
  const composerHintText = document.getElementById("chat-composer-hint-text");

  let sessions = [];
  let sessionId = null;
  let messages = [];
  let eventSource = null;
  let reloadTimer = null;
  let failures = 0;
  let creatingSession = false;
  const pendingSends = new Set();
  const deletingSessions = new Set();
  let stickToBottom = true;
  let loadSequence = 0;
  let renderSequence = 0;

  const prompts = new Map();
  const promptDrafts = new Map();
  const promptSeen = new Map();
  const tombstones = new Map();
  const promptBusy = new Set();
  const promptErrors = new Map();
  let promptEventSeq = 0;
  const promptEventLog = [];
  let promptHydrationSeq = 0;
  let promptHydrationRetried = false;
  let dockRequestKey = null;
  let dockCollapsed = false;
  let hasStreamReady = false;
  let promptStale = false;
  let announceTimer = null;

  const todoCache = new Map();
  const todoEventSeq = new Map();
  let todoFetchSeq = 0;
  let todoState = "idle";
  let planProgress = { completed: 0, total: 0 };
  let lastPlanSummary = "";

  let savedPermissions = [];
  let savedHydrated = false;
  let savedBadgeTimer = null;

  let policyWarnings = [];
  const dismissedWarnings = new Set();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== undefined) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function iconNode(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className === undefined ? "icon" : `icon ${className}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function apiBase() {
    return `/api/apps/${encodeURIComponent(appKey)}`;
  }

  function withProject(url) {
    return projectId.length === 0 ? url : `${url}?project=${encodeURIComponent(projectId)}`;
  }

  function sessionsUrl() {
    return withProject(`${apiBase()}/sessions`);
  }

  function sessionUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}`);
  }

  function messagesUrl(id) {
    const session = id === undefined ? sessionId : id;
    return withProject(
      `${apiBase()}/sessions/${encodeURIComponent(session || "")}/messages`,
    );
  }

  function eventsUrl() {
    return withProject(`${apiBase()}/events`);
  }

  function promptsUrl() {
    return withProject(`${apiBase()}/prompts`);
  }

  function todoUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}/todo`);
  }

  function savedPermissionsUrl() {
    return withProject(`${apiBase()}/permissions/saved`);
  }

  function savedPermissionUrl(id) {
    return withProject(`${apiBase()}/permissions/saved/${encodeURIComponent(id)}`);
  }

  function questionReplyUrl(id) {
    return withProject(`${apiBase()}/questions/${encodeURIComponent(id)}/reply`);
  }

  function questionRejectUrl(id) {
    return withProject(`${apiBase()}/questions/${encodeURIComponent(id)}/reject`);
  }

  function permissionReplyUrl(id) {
    return withProject(`${apiBase()}/permissions/${encodeURIComponent(id)}/reply`);
  }

  async function api(url, options) {
    const response = await fetch(url, { cache: "no-store", ...(options || {}) });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      let code;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") {
          message = parsed.error;
        }
        if (parsed && typeof parsed.code === "string") {
          code = parsed.code;
        }
      } catch (error) {
        void error;
      }
      const failure = new Error(
        message.slice(0, 400) || `Request failed (${response.status})`,
      );
      failure.status = response.status;
      failure.code = code;
      throw failure;
    }
    return response.json();
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
  }

  function relativeTime(value) {
    if (value === undefined || value === null) {
      return "";
    }
    let date = new Date(value);
    if (typeof value === "number" && value < 1_000_000_000_000) {
      date = new Date(value * 1000);
    }
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  function sessionTimestamp(session) {
    const time = session.time;
    if (time && typeof time === "object") {
      if (typeof time.updated === "number") return time.updated;
      if (typeof time.created === "number") return time.created;
    }
    if (typeof session.updatedAt === "string" || typeof session.updatedAt === "number") {
      return session.updatedAt;
    }
    if (typeof session.createdAt === "string" || typeof session.createdAt === "number") {
      return session.createdAt;
    }
    return undefined;
  }

  function sessionLabel(session) {
    return typeof session.title === "string" && session.title.trim().length > 0
      ? session.title.trim()
      : `Session ${String(session.id).slice(0, 8)}`;
  }

  function setLive(label, state) {
    if (liveEl === null) return;
    liveEl.textContent = label;
    liveEl.dataset.state = state;
    if (streamRetry !== null) {
      streamRetry.hidden = state !== "paused";
    }
  }

  function setWorking(working) {
    if (workingEl !== null) {
      workingEl.hidden = !working;
    }
  }

  function requestKey(request) {
    return `${request.source}:${request.id}`;
  }

  function pendingForSession(id) {
    const items = [];
    for (const entry of prompts.values()) {
      if (entry.request.sessionID === id) items.push(entry);
    }
    return items.sort((a, b) => (promptSeen.get(a.key) || 0) - (promptSeen.get(b.key) || 0));
  }

  function activePromptEntries() {
    return sessionId === null ? [] : pendingForSession(sessionId);
  }

  function otherSessionPromptCount() {
    let count = 0;
    for (const entry of prompts.values()) {
      if (entry.request.sessionID !== sessionId) count += 1;
    }
    return count;
  }

  function promptCountForSession(id) {
    let count = 0;
    for (const entry of prompts.values()) {
      if (entry.request.sessionID === id) count += 1;
    }
    return count;
  }

  function hasActiveSend() {
    return sessionId === null ? pendingSends.has("draft") : pendingSends.has(sessionId);
  }

  function pruneTombstones() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, at] of tombstones) {
      if (at < cutoff) tombstones.delete(key);
    }
  }

  function recordTombstone(key) {
    tombstones.set(key, Date.now());
    promptDrafts.delete(key);
    promptErrors.delete(key);
    promptBusy.delete(key);
  }

  function announce(message) {
    if (announcer === null) return;
    window.clearTimeout(announceTimer);
    announcer.textContent = "";
    announceTimer = window.setTimeout(() => {
      announcer.textContent = message;
    }, 30);
  }

  function showToast(message, tone) {
    const region = document.getElementById("toast-region");
    if (region === null) {
      announce(message);
      return;
    }
    const toast = element("div", "toast");
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    const icon = element("span", "toast__icon");
    icon.append(iconNode(tone === "error" ? "alert-triangle" : "check"));
    const copy = element("div", "toast__copy");
    copy.append(element("strong", "", message));
    const close = element("button", "btn btn-ghost btn-icon btn-sm");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.append(iconNode("x"));
    close.addEventListener("click", () => toast.remove());
    toast.append(icon, copy, close);
    region.append(toast);
    window.setTimeout(() => toast.remove(), 6000);
  }

  function composerHasDraft() {
    return promptEl instanceof HTMLTextAreaElement && promptEl.value.trim().length > 0;
  }

  function syncComposer() {
    const promptsWaiting = activePromptEntries().length > 0;
    const sending = hasActiveSend();
    if (sendButton instanceof HTMLButtonElement) {
      sendButton.disabled = sending || promptsWaiting;
    }
    if (waitingEl !== null) waitingEl.hidden = !promptsWaiting;
    setWorking(sending && !promptsWaiting);
    if (composerHintText !== null) {
      composerHintText.textContent = promptsWaiting
        ? "Answer the request above to continue."
        : "Enter to send / Shift+Enter for a new line";
    }
    setNewSessionBusy(creatingSession);
    renderSessions();
    updateInputNeeded();
    updatePlanChip();
  }

  function setBusy(button, busy) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = busy;
    if (busy) {
      button.setAttribute("aria-busy", "true");
      if (button.querySelector("[data-chat-spinner]") === null) {
        const spinner = element("span", "spinner");
        spinner.dataset.chatSpinner = "true";
        spinner.setAttribute("aria-hidden", "true");
        button.prepend(spinner);
      }
    } else {
      button.removeAttribute("aria-busy");
      const spinner = button.querySelector("[data-chat-spinner]");
      if (spinner !== null) spinner.remove();
    }
  }

  function newSessionButtons() {
    return Array.from(document.querySelectorAll("[data-chat-new-session]"));
  }

  function setNewSessionBusy(busy) {
    for (const button of newSessionButtons()) {
      setBusy(button, busy);
    }
  }

  function showSessionsLoading() {
    if (sessionsList === null) return;
    const skeleton = element("div", "skeleton-stack chat-sessions__skeleton");
    skeleton.setAttribute("aria-hidden", "true");
    skeleton.append(
      element("span", "skeleton skeleton--title"),
      element("span", "skeleton"),
      element("span", "skeleton skeleton--short"),
      element("span", "skeleton"),
    );
    sessionsList.replaceChildren(skeleton);
  }

  function showSessionsError(error, retry) {
    if (sessionsList === null) return;
    const state = element("div", "error-state chat-error");
    state.setAttribute("role", "alert");
    const mark = element("span", "error-state__mark");
    mark.append(iconNode("alert-triangle", "icon--lg"));
    state.append(mark);
    const body = element("div");
    body.append(
      element("h3", "error-state__title", "Sessions unavailable"),
      element("p", "error-state__body", error.message || String(error)),
    );
    const button = element("button", "btn btn-secondary btn-sm", "Retry");
    button.type = "button";
    button.addEventListener("click", retry);
    body.append(button);
    state.append(body);
    sessionsList.replaceChildren(state);
  }

  function showSessionsEmpty() {
    if (sessionsList === null) return;
    sessionsList.replaceChildren(
      element("p", "chat-empty", "No sessions yet. Send a message to start one."),
    );
  }

  function showSessionError(message) {
    if (sessionError === null) return;
    sessionError.hidden = message === null;
    sessionError.textContent = message === null ? "" : message;
  }

  function renderSessions() {
    if (sessionsList === null) return;
    const needle = (sessionSearch === null ? "" : sessionSearch.value).trim().toLowerCase();
    const visible = sessions.filter((session) => {
      if (needle.length === 0) return true;
      return (
        sessionLabel(session).toLowerCase().includes(needle) ||
        String(session.id).toLowerCase().includes(needle)
      );
    });
    if (sessions.length === 0) {
      showSessionsEmpty();
      return;
    }
    if (visible.length === 0) {
      sessionsList.replaceChildren(
        element("p", "chat-empty", "No sessions match this filter."),
      );
      return;
    }
    const list = document.createDocumentFragment();
    for (const session of visible) {
      const id = String(session.id);
      const row = element("div", "session-row");
      const button = element("button", "session-item");
      button.type = "button";
      button.dataset.sessionId = id;
      const active = session.id === sessionId;
      if (active) {
        button.classList.add("is-active");
        button.setAttribute("aria-current", "true");
      }
      const top = element("span", "session-item__top");
      top.append(element("span", "session-item__title", sessionLabel(session)));
      if (active) top.append(iconNode("check", "icon--sm"));
      const meta = element("span", "session-item__meta");
      meta.append(element("span", "mono", id.slice(0, 8)));
      const stamp = relativeTime(sessionTimestamp(session));
      if (stamp.length > 0) meta.append(element("span", "", stamp));
      const waitingCount = id === sessionId ? 0 : promptCountForSession(id);
      if (waitingCount > 0) {
        const flag = element("span", "session-item__flag");
        flag.setAttribute("aria-label", `${waitingCount} requests need input`);
        flag.append(iconNode("message", "icon--sm"), document.createTextNode(`${waitingCount} waiting`));
        meta.append(flag);
      }
      button.append(top, meta);
      button.addEventListener("click", () => {
        selectSession(id, { focus: true });
      });

      const remove = element("button", "session-delete");
      remove.type = "button";
      remove.dataset.sessionDelete = id;
      remove.title = "Delete session";
      remove.setAttribute("aria-label", `Delete ${sessionLabel(session)}`);
      remove.append(iconNode("trash", "icon--sm"));
      remove.disabled = deletingSessions.has(id);
      remove.addEventListener("click", () => {
        removeSession(id);
      });

      row.append(button, remove);
      list.append(row);
    }
    sessionsList.replaceChildren(list);
  }

  function emptyThread() {
    const state = element("div", "empty-state");
    const mark = element("span", "empty-state__mark");
    mark.append(iconNode("message", "icon--lg"));
    state.append(
      mark,
      element("h3", "empty-state__title", `Chat with ${appKey}`),
      element(
        "p",
        "empty-state__body",
        "Send the first message to start the agent. Its reply appears here, with tool calls in place.",
      ),
    );
    return state;
  }

  function showMessagesLoading() {
    if (messagesEl === null) return;
    if (newMessages !== null) newMessages.hidden = true;
    messagesEl.setAttribute("aria-busy", "true");
    const skeleton = element("div", "skeleton-stack");
    skeleton.setAttribute("aria-hidden", "true");
    skeleton.append(
      element("span", "skeleton skeleton--title"),
      element("span", "skeleton"),
      element("span", "skeleton skeleton--short"),
      element("span", "skeleton"),
    );
    messagesEl.replaceChildren(skeleton);
  }

  function showThreadError(error, retry) {
    if (messagesEl === null) return;
    messagesEl.removeAttribute("aria-busy");
    setRuntime("error");
    const state = element("div", "error-state chat-error");
    state.setAttribute("role", "alert");
    const mark = element("span", "error-state__mark");
    mark.append(iconNode("alert-triangle", "icon--lg"));
    const body = element("div");
    body.append(
      element("h3", "error-state__title", "Chat unavailable"),
      element("p", "error-state__body", error.message || String(error)),
    );
    const button = element("button", "btn btn-secondary btn-sm", "Retry");
    button.type = "button";
    button.addEventListener("click", retry);
    body.append(button);
    state.append(mark, body);
    messagesEl.replaceChildren(state);
    if (newMessages !== null) newMessages.hidden = true;
    setLive("Paused", "paused");
  }

  function setRuntime(state) {
    const contextRuntimeEl = document.getElementById("chat-context-runtime");
    for (const target of [runtimeEl, contextRuntimeEl]) {
      if (target !== null) {
        target.replaceChildren(statusChip(state));
      }
    }
  }

  function statusChip(status) {
    const map = {
      running: { state: "in_progress", icon: "activity", label: "Running" },
      completed: { state: "delivered", icon: "check", label: "Completed" },
      error: { state: "failed", icon: "alert-triangle", label: "Error" },
      pending: { state: "queued", icon: "clock", label: "Pending" },
    };
    const entry = map[status] || map.completed;
    const chip = element("span", "status");
    chip.dataset.state = entry.state;
    chip.append(iconNode(entry.icon), document.createTextNode(entry.label));
    return chip;
  }

  function renderInline(parent, text) {
    const pattern =
      /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s]+)/g;
    let last = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (match.index > last) {
        parent.append(document.createTextNode(text.slice(last, match.index)));
      }
      const token = match[0];
      if (token.startsWith("`") && token.endsWith("`")) {
        parent.append(element("code", "", token.slice(1, -1)));
      } else if (token.startsWith("**") && token.endsWith("**")) {
        const strong = element("strong");
        renderInline(strong, token.slice(2, -2));
        parent.append(strong);
      } else if (
        (token.startsWith("*") && token.endsWith("*")) ||
        (token.startsWith("_") && token.endsWith("_"))
      ) {
        const em = element("em");
        renderInline(em, token.slice(1, -1));
        parent.append(em);
      } else if (token.startsWith("[")) {
        const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
        if (linkMatch !== null) {
          const link = element("a", "", linkMatch[1]);
          link.href = linkMatch[2];
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          parent.append(link);
        } else {
          parent.append(document.createTextNode(token));
        }
      } else if (/^https?:\/\//.test(token)) {
        const trailing = /[.,;:!?]+$/.exec(token);
        const clean = trailing === null ? token : token.slice(0, -trailing[0].length);
        const link = element("a", "", clean);
        link.href = clean;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        parent.append(link);
        if (trailing !== null) parent.append(document.createTextNode(trailing[0]));
      } else {
        parent.append(document.createTextNode(token));
      }
      last = pattern.lastIndex;
      match = pattern.exec(text);
    }
    if (last < text.length) {
      parent.append(document.createTextNode(text.slice(last)));
    }
  }

  function startsBlock(line) {
    return (
      /^```/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      /^\s*(---|\*\*\*|___)\s*$/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*([-*]|\d+\.)\s+/.test(line)
    );
  }

  function renderMarkdown(container, text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim().length === 0) {
        index += 1;
        continue;
      }
      if (/^```/.test(line)) {
        const language = line.slice(3).trim();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = element("pre");
        const code = element("code", "", codeLines.join("\n"));
        if (language.length > 0) code.dataset.language = language;
        pre.append(code);
        container.append(pre);
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading !== null) {
        const level = heading[1].length;
        const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
        const node = element(tag);
        renderInline(node, heading[2]);
        container.append(node);
        index += 1;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        container.append(element("hr"));
        index += 1;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = element("blockquote");
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          if (quote.childNodes.length > 0) quote.append(element("br"));
          renderInline(quote, lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        container.append(quote);
        continue;
      }
      const listMatch = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line);
      if (listMatch !== null) {
        const ordered = /\d+\./.test(listMatch[1]);
        const list = element(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
          if (item === null || /\d+\./.test(item[1]) !== ordered) break;
          const li = element("li");
          renderInline(li, item[2]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }
      const paragraph = element("p");
      let first = true;
      while (
        index < lines.length &&
        lines[index].trim().length > 0 &&
        !startsBlock(lines[index])
      ) {
        if (!first) paragraph.append(element("br"));
        renderInline(paragraph, lines[index]);
        first = false;
        index += 1;
      }
      container.append(paragraph);
    }
  }

  function toolStatus(part) {
    const state = part.state && typeof part.state === "object" ? part.state : {};
    if (state.status === "error" || state.error) return "error";
    if (state.status === "running") return "running";
    if (state.status === "pending") return "pending";
    return "completed";
  }

  function toolPath(part) {
    const state = part.state && typeof part.state === "object" ? part.state : {};
    const input = state.input && typeof state.input === "object" ? state.input : {};
    const candidate =
      input.command || input.filePath || input.path || input.pattern || input.url || part.title;
    return typeof candidate === "string" ? candidate : "";
  }

  function toolOutput(part) {
    const state = part.state && typeof part.state === "object" ? part.state : {};
    if (typeof state.error === "string" && state.error.length > 0) return state.error;
    if (typeof state.output === "string") return state.output;
    if (typeof part.output === "string") return part.output;
    if (typeof part.text === "string") return part.text;
    return "No output";
  }

  function renderTool(part, key) {
    const status = toolStatus(part);
    const details = element("details", "tool-call");
    details.dataset.toolKey = key;
    if (status === "error") details.open = true;
    const summary = element("summary");
    summary.append(
      iconNode("terminal"),
      element("span", "mono", String(part.tool || "tool")),
    );
    const path = toolPath(part);
    if (path.length > 0) {
      const pathEl = element("span", "tool-call__path", path);
      pathEl.title = path;
      summary.append(pathEl);
    }
    summary.append(statusChip(status));
    details.append(summary, element("pre", "", toolOutput(part)));
    return details;
  }

  function renderDetail(kind, text, key) {
    const details = element("details", "tool-call");
    details.dataset.toolKey = key;
    const summary = element("summary");
    summary.append(iconNode(kind === "patch" ? "code" : "activity"));
    summary.append(element("span", "mono", kind));
    details.append(summary, element("pre", "", text));
    return details;
  }

  function messageTime(info) {
    if (!info || typeof info !== "object") return "";
    const time = info.time;
    let value = null;
    if (time && typeof time === "object" && typeof time.created === "number") {
      value = time.created;
    } else if (typeof info.createdAt === "string" || typeof info.createdAt === "number") {
      value = info.createdAt;
    }
    if (value === null) return "";
    const date = new Date(typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderMessage(message, messageIndex) {
    const info = message.info && typeof message.info === "object" ? message.info : {};
    const messageKey = String(info.id ?? messageIndex);
    const role = info.role === "user" ? "user" : "assistant";
    const wrapper = element("article", "message" + (role === "user" ? " message--user" : ""));
    wrapper.dataset.role = role;
    const meta = element("div", "message__meta");
    const avatar = element("span", "avatar avatar--sm", role === "user" ? operatorInitials : appInitials);
    avatar.setAttribute("aria-hidden", "true");
    meta.append(
      avatar,
      element("span", "message__role", role === "user" ? "operator" : appKey),
    );
    const stamp = messageTime(info);
    if (stamp.length > 0) meta.append(element("span", "message__time", stamp));
    wrapper.append(meta);

    const parts = Array.isArray(message.parts) ? message.parts : [];
    parts.forEach((part, partIndex) => {
      if (!part || typeof part !== "object") return;
      const key = `${messageKey}:${partIndex}`;
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        const body = element("div", "message__body");
        renderMarkdown(body, part.text);
        wrapper.append(body);
      } else if (part.type === "tool") {
        wrapper.append(renderTool(part, key));
      } else if (part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "Reasoning";
        wrapper.append(renderDetail("reasoning", text, key));
      } else if (part.type === "patch") {
        const text = typeof part.patch === "string" ? part.patch : typeof part.text === "string" ? part.text : "Patch";
        wrapper.append(renderDetail("patch", text, key));
      }
    });
    return wrapper;
  }

  function isAtBottom() {
    if (scrollEl === null) return true;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  }

  function renderMessages(options) {
    if (messagesEl === null || scrollEl === null) return;
    messagesEl.removeAttribute("aria-busy");
    const previous = options.previousScroll;
    const previousCount = options.previousCount;
    const openTools = new Set(
      [...messagesEl.querySelectorAll("details[data-tool-key][open]")].map(
        (node) => node.dataset.toolKey,
      ),
    );
    const sequence = ++renderSequence;
    messagesEl.replaceChildren();
    if (messages.length === 0) {
      messagesEl.append(emptyThread());
    } else {
      messages.forEach((message, index) => {
        const node = renderMessage(message, index);
        if (node.childNodes.length > 1) messagesEl.append(node);
      });
    }
    if (sequence === renderSequence && openTools.size > 0) {
      for (const node of messagesEl.querySelectorAll("details[data-tool-key]")) {
        if (openTools.has(node.dataset.toolKey)) node.open = true;
      }
    }
    if (countEl !== null) {
      countEl.textContent = plural(messages.length, "message");
    }
    if (options.initial || options.forceBottom || options.atBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      stickToBottom = true;
      if (newMessages !== null) newMessages.hidden = true;
    } else {
      scrollEl.scrollTop = previous;
      if (messages.length > previousCount && newMessages !== null) {
        newMessages.hidden = false;
      }
    }
  }

  function closeStream() {
    if (eventSource !== null) {
      eventSource.close();
      eventSource = null;
    }
    if (reloadTimer !== null) {
      window.clearTimeout(reloadTimer);
      reloadTimer = null;
    }
  }

  function scheduleReload() {
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      loadMessages({ silent: true, atBottom: isAtBottom() }).catch(() => {});
    }, 300);
  }

  function subscribe() {
    closeStream();
    failures = 0;
    if (!("EventSource" in window)) {
      setLive("Paused", "paused");
      return;
    }
    eventSource = new EventSource(eventsUrl());
    eventSource.onopen = () => {
      failures = 0;
      setLive("Live", "live");
    };
    eventSource.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        void error;
        return;
      }
      handleStreamEvent(payload);
    };
    eventSource.onerror = () => {
      failures += 1;
      if (failures >= 3) {
        closeStream();
        setLive("Paused", "paused");
        renderPlan();
      } else {
        setLive("Reconnecting", "reconnecting");
      }
    };
  }

  function handleStreamEvent(payload) {
    if (payload === null || typeof payload !== "object") return;
    const type = payload.type;
    if (type === "stream.ready") {
      const reconnect = hasStreamReady;
      hasStreamReady = true;
      setLive("Live", "live");
      hydrate({ reconnect });
      return;
    }
    if (type === "stream.warning") return;

    if (type === "question.asked" || type === "permission.asked") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const request = payload.request;
      if (!request || typeof request !== "object" || typeof request.id !== "string") return;
      const key = requestKey(request);
      tombstones.delete(key);
      const kind = type === "question.asked" ? "question" : "permission";
      if (!prompts.has(key)) promptSeen.set(key, Date.now());
      prompts.set(key, { key, kind, request });
      if (request.sessionID === sessionId) {
        renderPromptDock();
        announce(kind === "question" ? "The agent has a question." : "The agent needs permission.");
      }
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "question.replied" || type === "question.rejected") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const key = `${payload.source}:${payload.requestID}`;
      const wasOpen = prompts.has(key) && !promptBusy.has(key);
      recordTombstone(key);
      prompts.delete(key);
      if (wasOpen) {
        announce("Answered elsewhere.");
        showToast("Answered elsewhere.", "success");
      }
      if (payload.sessionID === sessionId) renderPromptDock();
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "permission.replied") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const key = `${payload.source}:${payload.requestID}`;
      const wasOpen = prompts.has(key) && !promptBusy.has(key);
      recordTombstone(key);
      prompts.delete(key);
      if (wasOpen) {
        announce("Answered elsewhere.");
        showToast("Answered elsewhere.", "success");
      }
      if (payload.sessionID === sessionId) renderPromptDock();
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "todo.updated" && typeof payload.sessionID === "string") {
      const previous = todoEventSeq.get(payload.sessionID) || 0;
      todoEventSeq.set(payload.sessionID, previous + 1);
      todoCache.set(payload.sessionID, {
        todos: Array.isArray(payload.todos) ? payload.todos : [],
        truncated: payload.truncated === true,
      });
      if (payload.sessionID === sessionId) {
        todoState = "ready";
        renderPlan();
      }
      return;
    }

    if (type === "session.activity" && payload.sessionID === sessionId) {
      scheduleReload();
    }
  }

  function replayPromptEvents(startSeq) {
    const oldest = promptEventLog.length > 0 ? promptEventLog[0].seq : promptEventSeq + 1;
    if (oldest > startSeq + 1) return false;
    for (const entry of promptEventLog) {
      if (entry.seq <= startSeq) continue;
      const payload = entry.event;
      if (payload.type === "question.asked" || payload.type === "permission.asked") {
        const request = payload.request;
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        tombstones.delete(key);
        prompts.set(key, {
          key,
          kind: payload.type === "question.asked" ? "question" : "permission",
          request,
        });
      } else if (
        payload.type === "question.replied" ||
        payload.type === "question.rejected" ||
        payload.type === "permission.replied"
      ) {
        const key = `${payload.source}:${payload.requestID}`;
        recordTombstone(key);
        prompts.delete(key);
      }
    }
    return true;
  }

  async function hydrate(options) {
    const settings = options || {};
    const sequence = ++promptHydrationSeq;
    const startSeq = promptEventSeq;
    const [promptResult, savedResult] = await Promise.allSettled([
      api(promptsUrl()),
      api(savedPermissionsUrl()),
    ]);
    if (sequence !== promptHydrationSeq) return;
    pruneTombstones();

    if (promptResult.status === "fulfilled") {
      const data = promptResult.value || {};
      const next = new Map();
      const questions = Array.isArray(data.questions) ? data.questions : [];
      const permissions = Array.isArray(data.permissions) ? data.permissions : [];
      for (const request of questions) {
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        if (tombstones.has(key)) continue;
        if (!promptSeen.has(key)) promptSeen.set(key, Date.now());
        next.set(key, { key, kind: "question", request });
      }
      for (const request of permissions) {
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        if (tombstones.has(key)) continue;
        if (!promptSeen.has(key)) promptSeen.set(key, Date.now());
        next.set(key, { key, kind: "permission", request });
      }
      if (!replayPromptEvents(startSeq) && !promptHydrationRetried) {
        promptHydrationRetried = true;
        window.setTimeout(() => {
          hydrate(settings).catch(() => {});
        }, 0);
        return;
      }
      promptHydrationRetried = false;
      promptStale = false;
      prompts.clear();
      for (const [key, value] of next) prompts.set(key, value);
      applyPolicyWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      renderPromptDock();
      renderQueue();
      syncComposer();
    } else {
      promptStale = true;
      applyPolicyWarnings(policyWarnings);
      if (promptDock !== null && activePromptEntries().length > 0) {
        promptDock.hidden = false;
        renderPromptDock();
      }
    }

    if (savedResult.status === "fulfilled") {
      applySavedPermissions(savedResult.value);
    }

    if (sessionId !== null) {
      await loadTodo(sessionId).catch(() => {});
    }
    if (settings.reconnect === true) {
      loadMessages({ silent: true }).catch(() => {});
    }
  }

  function questionDraft(entry) {
    let draft = promptDrafts.get(entry.key);
    if (draft === undefined) {
      draft = {
        index: 0,
        answers: entry.request.questions.map(() => []),
        custom: entry.request.questions.map(() => ""),
        confirm: null,
      };
      promptDrafts.set(entry.key, draft);
    }
    return draft;
  }

  function permissionDraft(entry) {
    let draft = promptDrafts.get(entry.key);
    if (draft === undefined) {
      draft = { confirm: null, feedback: "" };
      promptDrafts.set(entry.key, draft);
    }
    return draft;
  }

  function answersForQuestion(draft, index) {
    const selected = Array.isArray(draft.answers[index]) ? draft.answers[index].slice() : [];
    const custom = String(draft.custom[index] || "").trim();
    if (custom.length === 0) return selected;
    if (selected.includes(custom)) return selected;
    return [...selected, custom];
  }

  function questionAnswered(draft, index) {
    return answersForQuestion(draft, index).length > 0;
  }

  function questionNeedsReview(request) {
    return (
      request.questions.length > 1 ||
      (request.questions[0] !== undefined && request.questions[0].multiple === true)
    );
  }

  function unresolvedQuestions(entry, draft) {
    return entry.request.questions.filter((_, index) => !questionAnswered(draft, index)).length;
  }

  function primaryActionLabel(entry, draft) {
    if (promptBusy.has(entry.key)) return "Sending answer…";
    const steps = entry.request.questions.length;
    const needsReview = questionNeedsReview(entry.request);
    const isReview = needsReview && draft.index === steps;
    const error = promptErrors.has(entry.key);
    if (isReview) {
      return unresolvedQuestions(entry, draft) > 0
        ? "Send without answering"
        : error
          ? "Try again"
          : "Send answer";
    }
    if (needsReview) {
      if (draft.index < steps - 1) return "Next";
      const left = unresolvedQuestions(entry, draft);
      return left > 0 ? `Review · ${left} left` : "Review";
    }
    const empty = answersForQuestion(draft, draft.index).length === 0;
    return empty ? "Send without answering" : error ? "Try again" : "Send answer";
  }

  function syncQuestionChrome(entry, draft) {
    if (promptDock === null) return;
    const primary = promptDock.querySelector("[data-prompt-primary]");
    if (primary !== null && !promptBusy.has(entry.key)) {
      primary.textContent = primaryActionLabel(entry, draft);
    }
    const reviewTab = promptDock.querySelector("[data-prompt-review-tab]");
    if (reviewTab !== null) {
      const left = unresolvedQuestions(entry, draft);
      reviewTab.replaceChildren(
        document.createTextNode(left > 0 ? `Review · ${left} left` : "Review"),
      );
    }
    entry.request.questions.forEach((_, index) => {
      const tab = promptDock.querySelector(`[data-prompt-tab="${index}"]`);
      if (tab === null) return;
      const answered = questionAnswered(draft, index);
      const check = tab.querySelector(".icon");
      if (answered && check === null) tab.append(iconNode("check", "icon--sm"));
      else if (!answered && check !== null) check.remove();
    });
  }

  function focusOption(index, label) {
    if (promptDock === null) return;
    for (const input of promptDock.querySelectorAll(`input[name="prompt-option-${index}"]`)) {
      if (input instanceof HTMLInputElement && input.value === label) {
        input.focus();
        return;
      }
    }
  }

  function focusComposer() {
    if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
  }

  function focusDock() {
    if (promptDock === null || promptDock.hidden) {
      focusComposer();
      return;
    }
    const target = promptDock.querySelector("h2, h3, button, input, textarea");
    if (target instanceof HTMLElement) target.focus();
    else focusComposer();
  }

  function buildPromptHead(entry, label, metaText) {
    const head = element("div", "prompt-dock__head");
    const identity = element("div", "prompt-dock__identity");
    identity.append(element("p", "overline", label));
    if (metaText.length > 0) identity.append(element("span", "prompt-dock__count", metaText));
    const queueSize = Math.max(0, pendingForSession(entry.request.sessionID).length - 1);
    if (queueSize > 0) {
      identity.append(
        element(
          "span",
          "prompt-dock__queue-count",
          `${queueSize} more waiting`,
          ),
      );
    }
    if (promptStale || (liveEl !== null && liveEl.dataset.state === "paused")) {
      identity.append(element("span", "prompt-dock__queue-count", "Not updating"));
    }
    const collapse = element("button", "btn btn-ghost btn-icon btn-sm");
    collapse.type = "button";
    collapse.setAttribute("aria-expanded", dockCollapsed ? "false" : "true");
    collapse.setAttribute("aria-label", dockCollapsed ? "Expand request" : "Collapse request");
    collapse.title = dockCollapsed ? "Expand request" : "Collapse request";
    collapse.append(iconNode(dockCollapsed ? "chevron-right" : "chevron-down"));
    collapse.addEventListener("click", () => {
      dockCollapsed = !dockCollapsed;
      renderPromptDock();
      if (!composerHasDraft()) focusDock();
    });
    head.append(identity, collapse);
    return head;
  }

  function renderTabs(entry, draft, tabs) {
    const tabsEl = element("div", "prompt-dock__tabs");
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Questions");
    const questions = entry.request.questions;
    questions.forEach((question, index) => {
      const answered = questionAnswered(draft, index);
      const tab = element("button", "prompt-dock__tab");
      tab.type = "button";
      tab.dataset.promptTab = String(index);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", draft.index === index ? "true" : "false");
      tab.tabIndex = draft.index === index ? 0 : -1;
      tab.setAttribute("aria-controls", "chat-prompt-panel");
      const label = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
      tab.append(document.createTextNode(label));
      if (answered) tab.append(iconNode("check", "icon--sm"));
      tab.addEventListener("click", () => {
        draft.index = index;
        renderPromptDock();
        focusTab(index);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = (index + delta + tabs) % tabs;
        draft.index = next;
        renderPromptDock();
        focusTab(next);
      });
      tabsEl.append(tab);
    });
    if (tabs > questions.length) {
      const left = questions.filter((_, index) => !questionAnswered(draft, index)).length;
      const review = element("button", "prompt-dock__tab prompt-dock__tab--review");
      review.type = "button";
      review.dataset.promptReviewTab = "true";
      review.setAttribute("role", "tab");
      review.setAttribute("aria-selected", draft.index === questions.length ? "true" : "false");
      review.setAttribute("aria-controls", "chat-prompt-panel");
      review.tabIndex = draft.index === questions.length ? 0 : -1;
      review.append(
        document.createTextNode(left > 0 ? `Review · ${left} left` : "Review"),
      );
      review.addEventListener("click", () => {
        draft.index = questions.length;
        renderPromptDock();
        focusTab(questions.length);
      });
      tabsEl.append(review);
    }
    return tabsEl;
  }

  function focusTab(index) {
    if (promptDock === null) return;
    const tabs = Array.from(promptDock.querySelectorAll("[data-prompt-tab]"));
    const target = tabs.find((tab) => tab.dataset.promptTab === String(index));
    if (target instanceof HTMLElement) target.focus();
    else {
      const selected = promptDock.querySelector('[role="tab"][aria-selected="true"]');
      if (selected instanceof HTMLElement) selected.focus();
      else focusDock();
    }
  }

  function buildQuestionField(entry, draft, index) {
    const question = entry.request.questions[index];
    const fieldset = element("fieldset", "prompt-question");
    fieldset.id = "chat-prompt-panel";
    const legend = element("legend", "prompt-question__header");
    legend.textContent = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
    fieldset.append(legend);
    fieldset.append(element("p", "prompt-question__text", question.question));
    const group = element("div", "prompt-options");
    const inputType = question.multiple ? "checkbox" : "radio";
    question.options.forEach((option) => {
      const label = element("label", "prompt-option");
      const input = element("input", question.multiple ? "checkbox" : "radio");
      input.type = inputType;
      input.name = `prompt-option-${index}`;
      input.value = option.label;
      input.checked = draft.answers[index].includes(option.label);
      if (!question.multiple) input.dataset.single = "true";
      input.addEventListener("change", () => {
        if (question.multiple) {
          const current = draft.answers[index].filter((item) => item !== option.label);
          if (input.checked) current.push(option.label);
          draft.answers[index] = current;
        } else {
          draft.answers[index] = [option.label];
          draft.custom[index] = "";
        }
        renderPromptDock();
        focusOption(index, option.label);
      });
      const body = element("span", "prompt-option__body");
      body.append(element("span", "prompt-option__label", option.label));
      if (option.description.trim().length > 0) {
        body.append(element("span", "prompt-option__desc", option.description));
      }
      label.append(input, body);
      group.append(label);
    });
    fieldset.append(group);
    if (question.custom) {
      const custom = element("div", "prompt-custom");
      const customLabel = element("label", "label", "Other");
      customLabel.htmlFor = `prompt-custom-${index}`;
      const customInput = element("input", "input");
      customInput.type = "text";
      customInput.id = `prompt-custom-${index}`;
      customInput.dataset.promptCustom = String(index);
      customInput.value = draft.custom[index];
      customInput.placeholder = "Type a custom answer";
      customInput.addEventListener("input", () => {
        draft.custom[index] = customInput.value;
        if (!question.multiple && customInput.value.trim().length > 0) {
          draft.answers[index] = [];
          for (const input of fieldset.querySelectorAll('input[type="radio"]')) {
            input.checked = false;
          }
        }
        syncQuestionChrome(entry, draft);
      });
      custom.append(customLabel, customInput);
      fieldset.append(custom);
    }
    return fieldset;
  }

  function buildReview(entry, draft) {
    const wrap = element("div", "prompt-dock__review");
    wrap.id = "chat-prompt-panel";
    wrap.append(element("p", "overline", "Review answers"));
    const list = element("ol", "prompt-review-list");
    entry.request.questions.forEach((question, index) => {
      const item = element("li", "prompt-review");
      const body = element("div", "prompt-review__body");
      const header = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
      body.append(element("span", "prompt-review__header", header));
      const answers = answersForQuestion(draft, index);
      body.append(
        element(
          "span",
          answers.length > 0 ? "prompt-review__answer" : "prompt-review__answer is-empty",
          answers.length > 0 ? answers.join(", ") : "No answer",
        ),
      );
      const jump = element("button", "btn btn-ghost btn-sm", "Edit");
      jump.type = "button";
      jump.addEventListener("click", () => {
        draft.index = index;
        renderPromptDock();
        focusDock();
      });
      item.append(body, jump);
      list.append(item);
    });
    wrap.append(list);
    return wrap;
  }

  function buildQuestionActions(entry, draft, isReview) {
    const footer = element("div", "prompt-dock__foot");
    const left = element("div", "cluster");
    const dismiss = element("button", "btn btn-ghost btn-sm", "Dismiss");
    dismiss.type = "button";
    dismiss.disabled = promptBusy.has(entry.key);
    dismiss.addEventListener("click", () => {
      draft.confirm = draft.confirm === "dismiss" ? null : "dismiss";
      renderPromptDock();
    });
    left.append(dismiss);

    const right = element("div", "cluster");
    const steps = entry.request.questions.length;
    const busy = promptBusy.has(entry.key);
    const tooLarge = entry.request.tooLarge === true;

    if (!tooLarge) {
      if (isReview) {
        if (draft.index > 0) {
          const back = element("button", "btn btn-ghost btn-sm", "Back");
          back.type = "button";
          back.disabled = busy;
          back.addEventListener("click", () => {
            draft.index = Math.max(0, steps - 1);
            renderPromptDock();
            focusDock();
          });
          right.append(back);
        }
        const submit = element(
          "button",
          "btn btn-primary btn-sm",
          primaryActionLabel(entry, draft),
        );
        submit.type = "button";
        submit.dataset.promptPrimary = "true";
        submit.disabled = busy;
        submit.addEventListener("click", () => submitQuestion(entry));
        right.append(submit);
      } else if (draft.index < steps - 1) {
        const next = element("button", "btn btn-primary btn-sm prompt-dock__nav", "Next");
        next.type = "button";
        next.disabled = busy;
        next.addEventListener("click", () => {
          draft.index += 1;
          renderPromptDock();
          focusDock();
        });
        right.append(next);
      } else {
        const needsReview = steps > 1 || entry.request.questions[0].multiple === true;
        if (needsReview) {
          const review = element(
            "button",
            steps > 1 ? "btn btn-primary btn-sm prompt-dock__nav" : "btn btn-primary btn-sm",
            primaryActionLabel(entry, draft),
          );
          review.type = "button";
          review.dataset.promptPrimary = "true";
          review.disabled = busy;
          review.addEventListener("click", () => {
            draft.index = steps;
            renderPromptDock();
            focusDock();
          });
          right.append(review);
        } else {
          const submit = element(
            "button",
            "btn btn-primary btn-sm",
            primaryActionLabel(entry, draft),
          );
          submit.type = "button";
          submit.dataset.promptPrimary = "true";
          submit.disabled = busy;
          submit.addEventListener("click", () => submitQuestion(entry));
          right.append(submit);
        }
      }
    }
    footer.append(left, right);
    return footer;
  }

  function buildConfirm(entry, draft, kind) {
    const box = element("div", "prompt-confirm");
    box.setAttribute("role", "group");
    const text = element("p", "prompt-confirm__text");
    const actions = element("div", "cluster");
    if (kind === "dismiss") {
      text.textContent = "Dismiss this request? The agent continues without an answer.";
      const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        draft.confirm = null;
        renderPromptDock();
        focusDock();
      });
      const confirm = element("button", "btn btn-danger btn-sm", "Dismiss request");
      confirm.type = "button";
      confirm.addEventListener("click", () => dismissQuestion(entry));
      actions.append(cancel, confirm);
    } else {
      text.textContent = "Send without answering?";
      const body = element(
        "p",
        "prompt-confirm__body",
        "The agent receives an empty answer for the unanswered questions.",
      );
      box.append(body);
      const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        draft.confirm = null;
        renderPromptDock();
        focusDock();
      });
      const confirm = element("button", "btn btn-primary btn-sm", "Send without answering");
      confirm.type = "button";
      confirm.addEventListener("click", () => submitQuestion(entry));
      actions.append(cancel, confirm);
    }
    box.prepend(text);
    box.append(actions);
    return box;
  }

  function buildQuestionDock(entry) {
    const request = entry.request;
    const draft = questionDraft(entry);
    const steps = request.questions.length;
    const needsReview = steps > 1 || (request.questions[0] && request.questions[0].multiple === true);
    const tabs = needsReview ? steps + 1 : steps;
    if (draft.index >= tabs) draft.index = tabs - 1;
    const isReview = needsReview && draft.index === steps;
    const meta = isReview
      ? "Review"
      : steps > 0
        ? `Question ${Math.min(draft.index + 1, steps)} of ${steps}`
        : "Question";
    const card = element("article", "prompt-dock__card");
    card.dataset.kind = "question";
    const headingId = "chat-prompt-title";
    card.setAttribute("aria-labelledby", headingId);
    const head = buildPromptHead(entry, "Question", meta);
    head.querySelector(".prompt-dock__identity .overline").id = headingId;
    card.append(head);
    if (!dockCollapsed) {
      const body = element("div", "prompt-dock__body");
      if (request.tooLarge === true) {
        body.append(
          element("p", "prompt-dock__title", "This question is too large to answer."),
          element(
            "p",
            "prompt-dock__copy",
            request.tooLargeReason || "Its answers cannot be aligned safely.",
          ),
        );
      } else {
        if (tabs > 1) body.append(renderTabs(entry, draft, tabs));
        if (steps > 1 && !isReview) {
          const stepper = element("div", "prompt-dock__stepper");
          const prev = element("button", "btn btn-ghost btn-sm", "Back");
          prev.type = "button";
          prev.disabled = draft.index === 0;
          prev.addEventListener("click", () => {
            draft.index = Math.max(0, draft.index - 1);
            renderPromptDock();
            focusDock();
          });
          const label = element(
            "span",
            "prompt-dock__step-label",
            isReview ? "Review" : `Question ${draft.index + 1} of ${steps}`,
          );
          const next = element(
            "button",
            "btn btn-ghost btn-sm",
            isReview ? "Back" : draft.index === steps - 1 ? "Review" : "Next",
          );
          next.type = "button";
          next.disabled = isReview ? false : draft.index >= tabs - 1;
          next.addEventListener("click", () => {
            draft.index = isReview ? Math.max(0, steps - 1) : Math.min(tabs - 1, draft.index + 1);
            renderPromptDock();
            focusDock();
          });
          stepper.append(prev, label, next);
          body.append(stepper);
        }
        if (isReview) {
          body.append(buildReview(entry, draft));
        } else if (steps > 0) {
          body.append(buildQuestionField(entry, draft, draft.index));
        }
      }
      if (draft.confirm === "dismiss") {
        body.append(buildConfirm(entry, draft, "dismiss"));
      } else if (draft.confirm === "empty") {
        body.append(buildConfirm(entry, draft, "empty"));
      }
      const error = promptErrors.get(entry.key);
      if (error !== undefined) {
        const errorEl = element("p", "field-error prompt-dock__error", error);
        errorEl.setAttribute("role", "alert");
        body.append(errorEl);
      }
      card.append(body);
      if (draft.confirm !== "dismiss" && draft.confirm !== "empty") {
        card.append(buildQuestionActions(entry, draft, isReview));
      }
    }
    return card;
  }

  function permissionRisk(request) {
    if (
      ["external_directory", "bash", "edit", "write", "apply_patch", "task", "doom_loop"].includes(
        request.permission,
      )
    ) {
      return "high";
    }
    if (["webfetch", "websearch", "read", "glob", "grep", "list"].includes(request.permission)) {
      return "medium";
    }
    return "medium";
  }

  function riskChip(risk) {
    const labels = { high: "High risk", medium: "Medium risk", low: "Low risk" };
    const ticks = { high: 3, medium: 2, low: 1 };
    const chip = element("span", "risk-chip");
    chip.dataset.risk = risk;
    chip.append(iconNode(risk === "high" ? "alert-triangle" : "alert-circle", "icon--sm"));
    chip.append(document.createTextNode(labels[risk]));
    const meter = element("span", "risk-chip__meter");
    meter.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const tick = element("span", "risk-chip__tick");
      if (index < ticks[risk]) tick.dataset.on = "true";
      meter.append(tick);
    }
    chip.append(meter);
    return chip;
  }

  function permissionTitle(permission) {
    const titles = {
      bash: "Allow the agent to run this command?",
      edit: "Allow the agent to edit this file?",
      write: "Allow the agent to write this file?",
      apply_patch: "Allow the agent to apply this patch?",
      read: "Allow the agent to read this file?",
      glob: "Allow the agent to search these files?",
      grep: "Allow the agent to search file contents?",
      external_directory: "Allow the agent to reach outside the app?",
      webfetch: "Allow the agent to fetch this URL?",
      websearch: "Allow the agent to search the web?",
      doom_loop: "Allow the agent to repeat this tool call?",
    };
    return titles[permission] || `Allow the agent to use ${permission}?`;
  }

  function patternList(patterns) {
    const list = element("ul", "prompt-scope__list");
    for (const pattern of patterns) list.append(element("li", "mono", pattern));
    return list;
  }

  function metadataText(metadata, key) {
    const value = metadata[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
  }

  function evidencePre(text, className) {
    const pre = element("pre", className === undefined ? "prompt-evidence__pre" : className);
    pre.textContent = text;
    return pre;
  }

  function buildPermissionEvidence(request) {
    const wrap = element("div", "prompt-evidence");
    const metadata = request.metadata || {};
    const permission = request.permission;
    const rows = [];
    if (permission === "bash") {
      const command = metadataText(metadata, "command");
      if (command !== undefined) rows.push(["Command", evidencePre(command)]);
    } else if (permission === "edit" || permission === "write" || permission === "apply_patch") {
      const filepath = metadataText(metadata, "filepath");
      if (filepath !== undefined) rows.push(["File", element("span", "mono", filepath)]);
      const diff = metadataText(metadata, "diff");
      if (diff !== undefined) {
        rows.push(["Change", evidencePre(diff, "prompt-evidence__pre prompt-evidence__diff")]);
      }
    } else if (permission === "read" || permission === "glob" || permission === "grep") {
      if (request.patterns.length > 0) rows.push(["Path", patternList(request.patterns)]);
    } else if (permission === "webfetch") {
      const url = metadataText(metadata, "url");
      if (url !== undefined) rows.push(["URL", element("span", "mono", url)]);
      const format = metadataText(metadata, "format");
      if (format !== undefined) rows.push(["Format", element("span", "", format)]);
      const timeout = metadataText(metadata, "timeout");
      if (timeout !== undefined) rows.push(["Timeout", element("span", "", timeout)]);
    } else if (permission === "external_directory") {
      const filepath = metadataText(metadata, "filepath");
      if (filepath !== undefined) rows.push(["Path", element("span", "mono", filepath)]);
      const parentDir = metadataText(metadata, "parentDir");
      if (parentDir !== undefined) rows.push(["Parent", element("span", "mono", parentDir)]);
    } else if (permission === "doom_loop") {
      const tool = metadataText(metadata, "tool");
      if (tool !== undefined) rows.push(["Tool", element("span", "mono", tool)]);
      const input = metadata["input"];
      if (input !== undefined) {
        rows.push(["Input", evidencePre(JSON.stringify(input, null, 2))]);
      }
    } else {
      const entries = Object.entries(metadata);
      if (entries.length > 0) {
        const details = element("details", "prompt-evidence__details");
        details.append(element("summary", "", "Arguments"));
        details.append(evidencePre(JSON.stringify(metadata, null, 2)));
        rows.push([`${permission} arguments`, details]);
      }
    }
    if (rows.length === 0) return null;
    const dl = element("dl", "prompt-evidence__grid");
    for (const [label, value] of rows) {
      dl.append(element("dt", "prompt-evidence__label", label), element("dd", "prompt-evidence__value"));
      const dd = dl.lastElementChild;
      if (dd !== null) dd.append(value);
    }
    wrap.append(dl);
    return wrap;
  }

  function buildPermissionConfirm(entry, draft, kind) {
    const request = entry.request;
    const box = element("div", "prompt-confirm");
    box.setAttribute("role", "group");
    const text = element("p", "prompt-confirm__text");
    const actions = element("div", "cluster");
    const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      draft.confirm = null;
      renderPromptDock();
      focusDock();
    });
    if (kind === "always") {
      text.textContent =
        request.source === "v2"
          ? "Always allow is saved for this project until revoked."
          : "Always allow applies to this app instance until it restarts.";
      const body = element("div", "prompt-confirm__body");
      body.append(element("p", "caption", "This grants:"));
      body.append(patternList(request.always));
      if (request.source === "v2") {
        body.append(
          element(
            "p",
            "caption",
            "It may also resolve matching pending requests in other sessions of this app.",
          ),
        );
      }
      box.append(body);
      const confirm = element("button", "btn btn-primary btn-sm", "Always allow");
      confirm.type = "button";
      confirm.addEventListener("click", () => replyPermission(entry, "always"));
      actions.append(cancel, confirm);
    } else {
      text.textContent = "Deny this request?";
      const body = element("div", "prompt-confirm__body");
      body.append(
        element(
          "p",
          "caption",
          "Denying also rejects other pending permission requests in this session.",
        ),
      );
      const label = element("label", "label", "Feedback (optional)");
      label.htmlFor = "prompt-permission-feedback";
      const feedback = element("textarea", "textarea prompt-feedback");
      feedback.id = "prompt-permission-feedback";
      feedback.rows = 2;
      feedback.maxLength = 4000;
      feedback.value = draft.feedback;
      feedback.addEventListener("input", () => {
        draft.feedback = feedback.value;
      });
      body.append(label, feedback);
      box.append(body);
      const confirm = element("button", "btn btn-danger btn-sm", "Deny request");
      confirm.type = "button";
      confirm.addEventListener("click", () =>
        replyPermission(entry, "reject", draft.feedback.trim()),
      );
      actions.append(cancel, confirm);
    }
    box.prepend(text);
    box.append(actions);
    return box;
  }

  function buildPermissionDock(entry) {
    const request = entry.request;
    const draft = permissionDraft(entry);
    const risk = permissionRisk(request);
    const card = element("article", "prompt-dock__card");
    card.dataset.kind = "permission";
    const headingId = "chat-prompt-title";
    card.setAttribute("aria-labelledby", headingId);
    const head = buildPromptHead(entry, "Permission", "");
    const identity = head.querySelector(".prompt-dock__identity");
    const heading = identity === null ? null : identity.querySelector(".overline");
    if (heading !== null) heading.id = headingId;
    if (identity !== null) identity.append(riskChip(risk));
    card.append(head);
    if (!dockCollapsed) {
      const body = element("div", "prompt-dock__body");
      body.append(element("h3", "prompt-dock__title", permissionTitle(request.permission)));
      const scope = element("div", "prompt-scope");
      const thisRequest = element("div", "prompt-scope__row");
      thisRequest.append(element("span", "prompt-scope__label", "This request:"));
      if (request.patterns.length > 0) thisRequest.append(patternList(request.patterns));
      else thisRequest.append(element("span", "caption", "This request only."));
      scope.append(thisRequest);
      if (request.always.length > 0) {
        const always = element("div", "prompt-scope__row");
        always.append(element("span", "prompt-scope__label", "Always grants:"));
        always.append(patternList(request.always));
        scope.append(always);
      }
      const scopeNote = element(
        "p",
        "prompt-scope__note",
        request.source === "v2"
          ? "Saved for this project until revoked."
          : "For this app instance until restart.",
      );
      scope.append(scopeNote);
      if (request.source === "v2") {
        const openSaved = element(
          "button",
          "btn btn-secondary btn-sm prompt-scope__action",
          "Saved permissions",
        );
        openSaved.type = "button";
        openSaved.addEventListener("click", openSavedSection);
        scope.append(openSaved);
      }
      if (request.always.length === 0) {
        scope.append(
          element("p", "caption", "This request does not offer an always grant."),
        );
      }
      body.append(scope);
      const allPatterns = [...request.patterns, ...request.always];
      if (allPatterns.includes("*")) {
        const starCopy =
          request.permission === "external_directory"
            ? "The * pattern covers every outside path for this app/project. This is a high-risk grant."
            : request.permission === "bash"
              ? "The * pattern covers every parsed command. External-directory checks still apply where opencode performs them."
              : "The * pattern covers every request for this tool. It does not grant access outside the app.";
        body.append(element("p", "prompt-caveat", starCopy));
      }
      if (["edit", "write", "apply_patch", "read", "glob", "grep"].includes(request.permission)) {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "Paths outside the app are still checked by the external-directory policy.",
          ),
        );
      }
      if (request.permission === "bash" && request.always.length > 0) {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "Always grants the parsed command patterns shown above, not paths or URLs.",
          ),
        );
      }
      if (request.permission === "external_directory") {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "The external-directory policy normally denies this. Approving overrides it for this request.",
          ),
        );
      }
      const evidence = buildPermissionEvidence(request);
      if (evidence !== null) body.append(evidence);
      if (draft.confirm === "always") {
        body.append(buildPermissionConfirm(entry, draft, "always"));
      } else if (draft.confirm === "deny") {
        body.append(buildPermissionConfirm(entry, draft, "deny"));
      }
      const error = promptErrors.get(entry.key);
      if (error !== undefined) {
        const errorEl = element("p", "field-error prompt-dock__error", error);
        errorEl.setAttribute("role", "alert");
        body.append(errorEl);
      }
      card.append(body);
      const footer = element("div", "prompt-dock__foot");
      const left = element("div", "cluster");
      const deny = element("button", "btn btn-danger btn-sm", "Deny");
      deny.type = "button";
      deny.disabled = promptBusy.has(entry.key);
      deny.addEventListener("click", () => {
        draft.confirm = draft.confirm === "deny" ? null : "deny";
        renderPromptDock();
      });
      left.append(deny);
      const right = element("div", "cluster");
      const busy = promptBusy.has(entry.key);
      if (request.always.length > 0) {
        const always = element("button", "btn btn-secondary btn-sm", "Always allow");
        always.type = "button";
        always.disabled = busy;
        always.addEventListener("click", () => {
          draft.confirm = draft.confirm === "always" ? null : "always";
          renderPromptDock();
        });
        right.append(always);
      }
      const once = element(
        "button",
        "btn btn-primary btn-sm",
        busy ? "Sending reply…" : promptErrors.has(entry.key) ? "Try again" : "Allow once",
      );
      once.type = "button";
      once.disabled = busy;
      once.addEventListener("click", () => replyPermission(entry, "once"));
      right.append(once);
      if (draft.confirm === null) {
        footer.append(left, right);
        card.append(footer);
      }
    }
    return card;
  }

  function renderPromptDock() {
    if (promptDock === null) return;
    const entries = activePromptEntries();
    const wasHidden = promptDock.hidden;
    if (entries.length === 0) {
      promptDock.hidden = true;
      promptDock.replaceChildren();
      dockRequestKey = null;
      return;
    }
    const entry = entries[0];
    const changed = entry.key !== dockRequestKey;
    dockRequestKey = entry.key;
    promptDock.hidden = false;
    promptDock.replaceChildren(
      entry.kind === "question" ? buildQuestionDock(entry) : buildPermissionDock(entry),
    );
    if ((wasHidden || changed) && !composerHasDraft()) {
      focusDock();
    }
  }

  async function submitQuestion(entry) {
    if (promptBusy.has(entry.key)) return;
    const draft = questionDraft(entry);
    const answers = entry.request.questions.map((_, index) => answersForQuestion(draft, index));
    if (answers.some((answer) => answer.length === 0) && draft.confirm !== "empty") {
      draft.confirm = "empty";
      renderPromptDock();
      return;
    }
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptDock();
    try {
      await api(questionReplyUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: entry.request.source, answers }),
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce("Answer sent.");
      focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      renderQueue();
      syncComposer();
    }
  }

  async function dismissQuestion(entry) {
    if (promptBusy.has(entry.key)) return;
    const draft = questionDraft(entry);
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptDock();
    try {
      await api(questionRejectUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: entry.request.source }),
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce("Question dismissed.");
      focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      renderQueue();
      syncComposer();
    }
  }

  async function replyPermission(entry, reply, message) {
    if (promptBusy.has(entry.key)) return;
    const draft = permissionDraft(entry);
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptDock();
    try {
      const body = { source: entry.request.source, reply };
      if (typeof message === "string" && message.length > 0) body.message = message;
      await api(permissionReplyUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce(
        reply === "reject"
          ? "Permission denied."
          : reply === "always"
            ? "Permission always allowed."
            : "Permission allowed once.",
      );
      if (reply === "always" && entry.request.source === "v2") {
        loadSavedPermissions().catch(() => {});
      }
      focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      renderQueue();
      syncComposer();
    }
  }

  function updateInputNeeded() {
    const count = otherSessionPromptCount();
    if (inputNeeded !== null) {
      inputNeeded.hidden = count === 0;
      inputNeeded.setAttribute(
        "aria-label",
        count === 0
          ? "No requests need input"
          : `${count} ${count === 1 ? "request needs" : "requests need"} input`,
      );
    }
    if (inputNeededCount !== null) inputNeededCount.textContent = String(count);
    if (count === 0 && queueEl !== null && !queueEl.hidden) closeQueue(false);
    renderQueue();
  }

  function closeQueue(returnFocus) {
    if (queueEl === null) return;
    queueEl.hidden = true;
    if (inputNeeded !== null) inputNeeded.setAttribute("aria-expanded", "false");
    if (returnFocus === true && inputNeeded instanceof HTMLElement) inputNeeded.focus();
  }

  function openQueue() {
    if (queueEl === null) return;
    renderQueue();
    queueEl.hidden = false;
    if (inputNeeded !== null) inputNeeded.setAttribute("aria-expanded", "true");
    const first = queueEl.querySelector("button");
    if (first instanceof HTMLElement) first.focus();
  }

  function renderQueue() {
    if (queueList === null) return;
    const entries = [...prompts.values()].filter(
      (entry) => entry.request.sessionID !== sessionId,
    );
    if (entries.length === 0) {
      queueList.replaceChildren(
        element("p", "chat-queue__empty", "No other requests need input."),
      );
      return;
    }
    const list = document.createDocumentFragment();
    for (const entry of entries) {
      const session = sessions.find((candidate) => String(candidate.id) === entry.request.sessionID);
      const row = element("button", "chat-queue__row");
      row.type = "button";
      row.append(
        element("span", "chat-queue__kind", entry.kind === "question" ? "Question" : "Permission"),
        element(
          "span",
          "chat-queue__title",
          entry.kind === "question"
            ? entry.request.questions[0]?.header || "Agent question"
            : permissionTitle(entry.request.permission),
        ),
        element(
          "span",
          "chat-queue__session",
          session === undefined ? `Session ${entry.request.sessionID.slice(0, 8)}` : sessionLabel(session),
        ),
      );
      row.addEventListener("click", () => {
        closeQueue(false);
        selectSession(entry.request.sessionID, { focus: false, focusDock: true });
      });
      list.append(row);
    }
    queueList.replaceChildren(list);
  }

  async function loadSavedPermissions() {
    try {
      const data = await api(savedPermissionsUrl());
      applySavedPermissions(data);
    } catch (error) {
      void error;
    }
  }

  function applySavedPermissions(data) {
    const list = data && Array.isArray(data.permissions) ? data.permissions : [];
    const added = savedHydrated
      ? list.filter(
          (permission) =>
            !savedPermissions.some((existing) => existing.id === permission.id),
        )
      : [];
    savedPermissions = list.filter((permission) => permission && typeof permission.id === "string");
    savedHydrated = true;
    renderSavedPermissions();
    if (added.length > 0) {
      showSavedBadge();
      const first = added[0];
      announce(`New saved permission: ${first.action} ${first.resource}.`);
    }
  }

  function showSavedBadge() {
    if (savedBadge === null) return;
    savedBadge.hidden = false;
    window.clearTimeout(savedBadgeTimer);
    savedBadgeTimer = window.setTimeout(() => {
      if (savedBadge !== null) savedBadge.hidden = true;
    }, 8000);
  }

  function renderSavedPermissions() {
    if (savedSection === null || savedList === null) return;
    if (savedPermissions.length === 0) {
      savedSection.hidden = true;
      savedList.replaceChildren();
      return;
    }
    savedSection.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const permission of savedPermissions) {
      const row = element("div", "chat-saved__row");
      const meta = element("div", "chat-saved__meta");
      meta.append(
        element("span", "chat-saved__action mono", permission.action || "permission"),
        element("span", "chat-saved__resource mono", permission.resource || "*"),
        element(
          "span",
          "chat-saved__project mono",
          permission.projectID.length > 0 ? `project ${permission.projectID}` : "project unknown",
        ),
      );
      const actions = element("div", "chat-saved__actions");
      const revoke = element("button", "btn btn-ghost btn-sm", "Revoke");
      revoke.type = "button";
      revoke.setAttribute("aria-label", `Revoke ${permission.action || "saved permission"}`);
      revoke.addEventListener("click", () => {
        actions.replaceChildren();
        const question = element("span", "caption", "Revoke?");
        const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          actions.replaceChildren(revoke);
          revoke.focus();
        });
        const confirm = element("button", "btn btn-danger btn-sm", "Revoke");
        confirm.type = "button";
        confirm.addEventListener("click", () => revokeSavedPermission(permission, row));
        actions.append(question, cancel, confirm);
        confirm.focus();
      });
      actions.append(revoke);
      row.append(meta, actions);
      fragment.append(row);
    }
    savedList.replaceChildren(fragment);
  }

  async function revokeSavedPermission(permission, row) {
    row.setAttribute("aria-busy", "true");
    try {
      await api(savedPermissionUrl(permission.id), { method: "DELETE" });
      savedPermissions = savedPermissions.filter((item) => item.id !== permission.id);
      renderSavedPermissions();
      announce("Saved permission revoked.");
    } catch (error) {
      row.removeAttribute("aria-busy");
      announce(`Saved permission was not revoked: ${error.message || String(error)}`);
      renderSavedPermissions();
    }
  }

  function openSavedSection() {
    setContext(true, false);
    if (savedSection === null) return;
    savedSection.scrollIntoView({ block: "start" });
    const heading = savedSection.querySelector("h2");
    if (heading instanceof HTMLElement) heading.focus();
  }

  function applyPolicyWarnings(warnings) {
    const next = warnings
      .filter((warning) => typeof warning === "string")
      .map((warning) => warning.trim())
      .filter((warning) => warning.length > 0);
    for (const warning of [...dismissedWarnings]) {
      if (!next.includes(warning)) dismissedWarnings.delete(warning);
    }
    policyWarnings = next;
    renderPolicyWarnings();
  }

  function renderPolicyWarnings() {
    const visible = policyWarnings.filter((warning) => !dismissedWarnings.has(warning));
    if (policyWarning !== null) {
      policyWarning.hidden = visible.length === 0;
      if (visible.length > 0) {
        const content = document.createDocumentFragment();
        const lead = element("div", "policy-warning__lead");
        const mark = element("span", "policy-warning__mark");
        mark.append(iconNode("alert-triangle", "icon--sm"));
        lead.append(mark, element("span", "policy-warning__label", "Policy warning"));
        const list = element("ul", "policy-warning__list");
        for (const warning of visible) list.append(element("li", "", warning));
        content.append(lead, list);
        const dismiss = element("button", "btn btn-ghost btn-sm policy-warning__dismiss", "Dismiss");
        dismiss.type = "button";
        dismiss.addEventListener("click", () => {
          for (const warning of visible) dismissedWarnings.add(warning);
          renderPolicyWarnings();
          if (policyChip instanceof HTMLElement) policyChip.focus();
        });
        content.append(dismiss);
        policyWarning.replaceChildren(content);
      } else {
        policyWarning.replaceChildren();
      }
    }
    if (policyChip !== null) {
      const dismissed = policyWarnings.filter((warning) => dismissedWarnings.has(warning));
      policyChip.hidden = dismissed.length === 0;
      policyChip.setAttribute("aria-expanded", visible.length > 0 ? "true" : "false");
      if (policyChipLabel !== null) {
        policyChipLabel.textContent =
          dismissed.length === 1 ? "Policy warning" : `${dismissed.length} policy warnings`;
      }
    }
  }

  function updatePlanChip() {
    if (planChip === null) return;
    planChip.hidden = sessionId === null;
    if (planChipLabel !== null && planProgress !== null) {
      planChipLabel.textContent = `Plan ${planProgress.completed}/${planProgress.total}`;
    }
  }

  async function loadTodo(id) {
    if (id === null) {
      todoState = "idle";
      renderPlan();
      return;
    }
    const fetchSeq = ++todoFetchSeq;
    const eventSeq = todoEventSeq.get(id) || 0;
    todoState = todoCache.has(id) ? "ready" : "loading";
    renderPlan();
    try {
      const data = await api(todoUrl(id));
      if (fetchSeq !== todoFetchSeq || sessionId !== id) return;
      if ((todoEventSeq.get(id) || 0) !== eventSeq) return;
      todoCache.set(id, {
        todos: data && Array.isArray(data.todos) ? data.todos : [],
        truncated: data && data.truncated === true,
      });
      todoState = "ready";
      renderPlan();
    } catch (error) {
      if (fetchSeq !== todoFetchSeq || sessionId !== id) return;
      if ((todoEventSeq.get(id) || 0) !== eventSeq) return;
      void error;
      todoState = "error";
      renderPlan();
    }
  }

  function planStatus(status) {
    const map = {
      pending: { icon: "clock", label: "Pending" },
      in_progress: { icon: "activity", label: "Now" },
      completed: { icon: "check", label: "Done" },
      cancelled: { icon: "slash", label: "Dropped" },
      unknown: { icon: "alert-circle", label: "Unknown" },
    };
    return map[status] || map.unknown;
  }

  function priorityMeter(priority) {
    const ticks = { high: 3, medium: 2, low: 1, unknown: 0 };
    const meter = element("span", "chat-plan__priority");
    meter.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const tick = element("span", "chat-plan__tick");
      if (index < (ticks[priority] || 0)) tick.dataset.on = "true";
      meter.append(tick);
    }
    return meter;
  }

  function renderPlan() {
    if (planList === null || planEmpty === null || planSummary === null) return;
    if (sessionId === null) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Send a message to start a session.";
      planList.hidden = true;
      planList.replaceChildren();
      planSummary.textContent = "No plan yet";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    const cached = todoCache.get(sessionId);
    const paused = liveEl !== null && liveEl.dataset.state === "paused";
    if (todoState === "loading" && cached === undefined) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Loading plan…";
      planList.hidden = true;
      planSummary.textContent = "Loading";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    if (todoState === "error" && cached === undefined) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Not updating";
      planList.hidden = true;
      planSummary.textContent = "Not updating";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    const todos = cached === undefined ? [] : cached.todos;
    if (todos.length === 0) {
      planEmpty.hidden = false;
      planEmpty.textContent = "No plan yet";
      planList.hidden = true;
      planList.replaceChildren();
      planSummary.textContent = "No plan yet";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let cancelled = 0;
    for (const todo of todos) {
      if (todo.status === "pending") pending += 1;
      else if (todo.status === "in_progress") inProgress += 1;
      else if (todo.status === "completed") completed += 1;
      else if (todo.status === "cancelled") cancelled += 1;
    }
    const total = pending + inProgress + completed;
    planProgress = { completed, total };
    planEmpty.hidden = true;
    planList.hidden = false;
    const fragment = document.createDocumentFragment();
    let currentMarked = false;
    for (const todo of todos) {
      const item = element("li", "chat-plan__item");
      item.dataset.status = todo.status;
      const status = planStatus(todo.status);
      if (todo.status === "in_progress" && !currentMarked) {
        item.setAttribute("aria-current", "step");
        currentMarked = true;
      }
      const glyph = element("span", "chat-plan__status");
      glyph.append(iconNode(status.icon, "icon--sm"), document.createTextNode(status.label));
      const body = element("div", "chat-plan__body");
      body.append(element("span", "chat-plan__content", todo.content));
      const priority = element(
        "span",
        "chat-plan__priority-label",
        `Priority: ${todo.priority}`,
      );
      priority.classList.add("sr-only");
      body.append(priority);
      item.append(glyph, body, priorityMeter(todo.priority));
      fragment.append(item);
    }
    planList.replaceChildren(fragment);
    let summary;
    if (total === 0) summary = "No active steps";
    else if (completed === total) summary = "All steps complete";
    else summary = `${completed} of ${total} complete`;
    if (cancelled > 0) summary += ` · ${cancelled} cancelled`;
    if (paused) summary = "Not updating";
    else if (todoState === "error") summary = "Not updating";
    planSummary.textContent = summary;
    if (summary !== lastPlanSummary) {
      lastPlanSummary = summary;
      if (todoState === "ready") announce(`Plan: ${summary}.`);
    }
    updatePlanChip();
  }

  async function loadMessages(options) {
    const settings = options || {};
    const target = typeof settings.session === "string" ? settings.session : sessionId;
    if (target === null) return;
    const active = target === sessionId;
    const sequence = active ? ++loadSequence : 0;
    const atBottom = isAtBottom();
    const previousScroll = scrollEl === null ? 0 : scrollEl.scrollTop;
    const previousCount = messages.length;
    if (settings.initial) showMessagesLoading();
    try {
      const data = await api(messagesUrl(target));
      if (active && (sequence !== loadSequence || sessionId !== target)) return;
      if (!active) return;
      messages = Array.isArray(data.messages) ? data.messages : [];
      renderMessages({
        initial: settings.initial === true,
        atBottom,
        previousScroll,
        previousCount,
        forceBottom: settings.forceBottom === true,
      });
      if (settings.initial) setLive("Live", "live");
      setRuntime("running");
    } catch (error) {
      if (active && (sequence !== loadSequence || sessionId !== target)) return;
      if (!active) return;
      if (settings.silent) {
        setLive("Reconnecting", "reconnecting");
        return;
      }
      showThreadError(error, () => loadMessages({ initial: true }));
    }
  }

  async function refreshSessions() {
    try {
      const data = await api(sessionsUrl());
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sessions.length === 0) {
        if (sessionId !== null) startDraft({ focus: false });
        else showSessionsEmpty();
        return;
      }
      if (sessionId === null || !sessions.some((session) => session.id === sessionId)) {
        sessionId = String(sessions[0].id);
      }
      renderSessions();
      const current = sessions.find((session) => session.id === sessionId);
      if (current !== undefined && sessionTitleEl !== null) {
        sessionTitleEl.textContent = sessionLabel(current);
      }
    } catch (error) {
      showSessionsError(error, () => refreshSessions());
    }
  }

  function updateUrl() {
    const params = new URLSearchParams();
    params.set("app", appKey);
    if (projectId.length > 0) params.set("project", projectId);
    if (sessionId !== null) params.set("session", sessionId);
    window.history.replaceState(null, "", `/chat?${params.toString()}`);
  }

  async function selectSession(id, options) {
    const settings = options || {};
    sessionId = id;
    const session = sessions.find((candidate) => candidate.id === id);
    if (sessionTitleEl !== null) {
      sessionTitleEl.textContent = session === undefined ? `Session ${id.slice(0, 8)}` : sessionLabel(session);
    }
    if (sessionIdEl !== null) {
      sessionIdEl.textContent = id.slice(0, 8);
      sessionIdEl.title = id;
    }
    updateUrl();
    renderSessions();
    renderPromptDock();
    loadTodo(id).catch(() => {});
    syncComposer();
    closeSessions(false);
    closeContext(false);
    setLive("Loading messages", "reconnecting");
    await loadMessages({ initial: true });
    if (settings.focusDock === true) {
      focusDock();
    } else if (settings.focus === true) {
      if (activePromptEntries().length > 0) focusDock();
      else if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
    }
  }

  function startDraft(options) {
    const settings = options || {};
    loadSequence += 1;
    sessionId = null;
    messages = [];
    showSessionError(null);
    if (sessionTitleEl !== null) sessionTitleEl.textContent = "New session";
    if (sessionIdEl !== null) {
      sessionIdEl.textContent = "-";
      sessionIdEl.removeAttribute("title");
    }
    updateUrl();
    renderSessions();
    renderMessages({
      initial: true,
      atBottom: true,
      previousScroll: 0,
      previousCount: 0,
    });
    setLive("Ready", "idle");
    renderPromptDock();
    loadTodo(null).catch(() => {});
    syncComposer();
    setRuntime("running");
    closeSessions(false);
    closeContext(false);
    if (settings.focus === true && promptEl instanceof HTMLTextAreaElement) {
      promptEl.focus();
    }
  }

  async function ensureSession() {
    if (sessionId !== null) return sessionId;
    if (creatingSession) throw new Error("A session is already starting.");
    creatingSession = true;
    setNewSessionBusy(true);
    try {
      const created = await api(sessionsUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!created || created.id === undefined) {
        throw new Error("Session could not be created.");
      }
      const id = String(created.id);
      sessions = [created, ...sessions.filter((session) => String(session.id) !== id)];
      if (sessionSearch !== null) sessionSearch.value = "";
      sessionId = id;
      if (sessionTitleEl !== null) sessionTitleEl.textContent = sessionLabel(created);
      if (sessionIdEl !== null) {
        sessionIdEl.textContent = id.slice(0, 8);
        sessionIdEl.title = id;
      }
      updateUrl();
      renderSessions();
      closeSessions(false);
      showSessionError(null);
      setLive("Starting agent...", "starting");
      return id;
    } finally {
      creatingSession = false;
      setNewSessionBusy(creatingSession);
    }
  }

  async function removeSession(id) {
    if (deletingSessions.has(id)) return;
    const session = sessions.find((candidate) => String(candidate.id) === id);
    const label = session === undefined ? `Session ${id.slice(0, 8)}` : sessionLabel(session);
    if (!window.confirm(`Delete session "${label}"? This cannot be undone.`)) {
      return;
    }
    deletingSessions.add(id);
    showSessionError(null);
    renderSessions();
    try {
      await api(sessionUrl(id), { method: "DELETE" });
      const wasActive = sessionId === id;
      sessions = sessions.filter((candidate) => String(candidate.id) !== id);
      deletingSessions.delete(id);
      if (wasActive) {
        if (sessions.length > 0) {
          await selectSession(String(sessions[0].id), { focus: false });
        } else {
          startDraft({ focus: false });
        }
      } else {
        renderSessions();
      }
    } catch (error) {
      deletingSessions.delete(id);
      showSessionError(error.message || String(error));
      renderSessions();
    }
  }

  async function bootSessions() {
    setLive("Starting agent...", "starting");
    showSessionsLoading();
    showMessagesLoading();
    showSessionError(null);
    try {
      const data = await api(sessionsUrl());
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderSessions();
      if (sessions.length === 0) {
        startDraft({ focus: false });
        return;
      }
      const requested = new URLSearchParams(window.location.search).get("session");
      const wanted =
        requested !== null && sessions.some((session) => session.id === requested)
          ? requested
          : sessionId !== null && sessions.some((session) => session.id === sessionId)
            ? sessionId
            : String(sessions[0].id);
      await selectSession(wanted, { focus: false });
    } catch (error) {
      showSessionsError(error, bootSessions);
      showThreadError(error, bootSessions);
    }
  }

  function resizePrompt() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    promptEl.style.height = "auto";
    promptEl.style.height = `${promptEl.scrollHeight}px`;
  }

  function showSendError(message) {
    if (sendError === null) return;
    sendError.hidden = message === null;
    sendError.textContent = message === null ? "" : message;
    if (promptEl instanceof HTMLTextAreaElement) {
      if (message === null) {
        promptEl.removeAttribute("aria-invalid");
        promptEl.setAttribute("aria-describedby", "chat-composer-hint");
      } else {
        promptEl.setAttribute("aria-invalid", "true");
        promptEl.setAttribute(
          "aria-describedby",
          "chat-composer-hint chat-send-error",
        );
      }
    }
  }

  async function sendPrompt() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    if (hasActiveSend()) return;
    if (activePromptEntries().length > 0) {
      focusDock();
      return;
    }
    const text = promptEl.value.trim();
    if (text.length === 0) {
      promptEl.focus();
      return;
    }
    const draft = promptEl.value;
    const initialSession = sessionId;
    let pendingKey = initialSession === null ? "draft" : initialSession;
    if (pendingSends.has(pendingKey)) return;
    pendingSends.add(pendingKey);
    showSendError(null);
    showSessionError(null);
    syncComposer();
    promptEl.value = "";
    resizePrompt();
    let sentId = initialSession;
    try {
      const id = await ensureSession();
      sentId = id;
      if (pendingKey === "draft") {
        pendingSends.delete("draft");
        pendingKey = id;
        pendingSends.add(id);
      }
      syncComposer();
      await api(messagesUrl(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await loadMessages({ forceBottom: true, session: id });
      await refreshSessions();
      setRuntime("running");
      if (eventSource !== null && eventSource.readyState === 1) {
        setLive("Live", "live");
      }
      if (sessionId === id) promptEl.focus();
    } catch (error) {
      if (sessionId === sentId) {
        promptEl.value = draft;
        resizePrompt();
        showSendError(error.message || String(error));
        promptEl.focus();
      } else {
        announce(`Message failed: ${error.message || String(error)}`);
      }
    } finally {
      pendingSends.delete(pendingKey);
      if (sentId !== null) pendingSends.delete(sentId);
      syncComposer();
    }
  }

  function contextOpen() {
    return shell.dataset.chatContext === "open";
  }

  function sessionsOpen() {
    return shell.dataset.chatSessions === "open";
  }

  function setToggleExpanded(toggles, expanded) {
    for (const toggle of toggles) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function closeGlobalNav() {
    const appShell = document.getElementById("shell");
    const toggle = document.querySelector("[data-nav-toggle]");
    if (appShell !== null && appShell.dataset.nav === "open") {
      appShell.dataset.nav = "closed";
      if (toggle !== null) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open navigation");
      }
    }
  }

  function setContext(open, returnFocus) {
    shell.dataset.chatContext = open ? "open" : "closed";
    setToggleExpanded(contextToggles, open);
    if (open) {
      closeSessions(false);
      closeGlobalNav();
      if (contextClose instanceof HTMLElement) contextClose.focus();
    } else if (returnFocus === true) {
      const toggle = contextToggles[0];
      if (toggle instanceof HTMLElement) toggle.focus();
    }
  }

  function setSessions(open, returnFocus) {
    shell.dataset.chatSessions = open ? "open" : "closed";
    setToggleExpanded(sessionsToggles, open);
    if (open) {
      closeContext(false);
      closeGlobalNav();
      if (sessionsClose instanceof HTMLElement) sessionsClose.focus();
    } else if (returnFocus === true) {
      const toggle = sessionsToggles[0];
      if (toggle instanceof HTMLElement) toggle.focus();
    }
  }

  function closeContext(returnFocus) {
    setContext(false, returnFocus);
  }

  function closeSessions(returnFocus) {
    setSessions(false, returnFocus);
  }

  for (const toggle of contextToggles) {
    toggle.addEventListener("click", () => setContext(!contextOpen(), false));
  }
  for (const toggle of sessionsToggles) {
    toggle.addEventListener("click", () => setSessions(!sessionsOpen(), false));
  }
  if (contextClose instanceof HTMLElement) {
    contextClose.addEventListener("click", () => closeContext(true));
  }
  if (sessionsClose instanceof HTMLElement) {
    sessionsClose.addEventListener("click", () => closeSessions(true));
  }
  if (scrim instanceof HTMLElement) {
    scrim.addEventListener("click", () => {
      if (contextOpen()) closeContext(true);
      else if (sessionsOpen()) closeSessions(true);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const entry = activePromptEntries()[0];
    if (entry !== undefined) {
      const draft = entry.kind === "question" ? questionDraft(entry) : permissionDraft(entry);
      if (draft.confirm !== null) {
        draft.confirm = null;
        renderPromptDock();
        event.preventDefault();
        return;
      }
      if (entry.kind === "question") {
        const steps = entry.request.questions.length;
        const needsReview = steps > 1 || entry.request.questions[0].multiple === true;
        if (needsReview && draft.index === steps) {
          draft.index = Math.max(0, steps - 1);
          renderPromptDock();
          event.preventDefault();
          return;
        }
      }
    }
    if (queueEl !== null && !queueEl.hidden) {
      event.preventDefault();
      closeQueue(true);
      return;
    }
    if (contextOpen()) {
      event.preventDefault();
      closeContext(true);
    } else if (sessionsOpen()) {
      event.preventDefault();
      closeSessions(true);
    }
  });
  const navToggle = document.querySelector("[data-nav-toggle]");
  if (navToggle !== null) {
    navToggle.addEventListener("click", () => {
      closeContext(false);
      closeSessions(false);
    });
  }
  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 1360px)").matches && contextOpen()) closeContext(false);
    if (window.matchMedia("(min-width: 768px)").matches && sessionsOpen()) closeSessions(false);
  });

  if (sessionSearch !== null) {
    sessionSearch.addEventListener("input", renderSessions);
  }
  for (const button of newSessionButtons()) {
    button.addEventListener("click", () => {
      if (!creatingSession) startDraft({ focus: true });
    });
  }
  if (appSelect instanceof HTMLSelectElement) {
    appSelect.addEventListener("change", () => {
      const option = appSelect.selectedOptions[0];
      const project = option === undefined ? "" : option.dataset.project || "";
      const app = option === undefined ? "" : option.dataset.app || "";
      if (project.length > 0 && app.length > 0) {
        window.location.href = `/chat?app=${encodeURIComponent(app)}&project=${encodeURIComponent(project)}`;
      }
    });
  }
  if (promptEl instanceof HTMLTextAreaElement) {
    promptEl.addEventListener("input", resizePrompt);
    promptEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || !event.shiftKey) {
        event.preventDefault();
        sendPrompt();
      }
    });
    resizePrompt();
  }
  if (composer !== null) {
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      sendPrompt();
    });
  }
  if (scrollEl !== null) {
    scrollEl.addEventListener("scroll", () => {
      stickToBottom = isAtBottom();
      if (stickToBottom && newMessages !== null) newMessages.hidden = true;
    });
  }
  if (newMessages !== null) {
    newMessages.addEventListener("click", () => {
      if (scrollEl !== null) scrollEl.scrollTop = scrollEl.scrollHeight;
      newMessages.hidden = true;
      stickToBottom = true;
      if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
    });
  }
  if (promptDock !== null) {
    promptDock.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      const entry = activePromptEntries()[0];
      if (entry === undefined || entry.kind !== "question") return;
      event.preventDefault();
      submitQuestion(entry);
    });
  }
  if (inputNeeded !== null) {
    inputNeeded.addEventListener("click", () => {
      if (queueEl !== null && !queueEl.hidden) closeQueue(true);
      else openQueue();
    });
  }
  if (queueClose instanceof HTMLElement) {
    queueClose.addEventListener("click", () => closeQueue(true));
  }
  if (policyChip !== null) {
    policyChip.addEventListener("click", () => {
      dismissedWarnings.clear();
      renderPolicyWarnings();
      if (policyWarning !== null && !policyWarning.hidden) {
        policyWarning.scrollIntoView({ block: "nearest" });
        const dismiss = policyWarning.querySelector("button");
        if (dismiss instanceof HTMLElement) dismiss.focus();
      }
    });
  }
  if (planChip !== null) {
    planChip.addEventListener("click", () => {
      setContext(true, false);
      window.setTimeout(() => {
        if (planSection !== null) planSection.scrollIntoView({ block: "start" });
        if (planHeading instanceof HTMLElement) planHeading.focus();
      }, 220);
    });
  }
  if (streamRetry !== null) {
    streamRetry.addEventListener("click", () => {
      streamRetry.hidden = true;
      subscribe();
      hydrate().catch(() => {});
      loadMessages({ silent: true }).catch(() => {});
    });
  }
  window.addEventListener("beforeunload", closeStream);

  bootSessions();
  subscribe();
  hydrate().catch(() => {});
})();
