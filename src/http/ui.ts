import type {
  HandoffDispatchMode,
  HandoffOrigin,
  HandoffOutcome,
  HandoffReplyMode,
  HandoffReplyState,
  HandoffState,
} from "../coordinator/handoff.js";
import { isMasterProject, masterChatHref } from "../master/constants.js";

/**
 * Shared HTML primitives for the hanse web UI.
 *
 * Everything here composes the stage-1 class contract in DESIGN.md. Page modules
 * (dashboard.ts, and later chat.ts) own content; this module owns the shell,
 * icons, escaping, formatting, status rendering, dialogs, login, and toasts.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------------- */
/* Icons                                                                     */
/* ------------------------------------------------------------------------- */

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16" />',
  x: '<path d="M18 6 6 18M6 6l12 12" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  "chevron-right": '<path d="m9 18 6-6-6-6" />',
  "chevron-down": '<path d="m6 9 6 6 6-6" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />',
  dashboard:
    '<rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" />',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />',
  "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" />',
  "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" />',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />',
  external:
    '<path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />',
  clock: '<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />',
  stamp:
    '<path d="M5 22h14" /><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z" /><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13" />',
  send: '<path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" />',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2" />',
  gauge: '<path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" />',
  hourglass:
    '<path d="M5 22h14M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />',
  "alert-triangle":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" />',
  "alert-circle":
    '<circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />',
  slash: '<path d="M22 2 2 22" />',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  terminal: '<polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />',
  code: '<polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />',
  "arrow-right": '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  trash:
    '<path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
  "log-out":
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" />',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
  "eye-off":
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" />',
  loader:
    '<line x1="12" x2="12" y1="2" y2="6" /><line x1="12" x2="12" y1="18" y2="22" /><line x1="4.93" x2="7.76" y1="4.93" y2="7.76" /><line x1="16.24" x2="19.07" y1="16.24" y2="19.07" /><line x1="2" x2="6" y1="12" y2="12" /><line x1="18" x2="22" y1="12" y2="12" /><line x1="4.93" x2="7.76" y1="19.07" y2="16.24" /><line x1="16.24" x2="19.07" y1="7.76" y2="4.93" />',
  more: '<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className?: string): string {
  const classes = className === undefined ? "icon" : `icon ${className}`;
  return `<svg class="${classes}" aria-hidden="true" focusable="false"><use href="#i-${name}" /></svg>`;
}

