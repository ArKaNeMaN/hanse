(() => {
let saveInFlight = false;

function beginSave() {
  if (saveInFlight) {
    return null;
  }
  saveInFlight = true;
  return () => {
    saveInFlight = false;
  };
}

const SECTION_IDS = {
  agent: "settings-agent",
  web: "settings-web",
  context: "settings-context",
  git: "settings-git",
  restart: "settings-restart",
};

function syncDriverFields(select) {
  const form = select.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const driver = select.value;
  form.querySelectorAll("[data-driver-fields]").forEach((group) => {
    if (!(group instanceof HTMLElement)) {
      return;
    }
    const name = group.getAttribute("data-driver-fields");
    const active = name === driver;
    group.hidden = !active;
    group.querySelectorAll("input, select, textarea").forEach((control) => {
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement
      ) {
        control.disabled = !active;
      }
    });
  });
}

function syncAllDrivers() {
  document.querySelectorAll("[data-settings-driver]").forEach((select) => {
    if (select instanceof HTMLSelectElement) {
      syncDriverFields(select);
    }
  });
}

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.hasAttribute("data-settings-driver")) {
    syncDriverFields(target);
  }
});

syncAllDrivers();

const clearDialog = document.querySelector("#settings-clear-dialog");
const clearForm =
  clearDialog instanceof HTMLDialogElement ? clearDialog.querySelector("form") : null;
const clearTitle = document.querySelector("#settings-clear-title");
const clearBody = document.querySelector("#settings-clear-body");
const clearMeta = document.querySelector("#settings-clear-meta");
const clearFields = ["scope", "projectId", "appKey", "return_to", "key", "provider"];
let clearSourceForm = null;

function openClearDialog(sourceForm, submitter) {
  if (!(clearDialog instanceof HTMLDialogElement) || !(clearForm instanceof HTMLFormElement)) {
    return false;
  }
  clearSourceForm = sourceForm;
  clearError(clearForm);
  clearForm.setAttribute("action", sourceForm.getAttribute("action") ?? "/api/settings");
  clearForm.querySelectorAll("[data-clear-copy]").forEach((node) => node.remove());
  for (const name of clearFields) {
    const source = sourceForm.querySelector(`input[type="hidden"][name="${name}"]`);
    if (!(source instanceof HTMLInputElement) || source.value.length === 0) {
      continue;
    }
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = source.value;
    input.setAttribute("data-clear-copy", "");
    clearForm.appendChild(input);
  }
  const label =
    submitter instanceof HTMLElement
      ? (submitter.getAttribute("data-setting-label") ?? "setting")
      : "setting";
  const providerField = sourceForm.querySelector('input[type="hidden"][name="provider"]');
  const provider = providerField instanceof HTMLInputElement ? providerField.value : "";
  if (clearTitle !== null) {
    clearTitle.textContent = `Clear ${label} at this scope?`;
  }
  if (clearBody !== null) {
    clearBody.textContent =
      provider.length > 0
        ? "Wider keys and host auth will be suppressed for this application."
        : "Wider scopes will no longer apply. The setting stays disabled until you set it again.";
  }
  if (clearMeta !== null) {
    const scopeField = sourceForm.querySelector('input[type="hidden"][name="scope"]');
    clearMeta.textContent =
      scopeField instanceof HTMLInputElement ? `Scope: ${scopeField.value}` : "";
  }
  clearDialog.showModal();
  return true;
}

function clearBusy() {
  return clearForm instanceof HTMLFormElement && clearForm.dataset.submitting === "true";
}

if (clearDialog instanceof HTMLDialogElement) {
  clearDialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => clearDialog.close());
  });
  clearDialog.addEventListener("click", (event) => {
    if (event.target === clearDialog) {
      clearDialog.close();
    }
  });
  clearDialog.addEventListener("cancel", (event) => {
    if (clearBusy()) {
      event.preventDefault();
    }
  });
}

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const dialog = target.closest("#settings-clear-dialog");
    if (!(dialog instanceof HTMLDialogElement) || !clearBusy()) {
      return;
    }
    if (target === dialog || target.closest("[data-dialog-close]") !== null) {
      event.stopImmediatePropagation();
    }
  },
  true,
);

function errorSlot(form) {
  const row = form.closest(".setting-row");
  return row?.querySelector("[data-settings-error]") ?? form.querySelector("[data-settings-error]");
}

function firstControl(form) {
  return form.querySelector(
    "input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea",
  );
}

function clearError(form) {
  const slot = errorSlot(form);
  if (slot instanceof HTMLElement) {
    slot.textContent = "";
    slot.hidden = true;
  }
  form.querySelectorAll("[aria-invalid='true']").forEach((control) => {
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-describedby");
  });
}

