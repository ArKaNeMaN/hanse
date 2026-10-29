document.querySelectorAll("[data-dialog-open]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const id = trigger.getAttribute("data-dialog-open");
    const dialog = id === null ? null : document.getElementById(id);
    if (dialog instanceof HTMLDialogElement && typeof dialog.showModal === "function") {
      dialog.showModal();
    }
  });
});

document.querySelectorAll("[data-dialog-close]").forEach((control) => {
  control.addEventListener("click", () => {
    const dialog = control.closest("dialog");
    if (dialog instanceof HTMLDialogElement) {
      dialog.close();
    }
  });
});

document.querySelectorAll("dialog.dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.querySelectorAll(".field[data-invalid='true']").forEach((field) => {
      field.removeAttribute("data-invalid");
    });
  });
});

function closeMenu(menu, returnFocus) {
  const summary = menu.querySelector("summary");
  menu.open = false;
  if (returnFocus && summary instanceof HTMLElement) {
    summary.focus();
  }
}

document.querySelectorAll("details.menu").forEach((menu) => {
  menu.addEventListener("toggle", () => {
    if (!menu.open) {
      return;
    }
    document.querySelectorAll("details.menu[open]").forEach((other) => {
      if (other !== menu) {
        closeMenu(other, false);
      }
    });
  });
});

document.addEventListener("click", (event) => {
  document.querySelectorAll("details.menu[open]").forEach((menu) => {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) {
      closeMenu(menu, true);
    }
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  const menu = document.querySelector("details.menu[open]");
  if (menu instanceof HTMLDetailsElement) {
    closeMenu(menu, true);
  }
});

document.querySelectorAll(".segmented").forEach((group) => {
  const items = Array.from(group.querySelectorAll(".segmented__item"));
  group.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const index = items.indexOf(document.activeElement);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : items.length - 1;
    const next = items[(index + offset) % items.length];
    if (next instanceof HTMLElement) {
      next.focus();
    }
  });
});

document.querySelectorAll(".toast").forEach((toast) => {
  const close = toast.querySelector("[data-toast-close]");
  if (close !== null) {
    close.addEventListener("click", () => toast.remove());
  }
  const auto = toast.getAttribute("data-autodismiss");
  if (auto !== null) {
    const delay = Number(auto);
    window.setTimeout(() => toast.remove(), Number.isFinite(delay) ? delay : 6000);
  }
});

document.querySelectorAll("[data-password-toggle]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const control = toggle.closest(".field__control");
    const input = control === null ? null : control.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", show ? "true" : "false");
    toggle.setAttribute("aria-label", show ? "Hide token" : "Show token");
  });
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  if (form.hasAttribute("data-no-busy")) {
    return;
  }
  if (form.dataset.submitting === "true") {
    event.preventDefault();
    return;
  }
  const submitter = event.submitter;
  const button =
    submitter instanceof HTMLButtonElement
      ? submitter
      : form.querySelector("button[type='submit']");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  form.dataset.submitting = "true";
  form.setAttribute("aria-busy", "true");
  button.setAttribute("aria-busy", "true");
  window.setTimeout(() => {
    button.disabled = true;
    if (button.querySelector(".spinner") === null) {
      button.insertAdjacentHTML(
        "afterbegin",
        '<span class="spinner" aria-hidden="true"></span>',
      );
    }
  }, 0);
});