export function iconSprite(): string {
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join("");
  return `<svg class="sr-only" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

/* ------------------------------------------------------------------------- */
/* Formatting                                                                */
/* ------------------------------------------------------------------------- */

const STATUS: Record<HandoffState, { label: string; icon: IconName }> = {
  queued: { label: "Queued", icon: "clock" },
  awaiting_approval: { label: "Awaiting approval", icon: "stamp" },
  dispatching: { label: "Dispatching", icon: "send" },
  in_progress: { label: "In progress", icon: "activity" },
  delivered: { label: "Delivered", icon: "check" },
  rejected: { label: "Rejected", icon: "x" },
  failed: { label: "Failed", icon: "alert-triangle" },
  expired: { label: "Expired", icon: "hourglass" },
  cancelled: { label: "Cancelled", icon: "slash" },
};

export function statusLabel(state: HandoffState): string {
  return STATUS[state].label;
}

export function statusIcon(state: HandoffState): IconName {
  return STATUS[state].icon;
}

export function statusPill(state: HandoffState): string {
  return `<span class="status" data-state="${state}">${icon(STATUS[state].icon)}${STATUS[state].label}</span>`;
}

const REPLY_STATUS: Record<HandoffReplyState, { label: string; icon: IconName } | null> = {
  none: null,
  pending: { label: "Reply queued", icon: "clock" },
  awaiting_approval: { label: "Reply approval", icon: "stamp" },
  delivered: { label: "Reply delivered", icon: "check" },
  waiting_operator: { label: "Reply waiting", icon: "inbox" },
  failed: { label: "Reply failed", icon: "alert-triangle" },
  cancelled: { label: "Reply cancelled", icon: "slash" },
};

export function replyPill(state: HandoffReplyState): string {
  const entry = REPLY_STATUS[state];
  return entry === null ? "" : `<span class="badge">${icon(entry.icon)}${entry.label}</span>`;
}

export type RuntimeState = "starting" | "running" | "stopped" | "error";

export function runtimePill(state: RuntimeState): string {
  if (state === "starting") {
    return `<span class="status" data-state="dispatching">${icon("loader")}Starting</span>`;
  }
  if (state === "running") {
    return `<span class="status" data-state="in_progress">${icon("activity")}Running</span>`;
  }
  if (state === "error") {
    return `<span class="status" data-state="failed">${icon("alert-triangle")}Error</span>`;
  }
  return `<span class="status" data-state="queued">${icon("clock")}Stopped</span>`;
}

export function deletionStatus(label = "Deletion incomplete"): string {
  return `<span class="status" data-state="failed">${icon("alert-triangle")}${escapeHtml(label)}</span>`;
}

export function initials(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return "OP";
  }
  if (words.length === 1) {
    return (words[0] ?? "OP").slice(0, 2).toUpperCase();
  }
  return `${(words[0] ?? "").slice(0, 1)}${(words[1] ?? "").slice(0, 1)}`.toUpperCase();
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  return absoluteTime(iso);
}

export function timeTag(iso: string, className?: string): string {
  const classes = className === undefined ? "" : ` class="${className}"`;
  const label = timeAgo(iso);
  return `<time${classes} datetime="${escapeHtml(iso)}" title="${escapeHtml(absoluteTime(iso))}">${escapeHtml(label)}</time>`;
}

export function safeLocalPath(value: string | undefined, fallback = "/"): string {
  if (value === undefined) {
    return fallback;
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter
  ) {
    return fallback;
  }
  return value;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/* ------------------------------------------------------------------------- */
/* Chrome                                                                    */
/* ------------------------------------------------------------------------- */

export function ideBase(): string {
  const configured = process.env.HANSE_IDE_URL?.trim();
  if (configured === undefined || configured.length === 0) {
    return "/ide/";
  }
  return configured.endsWith("/") ? configured : `${configured}/`;
}

export function ideFolderUrl(folder: string): string {
  return `${ideBase()}?folder=${encodeURIComponent(folder)}`;
}

export interface Notice {
  message: string;
  tone: "success" | "error";
}

export function toastRegion(notice?: Notice): string {
  const toasts =
    notice === undefined
      ? ""
      : (() => {
          const isError = notice.tone === "error";
          const tone = isError ? "error" : "success";
          const glyph = isError ? "alert-triangle" : "check";
          const role = isError ? "alert" : "status";
          const auto = isError ? "" : ' data-autodismiss="6000"';
          return `<div class="toast" data-tone="${tone}" role="${role}"${auto}>
            <span class="toast__icon">${icon(glyph)}</span>
            <div class="toast__copy"><strong>${escapeHtml(notice.message)}</strong></div>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" data-toast-close aria-label="Dismiss">${icon("x")}</button>
          </div>`;
        })();
  return `<div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false">${toasts}</div>`;
}

export function documentPage(options: {
  title: string;
  body: string;
  scripts?: string[];
  styles?: string[];
  moduleScripts?: string[];
  viewport?: string;
}): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="${escapeHtml(options.viewport ?? "width=device-width, initial-scale=1")}" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(options.title)}</title>
    <script>
      (function () {
        try {
          var saved = localStorage.getItem("hanse-theme");
          if (saved === "light" || saved === "dark") {
            document.documentElement.dataset.theme = saved;
          }
        } catch (error) {}
      })();
    </script>
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
    ${(options.styles ?? []).map((style) => `<link rel="stylesheet" href="${escapeHtml(style)}" />`).join("")}
    <link rel="stylesheet" href="/assets/app.css" />
    <script src="/assets/app.js" defer></script>
    ${(options.scripts ?? []).map((script) => `<script src="${escapeHtml(script)}" defer></script>`).join("")}
    ${(options.moduleScripts ?? []).map((script) => `<script type="module" src="${escapeHtml(script)}"></script>`).join("")}
  </head>
  <body class="app-body">
    ${iconSprite()}
    ${options.body}
  </body>
