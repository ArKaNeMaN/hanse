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

  let sessions = [];
  let sessionId = null;
  let messages = [];
  let eventSource = null;
  let reloadTimer = null;
  let failures = 0;
  let sending = false;
  let creatingSession = false;
  let stickToBottom = true;
  let loadSequence = 0;
  let renderSequence = 0;

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

  function messagesUrl(id) {
    const session = id === undefined ? sessionId : id;
    return withProject(
      `${apiBase()}/sessions/${encodeURIComponent(session || "")}/messages`,
    );
  }

  function eventsUrl(id) {
    return withProject(
      `${apiBase()}/sessions/${encodeURIComponent(id)}/events`,
    );
  }

  async function api(url, options) {
    const response = await fetch(url, { cache: "no-store", ...(options || {}) });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") {
          message = parsed.error;
        }
      } catch (error) {
        void error;
      }
      throw new Error(message.slice(0, 400) || `Request failed (${response.status})`);
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
      element("p", "chat-empty", "No sessions yet. Start a new session."),
    );
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
      const button = element("button", "session-item");
      button.type = "button";
      button.dataset.sessionId = String(session.id);
      const active = session.id === sessionId;
      if (active) {
        button.classList.add("is-active");
        button.setAttribute("aria-current", "true");
      }
      const top = element("span", "session-item__top");
      top.append(element("span", "session-item__title", sessionLabel(session)));
      if (active) top.append(iconNode("check", "icon--sm"));
      const meta = element("span", "session-item__meta");
      meta.append(element("span", "mono", String(session.id).slice(0, 8)));
      const stamp = relativeTime(sessionTimestamp(session));
      if (stamp.length > 0) meta.append(element("span", "", stamp));
      button.append(top, meta);
      button.addEventListener("click", () => {
        selectSession(String(session.id), { focus: true });
      });
      list.append(button);
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
    if (sessionId === null) return;
    failures = 0;
    if (!("EventSource" in window)) {
      setLive("Paused", "paused");
      return;
    }
    eventSource = new EventSource(eventsUrl(sessionId));
    eventSource.onopen = () => {
      failures = 0;
      setLive("Live", "live");
    };
    eventSource.onmessage = () => scheduleReload();
    eventSource.onerror = () => {
      failures += 1;
      if (failures >= 3) {
        closeStream();
        setLive("Paused", "paused");
      } else {
        setLive("Reconnecting", "reconnecting");
      }
    };
  }

  async function loadMessages(options) {
    if (sessionId === null) return;
    const settings = options || {};
    const sequence = ++loadSequence;
    const atBottom = isAtBottom();
    const previousScroll = scrollEl === null ? 0 : scrollEl.scrollTop;
    const previousCount = messages.length;
    if (settings.initial) showMessagesLoading();
    try {
      const data = await api(messagesUrl());
      if (sequence !== loadSequence) return;
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
      if (sequence !== loadSequence) return;
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
        showSessionsEmpty();
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
    closeSessions(false);
    closeContext(false);
    setLive("Loading messages", "reconnecting");
    await loadMessages({ initial: true });
    subscribe();
    if (settings.focus === true && promptEl instanceof HTMLTextAreaElement) {
      promptEl.focus();
    }
  }

  async function createSession() {
    if (creatingSession) return;
    creatingSession = true;
    setNewSessionBusy(true);
    try {
      const created = await api(sessionsUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (created && created.id !== undefined) {
        if (sessionSearch !== null) sessionSearch.value = "";
        sessions = [created, ...sessions.filter((session) => session.id !== created.id)];
        renderSessions();
        await selectSession(String(created.id), { focus: true });
      }
    } catch (error) {
      showSessionsError(error, () => createSession());
      showThreadError(error, () => createSession());
    } finally {
      creatingSession = false;
      setNewSessionBusy(false);
    }
  }

  async function bootSessions() {
    setLive("Starting agent...", "starting");
    showSessionsLoading();
    showMessagesLoading();
    try {
      let data = await api(sessionsUrl());
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sessions.length === 0) {
        const created = await api(sessionsUrl(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (created && created.id !== undefined) sessions = [created];
      }
      if (sessions.length === 0) {
        showSessionsEmpty();
        showThreadError(new Error("No session could be created."), bootSessions);
        return;
      }
      const requested = new URLSearchParams(window.location.search).get("session");
      const wanted =
        requested !== null && sessions.some((session) => session.id === requested)
          ? requested
          : sessionId !== null && sessions.some((session) => session.id === sessionId)
            ? sessionId
            : String(sessions[0].id);
      sessions = sessions;
      renderSessions();
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
    if (sending || !(promptEl instanceof HTMLTextAreaElement)) return;
    if (sessionId === null) {
      showSendError("Session is still starting. Try again in a moment.");
      return;
    }
    const text = promptEl.value.trim();
    if (text.length === 0) {
      promptEl.focus();
      return;
    }
    sending = true;
    setWorking(true);
    setBusy(sendButton, true);
    showSendError(null);
    const draft = promptEl.value;
    promptEl.value = "";
    resizePrompt();
    try {
      await api(messagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await loadMessages({ forceBottom: true });
      await refreshSessions();
      setRuntime("running");
      if (eventSource !== null && eventSource.readyState === 1) {
        setLive("Live", "live");
      }
      promptEl.focus();
    } catch (error) {
      promptEl.value = draft;
      resizePrompt();
      showSendError(error.message || String(error));
      promptEl.focus();
    } finally {
      sending = false;
      setWorking(false);
      setBusy(sendButton, false);
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
    button.addEventListener("click", () => createSession());
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
  if (streamRetry !== null) {
    streamRetry.addEventListener("click", () => {
      streamRetry.hidden = true;
      subscribe();
      loadMessages({ silent: true }).catch(() => {});
    });
  }
  window.addEventListener("beforeunload", closeStream);

  bootSessions();
})();
