# 0014 - Settings saves without a page refresh

Status: implemented and verified; deployment pending.

## Problem

Every settings save (scalar values, provider keys, Git identity, and Git credentials) performed a
JSON mutation and then navigated to the canonical page with a `notice` query. A successful save
therefore destroyed the page: open rows, drafts, scroll position, and the user's place in a long
settings page. The server already resolved the full settings state after a mutation, so the data for
an in-place update existed; only the response and client contract were missing.

## Decision

Use **server-rendered fragments**, not a client-side settings renderer and not an SPA.

- A mutation with `x-hanse-fragment: settings` returns `200` JSON
  `{ ok: true, changed: [...], sections: {...} }` and never redirects.
- `agent`, `web`, `git`, and `restart` are the full outer HTML of the existing section elements;
  `warnings` is the inner HTML for the stable `#settings-warnings` wrapper.
- `changed` is narrow: Git mutations return `git,restart`; every other settings/provider mutation
  returns `agent,web,restart,warnings` because a model or web-driver change can change the provider
  list, warnings, and the restart state.
- The page and the fragment responses share one `settingsSections()` renderer, so the full page and
  an in-place update cannot drift.

This keeps the server as the authority for resolved values, scope sources, disabled actions, and
pending restarts. Re-rendering those rules in client JavaScript would duplicate the settings
resolver and create a second source of truth.

## Client behavior

- `settings.js` and `git-settings.js` use delegated submit handlers, so forms created by a section
  swap keep working without rebinding. A shared in-flight lock rejects a second save while one is
  pending, so overlapping responses cannot apply stale snapshots out of order.
- A successful save replaces only the sections in `changed`. Before swapping, the client captures
  open `.setting-row` IDs, drafts in other rows (hidden/password controls excluded), the focus row's
  viewport position, and the `.page` scroll position. After swapping it restores those, re-syncs web
  driver fields, keeps the saved row at the same viewport position, focuses its summary, updates the
  URL hash with `history.replaceState` (removing stale `notice`/`tone`), and shows a toast. Provider
  rows use stable IDs derived from the provider name; adding a provider focuses the new row.
- The clear dialog uses the same path. Its form submission is handled by `settings.js`, errors stay
  inline, and it closes only after a successful fragment response. `data-no-busy` prevents the shell
  submit spinner from owning the form state; Escape, the backdrop, and Cancel cannot dismiss an
  in-flight clear, and reopening the dialog clears stale errors.
- Git credentials reuse `window.hanseSettings.applySections`; the JSON request body, validation,
  native clear confirmation, and draft Test connection are unchanged. Test connection still renders
  its result with `textContent`.
- Without JavaScript, browser form posts still use the old redirect + toast path; Git credentials
  remain JS-required and keep the visible `<noscript>`.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass (84 test files,
  1,210 tests).
- New server tests cover the fragment payload, exact `changed` lists, section IDs, no `location`
  header, unchanged JSON API shape without the header, header forwarding through the HTTP server,
  missing-target `404`, the warnings wrapper, and the clear-dialog error slot.
- New asset tests cover the fragment header, delegated listeners, section swap, and draft/open-row
  restoration. The Git asset test now asserts delegated submission and the fragment header while
  retaining its no-`innerHTML`/no-secret-in-URL rules.
- `node docs/design/settings-save-qa.mjs` against a seeded coordinator with a fake SSH keygen:
  **PASS**, 85 assertions, 0 console/page errors. Scenarios: model save with open-row/draft
  preservation, web save/clear/inherit, Git identity, HTTPS save/clear, SSH save/clear, provider
  add/clear. Each scenario verifies the same document survived (`window.__settingsDocument`), the
  request carried `x-hanse-fragment`, the response `changed` list, the updated summary, the toast,
  and the expected URL hash. Evidence: `docs/design/artifacts/ux/settings-save-*` and
  `settings-save-report.json`.
- Additional manual Playwright checks with a delayed provider response: a second settings save is
  rejected with `Another settings save is still in progress.`; Escape on an in-flight clear leaves
  the dialog open until the response, which then closes it. Both passed.

## Accepted debt

- The fragment response builds the site model and resolves the full settings state per mutation. That
  is fine for human-paced settings edits, not for high-frequency API use.
- Fragment requests validate that the target project/app exists before the write. A delete between
  that check and the write can still produce a `404` after the write; the client treats it as a stale
  page and shows the error.
- A section swap re-renders other rows in the same section; text drafts and open state are restored,
  but password inputs (provider keys, Git tokens) are deliberately not carried across a swap, and
  transient panels such as a Git test result are reset.
- The `Restart agent` action in the pending section still performs a normal form navigation. It is an
  action, not a setting save, and is outside this change.
- No-JS saves still redirect and lose values.

## Deployment

Pending.
