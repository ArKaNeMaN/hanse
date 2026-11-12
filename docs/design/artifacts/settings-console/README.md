# Settings console evidence

Screenshots for the two-pane settings console described in
[`docs/design/settings-console.md`](../../settings-console.md).

## Fixture

The captures come from `e2e/support/server.ts`, the deterministic Playwright fixture. The data is
synthetic: project `E2E Project One`, application `alpha`, test provider/model identifiers, and the
`test-operator` session. No deployment host, real project, credential, or user data is shown.

## Captures

- `desktop-web.png` - 1440x900, application scope, Web tools. The page does not scroll; the console
  is 1144px wide with a 272px rail and an 870px pane; only the pane body scrolls.
- `mobile-web.png` - 390x844, application scope, Web tools. The document has no horizontal
  overflow; the page scrolls as one document; the section rail is a sticky horizontal tab strip;
  the summary is 2x2; rows and edits are stacked.

Captured with a one-off Playwright session against the fixture server; there is no committed
screenshot harness for this stage yet. The deterministic settings flows are covered by:

```bash
npx playwright test e2e/settings.spec.ts e2e/spa-settings.spec.ts
```