</html>`;
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface NavProject {
  id: string;
  name: string;
  appCount: number;
}

export interface ShellOptions {
  title: string;
  active: "overview" | "projects" | "project" | "handoffs" | "skills" | "settings" | "ssh" | "none";
  activeProjectId?: string;
  breadcrumb: Crumb[];
  projects: NavProject[];
  pendingCount: number;
  sshPendingCount?: number;
  operatorName: string;
  header: string;
  body: string;
  pageClass?: string;
  bodyClass?: string;
  scripts?: string[];
  styles?: string[];
  moduleScripts?: string[];
  viewport?: string;
  notice?: Notice;
  topbarActions?: string;
  settingsHref?: string;
  skillsHref?: string;
}

function pageClasses(base: string, extra: string | undefined): string {
  return extra === undefined || extra.length === 0 ? base : `${base} ${extra}`;
}

function breadcrumbHtml(crumbs: Crumb[]): string {
  const parts: string[] = [];
  crumbs.forEach((crumb, index) => {
    const current = index === crumbs.length - 1;
    if (current) {
      parts.push(`<span aria-current="page">${escapeHtml(crumb.label)}</span>`);
      return;
    }
    if (crumb.href === undefined) {
      parts.push(`<span>${escapeHtml(crumb.label)}</span>`);
      return;
    }
    parts.push(`<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`);
    parts.push(icon("chevron-right"));
  });
  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join("")}</nav>`;
}

function navItem(options: {
  href: string;
  label: string;
  iconName: IconName;
  active: boolean;
  count?: number;
}): string {
  const current = options.active ? ' aria-current="page"' : "";
  const count =
    options.count === undefined ? "" : `<span class="nav-item__count">${options.count}</span>`;
  const mark = options.active
    ? `<span class="nav-item__mark">${icon("check", "icon--sm")}</span>`
    : "";
  return `<a class="nav-item${options.active ? " is-active" : ""}" href="${escapeHtml(options.href)}"${current}>${icon(options.iconName)}<span class="nav-item__label">${escapeHtml(options.label)}</span>${mark}${count}</a>`;
}

function sidebarProjects(options: ShellOptions): string {
  const all = options.projects.filter((project) => !isMasterProject(project.id));
  let shown = all.slice(0, 6);
  if (
    options.activeProjectId !== undefined &&
    !shown.some((p) => p.id === options.activeProjectId)
  ) {
    const active = all.filter((project) => project.id === options.activeProjectId);
    const rest = all.filter((project) => project.id !== options.activeProjectId);
    shown = [...active, ...rest.slice(0, Math.max(0, 6 - active.length))];
  }
  const links = shown
    .map((project) =>
      navItem({
        href: `/projects/${encodeURIComponent(project.id)}`,
        label: project.name,
        iconName: "folder",
        active: options.activeProjectId === project.id,
        count: project.appCount,
      }),
    )
    .join("");
  return `<p class="nav-label">Projects</p>${links}<a class="nav-item" href="/projects">${icon("layers")}<span class="nav-item__label">All projects</span></a>`;
}

function sidebar(options: ShellOptions): string {
  const workbench =
    navItem({
      href: "/",
      label: "Overview",
      iconName: "dashboard",
      active: options.active === "overview",
    }) +
    navItem({
      href: "/projects",
      label: "Projects",
      iconName: "folder",
      active: options.active === "projects",
    }) +
    navItem({
      href: masterChatHref(),
      label: "Master",
      iconName: "gauge",
      active: false,
    }) +
    navItem({
      href: "/handoffs",
      label: "Handoffs",
      iconName: "branch",
      active: options.active === "handoffs",
      count: options.pendingCount,
    }) +
    navItem({
      href: options.skillsHref ?? "/skills",
      label: "Skills",
      iconName: "code",
      active: options.active === "skills",
    }) +
    navItem({
      href: options.settingsHref ?? "/settings",
      label: "Settings",
      iconName: "settings",
      active: options.active === "settings",
    }) +
    navItem({
      href: "/ssh",
      label: "SSH",
      iconName: "terminal",
      active: options.active === "ssh",
      ...(options.sshPendingCount === undefined ? {} : { count: options.sshPendingCount }),
    });

  return `<aside class="sidebar" id="sidebar" aria-label="Primary">
    <div class="sidebar__head">
      <a class="wordmark" href="/">hanse</a>
      <span class="sidebar__kicker">coordinator</span>
      <button class="btn btn-ghost btn-icon btn-sm sidebar__close" type="button" data-nav-close aria-label="Close navigation">${icon("x")}</button>
    </div>
    <nav class="sidebar__nav" aria-label="Workspace">
      <p class="nav-label">Workbench</p>
      ${workbench}
      ${sidebarProjects(options)}
    </nav>
    <div class="sidebar__foot">
      <span class="avatar avatar--sm">${escapeHtml(initials(options.operatorName))}</span>
      <span class="sidebar__operator">${escapeHtml(options.operatorName)}</span>
      <button class="btn btn-ghost btn-sm theme-toggle" type="button" data-theme-toggle aria-label="Switch to light theme" title="Switch theme">
        <span class="theme-toggle__icon" data-theme-icon="light">${icon("sun")}</span>
        <span class="theme-toggle__icon" data-theme-icon="dark">${icon("moon")}</span>
        <span data-theme-label>Light</span>
      </button>
      <form method="post" action="/logout">
        <button class="btn btn-ghost btn-icon btn-sm" type="submit" aria-label="Sign out" title="Sign out">${icon("log-out")}</button>
      </form>
    </div>
  </aside>`;
}

