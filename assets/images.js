(function () {
  const panel = document.getElementById("image-panel");
  const statusEl = document.getElementById("image-status");
  const refEl = document.getElementById("image-ref");
  if (panel === null || statusEl === null || refEl === null) {
    return;
  }

  const statusLive = document.getElementById("image-live");
  const builtEl = document.getElementById("image-built");
  const rollbackRefEl = document.getElementById("image-rollback-ref");
  const rollbackBuiltEl = document.getElementById("image-rollback-built");
  const rollbackForm = document.getElementById("image-rollback-form");
  const rollbackButton = document.getElementById("image-rollback");
  const rollbackDialogRef = document.getElementById("image-rollback-dialog-ref");
  const errorEl = document.getElementById("image-error");
  const hintEl = document.getElementById("image-hint");
  const noticeEl = document.getElementById("image-notice");
  const logsEl = document.getElementById("image-logs");
  const logsDetails = document.getElementById("image-logs-details");
  const buildButton = document.getElementById("image-build");
  const statusButton = document.getElementById("image-refresh");

  const imageUrl = panel.dataset.imageUrl || "";
  const logsUrl = panel.dataset.logsUrl || "";
  const runtimeUrl = panel.dataset.runtimeUrl || "";
  const POLL_MS = 3000;
  const STATUS = {
    missing: {
      label: "Not built",
      state: "queued",
      glyph: "clock",
      action: "Build image",
      hint: "No app image has been built. Build it before starting the agent.",
    },
    building: {
      label: "Building",
      state: "in_progress",
      glyph: "loader",
      action: "Building…",
      hint: "The runner is building this image. The previous image remains in use.",
    },
    ready: {
      label: "Built",
      state: "delivered",
      glyph: "check",
      action: "Rebuild image",
      hint: "The image matches the current Dockerfile and default base.",
    },
    stale: {
      label: "Out of date",
      state: "expired",
      glyph: "hourglass",
      action: "Rebuild image",
      hint: "The Dockerfile or default base changed. The running agent keeps the old image until you rebuild and restart.",
    },
    error: {
      label: "Build failed",
      state: "failed",
      glyph: "alert-triangle",
      action: "Retry build",
      hint: "The last build failed. The previous image is kept.",
    },
  };

  let timer = null;
  let statusBusy = false;
  let logsBusy = false;

  function setLive(text) {
    if (statusLive !== null && statusLive.textContent !== text) {
      statusLive.textContent = text;
    }
  }

  function normalizeStatus(value) {
    return Object.prototype.hasOwnProperty.call(STATUS, value) ? value : "error";
  }

  function formatTime(iso) {
    if (typeof iso !== "string" || iso.length === 0) {
      return "";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function renderTime(element, iso, emptyText) {
    element.dataset.builtAt = typeof iso === "string" ? iso : "";
    element.replaceChildren();
    if (typeof iso !== "string" || iso.length === 0) {
      element.textContent = emptyText;
      return;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      element.textContent = iso;
      return;
    }
    const time = document.createElement("time");
    time.setAttribute("datetime", iso);
    time.setAttribute("title", formatTime(iso));
    time.textContent = formatTime(iso);
    element.appendChild(time);
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

  function setStatusLabel(element, label) {
    for (const node of element.childNodes) {
      if (node.nodeType === 3) {
        node.textContent = label;
        return;
      }
    }
    element.appendChild(document.createTextNode(label));
  }

  function setStatusGlyph(element, glyph) {
    let use = element.querySelector("use");
    if (use === null) {
      element.insertAdjacentHTML(
        "afterbegin",
        `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${glyph}"></use></svg>`,
      );
      use = element.querySelector("use");
    }
    if (use !== null) {
      use.setAttribute("href", `#i-${glyph}`);
    }
  }

  function updateRollbackLabel(state) {
    const active = state === "running" || state === "starting";
    const label = active ? "Roll back and restart" : "Roll back image";
    const confirm = document.getElementById("image-rollback-confirm");
    if (confirm !== null) {
      confirm.textContent = label;
    }
    if (rollbackButton !== null) {
      const labelEl = rollbackButton.querySelector(".btn__label");
      if (labelEl !== null) {
        labelEl.textContent = label;
      }
    }
  }

  async function refreshRuntime() {
    if (runtimeUrl.length === 0 || panel.dataset.status === "default") {
      return;
    }
    try {
      const data = await request(runtimeUrl);
      const state = typeof data.state === "string" ? data.state : "";
      updateRollbackLabel(state);
      const cardRef = (panel.dataset.imageRef || "").length > 0 ? panel.dataset.imageRef : null;
      const runtimeRef =
        typeof data.imageRef === "string" && data.imageRef.length > 0 ? data.imageRef : null;
      const running = state === "running" || state === "starting";
      if (noticeEl !== null) {
        noticeEl.hidden = !(
          running &&
          cardRef !== null &&
          runtimeRef !== null &&
          cardRef !== runtimeRef
        );
      }
    } catch {
      // Runtime is secondary here; status and build controls stay usable.
    }
  }

  function renderStatus(data) {
    const status = normalizeStatus(data.status);
    const meta = STATUS[status];
    panel.dataset.status = status;
    statusEl.className = "status";
    statusEl.dataset.status = status;
    statusEl.dataset.state = meta.state;
    setStatusGlyph(statusEl, meta.glyph);
    setStatusLabel(statusEl, meta.label);

    const imageRef =
      typeof data.imageRef === "string" && data.imageRef.length > 0 ? data.imageRef : null;
    refEl.textContent = imageRef ?? "Not built";
    if (imageRef === null) {
      delete panel.dataset.imageRef;
    } else {
      panel.dataset.imageRef = imageRef;
    }

    if (builtEl !== null) {
      renderTime(builtEl, typeof data.builtAt === "string" ? data.builtAt : "", "Never");
    }

    const previousImageRef =
      typeof data.previousImageRef === "string" && data.previousImageRef.length > 0
        ? data.previousImageRef
        : null;
    if (rollbackRefEl !== null) {
      rollbackRefEl.textContent = previousImageRef ?? "None";
      const row = rollbackRefEl.closest(".summary-row");
      if (row !== null) row.hidden = previousImageRef === null;
    }
    if (rollbackBuiltEl !== null) {
      renderTime(
        rollbackBuiltEl,
        typeof data.previousImageBuiltAt === "string" ? data.previousImageBuiltAt : "",
        "",
      );
      rollbackBuiltEl.hidden = previousImageRef === null;
      const row = rollbackBuiltEl.closest(".summary-row");
      if (row !== null) row.hidden = previousImageRef === null;
    }
    if (rollbackForm !== null) {
      rollbackForm.hidden = previousImageRef === null;
    }
    if (rollbackDialogRef !== null) {
      rollbackDialogRef.textContent = previousImageRef ?? "no previous image";
    }

    if (errorEl !== null) {
      const message = typeof data.error === "string" ? data.error : "";
      errorEl.textContent = message;
      errorEl.hidden = message.length === 0;
    }
    if (hintEl !== null) {
      hintEl.textContent = meta.hint;
    }
    if (buildButton !== null) {
      const label = buildButton.querySelector(".btn__label");
      if (label !== null) {
        label.textContent = meta.action;
      }
      buildButton.dataset.actionLabel = meta.action;
      buildButton.disabled = status === "building";
      if (status === "building") {
        buildButton.setAttribute("aria-busy", "true");
      } else {
        buildButton.removeAttribute("aria-busy");
      }
    }
    if (rollbackButton !== null) {
      rollbackButton.disabled = status === "building";
    }

    if (status === "building") {
      if (logsDetails !== null && !logsDetails.open) {
        logsDetails.open = true;
      }
      schedulePoll();
    } else {
      stopPoll();
    }
    setLive(`${meta.label}. ${typeof data.error === "string" && data.error.length > 0 ? data.error : meta.hint}`);
    void refreshRuntime();
  }

  function renderLogs(data) {
    if (logsEl === null) {
      return;
    }
    const text =
      typeof data.logs === "string" && data.logs.length > 0 ? data.logs : "No build logs yet.";
    if (logsEl.textContent === text) {
      return;
    }
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 4;
    const previousTop = logsEl.scrollTop;
    logsEl.textContent = text;
    logsEl.scrollTop = atBottom ? logsEl.scrollHeight : previousTop;
  }

  async function refreshStatus() {
    if (statusBusy || imageUrl.length === 0) {
      return;
    }
    statusBusy = true;
    try {
      renderStatus(await request(imageUrl));
    } catch (error) {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not refresh image status.";
      setLive(message);
      if (errorEl !== null) {
        errorEl.textContent = message;
        errorEl.hidden = false;
      }
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
      setLive(
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not refresh build logs.",
      );
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
      const status = normalizeStatus(panel.dataset.status || "");
      if (status === "building") {
        if (logsDetails !== null && logsDetails.open) {
          await refreshLogs();
        }
        schedulePoll();
      }
    }, POLL_MS);
  }

  if (statusButton !== null) {
    statusButton.addEventListener("click", () => {
      void refreshStatus();
      if (logsDetails !== null && logsDetails.open) {
        void refreshLogs();
      }
    });
  }
  if (logsDetails !== null) {
    logsDetails.addEventListener("toggle", () => {
      if (logsDetails.open) {
        void refreshLogs();
      }
    });
  }

  const initial = panel.dataset.status || "";
  if (initial === "default") {
    void refreshRuntime();
  } else {
    renderStatus({
      status: initial,
      imageRef: refEl.textContent === "Not built" ? null : refEl.textContent,
      builtAt: builtEl !== null ? builtEl.dataset.builtAt || "" : "",
      previousImageRef:
        rollbackRefEl !== null && rollbackRefEl.textContent !== "None"
          ? rollbackRefEl.textContent
          : null,
      previousImageBuiltAt:
        rollbackBuiltEl !== null ? rollbackBuiltEl.dataset.builtAt || "" : "",
      error: errorEl !== null && !errorEl.hidden ? errorEl.textContent : null,
    });
  }
})();
