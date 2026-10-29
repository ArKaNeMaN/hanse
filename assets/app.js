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
  // Delegated so a client-side chrome swap does not lose the mobile drawer close.
  shell.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".sidebar a[href]") === null) {
      return;
    }
    if (window.matchMedia("(max-width: 1023px)").matches) {
      closeNav(false);
    }
  });
}

window.addEventListener("resize", () => {
  if (window.matchMedia("(min-width: 1024px)").matches && navOpen()) {
    closeNav(false);
  }
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
