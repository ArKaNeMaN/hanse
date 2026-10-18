# Design docs

- [Design system contract](../../DESIGN.md) - The Chart Room: atmosphere, tokens, typography,
  shell grammar, components, motion, accessibility, and accepted debt.
- [Primitive showcase](./showcase.html) - every primitive and state rendered from the real built
  stylesheet, dark and light, phone to desktop.
- [Stage 2 record](./stage-2.md) - the authenticated product screens, routes, decisions, evidence,
  and the stage-3 handoff.
- [Stage 3 record](./stage-3.md) - the three-pane chat workspace, real-agent and fixture evidence,
  decisions, accepted debt, and the stage-4 handoff.
- [Git workbench](./git-workbench.md) - the application page and human-only git status/actions
  design.
- [Architecture overview](./overview.md) - the coordinator architecture and stage plan.

## Run the showcase

From the repository root:

```bash
npm run build:css
npm run design:showcase
# open http://localhost:4173/docs/design/showcase.html
```

Query parameters:

- `?theme=dark` or `?theme=light` - pin a theme.
- `?capture=1` - document-flow mode so a full-page screenshot includes every specimen.
- `?focus=1` - focus the project-name input for focus-visible evidence.

## Evidence

`node docs/design/capture.mjs` writes real Playwright Chromium screenshots to
[`artifacts/`](./artifacts/):

- `showcase-{390,768,1440}-{dark,light}.png`
- `shell-{1440,390}-{dark,light}.png` and `shell-390-drawer-dark.png`
- `focus-visible-1440-dark.png`
- `dialog-1440-{dark,light}.png`, `toast-1440-{dark,light}.png`, `tooltip-1440-dark.png`
- `git/` - Application page and git panel captures at 390/768/1440 plus deterministic state
  captures (see [`artifacts/git/README.md`](./artifacts/git/README.md)).

The capture script resolves an installed Playwright module and Chromium build; it adds no
Playwright dependency to the product.
