import {
  HIGHLIGHT_TIMEOUT_MS,
  MAX_HIGHLIGHT_LINE_CHARS,
  MAX_HIGHLIGHT_PAGE_WORK_MS,
  MAX_HIGHLIGHT_VIEW_WORK_MS,
  MAX_INFLIGHT_HIGHLIGHT_STREAMS,
  MAX_PAGE_TOKEN_NODES,
  MAX_PENDING_HIGHLIGHT_FILES,
  MAX_TIMEOUTS_PER_LANGUAGE,
  MAX_TOKEN_NODES_PER_FILE,
  MAX_TOKEN_NODES_PER_REQUEST,
  sanitizeTokenType,
  streamCapBytes,
  VENDORED_LANGUAGES,
  WORKER_READY_TIMEOUT_MS,
} from "./chat-diff.js";

const KNOWN_LANGUAGES = new Set(VENDORED_LANGUAGES);
const ENCODER = new TextEncoder();
const TYPE_LABELS = {
  add: "Added",
  update: "Updated",
  delete: "Deleted",
  move: "Moved",
  binary: "Binary",
  unknown: "Changed file",
};

const contexts = new Map();
const jobs = new Map();
const stats = {
  inflightStreams: 0,
  reservedNodes: 0,
  pageCommitted: 0,
  pendingFiles: 0,
  disabled: false,
  timeouts: 0,
  pageWorkMs: 0,
};

let controllerGeneration = 0;
let jobSequence = 0;
let worker = null;
let workerReady = false;
let workerPromise = null;
let resolveWorker = null;
let readyTimer = 0;

export function reservationUnits(streams) {
  const count = Math.max(0, Math.floor(typeof streams === "number" ? streams : 0));
  return { streams: count, nodes: count * MAX_TOKEN_NODES_PER_REQUEST };
}

export function reservationFits(reservedNodes, inflightStreams, streams, limits = {}) {
  const units = reservationUnits(streams);
  const maxNodes =
    typeof limits.maxNodes === "number" ? limits.maxNodes : MAX_PAGE_TOKEN_NODES;
  const maxStreams =
    typeof limits.maxStreams === "number"
      ? limits.maxStreams
      : MAX_INFLIGHT_HIGHLIGHT_STREAMS;
  return (
    inflightStreams + units.streams <= maxStreams &&
    reservedNodes + units.nodes <= maxNodes
  );
}