export function appShell(options: ShellOptions): string {
  const topbarActions =
    options.topbarActions ??
    `<a class="btn btn-ghost btn-icon" href="${escapeHtml(ideBase())}" target="_blank" rel="noreferrer" aria-label="Open IDE in a new tab" title="Open IDE">${icon("external")}</a>`;

  const header = options.header.trim().length === 0 ? "" : options.header;
  return documentPage({
    title: `${options.title} - hanse`,
    scripts: options.scripts,
    styles: options.styles,
    moduleScripts: options.moduleScripts,
    viewport: options.viewport,
    body: `<a class="skip-link" href="#main">Skip to content</a>
    <div class="app-shell" data-nav="closed" id="shell">
      ${sidebar(options)}
      <div class="shell-main">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon nav-toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="sidebar" aria-label="Open navigation">${icon("menu")}</button>
          <a class="topbar__brand" href="/">hanse</a>
          ${breadcrumbHtml(options.breadcrumb)}
          <div class="topbar__actions">${topbarActions}</div>
        </header>
        <main class="${pageClasses("page", options.pageClass)}" id="main" tabindex="-1">
          ${header}
          <div class="${pageClasses("page__body", options.bodyClass)}">${options.body}</div>
        </main>
      </div>
      <div class="scrim" data-nav-close></div>
    </div>
    ${toastRegion(options.notice)}`,
  });
}

export function pageHeader(options: {
  overline?: string;
  title: string;
  description?: string;
  meta?: string[];
  actions?: string;
}): string {
  const overline =
    options.overline === undefined ? "" : `<p class="overline">${escapeHtml(options.overline)}</p>`;
  const description =
    options.description === undefined
      ? ""
      : `<p class="page-description">${escapeHtml(options.description)}</p>`;
  const meta =
    options.meta === undefined || options.meta.length === 0
      ? ""
      : `<div class="page-meta">${options.meta.map((entry) => `<span class="mono">${escapeHtml(entry)}</span>`).join("")}</div>`;
  const actions =
    options.actions === undefined
      ? ""
      : `<div class="page-header__actions">${options.actions}</div>`;
  return `<header class="page-header">
    <div class="page-header__main">
      ${overline}
      <h1 class="page-title">${escapeHtml(options.title)}</h1>
      ${description}
      ${meta}
    </div>
    ${actions}
  </header>`;
}

/* ------------------------------------------------------------------------- */
/* Content primitives                                                        */
/* ------------------------------------------------------------------------- */

export function emptyState(options: {
  iconName: IconName;
  title: string;
  body: string;
  action?: string;
}): string {
  const action = options.action === undefined ? "" : `<div class="cluster">${options.action}</div>`;
  return `<div class="empty-state">
    <span class="empty-state__mark">${icon(options.iconName, "icon--lg")}</span>
    <h3 class="empty-state__title">${escapeHtml(options.title)}</h3>
    <p class="empty-state__body">${escapeHtml(options.body)}</p>
    ${action}
  </div>`;
}

