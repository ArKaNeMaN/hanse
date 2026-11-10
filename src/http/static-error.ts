import type { HttpResponse } from "./handler.js";

export interface StaticErrorAction {
  readonly href: string;
  readonly label: string;
}

export interface StaticErrorOptions {
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly action?: StaticErrorAction;
  readonly headers?: Readonly<Record<string, string>>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A self-contained error page. It intentionally depends on no build output, no icon sprite, and no
 * JavaScript, so it still works when the SPA bundle or stylesheet is missing.
 */
export function staticErrorDocument(options: StaticErrorOptions): string {
  const action =
    options.action === undefined
      ? ""
      : `<a class="action" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(options.title)} - hanse</title>
    <style>
      :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #101418; color: #e6e9ee; }
      main { width: min(100%, 560px); border: 1px solid #303842; border-radius: 14px; padding: 28px; background: #171d24; }
      .status { margin: 0 0 8px; color: #d8b26e; font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0 0 12px; font-size: clamp(24px, 4vw, 34px); line-height: 1.1; }
      p { margin: 0; color: #aeb7c2; line-height: 1.6; }
      .action { display: inline-block; margin-top: 20px; border: 1px solid #d8b26e; border-radius: 8px; padding: 9px 14px; color: #101418; background: #d8b26e; font-weight: 650; text-decoration: none; }
      .action:focus-visible { outline: 2px solid #e6e9ee; outline-offset: 3px; }
      @media (prefers-color-scheme: light) {
        body { background: #f2f0eb; color: #171b20; }
        main { background: #fffdf8; border-color: #d8d2c5; }
        p { color: #5c6470; }
        .action { background: #171b20; border-color: #171b20; color: #fffdf8; }
      }
    </style>
  </head>
  <body>
    <main role="main">
      <p class="status">${options.status}</p>
      <h1>${escapeHtml(options.title)}</h1>
      <p>${escapeHtml(options.message)}</p>
      ${action}
    </main>
  </body>
</html>`;
}

export function staticErrorResponse(options: StaticErrorOptions): HttpResponse {
  return {
    status: options.status,
    contentType: "text/html; charset=utf-8",
    body: staticErrorDocument(options),
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...options.headers,
    },
  };
}
