(() => {
  "use strict";

  const root = document.getElementById("terminal");
  if (!root) return;
  const host = document.getElementById("terminal-host");
  const status = document.getElementById("terminal-status");
  const banner = document.getElementById("terminal-banner");
  const announcer = document.getElementById("terminal-announcer");
  const copyButton = document.getElementById("terminal-copy");
  const reconnectButton = document.getElementById("terminal-reconnect");
  const closeButton = document.getElementById("terminal-close");
  const wsPath = root.dataset.terminalWs;
  const runtimeUrl = root.dataset.runtimeUrl;
  const appKey = root.dataset.appKey ?? "";
  const projectId = root.dataset.projectId ?? "";
  if (!host || !status || !banner || !announcer || !wsPath || !runtimeUrl) return;

  const INPUT_CHUNK = 16 * 1024;
  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const chatHref = `/chat?app=${encodeURIComponent(appKey)}&project=${encodeURIComponent(projectId)}`;

  const STATUS = {
    connecting: { label: "Connecting", state: "queued", icon: "loader" },
    live: { label: "Live", state: "in_progress", icon: "activity" },
    reconnecting: { label: "Reconnecting", state: "dispatching", icon: "refresh" },
    paused: { label: "Paused", state: "cancelled", icon: "slash" },
    stopped: { label: "Agent stopped", state: "queued", icon: "clock" },
    closed: { label: "Terminal closed", state: "cancelled", icon: "slash" },
    exited: { label: "Shell exited", state: "cancelled", icon: "slash" },
    failed: { label: "Connection failed", state: "failed", icon: "alert-triangle" },
  };

  let term = null;
  let fitAddon = null;
  let socket = null;
  let connectedOnce = false;
  let closedByOperator = false;
  let generation = 0;
  let retryAttempt = 0;
  let retryFailure = false;
  let retryTimer = 0;
  let countdownTimer = 0;
  let retryDeadline = 0;
  let fitFrame = 0;
  let fitForce = false;
  let lastCols = 0;
  let lastRows = 0;
  let copyUnavailable = false;
  let disposed = false;

  /* ---------------------------------------------------------------------- */
  /* Design tokens                                                          */
  /* ---------------------------------------------------------------------- */

  function tokenValue(property, name) {
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.setProperty(property, `var(${name})`);
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).getPropertyValue(property).trim();
    probe.remove();
    if (computed.length > 0) return computed;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function color(name) {
    return tokenValue("color", name);
  }

  function readTheme() {
    return {
      background: color("--inset"),
      foreground: color("--text-1"),
      cursor: color("--brass"),
      cursorAccent: color("--inset"),
      selectionBackground: color("--selection"),
      selectionForeground: color("--text-1"),
      black: color("--text-2"),
      red: color("--status-failed"),
      green: color("--status-delivered"),
      yellow: color("--status-awaiting"),
      blue: color("--status-dispatching"),
      magenta: color("--status-expired"),
      cyan: color("--status-in-progress"),
      white: color("--text-1"),
      brightBlack: color("--text-3"),
      brightRed: color("--danger"),
      brightGreen: color("--success"),
      brightYellow: color("--warning"),
      brightBlue: color("--info"),
      brightMagenta: color("--brass"),
      brightCyan: color("--status-in-progress"),
      brightWhite: color("--text-1"),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Status and banner                                                      */
  /* ---------------------------------------------------------------------- */

  let statusKind = null;

  function renderStatus(kind, detail) {
    const meta = STATUS[kind];
    if (!meta) return;
    status.dataset.state = meta.state;
    if (statusKind !== kind) {
      statusKind = kind;
      status.className = "status";
      status.innerHTML = `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${meta.icon}" /></svg><span>${meta.label}</span><span data-status-detail aria-hidden="true"></span>`;
    }
    const detailNode = status.querySelector("[data-status-detail]");
    if (detailNode) detailNode.textContent = detail ? ` ${detail}` : "";
  }

  function setBanner(text) {
    if (text === null) {
      if (!banner.hidden) {
        banner.hidden = true;
        scheduleFit(false);
      }
      return;
    }
    if (banner.hidden || banner.textContent !== text) {
      banner.hidden = false;
      banner.textContent = text;
      scheduleFit(false);
    }
  }

  function announce(text) {
    announcer.textContent = text;
  }

  function updateCopyButton() {
    if (!copyButton) return;
    const available =
      !copyUnavailable &&
      ((navigator.clipboard && typeof navigator.clipboard.writeText === "function") ||
        typeof document.execCommand === "function");
    const hasSelection = term !== null && term.hasSelection();
    copyButton.disabled = !available || !hasSelection;
    copyButton.title = !available
      ? "Copy is unavailable in this browser"
      : hasSelection
        ? "Copy selection"
        : "Select terminal text to copy";
  }

  /* ---------------------------------------------------------------------- */
  /* Clipboard                                                              */
  /* ---------------------------------------------------------------------- */

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.insetBlockStart = "-1000px";
    area.style.insetInlineStart = "-1000px";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    if (term) term.focus();
    return copied;
  }

  async function copySelection() {
    if (!term) return;
    const selection = term.getSelection();
    if (selection.length === 0) return;
    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(selection);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) copied = fallbackCopy(selection);
    if (copied) {
      announce("Copied selection.");
    } else {
      copyUnavailable = true;
      updateCopyButton();
    }
  }

  async function pasteClipboard() {
    if (!term || !navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      return false;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) {
        term.paste(text);
        term.focus();
      }
      return true;
    } catch {
      return false;
    }
  }

  function handleKeyEvent(event) {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    const copyCombo =
      (event.ctrlKey && event.shiftKey && key === "c") ||
      (event.metaKey && !event.ctrlKey && key === "c");
    if (copyCombo) {
      if (term && term.hasSelection()) {
        void copySelection();
        return false;
      }
      return true;
    }
    const pasteCombo =
      (event.ctrlKey && event.shiftKey && key === "v") ||
      (event.metaKey && !event.ctrlKey && key === "v");
    if (pasteCombo) {
      if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        void pasteClipboard();
        return false;
      }
      return true;
    }
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Input and resize                                                       */
  /* ---------------------------------------------------------------------- */

  function sendBytes(bytes) {
    if (socket === null || socket.readyState !== WebSocket.OPEN || bytes.length === 0) return;
    let offset = 0;
    while (offset < bytes.length) {
      let end = Math.min(offset + INPUT_CHUNK, bytes.length);
      if (end < bytes.length) {
        while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
        if (end === offset) end = Math.min(offset + INPUT_CHUNK, bytes.length);
      }
      socket.send(bytes.subarray(offset, end));
      offset = end;
    }
  }

  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

  function sendData(data) {
    if (encoder === null) return;
    sendBytes(encoder.encode(data));
  }

  function sendBinary(data) {
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      bytes[index] = data.charCodeAt(index) & 0xff;
    }
    sendBytes(bytes);
  }

  function sendResize(force) {
    if (term === null || socket === null || socket.readyState !== WebSocket.OPEN) return;
    const cols = Math.max(1, Math.min(1000, term.cols));
    const rows = Math.max(1, Math.min(1000, term.rows));
    if (!force && cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  function fitAndResize(force) {
    if (term === null || fitAddon === null) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    sendResize(force);
  }

  function scheduleFit(force) {
    fitForce = fitForce || force;
    if (fitFrame !== 0) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = 0;
      const forceNow = fitForce;
      fitForce = false;
      fitAndResize(forceNow);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Terminal                                                               */
  /* ---------------------------------------------------------------------- */

  function ensureTerminal() {
    if (term !== null) return true;
    const TerminalCtor = window.Terminal;
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
    if (typeof TerminalCtor !== "function" || typeof FitCtor !== "function") {
      renderStatus("failed");
      setBanner("Terminal engine unavailable. Reload the page.");
      return false;
    }
    const fontFamily = tokenValue("font-family", "--font-mono") || "monospace";
    const fontSize = Number.parseFloat(tokenValue("font-size", "--text-mono")) || 12;
    host.replaceChildren();
    term = new TerminalCtor({
      fontFamily,
      fontSize,
      lineHeight: 1.5,
      letterSpacing: 0,
      cursorBlink: !reducedMotion.matches,
      cursorStyle: "bar",
      scrollback: 5000,
      screenReaderMode: true,
      allowTransparency: false,
      convertEol: false,
      allowProposedApi: false,
      theme: readTheme(),
    });
    fitAddon = new FitCtor();
    term.loadAddon(fitAddon);
    term.open(host);
    term.options.disableStdin = true;
    term.onData(sendData);
    if (typeof term.onBinary === "function") term.onBinary(sendBinary);
    term.onSelectionChange(updateCopyButton);
    term.attachCustomKeyEventHandler(handleKeyEvent);
    try {
      fitAddon.fit();
    } catch {
      // A hidden host cannot be measured; the open/resize handlers retry.
    }
    updateCopyButton();
    return true;
  }

  function disposeTerminal() {
    if (term !== null) {
      try {
        term.dispose();
      } catch {
        // already disposed
      }
    }
    term = null;
    fitAddon = null;
    host.replaceChildren();
    updateCopyButton();
    scheduleFit(false);
  }

  function renderStoppedState() {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state terminal-empty";
    wrapper.innerHTML = `<span class="empty-state__mark"><svg class="icon icon--lg" aria-hidden="true" focusable="false"><use href="#i-terminal" /></svg></span>
      <h3 class="empty-state__title">Agent is not running</h3>
      <p class="empty-state__body">The terminal attaches to the running application container. Open chat to start the agent, then reconnect.</p>
      <div class="cluster"><a class="btn btn-secondary" data-terminal-chat href="#">Open chat</a><button class="btn btn-ghost" type="button" data-terminal-retry>Reconnect</button></div>`;
    const chatLink = wrapper.querySelector("[data-terminal-chat]");
    if (chatLink) chatLink.setAttribute("href", chatHref);
    const retry = wrapper.querySelector("[data-terminal-retry]");
    if (retry) retry.addEventListener("click", () => void prepareConnect(true));
    host.replaceChildren(wrapper);
  }

  function showStopped() {
    generation += 1;
    closedByOperator = false;
    connectedOnce = false;
    clearRetry();
    closeSocketSilently();
    renderStatus("stopped");
    setBanner(null);
    disposeTerminal();
    renderStoppedState();
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime preflight                                                      */
  /* ---------------------------------------------------------------------- */

  async function fetchRuntimeState() {
    try {
      const response = await fetch(runtimeUrl, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      return payload && typeof payload.state === "string" ? payload.state : undefined;
    } catch {
      return undefined;
    }
  }

  function runtimeUnavailable(state) {
    return state === "stopped" || state === "error" || state === "failed";
  }

  /* ---------------------------------------------------------------------- */
  /* Connection lifecycle                                                   */
  /* ---------------------------------------------------------------------- */

  function closeSocketSilently() {
    if (socket === null) return;
    const current = socket;
    socket = null;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // already closing or closed
    }
  }

  function clearRetry() {
    if (retryTimer !== 0) window.clearTimeout(retryTimer);
    if (countdownTimer !== 0) window.clearInterval(countdownTimer);
    retryTimer = 0;
    countdownTimer = 0;
    retryDeadline = 0;
  }

  function retrySeconds() {
    return Math.max(0, Math.ceil((retryDeadline - Date.now()) / 1000));
  }

  function renderRetry() {
    const seconds = retrySeconds();
    if (retryFailure) {
      renderStatus("failed");
    } else {
      renderStatus("reconnecting", `in ${seconds}s`);
    }
    setBanner(`Connection failed. Reconnecting in ${seconds}s.`);
  }

  function scheduleRetry() {
    clearRetry();
    if (closedByOperator || disposed) return;
    const index = Math.min(retryAttempt, RETRY_DELAYS.length - 1);
    const delay = RETRY_DELAYS[index];
    retryAttempt += 1;
    retryDeadline = Date.now() + delay;
    renderRetry();
    countdownTimer = window.setInterval(renderRetry, 1000);
    retryTimer = window.setTimeout(() => {
      clearRetry();
      void prepareConnect(false);
    }, delay);
  }

  async function prepareConnect(manual) {
    if (disposed) return;
    generation += 1;
    const currentGeneration = generation;
    closedByOperator = false;
    clearRetry();
    closeSocketSilently();
    if (manual) retryAttempt = 0;
    renderStatus("connecting");
    setBanner(null);
    const state = await fetchRuntimeState();
    if (currentGeneration !== generation || disposed) return;
    if (runtimeUnavailable(state)) {
      showStopped();
      return;
    }
    if (!ensureTerminal()) return;
    term.options.disableStdin = true;
    if (connectedOnce) {
      try {
        term.reset();
      } catch {
        // a terminal disposed mid-flight has nothing to reset
      }
      try {
        fitAddon.fit();
      } catch {
        // fit again after the socket opens
      }
    }
    connectSocket(currentGeneration);
  }

  function connectSocket(expectedGeneration) {
    if (term === null) return;
    lastCols = 0;
    lastRows = 0;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    let current;
    try {
      current = new WebSocket(`${scheme}//${window.location.host}${wsPath}`);
    } catch {
      retryFailure = false;
      scheduleRetry();
      return;
    }
    socket = current;
    current.binaryType = "arraybuffer";
    current.onopen = () => {
      if (socket !== current || generation !== expectedGeneration) return;
      retryAttempt = 0;
      connectedOnce = true;
      term.options.disableStdin = false;
      renderStatus("live");
      setBanner(null);
      scheduleFit(true);
      term.focus();
    };
    current.onmessage = (event) => {
      if (socket !== current || term === null) return;
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };
    current.onerror = () => {
      // The close event carries the failure code; do not double-report here.
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      void handleClose(event);
    };
  }

  async function handleClose(event) {
    const currentGeneration = generation;
    const manual = closedByOperator;
    closedByOperator = false;
    if (term !== null) term.options.disableStdin = true;
    const code = typeof event.code === "number" ? event.code : 0;
    const normalExit = code === 1000 || code === 1001;
    if (manual) {
      renderStatus("closed");
      setBanner("Terminal closed. The application keeps running.");
    } else if (normalExit) {
      renderStatus("exited");
      setBanner("Shell exited. Reconnect to start a new shell.");
    } else {
      retryFailure = code === 1011;
      renderStatus(retryFailure ? "failed" : "reconnecting");
      setBanner("Connection failed. Checking the runtime...");
    }
    const state = await fetchRuntimeState();
    if (currentGeneration !== generation || disposed) return;
    if (runtimeUnavailable(state)) {
      showStopped();
      return;
    }
    if (manual || normalExit) return;
    scheduleRetry();
  }

  function manualClose() {
    closedByOperator = true;
    generation += 1;
    clearRetry();
    if (term !== null) term.options.disableStdin = true;
    renderStatus("closed");
    setBanner("Terminal closed. The application keeps running.");
    const current = socket;
    if (current === null) return;
    if (current.readyState === WebSocket.OPEN) {
      try {
        current.close(1000, "closed by operator");
      } catch {
        closeSocketSilently();
      }
      return;
    }
    closeSocketSilently();
  }

  function handleReconnect() {
    void prepareConnect(true);
  }

  function handleCloseButton() {
    manualClose();
  }

  function handleCopyButton() {
    void copySelection();
  }

  /* ---------------------------------------------------------------------- */
  /* Fit, theme, and teardown                                               */
  /* ---------------------------------------------------------------------- */

  let resizeObserver = null;
  const onViewportResize = () => scheduleFit(false);

  function onMotionPreference() {
    if (term !== null) term.options.cursorBlink = !reducedMotion.matches;
  }

  const themeObserver = new MutationObserver(() => {
    if (term !== null) term.options.theme = readTheme();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => scheduleFit(false));
    resizeObserver.observe(host);
  }
  window.addEventListener("resize", onViewportResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportResize);
  }
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", onMotionPreference);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => scheduleFit(true)).catch(() => undefined);
  }

  host.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a,button")) return;
    if (term !== null) term.focus();
  });

  if (copyButton) copyButton.addEventListener("click", handleCopyButton);
  if (reconnectButton) reconnectButton.addEventListener("click", handleReconnect);
  if (closeButton) closeButton.addEventListener("click", handleCloseButton);

  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      generation += 1;
      clearRetry();
      closeSocketSilently();
      if (resizeObserver !== null) resizeObserver.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("resize", onViewportResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onViewportResize);
      }
      if (reducedMotion.removeEventListener) {
        reducedMotion.removeEventListener("change", onMotionPreference);
      }
      if (term !== null) {
        try {
          term.dispose();
        } catch {
          // already disposed
        }
        term = null;
        fitAddon = null;
      }
    },
    { once: true },
  );

  updateCopyButton();
  void prepareConnect(false);
})();
