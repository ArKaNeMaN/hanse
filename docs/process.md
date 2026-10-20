# Delivery Process (project profile)

This file binds the feature-delivery pipeline to this repository. It is the single place that
defines reviewers, artifact paths, verification, and the commit policy. Keep it in sync when the
process changes.

## Pipeline

`design -> design review -> owner questions -> plan -> plan review -> execute -> record -> commit`.
Implementation is gated until the design review, plan review, and owner questions are closed. See
the `feature-delivery` skill for the full sequence.

## Roles

- Design author: maintainers.
- Design reviewer: `oracle` (independent architecture review).
- Plan author: maintainers.
- Plan reviewer: `momus` (independent clarity/verifiability review).
- Implementer: `developer` role; QA: `qa-engineer`; schema: `database-engineer`; security:
  `security-engineer` when relevant.

## Artifacts and indexes

- Design docs: `docs/design/` - index at `docs/design/README.md`.
- Plans: `docs/plans/` - index at `docs/plans/README.md`.
- Decision records (ADRs): `docs/decisions/` - numbered `NNNN-<slug>.md`.
- Stage journal: `docs/journal/` - index at `docs/journal/README.md`.
- Open questions: section in the relevant plan, and `docs/open-questions.md` while open.

## Language

Documentation and code comments: English.

## Verification commands

Every stage must leave these green:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Commit policy

- One stage, one coherent commit (code + tests + docs + record).
- Exception: when the record must capture an owner-verified deployment, a stage may use one code commit
  (code + tests + docs) plus one docs-only deploy-record commit. Both belong to the same stage; the
  code commit remains coherent.
- The maintainer authorizes commits; in autonomous mode the agent may commit each completed stage and
  push to `origin`.
- Commit messages follow Conventional Commits (`type(scope): summary`).
