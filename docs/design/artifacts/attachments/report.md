# Stage C attachments QA

- Status: **PASS**
- Mode: `deterministic` (real page/assets, deterministic `/api/apps/**` fixtures)
- Started: 2026-10-25T16:13:45.219Z
- Finished: 2026-10-25T16:14:16.294Z
- Base URL: `http://127.0.0.1:<ephemeral-test-port>`
- Command: `node docs/design/attachments-qa.mjs`

## Scenarios

| # | Surface | Scenario | Result | Assertions | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 attach controls | `attach-controls` | PASS | 13 | {"uploads":[{"sessionID":"ses_qa","name":"design.png","mime":"image/png","size":68,"id":"att_qa"},{"sessionID":"ses_qa","name":"notes.csv","mime":"text/csv","size":26,"id":"att_qa_2"},{"sessionID":"ses_qa","name":"brief.pdf","mime":"application/pdf","size":33,"id":"att_qa_3"},{"sessionID":"ses_qa","name":"button.pdf","mime":"application/pdf","size":33,"id... |
| 2 | 2 send | `send-text-and-file-only` | PASS | 22 | {"textSend":{"text":"Look at this","attachments":[{"id":"att_qa"}]},"fileSend":{"text":"","attachments":[{"id":"att_qa_2","mode":"file"}]},"optimisticText":{"cards":1,"name":"design.png","download":"/api/apps/storefront/attachments/att_qa?project=11111111-1111-4111-8111-111111111111","text":"Look at this"},"history":{"cards":1,"name":"design.png","downloa... |
| 3 | 3 remove/blocking | `remove-and-blocking` | PASS | 9 | {"deletes":["att_qa"],"draftPuts":[{"sessionID":"ses_remove","text":"","body":{"text":""}}],"deleteIfEmpty":["ses_remove"],"sendError":"Wait for the attachments to finish uploading.","sendDisabled":{"disabled":true,"title":"Resolve the attachments before sending"},"uploading":[{"name":"brief.pdf","status":"uploading","kind":"pdf","mode":null,"removeDisabl... |
| 4 | 4 foreign/missing | `foreign-and-missing` | PASS | 6 | {"foreignError":"Attachment not found. (attachment_not_found)","missingError":"The attachment file is missing. (attachment_missing)","sends":[{"text":"","attachments":[{"id":"att_qa","mode":"file"}]},{"text":"","attachments":[{"id":"att_qa_2","mode":"file"}]}]} |
| 5 | 5 title | `title-contract` | PASS | 8 | {"attachmentFirst":{"title":"Attachment"},"textOnly":{},"titleError":"A title is required before sending attachments. (title_required)","restored":[{"name":"keep.png","status":"ready","kind":"image","mode":"auto","removeDisabled":false,"removeTitle":"Remove","progress":null}]} |
| 6 | 6 clear race | `clear-race` | PASS | 6 | {"raceA":{"deleteIfEmpty":0,"uploads":[{"sessionID":"ses_race_a","name":"notes.csv","mime":"text/csv","size":26,"id":"att_qa"}]},"raceB":{"deleteIfEmpty":0}} |
| 7 | 7 responsive/visual | `responsive-visual` | PASS | 24 | [{"width":1440,"height":900,"colorScheme":"dark","layout":{"clientWidth":1440,"clientHeight":900,"scrollHeight":900,"innerHeight":900,"overflowX":0,"composer":{"left":488,"right":1120,"width":632,"top":694.71875,"bottom":900,"height":205.28125},"attachments":{"left":570.421875,"right":1037.578125,"width":467.15625,"top":707.71875,"bottom":816.5,"height":1... |
| 8 | 8 inline delivery | `inline-delivery` | PASS | 17 | {"send":{"text":"","attachments":[{"id":"att_qa","mode":"inline"}]},"warning":{"visible":true,"items":[{"code":"attachment_context_large","downgrade":false,"text":"This message is large for the model context; it was sent anyway."}]},"live":{"cards":[{"id":"att_qa","inline":true,"state":"sent","kind":"image","meta":"68 B · image/png · Sent · Inline","name"... |
| 9 | 9 inline downgrade | `inline-downgrade` | PASS | 11 | {"send":{"text":"","attachments":[{"id":"att_qa","mode":"inline"}]},"warning":{"visible":true,"items":[{"code":"attachment_inline_unsupported","downgrade":true,"text":"This model cannot display this attachment inline; it was sent as a file instead."},{"code":"attachment_capability_unknown","downgrade":true,"text":"The model capabilities could not be confi... |
| 10 | 10 redeliver as file | `redeliver-as-file` | PASS | 10 | {"body":{"attachments":[{"id":"att_qa","mode":"file"}]},"before":{"info":{"id":"msg_seed_1","sessionID":"ses_redeliver","role":"user","time":{"created":1792944852200},"hanse":{"attachments":[{"id":"att_qa","name":"look.png","mime":"image/png","size":68,"kind":"image","mode":"inline","state":"sent","downloadURL":"/api/apps/storefront/attachments/att_qa?pro... |
| 11 | 11 stream recovery | `stream-recovery` | PASS | 4 | {"notice":{"visible":true,"text":"A large live update was skipped; refreshing that part from history.","buttons":[]},"hydrationRequests":1,"seeded":"msg_stream"} |
| 12 | 12 stream limit | `stream-limit` | PASS | 4 | {"notice":{"visible":true,"text":"Too many live streams are open for this app (8). Close another chat tab, or keep reading history here.Retry liveRefresh history","buttons":["Retry live","Refresh history"]},"connection":"Live updates paused","eventGets":1} |

## Failures

_none_

## Screenshots

- `docs/design/artifacts/attachments/attachments-uploading-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-chips-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-send-text-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-file-only-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-remove-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-uploading-block-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-foreign-404-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-missing-409-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-title-create-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-title-text-only-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-title-required-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-clear-race-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-upload-during-clear-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-1440-light.png`
- `docs/design/artifacts/attachments/attachments-390-dark.png`
- `docs/design/artifacts/attachments/attachments-keyboard-390-dark.png`
- `docs/design/artifacts/attachments/attachments-390-light.png`
- `docs/design/artifacts/attachments/attachments-reduced-motion-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-inline-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-downgrade-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-redelivery-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-stream-recovery-1440-dark.png`
- `docs/design/artifacts/attachments/attachments-stream-limit-1440-dark.png`

## Expected HTTP errors exercised

- console: Failed to load resource: the server responded with a status of 404 (Not Found)
- console: Failed to load resource: the server responded with a status of 409 (Conflict)
- console: Failed to load resource: the server responded with a status of 429 (Too Many Requests)

## Unexpected console/page errors

_none_

## Failed network requests

_none_
