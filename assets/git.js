(function () {
  const panel = document.getElementById("git-panel");
  if (panel === null) {
    return;
  }

  const projectId = panel.dataset.projectId || "";
  const appKey = panel.dataset.appKey || "";
  const configuredBase = panel.dataset.apiBase || "";
  const apiBase =
    configuredBase.length > 0
      ? configuredBase.replace(/\/+$/, "")
      : `/api/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appKey)}/git`;

  const liveEl = document.getElementById("git-live");
  const refreshedEl = document.getElementById("git-refreshed");
  const refreshButton = document.getElementById("git-refresh");
  const repositoryBody = document.getElementById("git-repository-body");
  const changesBody = document.getElementById("git-changes-body");
  const remotesBody = document.getElementById("git-remotes-body");
  const lastCommitBody = document.getElementById("git-last-commit-body");
  const changesTitle = document.getElementById("changes-title");
  const changeCountsEl = document.getElementById("git-change-counts");

  if (repositoryBody === null || changesBody === null) {
    return;
  }

  const STATUS_TIMEOUT = 30_000;
  const ACTION_TIMEOUT = 180_000;
  const BODIES = [repositoryBody, changesBody, remotesBody, lastCommitBody];
  const GROUP_ORDER = ["staged", "unstaged", "untracked", "conflicted"];
  const GROUP_LABEL = {
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
    conflicted: "Conflicted",
  };
  const BUSY_LABEL = {
    fetch: "Fetching",
    update: "Updating",
    push: "Pushing",
    commit: "Committing",
    switch: "Switching",
  };
  const ACTION_PATH = {
    fetch: "fetch",
    update: "update",
    push: "push",
    commit: "commit",
    switch: "branches/switch",
  };

  let status = null;
  let loading = false;
  let busyAction = null;
  let redirecting = false;
  let commitDraft = "";
  let refreshedAt = 0;
  let needsRefresh = false;

  class GitApiError extends Error {
    constructor(message, code, httpStatus) {
      super(message);
      this.name = "GitApiError";
      this.code = code || "git_failed";
      this.httpStatus = httpStatus || 0;
    }
  }

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

  function setLive(text) {
    if (liveEl !== null) {
      liveEl.textContent = text;
    }
  }

  function goToLogin() {
    redirecting = true;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }

  async function request(path, options, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        cache: "no-store",
        ...(options || {}),
        signal: controller.signal,
      });
      if (response.status === 401) {
        goToLogin();
        throw new GitApiError("Session expired. Sign in again.", "session_expired", 401);
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
          data && typeof data.error === "string"
            ? data.error
            : `Request failed (${response.status})`;
        const code = data && typeof data.code === "string" ? data.code : "git_failed";
        throw new GitApiError(message.slice(0, 400), code, response.status);
      }
      if (data === null || typeof data !== "object") {
        throw new GitApiError(
          "The server returned an unexpected response.",
          "git_failed",
          response.status,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof GitApiError) {
        throw error;
      }
      if (error && error.name === "AbortError") {
        throw new GitApiError("The git operation timed out.", "timeout", 0);
      }
      throw new GitApiError(
        "The coordinator could not be reached. Check the connection and try again.",
        "network",
        0,
      );
    } finally {
      window.clearTimeout(timer);
    }
  }

  function statusFrom(data) {
    if (data && typeof data === "object" && data.status && typeof data.status === "object") {
      return data.status;
    }
    return data;
  }

  async function readStatusQuiet() {
    try {
      const data = await request("/status", undefined, STATUS_TIMEOUT);
      if (redirecting) {
        return null;
      }
      const next = statusFrom(data);
      return next && typeof next.state === "string" ? next : null;
    } catch (error) {
      void error;
      return null;
    }
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
    if (seconds < 45) {
      return "just now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    if (days === 1) {
      return "yesterday";
    }
    return `${days}d ago`;
  }

  function commitDate(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function markRefreshed() {
    refreshedAt = Date.now();
    if (refreshedEl === null) {
      return;
    }
    refreshedEl.textContent = "Refreshed just now";
    refreshedEl.title = new Date(refreshedAt).toLocaleString();
  }

  function refreshCaption() {
    if (refreshedEl === null || refreshedAt === 0) {
      return;
    }
    const minutes = Math.floor((Date.now() - refreshedAt) / 60_000);
    refreshedEl.textContent = minutes < 1 ? "Refreshed just now" : `Refreshed ${minutes}m ago`;
  }

  function ensureSpinner(button) {
    if (button.querySelector(".spinner") === null) {
      const spinner = element("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      button.prepend(spinner);
    }
  }

  function removeSpinner(button) {
    const spinner = button.querySelector(".spinner");
    if (spinner !== null) {
      spinner.remove();
    }
  }

  function setRefreshBusy(busy) {
    if (refreshButton === null) {
      return;
    }
    if (busy) {
      refreshButton.setAttribute("aria-busy", "true");
      refreshButton.setAttribute("aria-disabled", "true");
      ensureSpinner(refreshButton);
      return;
    }
    refreshButton.removeAttribute("aria-busy");
    refreshButton.removeAttribute("aria-disabled");
    removeSpinner(refreshButton);
    refreshButton.disabled = busyAction !== null;
  }

  function loadingSkeleton(label) {
    const fragment = document.createDocumentFragment();
    fragment.append(element("p", "sr-only", label));
    const stack = element("div", "skeleton-stack");
    stack.setAttribute("aria-hidden", "true");
    stack.append(
      element("span", "skeleton skeleton--title"),
      element("span", "skeleton"),
      element("span", "skeleton skeleton--short"),
      element("span", "skeleton"),
    );
    fragment.append(stack);
    return fragment;
  }

  function showLoading() {
    const labels = [
      [repositoryBody, "Loading repository status."],
      [changesBody, "Loading changes."],
      [remotesBody, "Loading remotes."],
      [lastCommitBody, "Loading last commit."],
    ];
    for (const [node, label] of labels) {
      if (node === null) {
        continue;
      }
      node.setAttribute("aria-busy", "true");
      node.replaceChildren(loadingSkeleton(label));
    }
    if (changeCountsEl !== null) {
      changeCountsEl.replaceChildren();
    }
  }

  function statusPill(state) {
    const mapping = state.conflicted
      ? { label: "Conflicts", state: "failed", icon: "alert-triangle" }
      : state.operation
        ? { label: "In progress", state: "in_progress", icon: "activity" }
        : state.branch && state.branch.detached
          ? { label: "Detached", state: "cancelled", icon: "slash" }
          : state.clean
            ? { label: "Clean", state: "delivered", icon: "check" }
            : { label: "Changes", state: "awaiting_approval", icon: "stamp" };
    const pill = element("span", "status");
    pill.id = "git-state";
    pill.dataset.state = mapping.state;
    pill.append(iconNode(mapping.icon), document.createTextNode(mapping.label));
    return pill;
  }

  function controlState(state) {
    const branch = state.branch && typeof state.branch === "object" ? state.branch : {};
    const detached = branch.detached === true;
    const unborn = !detached && (branch.head === null || branch.head === undefined);
    const upstream =
      state.upstream && typeof state.upstream.name === "string" ? state.upstream : null;
    const remotes = Array.isArray(state.remotes) ? state.remotes : [];
    const hasOrigin = remotes.some((remote) => remote && remote.name === "origin");
    const noRemote = remotes.length === 0;
    const conflicts = state.conflicted === true;
    const operation = typeof state.operation === "string" && state.operation.length > 0;
    const identity = Boolean(state.identity && state.identity.configured);
    const commitReason = conflicts
      ? "Resolve conflicts in the IDE before committing."
      : operation
        ? `Finish or abort the ${state.operation} in the IDE before committing.`
        : detached
          ? "Detached HEAD. Switch to a branch before committing."
          : !identity
            ? "Set user.name and user.email in the repository or host git config before committing."
            : null;
    return {
      detached,
      unborn,
      upstream,
      hasOrigin,
      noRemote,
      conflicts,
      operation,
      identity,
      commitReason,
      fetch: noRemote,
      update: detached || noRemote || unborn || upstream === null || conflicts || operation,
      push: detached || noRemote || unborn || (upstream === null && !hasOrigin),
      switch: conflicts || operation,
      commit: commitReason !== null,
    };
  }

  function actionsHint(state, rules) {
    if (rules.noRemote) {
      return "No remotes configured. Local commits still work.";
    }
    if (rules.detached) {
      return "Detached HEAD. Switch to a branch before committing.";
    }
    if (rules.conflicts) {
      return "Resolve conflicts in the IDE before committing.";
    }
    if (rules.operation) {
      return "Finish or abort the operation in the IDE.";
    }
    if (rules.unborn) {
      return "No commits yet. Commit changes to create the first commit.";
    }
    if (rules.upstream === null && rules.hasOrigin) {
      const branch = state.branch && state.branch.name ? state.branch.name : "the branch";
      return `Pushes to origin/${branch} and sets the upstream.`;
    }
    if (rules.upstream === null) {
      return "Set an upstream branch in git to update or push.";
    }
    return "Fetch, update, push, or switch this branch.";
  }

  function pushLabel(rules) {
    return !rules.unborn && rules.upstream === null && rules.hasOrigin
      ? "Push and set upstream"
      : "Push";
  }

  function actionLabel(action) {
    if (action === "push" && status && status.state === "ok") {
      return pushLabel(controlState(status));
    }
    if (action === "fetch") {
      return "Fetch";
    }
    if (action === "update") {
      return "Update branch";
    }
    if (action === "commit") {
      return "Commit all";
    }
    if (action === "switch") {
      return "Switch";
    }
    return "Push";
  }

  function actionButton(id, action, label, iconName) {
    const button = element("button", "btn btn-secondary");
    button.type = "button";
    button.id = id;
    button.dataset.gitAction = action;
    if (iconName !== undefined) {
      button.append(iconNode(iconName));
    }
    button.append(element("span", "btn__label", label));
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") {
        return;
      }
      runAction(action, {});
    });
    return button;
  }

  function syncActionControl(id, action, disabled, busyLabel) {
    const button = document.getElementById(id);
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const label = button.querySelector(".btn__label");
    if (busyAction === action) {
      button.disabled = false;
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("aria-busy", "true");
      if (label !== null) {
        label.textContent = busyLabel;
      }
      ensureSpinner(button);
      return;
    }
    button.disabled = disabled || busyAction !== null;
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-busy");
    if (label !== null) {
      label.textContent = actionLabel(action);
    }
    removeSpinner(button);
  }

  function syncControls(current) {
    const ok = current !== null && current.state === "ok";
    const rules = ok ? controlState(current) : null;
    syncActionControl("git-fetch", "fetch", !ok || rules.fetch, BUSY_LABEL.fetch);
    syncActionControl("git-update", "update", !ok || rules.update, BUSY_LABEL.update);
    syncActionControl("git-push", "push", !ok || rules.push, BUSY_LABEL.push);
    syncActionControl("git-commit", "commit", !ok || rules.commit, BUSY_LABEL.commit);
    syncActionControl("git-switch", "switch", !ok || rules.switch, BUSY_LABEL.switch);

    const select = document.getElementById("git-branch-select");
    if (select instanceof HTMLSelectElement) {
      select.disabled = !ok || rules.switch || busyAction !== null;
    }
    const textarea = document.getElementById("git-commit-message");
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.disabled = busyAction !== null;
    }
    if (refreshButton !== null) {
      refreshButton.disabled = busyAction !== null;
    }
    if (needsRefresh && busyAction === null) {
      for (const id of ["git-commit", "git-push"]) {
        const button = document.getElementById(id);
        if (button instanceof HTMLButtonElement) {
          button.disabled = true;
        }
      }
    }
  }

  function emptyState(iconName, title, body, action, detail) {
    const state = element("div", "empty-state");
    const mark = element("span", "empty-state__mark");
    mark.append(iconNode(iconName, "icon--lg"));
    state.append(
      mark,
      element("h3", "empty-state__title", title),
      element("p", "empty-state__body", body),
    );
    if (typeof detail === "string" && detail.length > 0) {
      state.append(element("p", "mono", detail));
    }
    if (action) {
      const link = element("a", "btn btn-secondary btn-sm", action.label);
      link.href = action.href;
      if (action.external === true) {
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      link.prepend(iconNode(action.icon || "external"));
      state.append(link);
    }
    return state;
  }

  function ideHref(root) {
    return typeof root === "string" && root.length > 0
      ? `/ide/?folder=${encodeURIComponent(root)}`
      : null;
  }

  function branchChoices(state) {
    const list = Array.isArray(state.branches) ? state.branches : [];
    const choices = [];
    for (const branch of list) {
      if (typeof branch === "string" && branch.length > 0 && !choices.includes(branch)) {
        choices.push(branch);
      }
    }
    const current = state.branch && typeof state.branch.name === "string" ? state.branch.name : null;
    if (current !== null && !choices.includes(current)) {
      choices.push(current);
    }
    return choices;
  }

  function switchControl(state, rules) {
    const choices = branchChoices(state);
    const current =
      state.branch && state.branch.detached !== true && typeof state.branch.name === "string"
        ? state.branch.name
        : null;
    const needsPlaceholder = Boolean(
      state.branch &&
        (state.branch.detached === true ||
          state.branch.head === null ||
          state.branch.head === undefined),
    );
    if (choices.length === 0) {
      return element("p", "hint", "No local branches available.");
    }
    if (choices.length <= 1 && !needsPlaceholder) {
      const only = choices.length === 1 ? choices[0] : current || "none";
      return element("p", "hint", `Only local branch: ${only}.`);
    }

    const form = element("form", "git-switch");
    form.id = "git-switch-form";
    form.setAttribute("data-no-busy", "");

    const field = element("div", "field");
    const label = element("label", "label", "Switch branch");
    label.htmlFor = "git-branch-select";
    const wrap = element("div", "select-wrap");
    const select = element("select", "select");
    select.id = "git-branch-select";
    if (needsPlaceholder || current === null || !choices.includes(current)) {
      const placeholder = element("option", "", "Choose a branch");
      placeholder.value = "";
      select.append(placeholder);
    }
    for (const branch of choices) {
      const option = element("option", "", branch);
      option.value = branch;
      select.append(option);
    }
    if (!needsPlaceholder && current !== null && choices.includes(current)) {
      select.value = current;
    }
    wrap.append(select, iconNode("chevron-down"));
    field.append(label, wrap);

    const button = element("button", "btn btn-secondary", "Switch");
    button.type = "submit";
    button.id = "git-switch";
    button.disabled = rules.switch;

    select.addEventListener("change", () => {
      if (busyAction !== null || rules.switch) {
        return;
      }
      button.disabled = false;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      requestSwitch();
    });

    form.append(field, button);
    return form;
  }

  function renderRepository(state) {
    const rules = controlState(state);
    const fragment = document.createDocumentFragment();

    const row = element("div", "git-status__row");
    const identity = element("div", "stack--tight");
    identity.append(element("p", "overline", "Current branch"));

    const branchLine = element("div", "git-branch");
    branchLine.id = "git-branch";
    branchLine.append(iconNode("branch"));
    const branchName =
      state.branch && typeof state.branch.name === "string" ? state.branch.name : null;
    const branchLabel =
      state.branch && state.branch.detached
        ? "Detached HEAD"
        : branchName !== null
          ? branchName
          : "Unknown branch";
    const branchText = element("span", "mono", branchLabel);
    if (branchName !== null) {
      branchText.title = branchName;
    }
    branchLine.append(branchText);
    identity.append(branchLine);

    const upstreamLine = element("div", "cluster");
    upstreamLine.id = "git-upstream";
    upstreamLine.append(element("span", "caption", "Upstream"));
    if (rules.upstream !== null) {
      upstreamLine.append(element("span", "mono", rules.upstream.name));
      const ahead = Number(rules.upstream.ahead) || 0;
      const behind = Number(rules.upstream.behind) || 0;
      if (ahead > 0) {
        upstreamLine.append(element("span", "badge badge--mono", `${ahead} ahead`));
      }
      if (behind > 0) {
        upstreamLine.append(element("span", "badge badge--mono", `${behind} behind`));
      }
    } else {
      upstreamLine.append(element("span", "mono", "No upstream"));
    }
    identity.append(upstreamLine);
    row.append(identity);

    const stateCluster = element("div", "cluster");
    stateCluster.append(statusPill(state));
    row.append(stateCluster);

    const actions = element("div", "git-actions");
    actions.id = "git-actions";
    const pushText = pushLabel(rules);
    actions.append(
      actionButton("git-fetch", "fetch", "Fetch", "refresh"),
      actionButton("git-update", "update", "Update branch"),
      actionButton("git-push", "push", pushText, "arrow-right"),
    );

    const hint = element("p", "hint", actionsHint(state, rules));
    hint.id = "git-actions-hint";

    const notice = element("div", "git-notice");
    notice.id = "git-notice";
    notice.hidden = true;

    fragment.append(row, actions, hint, notice, element("hr", "rule"));
    fragment.append(switchControl(state, rules));
    repositoryBody.replaceChildren(fragment);
  }

  function changeLabel(code) {
    const value = typeof code === "string" ? code.toUpperCase() : "";
    if (value === "M") {
      return "Modified";
    }
    if (value === "A") {
      return "Added";
    }
    if (value === "D") {
      return "Deleted";
    }
    if (value === "R") {
      return "Renamed";
    }
    if (value === "C") {
      return "Copied";
    }
    if (value === "T") {
      return "Type changed";
    }
    if (value === "UU") {
      return "Unmerged";
    }
    if (value === "AA") {
      return "Both added";
    }
    if (value === "DD") {
      return "Both deleted";
    }
    if (value.includes("U")) {
      return "Unmerged";
    }
    if (value === "U") {
      return "Unmerged";
    }
    if (value === "?") {
      return "Untracked";
    }
    return "Changed";
  }

  function groupFiles(files) {
    const groups = { staged: [], unstaged: [], untracked: [], conflicted: [] };
    for (const file of files) {
      if (!file || typeof file !== "object") {
        continue;
      }
      const key =
        typeof file.group === "string" && Object.hasOwn(groups, file.group)
          ? file.group
          : "unstaged";
      groups[key].push(file);
    }
    return groups;
  }

  function renderCounts(groups) {
    if (changeCountsEl === null) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const key of GROUP_ORDER) {
      const count = groups[key].length;
      if (count > 0) {
        fragment.append(element("span", "badge badge--mono", `${count} ${key}`));
      }
    }
    changeCountsEl.replaceChildren(fragment);
  }

  function fileGroup(key, files) {
    const group = element("section", "git-group");
    group.dataset.group = key;
    const head = element("div", "git-group__head");
    const title = element("div", "cluster");
    if (key === "conflicted") {
      title.append(iconNode("alert-triangle", "icon--sm"));
    }
    title.append(element("h3", "overline", GROUP_LABEL[key]));
    head.append(title, element("span", "badge badge--mono", String(files.length)));
    group.append(head);

    const list = element("ul", "git-file-list");
    for (const file of files) {
      const item = element("li", "git-file");
      const pathText =
        typeof file.oldPath === "string" && file.oldPath.length > 0
          ? `${file.oldPath} \u2192 ${String(file.path)}`
          : String(file.path || "");
      const path = element("span", "git-file__path mono", pathText);
      path.title = pathText;
      const code = element("span", "git-file__code", String(file.code || "?"));
      code.setAttribute("aria-hidden", "true");
      item.append(path, element("span", "sr-only", changeLabel(file.code)), code);
      list.append(item);
    }
    group.append(list);
    return group;
  }

  function showCommitError(title, message) {
    const errorEl = document.getElementById("git-commit-error");
    const textarea = document.getElementById("git-commit-message");
    if (errorEl === null) {
      showNotice("error", title, message);
      return;
    }
    errorEl.hidden = false;
    errorEl.replaceChildren(
      iconNode("alert-triangle"),
      element("span", "", `${title} ${message}`),
    );
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.setAttribute("aria-invalid", "true");
    }
  }

  function clearCommitError() {
    const errorEl = document.getElementById("git-commit-error");
    const textarea = document.getElementById("git-commit-message");
    if (errorEl !== null) {
      errorEl.hidden = true;
      errorEl.replaceChildren();
    }
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.removeAttribute("aria-invalid");
    }
  }

  function commitForm(state, rules) {
    const form = element("form", "git-commit");
    form.id = "git-commit-form";
    form.setAttribute("data-no-busy", "");

    const field = element("div", "field");
    const label = element("label", "label", "Commit message (required)");
    label.htmlFor = "git-commit-message";
    const textarea = element("textarea", "textarea");
    textarea.id = "git-commit-message";
    textarea.rows = 3;
    textarea.maxLength = 4000;
    textarea.value = commitDraft;
    textarea.setAttribute("aria-required", "true");
    textarea.setAttribute("aria-describedby", "git-commit-hint git-commit-error");

    const hint = element("p", "hint");
    hint.id = "git-commit-hint";
    hint.textContent =
      rules.commitReason ||
      "Commits all staged, unstaged, and untracked changes. Ignored files stay out.";
    if (rules.commitReason !== null && (rules.conflicts || rules.operation)) {
      const href = ideHref(state.root);
      if (href !== null) {
        hint.append(document.createTextNode(" "));
        const link = element("a", "", "Open IDE");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        hint.append(link);
      }
    }

    const errorEl = element("p", "field-error");
    errorEl.id = "git-commit-error";
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    field.append(label, textarea, hint, errorEl);

    const foot = element("div", "git-commit__foot");
    const button = element("button", "btn btn-primary", "Commit all");
    button.type = "submit";
    button.id = "git-commit";
    button.disabled = rules.commit;
    foot.append(button);

    form.append(field, foot);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitCommit();
    });
    textarea.addEventListener("input", () => {
      commitDraft = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        submitCommit();
      }
    });
    return form;
  }

  function cleanState() {
    return emptyState(
      "check",
      "Working tree clean",
      "No staged, unstaged, untracked, or conflicted files.",
    );
  }

  function renderChanges(state) {
    const files = Array.isArray(state.files) ? state.files : [];
    const groups = groupFiles(files);
    renderCounts(groups);
    if (files.length === 0) {
      changesBody.replaceChildren(cleanState());
      return;
    }
    const rules = controlState(state);
    const stack = element("div", "stack");
    for (const key of GROUP_ORDER) {
      if (groups[key].length > 0) {
        stack.append(fileGroup(key, groups[key]));
      }
    }
    stack.append(commitForm(state, rules));
    changesBody.replaceChildren(stack);
  }

  function renderRemotes(state) {
    if (remotesBody === null) {
      return;
    }
    const remotes = Array.isArray(state.remotes) ? state.remotes : [];
    if (remotes.length === 0) {
      remotesBody.replaceChildren(
        emptyState(
          "branch",
          "No remotes configured.",
          "Fetch and push need a remote. Local commits still work.",
        ),
      );
      return;
    }
    const list = element("ul", "git-file-list");
    for (const remote of remotes) {
      if (!remote || typeof remote !== "object") {
        continue;
      }
      const item = element("li", "git-file");
      const name = element("span", "badge badge--mono", String(remote.name || "remote"));
      const url = element("span", "git-file__path mono", String(remote.url || ""));
      url.title = String(remote.url || "");
      item.append(name, url);
      list.append(item);
    }
    remotesBody.replaceChildren(list);
  }

  function renderLastCommit(state) {
    if (lastCommitBody === null) {
      return;
    }
    const commit = state.lastCommit;
    if (!commit || typeof commit !== "object") {
      lastCommitBody.replaceChildren(
        emptyState("branch", "No commits yet.", "The first commit will appear here."),
      );
      return;
    }
    const stack = element("div", "stack--tight");
    stack.append(element("p", "body", String(commit.subject || "(no subject)")));
    const meta = element("div", "cluster");
    const shortHash = element(
      "span",
      "mono",
      String(commit.shortHash || commit.hash || ""),
    );
    if (typeof commit.hash === "string") {
      shortHash.title = commit.hash;
    }
    meta.append(shortHash);
    if (typeof commit.author === "string" && commit.author.length > 0) {
      meta.append(element("span", "caption", commit.author));
    }
    const date = commitDate(commit.committedAt);
    if (date !== null) {
      const time = element("time", "caption", relativeTime(commit.committedAt));
      time.dateTime = date.toISOString();
      time.title = date.toLocaleString();
      meta.append(time);
    }
    stack.append(meta);
    lastCommitBody.replaceChildren(stack);
  }

  function renderUnavailablePanels() {
    if (changeCountsEl !== null) {
      changeCountsEl.replaceChildren();
    }
    if (changesBody !== null) {
      changesBody.replaceChildren(
        element("p", "hint", "Changes are unavailable for this repository."),
      );
    }
    if (remotesBody !== null) {
      remotesBody.replaceChildren(
        element("p", "hint", "Remotes are unavailable for this repository."),
      );
    }
    if (lastCommitBody !== null) {
      lastCommitBody.replaceChildren(
        element("p", "hint", "Commit history is unavailable for this repository."),
      );
    }
  }

  function renderRepositoryState(state) {
    const kind = typeof state.state === "string" ? state.state : "missing";
    if (kind === "not_git") {
      const href = ideHref(state.root);
      repositoryBody.replaceChildren(
        emptyState(
          "branch",
          "Not a git repository",
          "This application path is not a git working tree. Git status and actions are unavailable.",
          href === null
            ? null
            : { label: "Open IDE", href, external: true, icon: "external" },
        ),
      );
      return;
    }
    if (kind === "not_root") {
      const href = ideHref(state.root);
      repositoryBody.replaceChildren(
        emptyState(
          "folder",
          "Not a repository root",
          "This application is inside a larger git repository. Git actions are only available when the application directory is the repository root.",
          href === null
            ? null
            : { label: "Open IDE", href, external: true, icon: "external" },
          typeof state.root === "string" ? state.root : null,
        ),
      );
      return;
    }
    if (kind === "missing") {
      repositoryBody.replaceChildren(
        emptyState(
          "folder",
          "Application path not found",
          "The registered path does not exist. Restore it or update the application manifest.",
          {
            label: "Open project",
            href: `/projects/${encodeURIComponent(projectId)}`,
            icon: "folder",
          },
        ),
      );
      return;
    }
    repositoryBody.replaceChildren(
      emptyState(
        "alert-triangle",
        "Repository status unavailable",
        typeof state.message === "string" && state.message.length > 0
          ? state.message
          : "The repository could not be inspected.",
      ),
    );
  }

  function renderLoadError(error, retry) {
    const outside = error instanceof GitApiError && error.code === "outside_workspace";
    const locked = error instanceof GitApiError && error.code === "git_locked";
    const title = outside
      ? "Repository path outside the workspace"
      : locked
        ? "Repository is locked"
        : "Repository status unavailable";
    const body = outside
      ? "Git actions are blocked because the registered path is outside the coordinator workspace."
      : locked
        ? "Another git process is using this repository. Wait for it to finish or remove a stale lock."
        : error instanceof Error && error.message.length > 0
          ? error.message
          : "The repository status could not be loaded.";

    const state = element("div", "error-state");
    state.setAttribute("role", "alert");
    const mark = element("span", "error-state__mark");
    mark.append(iconNode("alert-triangle", "icon--lg"));
    const copy = element("div");
    copy.append(element("h3", "error-state__title", title), element("p", "error-state__body", body));
    if (!outside) {
      const button = element("button", "btn btn-secondary btn-sm", "Retry");
      button.type = "button";
      button.addEventListener("click", retry);
      copy.append(button);
    } else {
      const link = element("a", "btn btn-secondary btn-sm", "Open project");
      link.href = `/projects/${encodeURIComponent(projectId)}`;
      link.prepend(iconNode("folder"));
      copy.append(link);
    }
    state.append(mark, copy);

    repositoryBody.removeAttribute("aria-busy");
    repositoryBody.replaceChildren(state);
    renderUnavailablePanels();
  }

  function renderStatus(next) {
    status = next;
    needsRefresh = false;
    if (status === null || status.state !== "ok") {
      renderRepositoryState(status || {});
      renderUnavailablePanels();
      markRefreshed();
      syncControls(status);
      return;
    }
    renderRepository(status);
    renderChanges(status);
    renderRemotes(status);
    renderLastCommit(status);
    markRefreshed();
    syncControls(status);
  }

  function showNotice(tone, title, message, retry) {
    const notice = document.getElementById("git-notice");
    if (notice === null) {
      return;
    }
    notice.hidden = false;
    notice.dataset.tone = tone;
    if (tone === "error") {
      notice.setAttribute("role", "alert");
    } else {
      notice.removeAttribute("role");
    }
    const text = element("span");
    if (typeof title === "string" && title.length > 0) {
      text.append(element("strong", "", `${title}. `));
    }
    text.append(document.createTextNode(message));
    const iconName =
      tone === "error" ? "alert-triangle" : tone === "warning" ? "alert-circle" : "check";
    const children = [iconNode(iconName), text];
    if (typeof retry === "function") {
      const button = element("button", "btn btn-secondary btn-sm", "Retry");
      button.type = "button";
      button.addEventListener("click", retry);
      children.push(button);
    }
    notice.replaceChildren(...children);
  }

  function describeError(error, action) {
    const code = error instanceof GitApiError ? error.code : "git_failed";
    const server = error instanceof Error ? error.message : "";
    if (code === "busy") {
      return {
        title: "Another git operation is running",
        message: "Another git operation is already running for this application.",
      };
    }
    if (code === "git_locked") {
      return {
        title: "Repository is locked",
        message:
          "Another git process is using this repository. Wait for it to finish or remove a stale lock.",
      };
    }
    if (code === "no_upstream") {
      return {
        title: "No upstream branch",
        message: "Set an upstream branch in git to update or push.",
      };
    }
    if (code === "detached") {
      return { title: "Detached HEAD", message: "Switch to a branch before doing this." };
    }
    if (code === "conflicts") {
      return {
        title: "Conflicts",
        message: "Resolve conflicts in the IDE before committing.",
      };
    }
    if (code === "operation_in_progress") {
      return {
        title: "Git operation in progress",
        message: "Finish or abort the operation in the IDE first.",
      };
    }
    if (code === "nothing_to_commit") {
      return {
        title: "Nothing to commit",
        message: "The working tree has no changes to commit.",
      };
    }
    if (code === "branch_not_found") {
      return {
        title: "Branch not found",
        message: "That branch no longer exists. Choose another branch.",
      };
    }
    if (code === "diverged") {
      return {
        title: "Update stopped",
        message: "The branch has diverged from its upstream. Reconcile it in the IDE.",
      };
    }
    if (code === "worktree_dirty") {
      return {
        title: "Update stopped",
        message:
          "Commit or discard the changes that would be overwritten, then update again.",
      };
    }
    if (code === "push_rejected") {
      return {
        title: "Push rejected",
        message:
          "The remote has commits you do not have. Fetch and update the branch, then try again.",
      };
    }
    if (code === "auth_failed") {
      return {
        title: "Authentication failed",
        message: server.length > 0 ? server : "Git could not authenticate with the remote.",
      };
    }
    if (code === "timeout") {
      return {
        title: "Timed out",
        message: "The git operation timed out. Refresh status before retrying.",
      };
    }
    if (code === "output_too_large") {
      return {
        title: "Output too large",
        message: "Git produced too much output to read here. Use the IDE for this repository.",
      };
    }
    if (code === "invalid_input") {
      return {
        title: "Check the input",
        message: server.length > 0 ? server : "The value was not accepted.",
      };
    }
    if (code === "outside_workspace") {
      return {
        title: "Repository path outside the workspace",
        message:
          "Git actions are blocked because the registered path is outside the coordinator workspace.",
      };
    }
    if (code === "network") {
      return {
        title: "Connection lost",
        message:
          "The coordinator could not be reached. Check the connection and refresh status before retrying.",
      };
    }
    const title =
      action === "commit"
        ? "Commit failed"
        : action === "switch"
          ? "Could not switch branch"
          : "Action failed";
    return { title, message: server.length > 0 ? server : "The git operation failed." };
  }

  function showErrorNotice(detail, error, action, body) {
    const retry =
      error instanceof GitApiError && error.code === "git_locked"
        ? () => {
            const notice = document.getElementById("git-notice");
            if (notice !== null) {
              notice.hidden = true;
            }
            runAction(action, body);
          }
        : null;
    showNotice("error", detail.title, detail.message, retry);
  }

  function fallbackMessage(action, data, body) {
    const next = data && data.status && typeof data.status === "object" ? data.status : status;
    if (action === "fetch") {
      return "Fetched all remotes.";
    }
    if (action === "update") {
      const head = next && next.branch && typeof next.branch.head === "string" ? next.branch.head : "";
      return head.length >= 7 ? `Branch updated to ${head.slice(0, 7)}.` : "Branch updated.";
    }
    if (action === "push") {
      const upstream = next && next.upstream && typeof next.upstream.name === "string"
        ? next.upstream.name
        : next && next.branch && typeof next.branch.name === "string"
          ? next.branch.name
          : "the remote";
      return `Pushed to ${upstream}.`;
    }
    if (action === "commit") {
      const hash =
        data && data.commit && typeof data.commit.shortHash === "string"
          ? data.commit.shortHash
          : next && next.lastCommit && typeof next.lastCommit.shortHash === "string"
            ? next.lastCommit.shortHash
            : "";
      return hash.length > 0 ? `Committed as ${hash}.` : "Committed changes.";
    }
    if (action === "switch") {
      const branch = body && typeof body.branch === "string" ? body.branch : "the branch";
      return `Switched to ${branch}.`;
    }
    return "Action completed.";
  }

  function focusSelectorFor(action, success) {
    if (action === "commit") {
      return success ? "#changes-title" : "#git-commit";
    }
    if (action === "switch") {
      return success ? "#git-branch-select" : "#git-switch";
    }
    return `#git-${action}`;
  }

  async function refetchAfterUncertainOutcome() {
    try {
      const data = await request("/status", undefined, STATUS_TIMEOUT);
      if (redirecting) {
        return false;
      }
      const next = statusFrom(data);
      if (next && typeof next.state === "string") {
        renderStatus(next);
        return true;
      }
    } catch (error) {
      void error;
    }
    return false;
  }

  async function runAction(action, body) {
    if (busyAction !== null || loading || redirecting) {
      return;
    }
    busyAction = action;
    if (repositoryBody !== null) {
      repositoryBody.setAttribute("aria-busy", "true");
    }
    syncControls(status);
    setLive(`${BUSY_LABEL[action]}...`);

    let focusSelector = null;
    try {
      const data = await request(
        `/${ACTION_PATH[action]}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        },
        ACTION_TIMEOUT,
      );
      if (redirecting) {
        return;
      }

      let fresh = null;
      if (data && data.status && typeof data.status === "object") {
        fresh = data.status;
      } else {
        fresh = await readStatusQuiet();
      }
      if (fresh !== null) {
        renderStatus(fresh);
      }
      if (action === "commit") {
        commitDraft = "";
        const textarea = document.getElementById("git-commit-message");
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.value = "";
        }
      }

      const warning =
        typeof data.warning === "string" && data.warning.length > 0
          ? data.warning
          : fresh === null && !(data && data.status)
            ? "Action completed; refresh status."
            : null;
      if (warning !== null) {
        showNotice("warning", "Action completed", warning);
        setLive(warning);
      } else {
        const message =
          typeof data.message === "string" && data.message.trim().length > 0
            ? data.message
            : fallbackMessage(action, data, body);
        showNotice("success", null, message);
        setLive(message);
      }
      focusSelector = focusSelectorFor(action, true);
    } catch (error) {
      if (redirecting || (error instanceof GitApiError && error.code === "session_expired")) {
        return;
      }
      if (
        (action === "commit" || action === "push") &&
        error instanceof GitApiError &&
        (error.code === "network" || error.code === "timeout")
      ) {
        const refetched = await refetchAfterUncertainOutcome();
        needsRefresh = !refetched;
      }
      const detail = describeError(error, action);
      if (needsRefresh) {
        const hint = document.getElementById("git-commit-hint");
        if (hint !== null) {
          hint.textContent =
            "Status could not be refreshed. Refresh before committing again.";
        }
      }
      if (action === "commit") {
        showCommitError(detail.title, detail.message);
        if (document.getElementById("git-commit-error") === null) {
          showErrorNotice(detail, error, action, body);
        }
      } else {
        showErrorNotice(detail, error, action, body);
      }
      setLive(`${detail.title}. ${detail.message}`);
      focusSelector = focusSelectorFor(action, false);
    } finally {
      busyAction = null;
      if (repositoryBody !== null) {
        repositoryBody.removeAttribute("aria-busy");
      }
      syncControls(status);
      if (focusSelector !== null) {
        const node = document.querySelector(focusSelector);
        if (node instanceof HTMLElement) {
          node.focus();
        }
      }
    }
  }

  function submitCommit() {
    const textarea = document.getElementById("git-commit-message");
    const button = document.getElementById("git-commit");
    if (!(textarea instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
      return;
    }
    if (busyAction !== null || button.disabled) {
      return;
    }
    clearCommitError();
    const message = textarea.value.trim();
    if (message.length === 0) {
      showCommitError("Enter a commit message.", "A message is required before committing.");
      textarea.focus();
      return;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(textarea.value)) {
      showCommitError("Check the commit message.", "Remove control characters before committing.");
      textarea.focus();
      return;
    }
    commitDraft = message;
    runAction("commit", { message });
  }

  function requestSwitch() {
    const select = document.getElementById("git-branch-select");
    const button = document.getElementById("git-switch");
    if (!(select instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) {
      return;
    }
    if (busyAction !== null || button.disabled) {
      return;
    }
    const branch = select.value;
    if (branch.length === 0) {
      showNotice("warning", "Choose a branch", "Select a local branch to switch to.");
      select.focus();
      return;
    }
    if (
      status !== null &&
      status.state === "ok" &&
      status.branch &&
      status.branch.detached !== true &&
      status.branch.name === branch
    ) {
      showNotice("warning", "Already on this branch", `You are already on ${branch}.`);
      select.focus();
      return;
    }
    runAction("switch", { branch });
  }

  async function loadStatus() {
    if (loading || busyAction !== null || redirecting) {
      return;
    }
    loading = true;
    for (const node of BODIES) {
      if (node !== null) {
        node.setAttribute("aria-busy", "true");
      }
    }
    setRefreshBusy(true);
    try {
      const data = await request("/status", undefined, STATUS_TIMEOUT);
      if (redirecting) {
        return;
      }
      const next = statusFrom(data);
      if (!next || typeof next.state !== "string") {
        throw new GitApiError("The server returned an unexpected status.", "git_failed", 0);
      }
      renderStatus(next);
      setLive("Repository status loaded.");
    } catch (error) {
      if (redirecting || (error instanceof GitApiError && error.code === "session_expired")) {
        return;
      }
      renderLoadError(error, () => loadStatus());
      setLive("Repository status could not be loaded.");
    } finally {
      loading = false;
      setRefreshBusy(false);
      for (const node of BODIES) {
        if (node !== null) {
          node.removeAttribute("aria-busy");
        }
      }
    }
  }

  if (changesTitle !== null) {
    changesTitle.setAttribute("tabindex", "-1");
  }

  if (refreshButton !== null) {
    refreshButton.addEventListener("click", () => {
      if (loading || busyAction !== null || refreshButton.getAttribute("aria-disabled") === "true") {
        return;
      }
      loadStatus();
    });
  }

  window.setInterval(refreshCaption, 30_000);
  showLoading();
  loadStatus();
})();
