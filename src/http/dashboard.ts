import type { Handoff } from "../coordinator/handoff.js";
import type { RegisteredApp } from "../registry/index.js";

export interface ProjectView {
  id: string;
  name: string;
  apps: RegisteredApp[];
  handoffs: Handoff[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = [
  "body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem;color:#111;background:#fafafa}",
  "h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}",
  "table{border-collapse:collapse;width:100%;margin:.5rem 0;background:#fff}",
  "th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:.85rem}",
  "th{background:#f0f0f0}form{display:inline}",
  "button{cursor:pointer;padding:.15rem .5rem;margin-right:.25rem}",
  "input,textarea{font-family:inherit;padding:.25rem;margin:.15rem 0;width:100%}",
  "fieldset{border:1px solid #ddd;margin:.6rem 0;padding:.6rem}",
  ".muted{color:#666;font-size:.8rem}",
].join("");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderLogin(): string {
  return page(
    "hanse - sign in",
    [
      "<h1>hanse</h1>",
      "<p>Enter the operator token to manage handoffs.</p>",
      '<form method="post" action="/login"><input name="token" type="password" placeholder="operator token" autofocus><button type="submit">Sign in</button></form>',
    ].join(""),
  );
}

function renderHandoffRow(handoff: Handoff, authenticated: boolean): string {
  const pending = handoff.state === "awaiting_approval";
  const actions = pending
    ? authenticated
      ? `<form method="post" action="/api/handoffs/${escapeHtml(handoff.id)}/approve"><button type="submit">approve</button></form>` +
        `<form method="post" action="/api/handoffs/${escapeHtml(handoff.id)}/reject"><button type="submit">reject</button></form>`
      : '<span class="muted">sign in to decide</span>'
    : "";
  return `<tr><td>${escapeHtml(handoff.id.slice(0, 8))}</td><td>${escapeHtml(handoff.state)}</td><td>${escapeHtml(handoff.fromAppId)}</td><td>${escapeHtml(handoff.toAppId)}</td><td>${escapeHtml(handoff.summary)}</td><td>${actions}</td></tr>`;
}

function renderNewHandoffForm(project: ProjectView): string {
  if (project.apps.length < 2) {
    return '<p class="muted">Two applications are required to create a handoff.</p>';
  }
  const options = project.apps
    .map((app) => `<option value="${escapeHtml(app.appKey)}">${escapeHtml(app.appKey)}</option>`)
    .join("");
  return [
    `<fieldset><legend>New handoff</legend>`,
    `<form method="post" action="/api/handoffs">`,
    `<input type="hidden" name="project" value="${escapeHtml(project.id)}">`,
    `from <select name="from">${options}</select> to <select name="to">${options}</select>`,
    `<input name="summary" placeholder="summary">`,
    `<textarea name="spec" placeholder="spec / requirement" rows="3"></textarea>`,
    `<label><input type="checkbox" name="requires_approval" value="1" style="width:auto"> requires approval</label>`,
    `<button type="submit">Request change</button>`,
    `</form></fieldset>`,
  ].join("");
}

export function renderDashboard(projects: ProjectView[], authenticated: boolean): string {
  const parts: string[] = ["<h1>hanse</h1>"];
  parts.push(
    authenticated
      ? '<p class="muted">signed in as operator</p>'
      : '<p class="muted">read-only - <a href="/login">sign in</a></p>',
  );
  parts.push(
    authenticated
      ? '<fieldset><legend>New project</legend><form method="post" action="/api/projects"><input name="name" placeholder="project name"><button type="submit">Create</button></form></fieldset>'
      : "",
  );
  if (projects.length === 0) {
    parts.push(
      '<p class="muted">No projects registered. Mount a project with <code>.hanse/project.yaml</code>.</p>',
    );
  }
  for (const project of projects) {
    parts.push(
      `<h2>${escapeHtml(project.name)} <span class="muted">${escapeHtml(project.id.slice(0, 8))}</span></h2>`,
    );
    const appRows = project.apps
      .map(
        (app) =>
          `<tr><td>${escapeHtml(app.appKey)}</td><td>${escapeHtml(app.path)}</td><td>${escapeHtml(app.kind ?? "-")}</td><td><a href="/chat?app=${encodeURIComponent(app.appKey)}">chat</a></td></tr>`,
      )
      .join("");
    parts.push(
      `<table><thead><tr><th>app</th><th>path</th><th>kind</th><th></th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="muted">(no applications)</td></tr>'}</tbody></table>`,
    );
    const handoffRows = project.handoffs
      .map((handoff) => renderHandoffRow(handoff, authenticated))
      .join("");
    parts.push(
      `<table><thead><tr><th>id</th><th>state</th><th>from</th><th>to</th><th>summary</th><th></th></tr></thead><tbody>${handoffRows || '<tr><td colspan="6" class="muted">(no handoffs)</td></tr>'}</tbody></table>`,
    );
    if (authenticated) {
      parts.push(renderNewHandoffForm(project));
    }
  }
  return page("hanse", parts.join(""));
}