function showError(form, message) {
  const slot = errorSlot(form);
  if (!(slot instanceof HTMLElement)) {
    return;
  }
  slot.textContent = message;
  slot.hidden = false;
  const control = firstControl(form);
  if (control instanceof HTMLElement) {
    control.setAttribute("aria-invalid", "true");
    if (slot.id.length > 0) {
      control.setAttribute("aria-describedby", slot.id);
    }
    control.focus();
  }
}

function setBusy(form, busy) {
  form.setAttribute("aria-busy", busy ? "true" : "false");
  if (busy) {
    form.querySelectorAll("input, select, textarea, button").forEach((control) => {
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLSelectElement) &&
        !(control instanceof HTMLTextAreaElement) &&
        !(control instanceof HTMLButtonElement)
      ) {
        return;
      }
      if (control.disabled) {
        return;
      }
      control.dataset.settingsBusy = "1";
      control.disabled = true;
    });
    return;
  }
  form.querySelectorAll("[data-settings-busy]").forEach((control) => {
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLSelectElement) &&
      !(control instanceof HTMLTextAreaElement) &&
      !(control instanceof HTMLButtonElement)
    ) {
      return;
    }
    control.disabled = false;
    delete control.dataset.settingsBusy;
  });
}

function formRowId(form) {
  const row = form.closest(".setting-row");
  return row instanceof HTMLElement ? row.id : "";
}

function returnHash(form) {
  if (!(form instanceof HTMLFormElement)) {
    return "";
  }
  const returnTo = form.querySelector("input[name='return_to']");
  if (!(returnTo instanceof HTMLInputElement) || returnTo.value.length === 0) {
    return "";
  }
  try {
    return new URL(returnTo.value, window.location.origin).hash;
  } catch {
    return "";
  }
}

function anchorHash(hash, focusRowId) {
  if (hash.length > 1) {
    const target = document.getElementById(hash.slice(1));
    if (target instanceof HTMLElement && target.classList.contains("setting-row")) {
      return hash;
    }
  }
  return focusRowId.length > 0 ? `#${focusRowId}` : hash;
}

