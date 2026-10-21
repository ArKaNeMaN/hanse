for (const form of document.querySelectorAll("form[data-ssh-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.sshConfirm || "Continue?")) {
      event.preventDefault();
    }
  });
}
