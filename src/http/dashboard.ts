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

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/app.css"></head><body class="min-h-screen bg-base-100 text-base-content">${body}</body></html>`;
}

function stateBadge(state: string): string {
  const map: Record<string, string> = {
    delivered: "badge-success",
    rejected: "badge-error",
    failed: "badge-error",
    expired: "badge-warning",
    awaiting_approval: "badge-warning",
    dispatching: "badge-info",
    in_progress: "badge-info",
    queued: "badge-ghost",
    cancelled: "badge-ghost",
  };
  return `<span class="badge badge-sm ${map[state] ?? "badge-ghost"}">${escapeHtml(state)}</span>`;
}

function navbar(authenticated: boolean): string {
  const right = authenticated
    ? '<span class="text-xs opacity-60">operator</span>'
    : '<a class="btn btn-xs btn-ghost" href="/login">sign in</a>';
  const ideUrl = process.env.HANSE_IDE_URL;
  const ide =
    ideUrl !== undefined && ideUrl.length > 0
      ? `<a class="btn btn-xs btn-ghost" href="${escapeHtml(ideUrl)}" target="_blank" rel="noreferrer">IDE</a>`
      : "";
  return `<div class="navbar min-h-12 border-b border-base-300 bg-base-200 px-4"><div class="flex-1"><span class="text-lg font-semibold tracking-tight">hanse</span></div><div class="flex-none flex items-center gap-2">${ide}${right}</div></div>`;
}

export function renderLogin(): string {
  return page(
    "hanse - sign in",
    `<div class="flex min-h-screen items-center justify-center p-4"><form method="post" action="/login" class="card w-80 border border-base-300 bg-base-200"><div class="card-body gap-3"><h1 class="text-xl font-semibold tracking-tight">hanse</h1><p class="text-xs opacity-60">Enter the operator token.</p><input name="token" type="password" class="input input-bordered input-sm w-full" placeholder="operator token" autofocus><button class="btn btn-primary btn-sm w-full">sign in</button></div></form></div>`,
  );
}

function renderProject(project: ProjectView, authenticated: boolean): string {
  const appRows = project.apps
    .map(
      (app) =>
        `<tr><td class="font-medium">${escapeHtml(app.appKey)}</td><td class="font-mono text-xs opacity-60">${escapeHtml(app.path)}</td><td>${app.kind ? `<span class="badge badge-ghost badge-sm">${escapeHtml(app.kind)}</span>` : ""}</td><td class="text-right"><a class="btn btn-xs btn-primary" href="/chat?app=${encodeURIComponent(app.appKey)}">chat</a></td></tr>`,
    )
    .join("");
  const handoffRows = project.handoffs
    .map((handoff) => {
      const actions =
        authenticated && handoff.state === "awaiting_approval"
          ? `<form method="post" action="/api/handoffs/${escapeHtml(handoff.id)}/approve" class="inline"><button class="btn btn-xs btn-success">approve</button></form> <form method="post" action="/api/handoffs/${escapeHtml(handoff.id)}/reject" class="inline"><button class="btn btn-xs btn-error">reject</button></form>`
          : "";
      return `<tr><td class="font-mono text-xs">${escapeHtml(handoff.id.slice(0, 8))}</td><td>${stateBadge(handoff.state)}</td><td class="text-xs opacity-70">${escapeHtml(handoff.fromAppId.split(":").pop() ?? "")}</td><td class="text-xs opacity-70">${escapeHtml(handoff.toAppId.split(":").pop() ?? "")}</td><td class="text-xs">${escapeHtml(handoff.summary)}</td><td class="text-right">${actions}</td></tr>`;
    })
    .join("");
  const addApp = authenticated
    ? `<form method="post" action="/api/projects/${escapeHtml(project.id)}/apps" class="mt-2 flex flex-wrap items-center gap-2"><input name="name" class="input input-bordered input-xs w-40" placeholder="app name" required><input name="path" class="input input-bordered input-xs w-44" placeholder="path (optional)"><input name="remote" class="input input-bordered input-xs w-64" placeholder="git remote (optional)"><button class="btn btn-xs btn-primary">add app</button></form>`
    : "";
  return `<section class="card border border-base-300 bg-base-200"><div class="card-body gap-3 p-4"><h2 class="card-title text-base">${escapeHtml(project.name)} <span class="font-mono text-xs font-normal opacity-40">${escapeHtml(project.id.slice(0, 8))}</span></h2><div class="overflow-x-auto"><table class="table table-sm"><thead><tr><th>app</th><th>path</th><th>kind</th><th></th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="text-sm opacity-50">(no applications)</td></tr>'}</tbody></table></div>${addApp}<div class="divider my-1"></div><h3 class="text-sm font-semibold">Handoffs</h3><div class="overflow-x-auto"><table class="table table-sm"><thead><tr><th>id</th><th>state</th><th>from</th><th>to</th><th>summary</th><th></th></tr></thead><tbody>${handoffRows || '<tr><td colspan="6" class="text-sm opacity-50">(no handoffs)</td></tr>'}</tbody></table></div></div></section>`;
}

export function renderDashboard(projects: ProjectView[], authenticated: boolean): string {
  const newProject = authenticated
    ? '<form method="post" action="/api/projects" class="flex items-center gap-2"><input name="name" class="input input-bordered input-sm w-56" placeholder="new project name"><button class="btn btn-primary btn-sm">create</button></form>'
    : "";
  const sections =
    projects.length === 0
      ? '<div class="text-sm opacity-60">No projects. Create one above or mount a project with <code>.hanse/project.yaml</code>.</div>'
      : projects.map((project) => renderProject(project, authenticated)).join("");
  return page(
    "hanse",
    `${navbar(authenticated)}<main class="mx-auto max-w-6xl space-y-5 p-4"><div class="flex items-center justify-between"><h1 class="text-lg font-semibold">Projects</h1>${newProject}</div>${sections}</main>`,
  );
}