export function isHighlightEligible(language, kind) {
  if (typeof language !== "string" || !KNOWN_LANGUAGES.has(language)) return false;
  return !(kind === "diff" && language === "diff");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pathOf(file) {
  if (typeof file.path === "string" && file.path.length > 0) return file.path;
  if (typeof file.newPath === "string" && file.newPath.length > 0) return file.newPath;
  if (typeof file.oldPath === "string" && file.oldPath.length > 0) return file.oldPath;
  return "unknown";
}

function headPath(file) {
  const oldPath = typeof file.oldPath === "string" ? file.oldPath : "";
  const newPath = typeof file.newPath === "string" ? file.newPath : "";
  if (file.type === "move" && oldPath.length > 0 && newPath.length > 0 && oldPath !== newPath) {
    return `${oldPath} -> ${newPath}`;
  }
  return pathOf(file);
}

function typeLabel(file) {
  return TYPE_LABELS[file.type] || TYPE_LABELS.unknown;
}

function renderHead(file) {
  const head = element("div", "tool-diff__head");
  const pathText = headPath(file);
  const pathEl = element("span", "tool-diff__path", pathText);
  pathEl.title = pathText;
  head.append(pathEl, element("span", "tool-diff__type", typeLabel(file)));

  const additions = numberOf(file.additions);
  const deletions = numberOf(file.deletions);
  if (!file.headerOnly && !file.binary && additions !== null && deletions !== null) {
    head.append(
      element("span", "tool-diff__stat", `+${additions}`),
      element("span", "tool-diff__stat", `-${deletions}`),
    );
  }
  if (file.headerOnly) {
    head.append(
      element(
        "span",
        "tool-diff__note",
        file.binary ? "Binary file changed" : "No textual changes",
      ),
    );
  }
  return head;
}

function lineText(line) {
  return typeof line.text === "string" ? line.text : "";
}

function renderDiffLine(line) {
  const kind = typeof line.kind === "string" ? line.kind : "meta";
  const row = element("div", "diff-line");
  row.dataset.kind = kind;
  const oldNumber = element(
    "span",
    "diff-line__num",
    numberOf(line.oldNumber) === null ? "" : String(line.oldNumber),
  );
  const newNumber = element(
    "span",
    "diff-line__num",
    numberOf(line.newNumber) === null ? "" : String(line.newNumber),
  );
  oldNumber.setAttribute("aria-hidden", "true");
  newNumber.setAttribute("aria-hidden", "true");
  row.append(
    oldNumber,
    newNumber,
    element("span", "diff-line__sign", kind === "add" ? "+" : kind === "del" ? "-" : " "),
  );
  const text = lineText(line);
  const code = element("span", "diff-line__code", text);
  row.append(code);
  return { row, code, text };
}

function createFileState(file, index, kind, streams) {
  const language = typeof file.language === "string" ? file.language : null;
  const eligible =
    isHighlightEligible(language, kind) &&
    streams.some((stream) => stream.expectedLines > 0);
  return {
    file,
    index,
    kind,
    language,
    streams,
    eligible,
    state: "plain",
    status: eligible ? "idle" : "done",
    submitted: false,
    reserved: 0,
    reservedStreams: 0,
    committed: 0,
    released: false,
    pendingAdmission: false,
    generation: 0,
    jobID: null,
    requestsOut: 0,
    plainReason: "",
  };
}

function renderDiff(view, context) {
  const container = element("div", "tool-diff");
  const files = Array.isArray(view.files) ? view.files : [];
  const scroller = element("div", "tool-diff__scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute(
    "aria-label",
    files.length === 1
      ? `Diff for ${pathOf(files[0])}, scrollable`
      : `Diff for ${files.length} files, scrollable`,
  );
  container.append(scroller);

  files.forEach((file, index) => {
    const fileElement = element("div", "tool-diff__file");
    fileElement.append(renderHead(file));

    const hunksElement = element("div", "tool-diff__hunks");
    const newTexts = [];
    const oldTexts = [];
    const newTargets = [];
    const oldTargets = [];
    const hunks = Array.isArray(file.hunks) ? file.hunks : [];

    for (const hunk of hunks) {
      const hunkElement = element("div", "tool-diff__hunk");
      hunkElement.append(
        element(
          "div",
          "tool-diff__hunk-head",
          typeof hunk.header === "string" ? hunk.header : "",
        ),
      );
      const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
      for (const line of lines) {
        const rendered = renderDiffLine(line);
        hunkElement.append(rendered.row);
        const kind = rendered.row.dataset.kind;
        if (kind === "context") {
          newTexts.push(rendered.text);
          oldTexts.push(rendered.text);
          newTargets.push(rendered);
          oldTargets.push(null);
        } else if (kind === "add") {
          newTexts.push(rendered.text);
          newTargets.push(rendered);
        } else if (kind === "del") {
          oldTexts.push(rendered.text);
          oldTargets.push(rendered);
        }
      }
      hunksElement.append(hunkElement);
    }

    fileElement.append(hunksElement);
    scroller.append(fileElement);

    const streams = [];
    if (newTexts.length > 0) {
      streams.push({
        id: `s${index}:new`,
        side: "new",
        text: newTexts.join("\n"),
        expectedLines: newTexts.length,
        targets: newTargets,
        response: null,
        plan: null,
        nodes: 0,
        timer: 0,
        started: 0,
      });
    }
    if (oldTexts.length > 0) {
      streams.push({
        id: `s${index}:old`,
        side: "old",
        text: oldTexts.join("\n"),
        expectedLines: oldTexts.length,
        targets: oldTargets,
        response: null,
        plan: null,
        nodes: 0,
        timer: 0,
        started: 0,
      });
    }
    context.files.push(createFileState(file, index, "diff", streams));
  });

  appendDiagnostics(container, view.diagnostics);
  return container;
}

function contentLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderWrite(view, context) {
  const container = element("div", "tool-code");
  const files = Array.isArray(view.files) ? view.files : [];
  const file = files.length > 0 && files[0] !== null && typeof files[0] === "object" ? files[0] : {};
  const content = typeof file.content === "string" ? file.content : "";
  const lines = contentLines(content);
  const pathText = pathOf(file);

  const head = element("div", "tool-code__head");
  const pathEl = element("span", "tool-code__path", pathText);
  pathEl.title = pathText;
  head.append(pathEl, element("span", "tool-code__meta", `${lines.length} lines`));
  if (typeof file.language === "string") {
    head.append(element("span", "tool-code__lang", file.language));
  }
  container.append(head);

  const scroller = element("div", "tool-code__scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", `Written content for ${pathText}, scrollable`);
  const targets = [];
  lines.forEach((text, index) => {
    const row = element("div", "code-line");
    const code = element("span", "code-line__code", text);
    const lineNumber = element("span", "code-line__num", String(index + 1));
    lineNumber.setAttribute("aria-hidden", "true");
    row.append(lineNumber, code);
    scroller.append(row);
    targets.push({ code, text });
  });
  container.append(scroller);
  appendDiagnostics(container, view.diagnostics);

  const streams = [];
  if (lines.length > 0) {
    streams.push({
      id: "s0:write",
      side: "write",
      text: lines.join("\n"),
      expectedLines: lines.length,
      targets,
      response: null,
      plan: null,
      nodes: 0,
      timer: 0,
      started: 0,
    });
  }
  context.files.push(createFileState(file, 0, "write", streams));
  return container;
}

function renderFileList(view) {
  const container = element("div", "tool-diff");
  container.dataset.mode = "files";
  container.dataset.highlight = "plain";
  const list = element("ul", "tool-diff__file-list");
  const files = Array.isArray(view.files) ? view.files : [];
  for (const file of files) {
    const value = file !== null && typeof file === "object" ? pathOf(file) : String(file);
    list.append(element("li", "tool-diff__file-list-item", value));
  }
  container.append(list);
  appendDiagnostics(container, view.diagnostics);
  return container;
}

function appendDiagnostics(container, diagnostics) {
  if (typeof diagnostics !== "string" || diagnostics.trim().length === 0) return;
  container.append(element("div", "tool-diff__diagnostics", diagnostics));
}

function updateContainerState(context) {
  if (context.container === null) return;
  let state = "plain";
  let anyBudget = false;
  let anyPending = false;
  let anyError = false;
  let anyTokens = false;
  for (const file of context.files) {
    if (file.state === "budget") anyBudget = true;
    else if (file.state === "pending") anyPending = true;
    else if (file.state === "error") anyError = true;
    else if (file.state === "tokens") anyTokens = true;
  }
  if (stats.disabled) state = "plain";
  else if (anyBudget) state = "budget";
  else if (anyPending) state = "pending";
  else if (anyError) state = "error";
  else if (anyTokens) state = "tokens";
  context.container.dataset.highlight = state;
}

function scrollerOf(container) {
  return container.querySelector(".tool-diff__scroll, .tool-code__scroll");
}

function saveView(scroller) {
  if (scroller === null) return null;
  return {
    top: scroller.scrollTop,
    left: scroller.scrollLeft,
    focus: scroller === document.activeElement || scroller.contains(document.activeElement),
  };
}

function restoreView(scroller, saved) {
  if (scroller === null || saved === null) return;
  if (saved.focus) {
    try {
      scroller.focus({ preventScroll: true });
    } catch {
      scroller.focus();
    }
  }
  scroller.scrollTop = saved.top;
  scroller.scrollLeft = saved.left;
}

function applyPlan(targets, plan) {
  for (let index = 0; index < targets.length && index < plan.length; index += 1) {
    const target = targets[index];
    if (target === null || target === undefined) continue;
    const segments = Array.isArray(plan[index]) ? plan[index] : [];
    const children = [];
    for (const segment of segments) {
      if (!Array.isArray(segment)) continue;
      const text = typeof segment[0] === "string" ? segment[0] : "";
      if (text.length === 0) continue;
      const span = document.createElement("span");
      span.className = "token";
      const types = Array.isArray(segment[1]) ? segment[1] : [];
      for (const type of types) {
        const clean = sanitizeTokenType(type);
        if (clean !== null) span.classList.add(clean);
      }
      span.textContent = text;
      children.push(span);
    }
    target.code.replaceChildren(...children);
  }
}

function restorePlain(fileState) {
  for (const stream of fileState.streams) {
    for (const target of stream.targets) {
      if (target !== null && target !== undefined) target.code.textContent = target.text;
    }
  }
}

function clearStreamTimers(fileState) {
  for (const stream of fileState.streams) {
    if (stream.timer !== 0) {
      clearTimeout(stream.timer);
      stream.timer = 0;
    }
  }
}

function removeJob(fileState) {
  if (fileState.jobID !== null) {
    jobs.delete(fileState.jobID);
    fileState.jobID = null;
  }
}

function releaseFile(fileState) {
  if (fileState.released) return;
  if (fileState.reserved > 0) stats.reservedNodes -= fileState.reserved;
  if (fileState.committed > 0) stats.pageCommitted -= fileState.committed;
  if (fileState.reservedStreams > 0) {
    stats.inflightStreams -= fileState.reservedStreams;
  }
  fileState.reserved = 0;
  fileState.committed = 0;
  fileState.reservedStreams = 0;
  fileState.released = true;
}

function commitReservation(fileState, actualNodes) {
  const retained = Math.max(0, Math.min(actualNodes, fileState.reserved));
  stats.reservedNodes -= fileState.reserved - retained;
  stats.inflightStreams -= fileState.reservedStreams;
  fileState.reservedStreams = 0;
  fileState.reserved = retained;
  fileState.committed = retained;
  stats.pageCommitted += retained;
}

function dropPending(fileState) {
  if (!fileState.pendingAdmission) return;
  fileState.pendingAdmission = false;
  stats.pendingFiles = Math.max(0, stats.pendingFiles - 1);
}

function resetStreams(fileState) {
  for (const stream of fileState.streams) {
    if (stream.timer !== 0) clearTimeout(stream.timer);
    stream.timer = 0;
    stream.response = null;
    stream.plan = null;
    stream.nodes = 0;
    stream.started = 0;
  }
}

function failFile(context, fileState, state, reason = "") {
  if (fileState.status === "cancelled") return;
  removeJob(fileState);
  clearStreamTimers(fileState);
  dropPending(fileState);
  releaseFile(fileState);
  fileState.status = "done";
  fileState.state = state;
  fileState.plainReason = reason;
  updateContainerState(context);
}

function terminateWorker() {
  if (readyTimer !== 0) {
    clearTimeout(readyTimer);
    readyTimer = 0;
  }
  const resolve = resolveWorker;
  resolveWorker = null;
  workerPromise = null;
  workerReady = false;
  if (worker !== null) {
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }
  worker = null;
  if (typeof resolve === "function") resolve(false);
}

function failAllInflight(state) {
  for (const [jobID, job] of Array.from(jobs)) {
    jobs.delete(jobID);
    failFile(job.context, job.fileState, state, "worker-error");
  }
}

function disableHighlighting() {
  stats.disabled = true;
  terminateWorker();
  failAllInflight("plain");
  for (const context of contexts.values()) {
    for (const fileState of context.files) {
      if (fileState.status !== "done") failFile(context, fileState, "plain", "disabled");
    }
    updateContainerState(context);
  }
}

function ensureWorker() {
  if (stats.disabled) return Promise.resolve(false);
  if (worker !== null && workerReady) return Promise.resolve(true);
  if (workerPromise !== null) return workerPromise;

  let instance;
  try {
    instance = new Worker(new URL("./chat-highlight-worker.js", import.meta.url), {
      type: "module",
    });
  } catch {
    disableHighlighting();
    return Promise.resolve(false);
  }

  worker = instance;
  workerReady = false;
  instance.onmessage = handleWorkerMessage;
  instance.onerror = () => disableHighlighting();
  instance.onmessageerror = () => disableHighlighting();

  workerPromise = new Promise((resolve) => {
    resolveWorker = resolve;
    readyTimer = setTimeout(() => {
      readyTimer = 0;
      terminateWorker();
      disableHighlighting();
    }, WORKER_READY_TIMEOUT_MS);
  });

  try {
    instance.postMessage({ type: "init" });
  } catch {
    disableHighlighting();
  }
  return workerPromise;
}

function streamAllowed(stream, language) {
  if (ENCODER.encode(stream.text).length > streamCapBytes(language)) return false;
  let chars = 0;
  for (let index = 0; index < stream.text.length; index += 1) {
    if (stream.text.charCodeAt(index) === 10) {
      if (chars > MAX_HIGHLIGHT_LINE_CHARS) return false;
      chars = 0;
    } else {
      chars += 1;
    }
  }
  return chars <= MAX_HIGHLIGHT_LINE_CHARS;
}

function finalizeFile(context, fileState) {
  if (fileState.status === "done" || fileState.status === "cancelled") return;
  let totalNodes = 0;
  for (const stream of fileState.streams) {
    if (stream.response === "tokens") totalNodes += stream.nodes;
  }
  if (totalNodes > MAX_TOKEN_NODES_PER_FILE) {
    failFile(context, fileState, "plain", "tokens");
    return;
  }

  const scroller = scrollerOf(context.container);
  const saved = saveView(scroller);
  let hasTokens = false;
  for (const stream of fileState.streams) {
    if (stream.response !== "tokens" || !Array.isArray(stream.plan)) continue;
    applyPlan(stream.targets, stream.plan);
    hasTokens = true;
  }

  commitReservation(fileState, totalNodes);
  fileState.status = "done";
  fileState.state = hasTokens ? "tokens" : "plain";
  if (!hasTokens) fileState.plainReason = "plain";
  if (hasTokens) restoreView(scroller, saved);
  removeJob(fileState);
  updateContainerState(context);
}

function handleTimeout(jobID) {
  const job = jobs.get(jobID);
  if (job === undefined) return;
  const { context, fileState } = job;
  if (
    contexts.get(context.partID) !== context ||
    context.cancelled ||
    context.generation !== job.generation ||
    context.viewKey !== job.viewKey ||
    fileState.jobID !== jobID
  ) {
    jobs.delete(jobID);
    return;
  }
  jobs.delete(jobID);
  stats.timeouts += 1;
  const language = fileState.language;
  const count = (context.timeouts.get(language) || 0) + 1;
  context.timeouts.set(language, count);

  terminateWorker();
  failAllInflight("error");
  failFile(context, fileState, "error", "timeout");

  if (count >= MAX_TIMEOUTS_PER_LANGUAGE) {
    for (const file of context.files) {
      if (file.language !== language || file.status === "done") continue;
      if (file.status === "waiting" || file.status === "idle") {
        failFile(context, file, "plain", "breaker");
      }
    }
  }
  updateContainerState(context);
}

function handleWorkerMessage(event) {
  const data = event === null || event === undefined ? null : event.data;
  if (data === null || typeof data !== "object") return;

  if (data.type === "ready") {
    if (readyTimer !== 0) {
      clearTimeout(readyTimer);
      readyTimer = 0;
    }
    workerReady = true;
    const resolve = resolveWorker;
    resolveWorker = null;
    workerPromise = null;
    if (typeof resolve === "function") resolve(true);
    return;
  }

  if (data.type === "error" && (typeof data.jobID !== "string" || data.jobID.length === 0)) {
    disableHighlighting();
    return;
  }

  const job = jobs.get(data.jobID);
  if (job === undefined) return;
  const { context, fileState } = job;
  if (
    contexts.get(context.partID) !== context ||
    context.cancelled ||
    context.generation !== job.generation ||
    context.viewKey !== job.viewKey ||
    fileState.jobID !== data.jobID ||
    fileState.status !== "inflight"
  ) {
    jobs.delete(data.jobID);
    return;
  }

  const stream = fileState.streams.find((entry) => entry.id === data.streamID);
  if (stream === undefined || stream.response !== null) return;

  if (stream.timer !== 0) {
    clearTimeout(stream.timer);
    stream.timer = 0;
  }
  const elapsed = Math.max(0, Date.now() - stream.started);
  stats.pageWorkMs += elapsed;
  context.workMs += elapsed;

  if (data.type === "tokens") {
    const plan = Array.isArray(data.lines) ? data.lines : [];
    const nodes =
      typeof data.tokenNodes === "number" && Number.isFinite(data.tokenNodes)
        ? Math.max(0, Math.floor(data.tokenNodes))
        : 0;
    if (plan.length !== stream.expectedLines) {
      stream.response = "mismatch";
      stream.plan = null;
      stream.nodes = 0;
    } else {
      stream.response = "tokens";
      stream.plan = plan;
      stream.nodes = nodes;
    }
  } else if (data.type === "plain") {
    stream.response = "plain";
    fileState.plainReason = typeof data.reason === "string" ? data.reason : "plain";
  } else {
    stream.response = "error";
    fileState.plainReason = typeof data.reason === "string" ? data.reason : "error";
  }

  if (stream.response === "plain") {
    failFile(context, fileState, "plain", fileState.plainReason);
    return;
  }
  if (stream.response === "error") {
    failFile(context, fileState, "error", fileState.plainReason);
    return;
  }

  fileState.requestsOut -= 1;
  if (fileState.requestsOut <= 0) finalizeFile(context, fileState);
}

function dispatchFile(context, fileState) {
  if (fileState.status !== "waiting") return;
  if (contexts.get(context.partID) !== context || context.cancelled) return;
  if (stats.disabled) {
    failFile(context, fileState, "plain", "disabled");
    return;
  }
  if ((context.timeouts.get(fileState.language) || 0) >= MAX_TIMEOUTS_PER_LANGUAGE) {
    failFile(context, fileState, "plain", "breaker");
    return;
  }
  if (
    stats.pageWorkMs >= MAX_HIGHLIGHT_PAGE_WORK_MS ||
    context.workMs >= MAX_HIGHLIGHT_VIEW_WORK_MS
  ) {
    failFile(context, fileState, "budget", "work");
    return;
  }

  const streams = fileState.streams.filter(
    (stream) => stream.expectedLines > 0 && stream.response === null,
  );
  if (streams.length === 0 || fileState.language === null) {
    finalizeFile(context, fileState);
    return;
  }
  if (!streams.every((stream) => streamAllowed(stream, fileState.language))) {
    failFile(context, fileState, "plain", "caps");
    return;
  }

  const jobID = `hj${++jobSequence}`;
  fileState.jobID = jobID;
  fileState.generation = context.generation;
  fileState.status = "inflight";
  fileState.requestsOut = streams.length;
  jobs.set(jobID, {
    context,
    fileState,
    generation: context.generation,
    viewKey: context.viewKey,
  });

  for (const stream of streams) {
    stream.started = Date.now();
    stream.timer = setTimeout(() => handleTimeout(jobID), HIGHLIGHT_TIMEOUT_MS);
    try {
      worker.postMessage({
        type: "tokenize",
        jobID,
        streamID: stream.id,
        text: stream.text,
        language: fileState.language,
      });
    } catch {
      disableHighlighting();
      return;
    }
  }
  updateContainerState(context);
}

function submitContext(context) {
  if (context.cancelled || stats.disabled) {
    for (const fileState of context.files) {
      if (fileState.state !== "tokens") fileState.state = "plain";
    }
    updateContainerState(context);
    return;
  }

  for (const fileState of context.files) {
    if (!fileState.eligible) {
      fileState.state = "plain";
      continue;
    }
    if (fileState.status === "inflight" || fileState.status === "waiting") continue;
    if (fileState.status === "done" && fileState.state === "tokens") continue;

    dropPending(fileState);
    clearStreamTimers(fileState);
    removeJob(fileState);
    releaseFile(fileState);
    resetStreams(fileState);
    restorePlain(fileState);
    fileState.released = false;
    fileState.committed = 0;
    fileState.reserved = 0;
    fileState.reservedStreams = 0;
    fileState.status = "idle";
    fileState.state = "pending";

    if ((context.timeouts.get(fileState.language) || 0) >= MAX_TIMEOUTS_PER_LANGUAGE) {
      fileState.state = "plain";
      fileState.status = "done";
      continue;
    }
    if (
      stats.pageWorkMs >= MAX_HIGHLIGHT_PAGE_WORK_MS ||
      context.workMs >= MAX_HIGHLIGHT_VIEW_WORK_MS
    ) {
      fileState.state = "budget";
      fileState.status = "done";
      continue;
    }
    if (!workerReady && stats.pendingFiles >= MAX_PENDING_HIGHLIGHT_FILES) {
      fileState.state = "budget";
      fileState.status = "done";
      continue;
    }

    const logical = fileState.kind === "diff" ? 2 : 1;
    if (
      !reservationFits(stats.reservedNodes, stats.inflightStreams, logical)
    ) {
      fileState.state = "budget";
      fileState.status = "done";
      continue;
    }

    const units = reservationUnits(logical);
    stats.reservedNodes += units.nodes;
    stats.inflightStreams += units.streams;
    fileState.reserved = units.nodes;
    fileState.reservedStreams = units.streams;
    fileState.status = "waiting";

    if (workerReady) {
      dispatchFile(context, fileState);
      continue;
    }
    fileState.pendingAdmission = true;
    stats.pendingFiles += 1;
    ensureWorker().then((ready) => {
      dropPending(fileState);
      if (!ready) {
        failFile(context, fileState, "plain", "disabled");
        return;
      }
      if (contexts.get(context.partID) === context && !context.cancelled) {
        dispatchFile(context, fileState);
      }
    });
  }
  updateContainerState(context);
}

export function mountToolView(view, options = {}) {
  if (view === null || typeof view !== "object" || view.kind === "plain") return null;
  const partID = options.partID === undefined ? "" : String(options.partID);
  const viewKey = options.viewKey === undefined ? "" : String(options.viewKey);
  cancelContext(partID);

  const context = {
    partID,
    viewKey,
    view,
    generation: 0,
    cancelled: false,
    submitted: false,
    container: null,
    files: [],
    workMs: 0,
    timeouts: new Map(),
  };

  if (view.kind === "files") {
    context.container = renderFileList(view);
  } else if (view.kind === "diff") {
    context.container = renderDiff(view, context);
  } else if (view.kind === "write") {
    context.container = renderWrite(view, context);
  } else {
    return null;
  }

  contexts.set(partID, context);
  updateContainerState(context);
  return context.container;
}

export function setToolViewOpen(partID, viewKey, view, body, open) {
  void view;
  void body;
  const key = partID === undefined ? "" : String(partID);
  const context = contexts.get(key);
  if (context === undefined || context.viewKey !== String(viewKey)) return false;

  if (open) {
    context.submitted = true;
    submitContext(context);
    return true;
  }

  closeContext(context);
  return true;
}

function closeContext(context) {
  context.generation += 1;
  context.submitted = false;
  for (const fileState of context.files) {
    clearStreamTimers(fileState);
    dropPending(fileState);
    removeJob(fileState);
    releaseFile(fileState);
    resetStreams(fileState);
    restorePlain(fileState);
    fileState.status = fileState.eligible ? "idle" : "done";
    fileState.state = "plain";
    fileState.released = false;
  }
  updateContainerState(context);
}

function cancelContext(partID) {
  const context = contexts.get(partID);
  if (context === undefined) return;
  context.cancelled = true;
  context.generation += 1;
  for (const fileState of context.files) {
    clearStreamTimers(fileState);
    dropPending(fileState);
    removeJob(fileState);
    releaseFile(fileState);
    resetStreams(fileState);
    fileState.status = "cancelled";
  }
  contexts.delete(partID);
}

export function resetHighlightController(options = {}) {
  const partID = options.partID;
  if (partID !== undefined && partID !== null) {
    cancelContext(String(partID));
    return;
  }

  controllerGeneration += 1;
  for (const part of Array.from(contexts.keys())) cancelContext(part);
  contexts.clear();
  jobs.clear();
  stats.inflightStreams = 0;
  stats.reservedNodes = 0;
  stats.pageCommitted = 0;
  stats.pendingFiles = 0;
  stats.timeouts = 0;
  stats.pageWorkMs = 0;
  void controllerGeneration;
}

export function getHighlightStats() {
  return {
    inflightStreams: stats.inflightStreams,
    reservedNodes: stats.reservedNodes,
    pageCommitted: stats.pageCommitted,
    pendingFiles: stats.pendingFiles,
    disabled: stats.disabled,
    timeouts: stats.timeouts,
  };
}
