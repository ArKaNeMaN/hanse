(() => {
  const root = document.getElementById("terminal");
  if (!root) return;
  const output = document.getElementById("terminal-output");
  const input = document.getElementById("terminal-input");
  const status = document.getElementById("terminal-status");
  const reconnect = document.getElementById("terminal-reconnect");
  const close = document.getElementById("terminal-close");
  const wsPath = root.dataset.terminalWs;
  if (!output || !input || !status || !wsPath) return;

  const MAX_OUTPUT_CHARS = 400000;
  const KEEP_OUTPUT_CHARS = 300000;
  let socket = null;
  let decoder = new TextDecoder();
  let resizeTimer = 0;

  function setStatus(text, state) {
    status.textContent = text;
    status.className =
      state === "connected"
        ? "badge badge-success"
        : state === "error"
          ? "badge badge-error"
          : "badge";
  }

  function append(text) {
    if (text.length === 0) return;
    output.textContent += text;
    if (output.textContent.length > MAX_OUTPUT_CHARS) {
      output.textContent = output.textContent.slice(-KEEP_OUTPUT_CHARS);
    }
    output.scrollTop = output.scrollHeight;
  }

  function send(data) {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }

  function terminalSize() {
    const rect = output.getBoundingClientRect();
    const cols = Math.max(20, Math.min(1000, Math.floor(rect.width / 8)));
    const rows = Math.max(5, Math.min(1000, Math.floor(rect.height / 18)));
    return { cols, rows };
  }

  function sendResize() {
    const { cols, rows } = terminalSize();
    send(JSON.stringify({ type: "resize", cols, rows }));
  }

  function scheduleResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendResize, 200);
  }

  function connect() {
    if (socket !== null) {
      socket.onclose = null;
      socket.close();
    }
    decoder = new TextDecoder();
    setStatus("Connecting", "connecting");
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${window.location.host}${wsPath}`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      setStatus("Connected", "connected");
      sendResize();
      input.focus();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        append(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        append(decoder.decode(new Uint8Array(event.data), { stream: true }));
      }
    };
    socket.onerror = () => setStatus("Connection error", "error");
    socket.onclose = () => setStatus("Disconnected", "disconnected");
  }

  function closeTerminal() {
    if (socket !== null) {
      socket.onclose = null;
      socket.close(1000, "closed");
      socket = null;
    }
    setStatus("Closed", "disconnected");
  }

  function keyBytes(event) {
    if (event.metaKey) return undefined;
    if (event.ctrlKey && !event.altKey && event.key.length === 1) {
      if (event.key.toLowerCase() === "v") return undefined;
      const code = event.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    }
    switch (event.key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return "\x7f";
      case "Tab":
        return "\t";
      case "Escape":
        return "\x1b";
      case "ArrowUp":
        return "\x1b[A";
      case "ArrowDown":
        return "\x1b[B";
      case "ArrowRight":
        return "\x1b[C";
      case "ArrowLeft":
        return "\x1b[D";
      case "Home":
        return "\x1b[H";
      case "End":
        return "\x1b[F";
      case "PageUp":
        return "\x1b[5~";
      case "PageDown":
        return "\x1b[6~";
      case "Delete":
        return "\x1b[3~";
      default:
        break;
    }
    if (event.key.length === 1) {
      return event.altKey ? `\x1b${event.key}` : event.key;
    }
    return undefined;
  }

  input.addEventListener("keydown", (event) => {
    const bytes = keyBytes(event);
    if (bytes === undefined) return;
    event.preventDefault();
    send(bytes);
  });

  input.addEventListener("input", () => {
    if (input.value.length > 0) {
      send(input.value);
      input.value = "";
    }
  });

  output.addEventListener("click", () => input.focus());
  window.addEventListener("resize", scheduleResize);
  reconnect?.addEventListener("click", connect);
  close?.addEventListener("click", closeTerminal);

  connect();
})();
