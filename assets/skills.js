(() => {
  const FRAGMENT_VALUE = "skills";
  const DEFAULT_ERROR = "The skill could not be saved.";

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

  function showToast(message) {
    const region = document.getElementById("toast-region");
    if (!(region instanceof HTMLElement)) {
      return;
    }
    region.querySelectorAll("[data-skill-toast]").forEach((node) => node.remove());
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.tone = "success";
    toast.setAttribute("role", "status");
    toast.setAttribute("data-skill-toast", "");
    toast.setAttribute("data-autodismiss", "6000");
    const icon = document.createElement("span");
    icon.className = "toast__icon";
    icon.appendChild(svgIcon("check"));
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

  function errorSlot(form) {
    const slot = form.querySelector("[data-skill-error]");
    return slot instanceof HTMLElement ? slot : null;
  }

  function clearError(form) {
    const slot = errorSlot(form);
    if (slot !== null) {
      slot.textContent = "";
      slot.hidden = true;
    }
    form.querySelectorAll("[aria-invalid='true']").forEach((control) => {
      control.removeAttribute("aria-invalid");
    });
  }

  function showError(form, message) {
    const slot = errorSlot(form);
    if (slot !== null) {
      slot.textContent = message;
      slot.hidden = false;
    }
    const control = form.querySelector(
      "input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea",
    );
    if (control instanceof HTMLElement) {
      control.setAttribute("aria-invalid", "true");
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
        control.dataset.skillBusy = "1";
        control.disabled = true;
      });
      return;
    }
    form.querySelectorAll("[data-skill-busy]").forEach((control) => {
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLSelectElement) &&
        !(control instanceof HTMLTextAreaElement) &&
        !(control instanceof HTMLButtonElement)
      ) {
        return;
      }
      control.disabled = false;
      delete control.dataset.skillBusy;
    });
  }

  function openRowIds() {
    const ids = [];
    document.querySelectorAll("#skills-surface details.setting-row[open]").forEach((row) => {
      if (row instanceof HTMLElement && row.id.length > 0) {
        ids.push(row.id);
      }
    });
    return ids;
  }

  function restoreOpenRows(ids) {
    for (const id of ids) {
      const row = document.getElementById(id);
      if (row instanceof HTMLDetailsElement) {
        row.open = true;
      }
    }
  }

  function scroller() {
    const page = document.querySelector(".page");
    return page instanceof HTMLElement ? page : null;
  }

  function scrollTop() {
    const page = scroller();
    return page === null ? window.scrollY : page.scrollTop;
  }

  function restoreScroll(top) {
    const page = scroller();
    if (page !== null) {
      page.scrollTop = top;
    } else {
      window.scrollTo(0, top);
    }
  }

  function focusRow(id) {
    const row = id.length > 0 ? document.getElementById(id) : null;
    if (row instanceof HTMLDetailsElement) {
      row.open = true;
      const summary = row.querySelector("summary");
      if (summary instanceof HTMLElement) {
        summary.focus({ preventScroll: true });
      }
      return true;
    }
    if (row instanceof HTMLElement) {
      row.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  function focusNamedSkill(name) {
    if (name.length === 0) {
      return false;
    }
    const rows = document.querySelectorAll("#skills-defined details.setting-row[data-skill-name]");
    for (const row of rows) {
      if (row instanceof HTMLElement && row.getAttribute("data-skill-name") === name) {
        return focusRow(row.id);
      }
    }
    return false;
  }

  function replaceSurface(surface) {
    const current = document.getElementById("skills-surface");
    if (!(current instanceof HTMLElement) || typeof surface !== "string") {
      return false;
    }
    const template = document.createElement("template");
    template.innerHTML = surface;
    const next = template.content.firstElementChild;
    if (!(next instanceof HTMLElement) || next.id !== "skills-surface") {
      return false;
    }
    current.replaceWith(next);
    return true;
  }

  function updateCounter(input) {
    const max = Number(input.getAttribute("data-skill-counter"));
    const field = input.closest(".field");
    const output = field === null ? null : field.querySelector("[data-skill-counter-output]");
    if (output instanceof HTMLElement && Number.isFinite(max)) {
      output.textContent = `${input.value.length} / ${max}`;
    }
  }

  function initCounters() {
    document.querySelectorAll("[data-skill-counter]").forEach((input) => {
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        updateCounter(input);
      }
    });
  }

  function closeDialogs() {
    document.querySelectorAll("dialog.dialog[open]").forEach((dialog) => {
      if (dialog instanceof HTMLDialogElement) {
        dialog.close();
      }
    });
  }

  function formFocusId(form) {
    const row = form.closest("details.setting-row");
    if (row instanceof HTMLElement && row.id.length > 0) {
      return row.id;
    }
    return "";
  }

  function formSkillName(form) {
    const name = form.querySelector('input[name="name"]');
    return name instanceof HTMLInputElement ? name.value.trim() : "";
  }

  async function submitSkillForm(form) {
    if (form.dataset.submitting === "true") {
      return;
    }
    form.dataset.submitting = "true";
    clearError(form);
    const openIds = openRowIds();
    const top = scrollTop();
    const focusId = formFocusId(form);
    const skillName = formSkillName(form);
    // Serialize before disabling controls; disabled fields are omitted from FormData.
    const body = new URLSearchParams(new FormData(form));
    setBusy(form, true);
    try {
      const response = await fetch(form.getAttribute("action") ?? window.location.href, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "x-hanse-fragment": FRAGMENT_VALUE,
        },
        body: body.toString(),
      });
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!response.ok) {
        let message = DEFAULT_ERROR;
        try {
          const payload = await response.json();
          if (payload !== null && typeof payload === "object" && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch (error) {
          void error;
        }
        showError(form, message);
        return;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        typeof payload.surface !== "string"
      ) {
        showError(form, "The server returned an unexpected response.");
        return;
      }
      closeDialogs();
      if (!replaceSurface(payload.surface)) {
        window.location.reload();
        return;
      }
      restoreOpenRows(openIds);
      restoreScroll(top);
      initCounters();
      if (!focusRow(focusId) && skillName.length > 0) {
        focusNamedSkill(skillName);
      }
      showToast(form.getAttribute("data-success-notice") ?? "Skill saved.");
    } catch (error) {
      showError(form, "The skill could not be saved. Check your connection and try again.");
    } finally {
      if (form.isConnected) {
        setBusy(form, false);
        delete form.dataset.submitting;
      }
    }
  }

  const deleteDialog = document.getElementById("skill-delete-dialog");
  const deleteForm =
    deleteDialog === null ? null : deleteDialog.querySelector("[data-skill-delete-form]");

  function openDeleteDialog(button) {
    if (!(deleteDialog instanceof HTMLDialogElement) || !(deleteForm instanceof HTMLFormElement)) {
      return;
    }
    const id = button.getAttribute("data-skill-id") ?? "";
    const name = button.getAttribute("data-skill-name") ?? "";
    const returnTo = button.getAttribute("data-return-to") ?? "";
    if (!/^\d+$/.test(id)) {
      return;
    }
    deleteForm.setAttribute("action", `/api/skills/${id}/delete`);
    const returnField = deleteForm.querySelector('input[name="return_to"]');
    if (returnField instanceof HTMLInputElement) {
      returnField.value = returnTo;
    }
    deleteForm.querySelectorAll("[data-skill-delete-name]").forEach((node) => {
      node.textContent = name;
    });
    clearError(deleteForm);
    deleteDialog.showModal();
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-skill-form")) {
      return;
    }
    event.preventDefault();
    void submitSkillForm(form);
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      target.hasAttribute("data-skill-counter")
    ) {
      updateCounter(target);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const remove = target.closest("[data-skill-delete]");
    if (remove instanceof HTMLElement) {
      openDeleteDialog(remove);
      return;
    }
    const cancel = target.closest("[data-skill-cancel]");
    if (cancel !== null) {
      const row = cancel.closest("details.setting-row");
      if (row instanceof HTMLDetailsElement) {
        row.open = false;
      }
      return;
    }
    const example = target.closest("[data-skill-example]");
    if (example !== null) {
      const dialog = example.closest("dialog.dialog");
      if (!(dialog instanceof HTMLElement)) {
        return;
      }
      const name = dialog.querySelector('input[name="name"]');
      const description = dialog.querySelector('input[name="description"]');
      const content = dialog.querySelector('textarea[name="content"]');
      if (name instanceof HTMLInputElement) {
        name.value = "release-checklist";
        name.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (description instanceof HTMLInputElement) {
        description.value =
          "Use when preparing a release, to verify the version, changelog, and rollback plan before tagging.";
        description.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (content instanceof HTMLTextAreaElement) {
        content.value = [
          "# Release checklist",
          "",
          "1. Confirm the working tree is clean and the base branch is up to date.",
          "2. Verify the version and changelog entry.",
          "3. Run the full test suite and the build.",
          "4. Record the rollback plan before tagging.",
        ].join("\n");
        content.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  });

  function openHashRow() {
    if (window.location.hash.length <= 1) {
      return;
    }
    let target = null;
    try {
      target = document.querySelector(window.location.hash);
    } catch (error) {
      target = null;
    }
    if (target instanceof HTMLDetailsElement && target.classList.contains("setting-row")) {
      target.open = true;
      const summary = target.querySelector("summary");
      if (summary instanceof HTMLElement) {
        summary.focus({ preventScroll: true });
      }
    }
  }

  initCounters();
  openHashRow();
  window.addEventListener("hashchange", openHashRow);
})();
