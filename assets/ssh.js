for (const form of document.querySelectorAll("form[data-ssh-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.sshConfirm || "Continue?")) {
      event.preventDefault();
    }
  });
}

for (const input of document.querySelectorAll("input[data-ssh-key-file]")) {
  input.addEventListener("change", () => {
    const file = input.files instanceof FileList ? input.files[0] : undefined;
    const targetId = input.dataset.sshKeyTarget;
    const target = targetId === undefined ? null : document.getElementById(targetId);
    if (file === undefined || !(target instanceof HTMLTextAreaElement)) {
      return;
    }
    file.text().then((text) => {
      target.value = text;
    });
  });
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.insetBlockStart = "-1000px";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

for (const button of document.querySelectorAll("[data-ssh-copy]")) {
  button.addEventListener("click", () => {
    const targetId = button.dataset.sshCopy;
    const target = targetId === undefined ? null : document.getElementById(targetId);
    if (target === null) {
      return;
    }
    const text = target.textContent || "";
    const done = () => {
      const original = button.innerHTML;
      const originalLabel = button.getAttribute("aria-label");
      button.textContent = "Copied";
      button.setAttribute("aria-label", "Copied");
      window.setTimeout(() => {
        button.innerHTML = original;
        if (originalLabel === null) {
          button.removeAttribute("aria-label");
        } else {
          button.setAttribute("aria-label", originalLabel);
        }
      }, 1500);
    };
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  });
}

// Server errors reopen the matching dialog with the open attribute. Upgrade it to a
// modal so it is centered, traps focus, and closes on Escape/backdrop like every other dialog.
for (const dialog of document.querySelectorAll("dialog.dialog[open]")) {
  if (dialog instanceof HTMLDialogElement && typeof dialog.showModal === "function") {
    dialog.removeAttribute("open");
    dialog.showModal();
    const first = dialog.querySelector("input:not([type='hidden']), select, textarea, button");
    if (first instanceof HTMLElement) {
      first.focus();
    }
  }
}
