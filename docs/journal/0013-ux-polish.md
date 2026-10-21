# 0013 - UX/UI polish pass

Status: implemented and verified locally; deployment pending. Design:
[`docs/design/ux-polish.md`](../design/ux-polish.md). Plan:
[`docs/plans/0013-ux-polish.md`](../plans/0013-ux-polish.md).

## What changed

- **Application page.** Git is again the first and largest job. A two-cell state strip (Runtime,
  Settings) replaces the pending banner and the duplicated Application rail card. Image and SSH
  access became compact rail cards; the Image card uses `.status` pills, lazy build logs in a
  disclosure, a confirmed rollback dialog, and a `Restart the agent to use the new image.` hint.
  The header keeps `Open chat` and `Terminal` plus a `More actions` disclosure. Exactly one
  pending-restart statement remains, and the Runtime cell owns the restart dialog. Stopped agents
  show `Saved`/`Settings apply when the agent starts.` instead of claiming settings match a running
  agent.
- **Settings.** A sticky scope/section nav and four section cards (`Agent`, `Web tools`, `Git`,
  `Restart & pending`) replace the card stack. Each setting is a collapsed `<details>` row with its
  effective value and source; editor, warnings, scope history (`Scope details`), and actions are
  inside. Editing uses own-scope prefill, disabled no-op Inherit/Clear with visible reasons, one
  primary Save per open row, a shared clear dialog, and inline errors with preserved values. Git
  credentials keep their JSON contract and gain a JS-required notice. Measured app-scope settings
  height fell from 4,125px to 1,002px at 1440 (-75.7%) and from 5,948px to 1,407px at 390 (-76.3%).
- **Operator terminal.** Replaced the `<pre>` + textarea with a full-height vendored xterm.js 6.0.0
  + fit addon terminal: ANSI/alternate screen, 5,000-line scrollback, theme from design tokens,
  FitAddon/ResizeObserver sizing, binary UTF-8 input (`onData`/`onBinary`), text resize controls,
  copy/paste with an insecure-HTTP fallback, runtime preflight, backoff reconnect, honest close and
  stopped-agent states, and `TERM`/`COLORTERM`/`LANG` in the runner exec.
- **State truth.** Runtime now has one vocabulary (`starting`, `running`, `stopped`, `error`; legacy
  `failed` normalizes to `error`) used by overview counts and every pill. Restart calls
  `restartIfRunning()` instead of only stopping. Migration v10 persists the launch settings/profile
  hash; running-but-unattached or pre-v10 agents show `Restart required` / `Applied state unknown`
  instead of a false `Applied`. Chat runtime chips poll `/api/apps/:app/runtime` (10s while visible)
  instead of guessing from request outcomes; `Ready` can no longer coexist with a queued/active
  prompt, and the connection lane is written only by the SSE lifecycle.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` are green (83 test files,
  1,194 tests).
- Browser QA at 390/768/1024/1440, dark and light, against a seeded coordinator plus a fake runner:
  no console/page errors on the application page, settings, and live terminal; overflow menu closes
  on Escape; image details/rollback dialog; settings save, inline validation, clear dialog, Git
  confirm; terminal live echo, close/reconnect, theme update, and stopped-agent empty state.
- Terminal live check: fake runner sent `QA terminal ready`, typed `hello` echoed through binary
  input, manual Close showed `Terminal closed` without stopping the app, Reconnect started a new
  shell, and a stopped app showed `Agent is not running`.
- Settings height measured against `bca2f7e` (the pre-settings-rewrite commit) with the same
  seeded data.

## Accepted debt

- Settings non-Git forms without JS fall back to redirect + toast and lose values; Git credential
  forms require JS (visible `<noscript>`).
- Terminal reconnect starts a new ephemeral shell; no search/web-links addon or persistent
  multiplexer.
- Pre-v10 running instances show `Applied state unknown` until restarted.
- Chat runtime polling can lag up to 10s; there is no runtime SSE.
- Terminal copy/paste uses `document.execCommand` on insecure HTTP.

## Deployment

Pending. Deploy the commit with the SSH and git-credentials stages per
[`docs/deploy/host.md`](../deploy/deployment-host.md); migration v10 is additive.
