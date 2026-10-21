const forms = document.querySelectorAll("[data-git-auth]");

function setBusy(form, busy) {
  form.querySelectorAll("button, input, textarea, select").forEach((control) => {
    control.disabled = busy;
  });
  if (busy) {
    const error = form.querySelector("[data-git-error]");
    if (error !== null) {
      error.hidden = true;
      error.textContent = "";
    }
  }
}

function showError(form, message) {
  const error = form.querySelector("[data-git-error]");
  if (error !== null) {
    error.textContent = message;
    error.hidden = false;
  }
}

function field(formData, name) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function draftValue(formData, kind) {
  if (kind === "ssh") {
    const knownHosts = field(formData, "knownHosts");
    return {
      privateKey: field(formData, "privateKey"),
      ...(knownHosts.trim().length === 0 ? {} : { knownHosts }),
    };
  }
  return {
    hosts: field(formData, "hosts")
      .split(/[\n,]+/)
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
    username: field(formData, "username"),
    token: field(formData, "token"),
  };
}

function buildPayload(form, action) {
  const formData = new FormData(form);
  const kind = field(formData, "kind");
  const payload = {
    scope: field(formData, "scope") || "global",
    kind,
    action,
  };
  const projectId = field(formData, "projectId");
  const appKey = field(formData, "appKey");
  if (projectId.length > 0) {
    payload.projectId = projectId;
  }
  if (appKey.length > 0) {
    payload.appKey = appKey;
  }
  if (action !== "set") {
    return payload;
  }
  payload.value = draftValue(formData, kind);
  return payload;
}

function buildTestPayload(form) {
  const formData = new FormData(form);
  const kind = field(formData, "kind");
  const remote = field(formData, "testRemote").trim();
  const draft = draftValue(formData, kind);
  return {
    kind,
    ...(remote.length === 0 ? {} : { remote }),
    [kind]: draft,
  };
}

function testUrl(form) {
  const formData = new FormData(form);
  const projectId = field(formData, "projectId");
  const appKey = field(formData, "appKey");
  if (projectId.length === 0 || appKey.length === 0) {
    return null;
  }
  return `/api/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appKey)}/git/test`;
}

function testResult(form) {
  return {
    panel: form.querySelector("[data-git-test-result]"),
    summary: form.querySelector("[data-git-test-summary]"),
    warnings: form.querySelector("[data-git-test-warnings]"),
    error: form.querySelector("[data-git-test-error]"),
  };
}

function clearTestResult(form) {
  const result = testResult(form);
  if (result.panel !== null) {
    result.panel.hidden = true;
  }
  if (result.summary !== null) {
    result.summary.textContent = "";
  }
  if (result.warnings !== null) {
    result.warnings.replaceChildren();
    result.warnings.hidden = true;
  }
  if (result.error !== null) {
    result.error.textContent = "";
    result.error.hidden = true;
  }
}

function renderTestResult(form, data) {
  const result = testResult(form);
  if (result.panel === null || result.summary === null) {
    return;
  }
  const parts = [`Connected: ${typeof data.refs === "number" ? data.refs : 0} refs`];
  if (typeof data.remote === "string" && data.remote.length > 0) {
    parts.push(`from ${data.remote}`);
  }
  if (typeof data.head === "string" && data.head.length > 0) {
    parts.push(`HEAD ${data.head}`);
  }
  result.summary.textContent = parts.join(" ");
  if (result.warnings !== null) {
    result.warnings.replaceChildren();
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    for (const warning of warnings) {
      if (typeof warning !== "string" || warning.length === 0) {
        continue;
      }
      const item = document.createElement("li");
      item.textContent = warning;
      result.warnings.appendChild(item);
    }
    result.warnings.hidden = warnings.length === 0;
  }
  if (result.error !== null) {
    result.error.textContent = "";
    result.error.hidden = true;
  }
  result.panel.hidden = false;
}

function renderTestError(form, message) {
  const result = testResult(form);
  if (result.panel === null) {
    return;
  }
  if (result.summary !== null) {
    result.summary.textContent = "";
  }
  if (result.warnings !== null) {
    result.warnings.replaceChildren();
    result.warnings.hidden = true;
  }
  if (result.error !== null) {
    result.error.textContent = message;
    result.error.hidden = false;
  }
  result.panel.hidden = false;
}

function submitTest(form) {
  const url = testUrl(form);
  if (url === null) {
    showError(form, "An application scope is required to test the remote.");
    return;
  }
  const payload = buildTestPayload(form);
  clearTestResult(form);
  setBusy(form, true);
  fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (!response.ok) {
        const message =
          data !== null && typeof data.error === "string"
            ? data.error
            : "The remote could not be reached.";
        renderTestError(form, message);
        setBusy(form, false);
        return;
      }
      if (data === null || typeof data !== "object") {
        renderTestError(form, "The remote returned an invalid result.");
        setBusy(form, false);
        return;
      }
      renderTestResult(form, data);
      setBusy(form, false);
    })
    .catch(() => {
      renderTestError(form, "The remote could not be reached.");
      setBusy(form, false);
    });
}

function noticeFor(action) {
  if (action === "clear") {
    return "Git credential cleared.";
  }
  if (action === "inherit") {
    return "Git credential inherited.";
  }
  return "Git credential saved.";
}

forms.forEach((form) => {
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    const isTest =
      submitter instanceof HTMLElement && submitter.hasAttribute("data-git-test");
    event.preventDefault();
    if (isTest) {
      submitTest(form);
      return;
    }
    const action =
      submitter instanceof HTMLButtonElement && submitter.value.length > 0
        ? submitter.value
        : "set";
    if (action === "clear" && !window.confirm("Clear this git credential at this scope?")) {
      return;
    }
    const payload = buildPayload(form, action);
    setBusy(form, true);
    fetch("/api/settings/git", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        let data = null;
        try {
          data = await response.json();
        } catch (error) {
          data = null;
        }
        if (!response.ok) {
          const message =
            data !== null && typeof data.error === "string"
              ? data.error
              : "The git credential could not be saved.";
          showError(form, message);
          setBusy(form, false);
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set("notice", noticeFor(action));
        url.searchParams.set("tone", "success");
        url.hash = `git-${payload.kind}`;
        window.location.assign(url.toString());
      })
      .catch(() => {
        showError(form, "The git credential could not be saved.");
        setBusy(form, false);
      });
  });
});