function updateUrl(hash) {
  const url = new URL(window.location.href);
  url.searchParams.delete("notice");
  url.searchParams.delete("tone");
  url.hash = hash.length > 1 ? hash : "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function showToast(message, tone) {
  const region = document.getElementById("toast-region");
  if (!(region instanceof HTMLElement)) {
    return;
  }
  const isError = tone === "error";
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = isError ? "error" : "success";
  toast.setAttribute("role", isError ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "toast__icon";
  icon.appendChild(svgIcon(isError ? "alert-triangle" : "check"));
  const copy = document.createElement("div");
  copy.className = "toast__copy";
  const strong = document.createElement("strong");
  strong.textContent = message;
  copy.appendChild(strong);
  const close = document.createElement("button");
  close.className = "btn btn-ghost btn-icon btn-sm";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.appendChild(svgIcon("x"));
  close.addEventListener("click", () => toast.remove());
  toast.append(icon, copy, close);
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function fragmentPayload(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Array.isArray(data.changed) &&
    data.sections !== null &&
    typeof data.sections === "object"
  );
}

function isSkippedControl(control, skipForm, skipRow) {
  if (control.name.length === 0) {
    return true;
  }
  if (
    control instanceof HTMLInputElement &&
    (control.type === "hidden" || control.type === "password")
  ) {
    return true;
  }
  if (skipForm instanceof HTMLFormElement && control.closest("form") === skipForm) {
    return true;
  }
  if (skipRow instanceof HTMLElement && control.closest(".setting-row") === skipRow) {
    return true;
  }
  return false;
}

function captureDrafts(changed, skipForm) {
  const skipRow = skipForm instanceof HTMLFormElement ? skipForm.closest(".setting-row") : null;
  const drafts = [];
  const counts = new Map();
  for (const name of changed) {
    const sectionId = SECTION_IDS[name];
    if (sectionId === undefined) {
      continue;
    }
    const section = document.getElementById(sectionId);
    if (section === null) {
      continue;
    }
    section.querySelectorAll("input, select, textarea").forEach((control) => {
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLSelectElement) &&
        !(control instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      if (isSkippedControl(control, skipForm, skipRow)) {
        return;
      }
      const row = control.closest(".setting-row");
      const rowId = row instanceof HTMLElement ? row.id : "";
      const key = `${rowId}\u0000${control.name}`;
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      drafts.push({
        sectionId,
        rowId,
        name: control.name,
        index,
        value: control.value,
        checked: control instanceof HTMLInputElement ? control.checked : false,
      });
    });
  }
  return drafts;
}

function restoreDrafts(drafts) {
  for (const draft of drafts) {
    const scope =
      draft.rowId.length > 0
        ? document.getElementById(draft.rowId)
        : document.getElementById(draft.sectionId);
    if (scope === null) {
      continue;
    }
    const matches = [];
    scope.querySelectorAll("input, select, textarea").forEach((control) => {
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLSelectElement) &&
        !(control instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      if (control.name !== draft.name) {
        return;
      }
      if (
        control instanceof HTMLInputElement &&
        (control.type === "hidden" || control.type === "password")
      ) {
        return;
      }
      matches.push(control);
    });
    const control = matches[draft.index];
    if (control === undefined) {
      continue;
    }
    if (control instanceof HTMLInputElement) {
      if (control.type === "checkbox" || control.type === "radio") {
        control.checked = draft.checked;
      } else {
        control.value = draft.value;
      }
    } else if (control instanceof HTMLSelectElement) {
      const hasOption = Array.from(control.options).some((option) => option.value === draft.value);
      if (hasOption) {
        control.value = draft.value;
      }
    } else {
      control.value = draft.value;
    }
  }
}

function replaceSection(key, html) {
  const id = SECTION_IDS[key];
  if (id === undefined || typeof html !== "string" || html.length === 0) {
    return false;
  }
  const current = document.getElementById(id);
  if (current === null) {
    return false;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const next = template.content.firstElementChild;
  if (!(next instanceof HTMLElement) || next.id !== id) {
    return false;
  }
  current.replaceWith(next);
  return true;
}

function replaceWarnings(html) {
  if (typeof html !== "string") {
    return false;
  }
  const wrapper = document.getElementById("settings-warnings");
  if (wrapper === null) {
    return false;
  }
  if (wrapper.innerHTML !== html) {
    wrapper.innerHTML = html;
  }
  return true;
}

function applySections(data, options) {
  if (!fragmentPayload(data)) {
    return false;
  }
  const settings = options === undefined || options === null ? {} : options;
  const changed = data.changed.filter((name) => typeof name === "string");
  const skipForm = settings.skipForm instanceof HTMLFormElement ? settings.skipForm : null;
  const focusRowId = typeof settings.focusRowId === "string" ? settings.focusRowId : "";
  const message =
    typeof settings.message === "string" && settings.message.length > 0
      ? settings.message
      : "Settings saved.";
  const onSuccess = typeof settings.onSuccess === "function" ? settings.onSuccess : null;
  const returnToHash = returnHash(skipForm);

  const openRowIds = [];
  document.querySelectorAll(".setting-row").forEach((row) => {
    if (row instanceof HTMLDetailsElement && row.open && row.id.length > 0) {
      openRowIds.push(row.id);
    }
  });
  const drafts = captureDrafts(changed, skipForm);
  const focusRow = focusRowId.length > 0 ? document.getElementById(focusRowId) : null;
  const focusTop = focusRow instanceof HTMLElement ? focusRow.getBoundingClientRect().top : null;
  const scroller = document.querySelector(".page");
  const scrollerElement = scroller instanceof HTMLElement ? scroller : null;
  const scrollLeft = scrollerElement?.scrollLeft ?? window.scrollX;
  const scrollTop = scrollerElement?.scrollTop ?? window.scrollY;

  let applied = 0;
  for (const key of changed) {
    if (key === "warnings") {
      if (replaceWarnings(data.sections.warnings)) {
        applied += 1;
      }
      continue;
    }
    if (replaceSection(key, data.sections[key])) {
      applied += 1;
    }
  }
  if (applied !== changed.length) {
    return false;
  }

  for (const id of openRowIds) {
    const row = document.getElementById(id);
    if (row instanceof HTMLDetailsElement) {
      row.open = true;
    }
  }
  restoreDrafts(drafts);
  syncAllDrivers();

  const nextFocus = focusRowId.length > 0 ? document.getElementById(focusRowId) : null;
  if (nextFocus instanceof HTMLElement) {
    if (nextFocus instanceof HTMLDetailsElement) {
      nextFocus.open = true;
    }
    if (focusTop !== null) {
      const delta = nextFocus.getBoundingClientRect().top - focusTop;
      if (scrollerElement !== null) {
        scrollerElement.scrollTop += delta;
      } else {
        window.scrollBy(0, delta);
      }
    }
    const summary = nextFocus.querySelector("summary");
    if (summary instanceof HTMLElement) {
      summary.focus({ preventScroll: true });
    }
  } else if (scrollerElement !== null) {
    scrollerElement.scrollTop = scrollTop;
    scrollerElement.scrollLeft = scrollLeft;
  } else {
    window.scrollTo(scrollLeft, scrollTop);
  }

  updateUrl(anchorHash(returnToHash, focusRowId));
  showToast(message);
  if (onSuccess !== null) {
    onSuccess();
  }
  return true;
}

function navigateAfterSave(form, message) {
  const returnTo = form.querySelector("input[name='return_to']");
  const target =
    returnTo instanceof HTMLInputElement && returnTo.value.length > 0
      ? returnTo.value
      : window.location.pathname;
  const url = new URL(target, window.location.origin);
  const hash = url.hash;
  url.hash = "";
  const notice =
    typeof message === "string" && message.length > 0
      ? message
      : (form.getAttribute("data-success-notice") ?? "Settings saved.");
  url.searchParams.set("notice", notice);
  url.searchParams.set("tone", "success");
  window.location.assign(`${url.toString()}${hash}`);
}

function submitForm(form, body, options) {
  const release = beginSave();
  if (release === null) {
    showError(form, "Another settings save is still in progress.");
    return;
  }
  void submitFormLocked(form, body, options).finally(release);
}

async function submitFormLocked(form, body, options) {
  if (form.dataset.submitting === "true") {
    return;
  }
  form.dataset.submitting = "true";
  clearError(form);
  setBusy(form, true);
  const settings = options === undefined || options === null ? {} : options;
  const skipForm = settings.skipForm instanceof HTMLFormElement ? settings.skipForm : form;
  const focusRowId =
    typeof settings.focusRowId === "string" ? settings.focusRowId : formRowId(form);
  const failureMessage =
    typeof settings.failureMessage === "string"
      ? settings.failureMessage
      : "The setting could not be saved.";
  try {
    const response = await fetch(form.getAttribute("action") ?? window.location.href, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "x-hanse-fragment": "settings",
      },
      body: body.toString(),
    });
    if (response.status === 401) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!response.ok) {
      let message = failureMessage;
      try {
        const data = await response.json();
        if (data !== null && typeof data.error === "string") {
          message = data.error;
        }
      } catch {
        message = failureMessage;
      }
      showError(form, message);
      return;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const applied = applySections(data, {
      skipForm,
      message: settings.message,
      focusRowId,
      onSuccess: settings.onSuccess,
    });
    if (applied) {
      return;
    }
    navigateAfterSave(form, settings.message);
  } catch {
    showError(form, failureMessage);
  } finally {
    if (form.isConnected) {
      setBusy(form, false);
      delete form.dataset.submitting;
    }
  }
}

