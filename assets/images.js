(function () {
  const panel = document.getElementById("image-panel");
  if (panel === null) {
    return;
  }

  const statusEl = document.getElementById("image-status");
  const statusLive = document.getElementById("image-live");
  const refEl = document.getElementById("image-ref");
  const builtEl = document.getElementById("image-built");
  const errorEl = document.getElementById("image-error");
  const hintEl = document.getElementById("image-hint");
  const logsEl = document.getElementById("image-logs");
  const buildButton = document.getElementById("image-build");
  const statusButton = document.getElementById("image-refresh");
  const logsButton = document.getElementById("image-logs-refresh");

  if (statusEl === null || refEl === null || builtEl === null || logsEl === null) {
    return;
  }

  const imageUrl = panel.dataset.imageUrl || "";
  const logsUrl = panel.dataset.logsUrl || "";
  const POLL_MS = 3000;
  const STATUS = {
    missing: {
      label: "Missing",
      tone: "badge-ghost",
      action: "Build image",
      hint: "No app image has been built. Build it before starting the agent.",
    },
    building: {
      label: "Building",
      tone: "badge-info",
      action: "Building...",
      hint: "The runner is building this image. The previous image remains in use.",
    },
    ready: {
      label: "Ready",
      tone: "badge-success",
      action: "Rebuild image",
      hint: "The image matches the current Dockerfile and default base.",
    },
    stale: {
      label: "Stale",
      tone: "badge-warning",
      action: "Rebuild image",
      hint: "The Dockerfile or default base changed. The running container keeps the old image until you rebuild.",
    },
    error: {
      label: "Error",
      tone: "badge-error",
      action: "Retry build",
      hint: "The last build failed. Review the logs and retry; the previous image is kept.",
    },
  };

  let timer = null;
  let statusBusy = false;
  let logsBusy = false;

  function setLive(text) {
    if (statusLive !== null) {
      statusLive.textContent = text;
    }
  }

  function normalizeStatus(value) {
    return Object.prototype.hasOwnProperty.call(STATUS, value) ? value : "error";
  }

  function formatTime(iso) {
    if (typeof iso !== "string" || iso.length === 0) {
      return "Never";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleString();
  }

  async function request(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        throw new Error("Session expired. Sign in again.");
      }
      const raw = await response.text();
      let data = null;
      if (raw.length > 0) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      }
      if (!response.ok) {
        const message =
          data && typeof data.error === "string" ? data.error : `Request failed (${response.status})`;
        throw new Error(message.slice(0, 400));
      }
      return data && typeof data === "object" ? data : {};
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function renderStatus(data) {
    const status = normalizeStatus(data.status);
    const meta = STATUS[status];
    panel.dataset.status = status;
    statusEl.dataset.status = status;
    statusEl.className = `badge ${meta.tone}`;
    statusEl.textContent = meta.label;

    refEl.textContent =
      typeof data.imageRef === "string" && data.imageRef.length > 0 ? data.imageRef : "Not built";
    builtEl.dataset.builtAt = typeof data.builtAt === "string" ? data.builtAt : "";
    builtEl.textContent = formatTime(data.builtAt);

    if (errorEl !== null) {
      const message = typeof data.error === "string" ? data.error : "";
      errorEl.textContent = message;
      errorEl.hidden = message.length === 0;
    }
    if (hintEl !== null) {
      hintEl.textContent = meta.hint;
    }
    if (buildButton !== null) {
      buildButton.textContent = meta.action;
      buildButton.dataset.actionLabel = meta.action;
      buildButton.disabled = status === "building";
    }

    if (status === "building") {
      schedulePoll();
    } else {
      stopPoll();
    }
    setLive(`${meta.label}. ${data.error ? String(data.error) : meta.hint}`);
  }

  function renderLogs(data) {
    const text = typeof data.logs === "string" ? data.logs : "";
    logsEl.textContent = text.length === 0 ? "No build logs yet." : text;
  }

  async function refreshStatus() {
    if (statusBusy || imageUrl.length === 0) {
      return;
    }
    statusBusy = true;
    try {
      renderStatus(await request(imageUrl));
    } catch (error) {
      setLive(error instanceof Error ? error.message : "Could not refresh image status.");
    } finally {
      statusBusy = false;
    }
  }

  async function refreshLogs() {
    if (logsBusy || logsUrl.length === 0) {
      return;
    }
    logsBusy = true;
    try {
      renderLogs(await request(logsUrl));
    } catch (error) {
      setLive(error instanceof Error ? error.message : "Could not refresh build logs.");
    } finally {
      logsBusy = false;
    }
  }

  function stopPoll() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function schedulePoll() {
    if (timer !== null) {
      return;
    }
    timer = window.setTimeout(async () => {
      timer = null;
      await refreshStatus();
      await refreshLogs();
      const status = normalizeStatus(panel.dataset.status || "");
      if (status === "building") {
        schedulePoll();
      }
    }, POLL_MS);
  }

  if (statusButton !== null) {
    statusButton.addEventListener("click", () => {
      void refreshStatus();
    });
  }
  if (logsButton !== null) {
    logsButton.addEventListener("click", () => {
      void refreshLogs();
    });
  }

  const initial = normalizeStatus(panel.dataset.status || "");
  renderStatus({
    status: initial,
    imageRef: refEl.textContent === "Not built" ? null : refEl.textContent,
    builtAt: builtEl.dataset.builtAt || "",
    error: errorEl !== null && !errorEl.hidden ? errorEl.textContent : null,
  });

  void refreshLogs();
  if (initial === "building") {
    void refreshStatus();
  }
})();
