# Process protection C2 browser QA

- Status: **PASS**
- Mode: `deterministic` (real page/assets, deterministic `/api/apps/**` fixtures)
- Started: 2026-10-27T21:53:32.997Z
- Finished: 2026-10-27T21:53:40.667Z
- Command: `node docs/design/process-protection-qa.mjs`

## Scenarios

| # | Scenario | Result | Assertions | Failure |
| --- | --- | --- | --- | --- |
| 1 | `reload-stopped` | PASS | 10 |  |
| 2 | `interleaved-notices` | PASS | 8 |  |
| 3 | `notice-only` | PASS | 3 |  |
| 4 | `resume-not-omo` | PASS | 5 |  |
| 5 | `visual-1440-768` | PASS | 20 |  |

## Screenshots

- `docs/design/artifacts/process-protection/stopped-reload-1440-dark.png`
- `docs/design/artifacts/process-protection/interleaved-1440-dark.png`
- `docs/design/artifacts/process-protection/interleaved-1440-light.png`
- `docs/design/artifacts/process-protection/interleaved-768-dark.png`
- `docs/design/artifacts/process-protection/interleaved-768-light.png`

## Failures

_none_

## Unexpected console/page errors

_none_

## Failed network requests

_none_
