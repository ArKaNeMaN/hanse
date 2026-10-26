(function () {
  const panel = document.getElementById("image-panel");
  const statusEl = document.getElementById("image-status");
  const refEl = document.getElementById("image-ref");
  if (panel === null || statusEl === null || refEl === null) {
    return;
  }

  const isDefaultPanel = panel.dataset.status === "default";
  const statusLive = document.getElementById("image-live");
  const builtEl = document.getElementById("image-built");
  const baseKindEl = document.getElementById("image-base-kind");
  const baseRefEl = document.getElementById("image-base-ref");
  const baseDigestEl = document.getElementById("image-base-digest");
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

  const DERIVED_STATES = new Set([
    "current",
    "restart_required",
    "rebuild_required",
    "building",
    "build_error",
    "not_ready",
    "unknown",
  ]);
  const BUILD_STATES = new Set(["building", "build_error", "not_ready", "rebuild_required"]);
  const RAW_STATE = {
    missing: "not_ready",
    building: "building",
    ready: "current",
    stale: "rebuild_required",
    error: "build_error",
  };
  const BASE_KIND_LABEL = {
    default: "Default",
    base: "Base",
    explicit: "Explicit",
    unknown: "Unknown",
  };

  const CUSTOM_STATES = {
    current: {
      label: "Built",
      state: "delivered",
      glyph: "check",
      action: "Rebuild image",
      hint: "The image matches the current Dockerfile and base.",
    },
    restart_required: {
      label: "Restart required",
      state: "awaiting_approval",
      glyph: "refresh",
      action: "Rebuild image",
      hint: "The running agent uses the previous image. Restart it to use the new image.",
    },
    rebuild_required: {
      label: "Out of date",
      state: "expired",
      glyph: "hourglass",
      action: "Rebuild image",
      hint: "The base image or Dockerfile changed. Rebuild and restart the running agent to use the new image.",
    },
    building: {
      label: "Building",
      state: "in_progress",
      glyph: "loader",
      action: "Building…",
      hint: "The runner is building this image. The previous image remains in use.",
    },
    build_error: {
      label: "Build failed",
      state: "failed",
      glyph: "alert-triangle",
      action: "Retry build",
      hint: "The last build failed. The previous image is kept.",
    },
    not_ready: {
      label: "Not built",
      state: "queued",
      glyph: "clock",
      action: "Build image",
      hint: "No app image has been built. Build it before starting the agent.",
    },
    unknown: {
      label: "Unknown",
      state: "queued",
      glyph: "clock",
      action: "Rebuild image",
      hint: "The image identity could not be confirmed. Refresh to try again.",
    },
  };

  const DEFAULT_STATES = {
    current: {
      label: "Current",
      state: "delivered",
      glyph: "check",
      hint: "The agent runs the current default image.",
    },
    restart_required: {
      label: "Restart required",
      state: "awaiting_approval",
      glyph: "refresh",
      hint: "Restart the agent to use the current default image.",
    },
    unknown: {
      label: "Unknown",
      state: "queued",
      glyph: "clock",
      hint: "The default image identity could not be confirmed. Refresh to try again.",
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
    if (runtimeUrl.length === 0 || isDefaultPanel) {
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

  function deriveState(data) {
    if (
      data !== null &&
      typeof data === "object" &&
      typeof data.state === "string" &&
      DERIVED_STATES.has(data.state)
    ) {
      return data.state;
    }
    const raw =
      data !== null && typeof data === "object" && typeof data.status === "string"
        ? data.status
        : "";
    return RAW_STATE[raw] ?? "unknown";
  }

  function presentation(state) {
    const safe = isDefaultPanel && BUILD_STATES.has(state) ? "unknown" : state;
    const table = isDefaultPanel ? DEFAULT_STATES : CUSTOM_STATES;
    return table[safe] ?? table.unknown;
  }

  function renderBase(data) {
    if (baseKindEl === null && baseRefEl === null && baseDigestEl === null) {
      return;
    }
    const kind =
      data !== null && typeof data.baseKind === "string"
        ? (BASE_KIND_LABEL[data.baseKind] ?? "Unknown")
        : "Unknown";
    if (baseKindEl !== null) {
      baseKindEl.textContent = kind;
    }
    if (baseRefEl !== null) {
      const baseRef =
        data !== null && typeof data.baseRef === "string" && data.baseRef.length > 0
          ? data.baseRef
          : null;
      baseRefEl.textContent = baseRef ?? "—";
    }
    if (baseDigestEl !== null) {
      const stored =
        data !== null && typeof data.baseDigest === "string" && data.baseDigest.length > 0
          ? data.baseDigest
          : null;
      const current =
        data !== null &&
        typeof data.currentBaseDigest === "string" &&
        data.currentBaseDigest.length > 0
          ? data.currentBaseDigest
          : null;
      if (stored !== null && current !== null && stored !== current) {
        baseDigestEl.textContent = `${stored} → ${current}`;
      } else {
        baseDigestEl.textContent = stored ?? current ?? "—";
      }
    }
  }

  function renderState(data) {
    const state = deriveState(data);
    const meta = presentation(state);
    panel.dataset.state = state;
    statusEl.className = "status";
    statusEl.dataset.status = state;
    statusEl.dataset.state = meta.state;
    setStatusGlyph(statusEl, meta.glyph);
    setStatusLabel(statusEl, meta.label);

    const imageRef =
      data !== null && typeof data.imageRef === "string" && data.imageRef.length > 0
        ? data.imageRef
        : null;
    refEl.textContent = imageRef ?? (isDefaultPanel ? "Default agent image" : "Not built");
    if (imageRef === null) {
      delete panel.dataset.imageRef;
    } else {
      panel.dataset.imageRef = imageRef;
    }

    renderBase(data);

    if (builtEl !== null) {
      const builtAt = data !== null && typeof data.builtAt === "string" ? data.builtAt : "";
      renderTime(builtEl, builtAt, "Never");
    }

    const previousImageRef =
      data !== null &&
      typeof data.previousImageRef === "string" &&
      data.previousImageRef.length > 0
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
        data !== null && typeof data.previousImageBuiltAt === "string"
          ? data.previousImageBuiltAt
          : "",
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
      const message =
        data !== null && typeof data.error === "string" && !isDefaultPanel ? data.error : "";
      errorEl.textContent = message;
      errorEl.hidden = message.length === 0;
    }
    if (hintEl !== null) {
      hintEl.textContent = meta.hint;
    }
    if (buildButton !== null && meta.action !== undefined) {
      const label = buildButton.querySelector(".btn__label");
      if (label !== null) {
        label.textContent = meta.action;
      }
      buildButton.dataset.actionLabel = meta.action;
      buildButton.disabled = state === "building";
      if (state === "building") {
        buildButton.setAttribute("aria-busy", "true");
      } else {
        buildButton.removeAttribute("aria-busy");
      }
    }
    if (rollbackButton !== null) {
      rollbackButton.disabled = state === "building";
    }

    if (state === "building") {
      if (logsDetails !== null && !logsDetails.open) {
        logsDetails.open = true;
      }
      schedulePoll();
    } else {
      stopPoll();
    }
    const error =
      !isDefaultPanel &&
      data !== null &&
      typeof data.error === "string" &&
      data.error.length > 0
        ? data.error
        : "";
    setLive(`${meta.label}. ${error.length > 0 ? error : meta.hint}`);
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
      renderState(await request(imageUrl));
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
      if (panel.dataset.state === "building") {
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

  if (imageUrl.length > 0) {
    void refreshStatus();
  } else if (isDefaultPanel) {
    setLive("Default image.");
    void refreshRuntime();
  } else {
    renderState({
      status: panel.dataset.status || "missing",
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
