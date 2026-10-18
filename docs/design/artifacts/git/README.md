# Git workbench captures

Playwright Chromium captures for the Application page and git panel (2026-10-19).

- `application-{390,768,1440}-*` - the real page against a local coordinator, a temp workspace
  application repository, and a bare `file://` remote. The `1440-dark` capture is the dirty state;
  the `390-dark-bottom` capture shows the stacked rail after scrolling.
- `state-*-1440-dark.png` - deterministic UI states (dirty, conflicts, in-progress operation,
  detached, no remote, no upstream, no identity, not-git, not-root, missing, outside workspace,
  load error, busy) captured with Playwright route interception for `/git/status`; no external
  network was used.

The capture harness lived outside the repository; these are the checked-in evidence images. See
[`docs/design/git-workbench.md`](../../git-workbench.md) for the design and
[`docs/plans/0002-git-workbench.md`](../../../plans/0002-git-workbench.md) for the verification plan.