export interface RouteCardInput {
  id: string;
  state: HandoffState;
  from: string;
  to: string;
  summary: string;
  foot?: string;
}

export function routeCard(input: RouteCardInput): string {
  const glyph = icon(statusIcon(input.state));
  const foot = input.foot === undefined ? "" : `<div class="route-card__foot">${input.foot}</div>`;
  return `<article class="route-card" data-state="${input.state}">
    <div class="route-card__head">
      <span class="mono table__nowrap">${escapeHtml(input.id.slice(0, 8))}</span>
      ${statusPill(input.state)}
    </div>
    <div class="route" aria-label="Handoff from ${escapeHtml(input.from)} to ${escapeHtml(input.to)}">
      <span class="route__end">
        <span class="route__app">${escapeHtml(input.from)}</span>
        <span class="route__meta">origin</span>
      </span>
      <span class="route__track" aria-hidden="true">
        <span class="route__node"></span>
        <span class="route__seal">${glyph}</span>
        <span class="route__node"></span>
      </span>
      <span class="route__end route__end--to">
        <span class="route__app">${escapeHtml(input.to)}</span>
        <span class="route__meta">target</span>
      </span>
    </div>
    <p class="route-card__summary">${escapeHtml(input.summary)}</p>
    ${foot}
  </article>`;
}

export function routeText(from: string, to: string): string {
  return `<span class="table__route"><span class="mono">${escapeHtml(from)}</span>${icon("arrow-right", "icon--sm")}<span class="mono">${escapeHtml(to)}</span></span>`;
}

export interface HandoffDialogInput {
  id: string;
  state: HandoffState;
  from: string;
  to: string;
  summary: string;
  spec: string;
  attempts: number;
  error: string | null;
  result: string | null;
  outcome: HandoffOutcome | null;
  createdAt: string;
  updatedAt: string;
  returnTo: string;
  approvalKind: "dispatch" | "reply" | null;
  policyDispatchMode: HandoffDispatchMode;
  policyReplyMode: HandoffReplyMode;
  origin: HandoffOrigin;
  sourceSessionId: string | null;
  sourceSessionHref: string | null;
  sourceSessionDeleted: boolean;
  targetSessionId: string | null;
  targetSessionHref: string | null;
  replyState: HandoffReplyState;
  replyError: string | null;
  replyDeliveredSessionId: string | null;
  replyDeliveredAt: string | null;
  replyDeliveredHref: string | null;
  deliveredVia: string | null;
  operatorNote: string | null;
  canCancel: boolean;
  canRelaunch: boolean;
  canRetryReply: boolean;
  canCancelReply: boolean;
}

function sessionRef(href: string | null, id: string | null, emptyLabel: string): string {
  if (id === null) {
    return `<span class="small">${escapeHtml(emptyLabel)}</span>`;
  }
  const short = escapeHtml(id.slice(0, 8));
  return href === null
    ? `<span class="mono">${short}</span>`
    : `<a class="mono" href="${escapeHtml(href)}">${short}</a>`;
}

