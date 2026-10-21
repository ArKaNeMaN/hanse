# UX polish browser evidence

`node docs/design/ux-qa.mjs` is the browser gate for the UX polish pass. It targets a running
coordinator through `UX_QA_URL` and `UX_QA_TOKEN` (defaults: `http://127.0.0.1:8799`, `qa-token`) and
writes screenshots plus `report.json` here. It exits 1 on a failed assertion, console error, or page
error. The 400 response from the deliberate validation scenario is expected and filtered.

## Fixture

The gate expects a seeded fixture with:

- project `11111111-1111-4111-8111-111111111111`;
- app `storefront` (build-configured, image `ready`, one previous image version, runtime `running`);
- app `fulfillment` (no build config, runtime `stopped`);
- app-scope settings empty so the model row shows `Inherited: ...`;
- a terminal-capable runner for the live scenario. The local run used a fake exec bridge on
  `127.0.0.1:8801` that accepts `/v1/apps/:id/exec`, sends `QA terminal ready\r\n$ `, echoes input as
  `qa:<line>`, and honors resize text frames.

The `storefront` git status is intercepted by the harness with a clean `main` fixture so the git panel
is deterministic and the runner is not asked for a real repository operation.

## Scenarios

- Application page at 390/768/1024/1440, dark and light: state strip before the workbench, Image and
  SSH cards in the rail, two overflow links, Escape close, Image details, rollback dialog, no
  horizontal overflow.
- Settings at the same widths/themes: at least 7 setting rows, no scope tables, no visible setting
  form at rest, measured height (1,407px at 390; 1,002px at 1440), open model row, own-scope
  placeholder, validation error with `aria-invalid`, clear dialog, Git credential form.
- Terminal at 390/1440, dark and light: live xterm, typed `hello` echoed as `qa:hello`, manual close,
  reconnect to a new live shell; stopped app renders `Agent is not running` and `Agent stopped`.

## Results

`report.json`: **PASS**, 164 assertions, zero console/page errors. Screenshots:
`application-{390,768,1024,1440}-{dark,light}.png`, `settings-*` (including open/validation/Git
states), `terminal-{390,1440}-{dark,light}.png`, and `terminal-stopped-1200-dark.png`.

Height comparison against the pre-settings-rewrite commit `bca2f7e` with the same data: app scope
4,125px -> 1,002px at 1440 (-75.7%) and 5,948px -> 1,407px at 390 (-76.3%); global scope 3,527px ->
1,132px (-67.9%) and 4,498px -> 1,574px (-65.0%).
