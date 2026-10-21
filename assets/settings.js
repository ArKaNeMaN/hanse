(() => {
const driverSelects = document.querySelectorAll("[data-settings-driver]");

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

driverSelects.forEach((select) => {
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  syncDriverFields(select);
  select.addEventListener("change", () => syncDriverFields(select));
});

const clearDialog = document.querySelector("#settings-clear-dialog");
const clearForm =
  clearDialog instanceof HTMLDialogElement ? clearDialog.querySelector("form") : null;
const clearTitle = document.querySelector("#settings-clear-title");
const clearBody = document.querySelector("#settings-clear-body");
const clearMeta = document.querySelector("#settings-clear-meta");
const clearFields = ["scope", "projectId", "appKey", "return_to", "key", "provider"];

function openClearDialog(sourceForm, submitter) {
  if (!(clearDialog instanceof HTMLDialogElement) || !(clearForm instanceof HTMLFormElement)) {
    return false;
  }
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

if (clearDialog instanceof HTMLDialogElement) {
  clearDialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => clearDialog.close());
  });
  clearDialog.addEventListener("click", (event) => {
    if (event.target === clearDialog) {
      clearDialog.close();
    }
  });
}

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
    form.querySelectorAll("button[type='submit']").forEach((button) => {
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return;
      }
      button.dataset.settingsBusy = "1";
      button.disabled = true;
    });
    return;
  }
  form.querySelectorAll("button[data-settings-busy]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.disabled = false;
    delete button.dataset.settingsBusy;
  });
}

function navigateAfterSave(form) {
  const returnTo = form.querySelector("input[name='return_to']");
  const target =
    returnTo instanceof HTMLInputElement && returnTo.value.length > 0
      ? returnTo.value
      : window.location.pathname;
  const url = new URL(target, window.location.origin);
  const hash = url.hash;
  url.hash = "";
  url.searchParams.set("notice", form.getAttribute("data-success-notice") ?? "Settings saved.");
  url.searchParams.set("tone", "success");
  window.location.assign(`${url.toString()}${hash}`);
}

async function submitSettings(form, body) {
  if (form.dataset.submitting === "true") {
    return;
  }
  form.dataset.submitting = "true";
  clearError(form);
  setBusy(form, true);
  try {
    const response = await fetch(form.getAttribute("action") ?? window.location.href, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (response.status === 401) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!response.ok) {
      let message = "The setting could not be saved.";
      try {
        const data = await response.json();
        if (data !== null && typeof data.error === "string") {
          message = data.error;
        }
      } catch {
        message = "The setting could not be saved.";
      }
      showError(form, message);
      return;
    }
    navigateAfterSave(form);
  } catch {
    showError(form, "The setting could not be saved.");
  } finally {
    if (form.isConnected) {
      setBusy(form, false);
      delete form.dataset.submitting;
    }
  }
}

document.querySelectorAll("[data-settings-form]").forEach((form) => {
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", (event) => {
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
      event.submitter instanceof HTMLElement
        ? new FormData(form, event.submitter)
        : new FormData(form);
    const body = new URLSearchParams(formData);
    if (!body.has("action")) {
      body.set("action", "set");
    }
    submitSettings(form, body);
  });
});
})();