export function handoffDialog(input: HandoffDialogInput): string {
  const dialogId = `h-${input.id}`;
  const safeDialogId = escapeHtml(dialogId);
  const safeTitleId = escapeHtml(`${dialogId}-title`);
  const meta = `${input.id} / ${input.from} to ${input.to}`;
  const title =
    input.approvalKind === "reply"
      ? "Review reply"
      : input.approvalKind === "dispatch"
        ? "Review handoff"
        : "Handoff detail";

  const source = sessionRef(
    input.sourceSessionHref,
    input.sourceSessionId,
    input.origin === "operator"
      ? "Operator-created (no source session)"
      : "Not bound to a session yet",
  );
  const target = sessionRef(input.targetSessionHref, input.targetSessionId, "Not dispatched yet");

  const error =
    input.error === null || input.error.length === 0
      ? ""
      : `<div class="error-state" role="alert">
          <span class="error-state__mark">${icon("alert-triangle")}</span>
          <div><h3 class="error-state__title">Request failed</h3><p class="error-state__body">${escapeHtml(input.error)}</p></div>
        </div>`;
  const result =
    input.result === null || input.result.length === 0
      ? ""
      : `<div class="stack--tight">
          <p class="overline">Result${input.outcome === null ? "" : ` (${escapeHtml(input.outcome)})`}</p>
          <div class="prose prose--pre">${escapeHtml(input.result)}</div>
        </div>`;
  const reply =
    input.replyState === "none"
      ? ""
      : `<div class="stack--tight">
          <p class="overline">Reply</p>
          <div class="cluster">${replyPill(input.replyState)}${input.deliveredVia === null ? "" : `<span class="mono">via ${escapeHtml(input.deliveredVia)}</span>`}</div>
          ${
            input.replyError === null || input.replyError.length === 0
              ? ""
              : `<p class="field-error">${icon("alert-circle")}${escapeHtml(input.replyError)}</p>`
          }
          ${
            input.replyDeliveredAt === null
              ? ""
              : `<p class="small">Delivered ${escapeHtml(absoluteTime(input.replyDeliveredAt))} to ${sessionRef(input.replyDeliveredHref, input.replyDeliveredSessionId, "session")}</p>`
          }
          ${
            input.operatorNote === null || input.operatorNote.length === 0
              ? ""
              : `<div class="stack--tight"><p class="overline">Operator note</p><div class="prose prose--pre">${escapeHtml(input.operatorNote)}</div></div>`
          }
        </div>`;

  const details = `${routeCard(input)}
    <div class="stack--tight">
      <p class="overline">Policy</p>
      <p class="small">Dispatch: <span class="mono">${escapeHtml(input.policyDispatchMode)}</span> · Reply: <span class="mono">${escapeHtml(input.policyReplyMode)}</span> · Origin: <span class="mono">${escapeHtml(input.origin)}</span></p>
    </div>
    <div class="stack--tight">
      <p class="overline">Sessions</p>
      <p class="small">Source: ${source}</p>
      <p class="small">Target: ${target}</p>
      ${input.sourceSessionDeleted ? `<p class="field-error">${icon("alert-circle")}The source session was deleted; any reply will wait for an operator decision.</p>` : ""}
    </div>
    <div class="stack--tight">
      <p class="overline">Specification</p>
      <div class="prose prose--pre">${escapeHtml(input.spec)}</div>
    </div>
    <div class="stack--tight">
      <p class="overline">Attempts</p>
      <p class="mono">${input.attempts}</p>
      <p class="mono">created ${escapeHtml(absoluteTime(input.createdAt))}</p>
      <p class="mono">updated ${escapeHtml(absoluteTime(input.updatedAt))}</p>
    </div>
    ${error}
    ${result}
    ${reply}`;

  const reason =
    input.approvalKind === null
      ? ""
      : `<div class="field">
          <label class="label" for="${safeDialogId}-reason">Reason, optional</label>
          <textarea class="textarea" id="${safeDialogId}-reason" name="reason" placeholder="Record why this is approved or rejected" aria-describedby="${safeDialogId}-reason-hint"></textarea>
          <p class="hint" id="${safeDialogId}-reason-hint">The reason is written to the handoff audit trail.</p>
        </div>`;

  if (input.approvalKind !== null) {
    const approve = input.approvalKind === "reply" ? "Approve reply" : "Approve handoff";
    const reject = input.approvalKind === "reply" ? "Reject reply" : "Reject handoff";
    return `<dialog class="dialog" id="${safeDialogId}" aria-labelledby="${safeTitleId}">
      <div class="dialog__frame">
        <header class="dialog__head">
          <h2 class="dialog__title" id="${safeTitleId}">${title}</h2>
          <p class="dialog__meta">${escapeHtml(meta)}</p>
        </header>
        <form class="dialog__form" method="post" action="/api/handoffs/${encodeURIComponent(input.id)}/decision">
          <div class="dialog__body">
            ${details}
            ${reason}
            <input type="hidden" name="approval_kind" value="${input.approvalKind}" />
            <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
          </div>
          <footer class="dialog__foot">
            <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
            <button class="btn btn-primary" type="submit" name="decision" value="approved">${approve}</button>
            <button class="btn btn-danger" type="submit" name="decision" value="rejected">${reject}</button>
          </footer>
        </form>
      </div>
    </dialog>`;
  }

  const relaunch = input.canRelaunch
    ? `<form class="stack--tight" method="post" action="/api/handoffs/${encodeURIComponent(input.id)}/reply/relaunch">
        <div class="field">
          <label class="label" for="${safeDialogId}-note">Operator note, optional</label>
          <textarea class="textarea" id="${safeDialogId}-note" name="note" placeholder="Context for the new session"></textarea>
          <p class="hint">The original request, the sibling reply, and this note are sent to a new ${escapeHtml(input.from)} session.</p>
        </div>
        <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
        <div class="cluster"><button class="btn btn-primary" type="submit">Start in a new session</button></div>
      </form>`
    : "";
  const smallActions = [
    input.canRetryReply
      ? `<form method="post" action="/api/handoffs/${encodeURIComponent(input.id)}/reply/deliver">
          <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
          <button class="btn btn-secondary btn-sm" type="submit">Retry reply delivery</button>
        </form>`
      : "",
    input.canCancelReply
      ? `<form method="post" action="/api/handoffs/${encodeURIComponent(input.id)}/reply/cancel">
          <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
          <button class="btn btn-ghost btn-sm" type="submit">Cancel reply</button>
        </form>`
      : "",
    input.canCancel
      ? `<form method="post" action="/api/handoffs/${encodeURIComponent(input.id)}/cancel">
          <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
          <button class="btn btn-danger btn-sm" type="submit">Cancel handoff</button>
        </form>`
      : "",
  ]
    .filter((value) => value.length > 0)
    .join("");
  const actions =
    relaunch.length === 0 && smallActions.length === 0
      ? ""
      : `<div class="stack--tight">${relaunch}${smallActions.length === 0 ? "" : `<div class="cluster">${smallActions}</div>`}</div>`;

  return `<dialog class="dialog" id="${safeDialogId}" aria-labelledby="${safeTitleId}">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="${safeTitleId}">${title}</h2>
        <p class="dialog__meta">${escapeHtml(meta)}</p>
      </header>
      <div class="dialog__body">
        ${details}
        ${actions}
      </div>
      <footer class="dialog__foot">
        <button class="btn btn-ghost" type="button" data-dialog-close>Close</button>
      </footer>
    </div>
  </dialog>`;
}

