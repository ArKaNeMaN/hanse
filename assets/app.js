const root = document.documentElement;
const shell = document.getElementById("shell");
const navToggle = document.querySelector("[data-nav-toggle]");

function navOpen() {
  return shell !== null && shell.dataset.nav === "open";
}

function setNav(open) {
  if (shell === null) {
    return;
  }
  shell.dataset.nav = open ? "open" : "closed";
  if (navToggle !== null) {
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  }
  if (open) {
    const first = shell.querySelector(".sidebar .nav-item");
    if (first instanceof HTMLElement) {
      window.setTimeout(() => first.focus(), 0);
    }
  }
}

function closeNav(returnFocus) {
  setNav(false);
  if (returnFocus && navToggle instanceof HTMLElement) {
    navToggle.focus();
  }
}

if (navToggle instanceof HTMLElement) {
  navToggle.addEventListener("click", () => setNav(!navOpen()));
}

document.querySelectorAll("[data-nav-close]").forEach((control) => {
  control.addEventListener("click", () => closeNav(true));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navOpen()) {
    closeNav(true);
  }
});

if (shell !== null) {
  shell.querySelectorAll(".sidebar a[href]").forEach((link) => {
    link.addEventListener("click", () => {
      if (window.matchMedia("(max-width: 1023px)").matches) {
        closeNav(false);
      }
    });
  });
}

window.addEventListener("resize", () => {
  if (window.matchMedia("(min-width: 1024px)").matches && navOpen()) {
    closeNav(false);
  }
});

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

const themeToggle = document.querySelector("[data-theme-toggle]");
const themeLabel = document.querySelector("[data-theme-label]");

function syncTheme(theme) {
  root.dataset.theme = theme;
  if (themeLabel !== null) {
    themeLabel.textContent = theme === "light" ? "Dark" : "Light";
  }
  if (themeToggle !== null) {
    themeToggle.setAttribute(
      "aria-label",
      theme === "light" ? "Switch to dark theme" : "Switch to light theme",
    );
  }
}

syncTheme(root.dataset.theme === "light" ? "light" : "dark");

if (themeToggle !== null) {
  themeToggle.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    syncTheme(next);
    try {
      localStorage.setItem("hanse-theme", next);
    } catch (error) {
      void error;
    }
  });
}

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