function submitClear(form) {
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  if (form.dataset.submitting === "true") {
    return;
  }
  const source = clearSourceForm instanceof HTMLFormElement ? clearSourceForm : null;
  const sourceRowId = source === null ? "" : formRowId(source);
  const body = new URLSearchParams(new FormData(form));
  if (!body.has("action")) {
    body.set("action", "clear");
  }
  submitForm(form, body, {
    skipForm: source === null ? form : source,
    focusRowId: sourceRowId,
    message: "Setting cleared.",
    failureMessage: "The setting could not be cleared.",
    onSuccess: () => {
      if (clearDialog instanceof HTMLDialogElement && clearDialog.open) {
        clearDialog.close();
      }
      clearSourceForm = null;
      const row = sourceRowId.length > 0 ? document.getElementById(sourceRowId) : null;
      const summary = row instanceof HTMLElement ? row.querySelector("summary") : null;
      if (summary instanceof HTMLElement) {
        summary.focus({ preventScroll: true });
      }
    },
  });
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  if (form.id === "settings-clear-form") {
    event.preventDefault();
    submitClear(form);
    return;
  }
  if (form.matches("[data-git-auth]")) {
    return;
  }
  if (!form.hasAttribute("data-settings-form")) {
    return;
  }
  const submitter = event.submitter;
  if (submitter instanceof HTMLElement && submitter.hasAttribute("data-confirm-clear")) {
    event.preventDefault();
    if (form.dataset.submitting === "true") {
      return;
    }
    openClearDialog(form, submitter);
    return;
  }
  event.preventDefault();
  if (form.dataset.submitting === "true") {
    return;
  }
  const formData =
    submitter instanceof HTMLElement ? new FormData(form, submitter) : new FormData(form);
  const body = new URLSearchParams(formData);
  if (!body.has("action")) {
    body.set("action", "set");
  }
  let focusRowId = formRowId(form);
  if (focusRowId.length === 0 && form.classList.contains("provider-add__form")) {
    const provider = form.querySelector('input[name="provider"]');
    if (provider instanceof HTMLInputElement && provider.value.length > 0) {
      focusRowId = `provider-${encodeURIComponent(provider.value)}`;
    }
  }
  submitForm(form, body, {
    skipForm: form,
    focusRowId,
    message: form.getAttribute("data-success-notice") ?? "Settings saved.",
  });
});

window.hanseSettings = { applySections, showToast, beginSave };

if (window.location.hash.length > 1) {
  let target = null;
  try {
    target = document.querySelector(window.location.hash);
  } catch {
    target = null;
  }
  if (target instanceof HTMLDetailsElement && target.classList.contains("setting-row")) {
    target.open = true;
  }
}
})();