/* ------------------------------------------------------------------------- */
/* Login and error pages                                                     */
/* ------------------------------------------------------------------------- */

export function loginPage(options: { next: string; error?: string }): string {
  const invalid = options.error !== undefined;
  const error = invalid
    ? `<p class="field-error" id="token-error">${icon("alert-circle")}Token rejected. Check the value and try again.</p>`
    : `<p class="hint" id="token-hint">The operator token is set by HANSE_OPERATOR_TOKEN.</p>`;
  const describedBy = invalid ? "token-error" : "token-hint";
  return documentPage({
    title: "Sign in - hanse",
    body: `<main class="cover chart-ground" id="main">
      <div></div>
      <section class="login-plate" aria-labelledby="login-title">
        <div class="login-plate__head">
          <span class="login-plate__brand">hanse</span>
          <span class="sidebar__kicker">coordinator</span>
        </div>
        <hr class="rule rule--double" />
        <h1 class="h2" id="login-title">Operator sign-in</h1>
        <p class="body">Enter the operator token to open the chart room.</p>
        <form method="post" action="/login" class="stack">
          <input type="hidden" name="next" value="${escapeHtml(options.next)}" />
          <div class="field"${invalid ? ' data-invalid="true"' : ""}>
            <label class="label" for="token">Operator token (required)</label>
            <div class="field__control">
              <input class="input" id="token" name="token" type="password" required autofocus autocomplete="current-password"${invalid ? ' aria-invalid="true"' : ""} aria-describedby="${describedBy}" />
              <button class="btn btn-ghost btn-icon btn-sm" type="button" data-password-toggle aria-label="Show token" aria-pressed="false">
                <span data-password-icon="hidden">${icon("eye")}</span>
                <span data-password-icon="visible">${icon("eye-off")}</span>
              </button>
            </div>
            ${error}
          </div>
          <button class="btn btn-primary btn-lg btn-block" type="submit"><span class="btn__label">Sign in</span></button>
        </form>
        <p class="caption">The session stays on this browser for 30 days. Sign out from the sidebar.</p>
      </section>
      <p class="caption login-plate__foot">hanse coordinator / operator access</p>
    </main>`,
  });
}
