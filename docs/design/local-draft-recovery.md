# Design - Composer draft retention until send response

Status: accepted, minimal client-only fix. Owner chose this after six reviews of larger
local-journal/idempotency designs.

## Context

The chat composer clears its text before the send request and does not restore it on an unknown
outcome (`ui/composables/useChatComposer.ts:843-868,909-941`). During a deployment the server was
unreachable; the composer cleared, the request failed as unknown, and the text was lost.

## Decision

Keep the composer text (and its attachment chips) in place until the send has a definitive response.
No local storage, no server migration, no attempt id, no idempotency layer.

- Do not call `store.setDraft("")` / `store.setAttachments([])` before the POST.
- On a successful `202`/accepted response, clear only the text that was sent, and only if the composer
  still equals it. If the operator typed a newer draft during the request, keep the newer draft.
  Remove only the attachment chips that were part of the sent payload.
- On a definite `failed` response, keep the current composer text. Do not overwrite a newer draft with
  the sent text. Do not force-save a duplicate server draft: the server `pending_sends` row (if the
  insert happened) or the pre-send server draft (if it did not) is the recovery copy.
- On `unknown`/transport failure, keep the composer text and show the existing unknown-recovery banner.
  Do not force-send.
- When `Check again` confirms an unknown message was accepted, clear the composer only if it still
  equals the sent text; a newer draft is preserved.
- On auth/session-gone, keep the composer text.
- No local storage: a reload after an unknown outcome relies on the server `pending_sends` row (if the
  request reached the coordinator) or the server draft (if it did not). A response lost before the
  coordinator saw the request and no server draft is the accepted residual loss window.

## Non-goals

- sessionStorage/IndexedDB drafts.
- attemptID/idempotency keys or schema migrations.
- Prompt-answer drafts.
- Cross-reload recovery when no server copy exists.

## Files

- `ui/composables/useChatComposer.ts`: move the clear from send-start to the accepted branch; keep the
  composer on failed/unknown; force-save the current draft on a definite failure; preserve a newer
  draft and newer attachments.
- `test/ui/chat-send.test.ts` (and any affected composer tests): assert the new behavior.

## Verification

- Composer still shows the text while the send request is pending.
- Success clears the sent text and sent chips; a newer draft typed during the request survives.
- Failed keeps the current draft and force-saves it; a newer draft is not overwritten.
- Unknown keeps the draft and shows the unknown banner; Check again clears it only if unchanged.
- Auth/session-gone keep the draft.
- Gates: `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run lint`, `npm run build`.

## Review history

Revisions 1-6 of a larger local-journal/attempt-id design received CONDITIONAL PASS from Oracle but
never became plan-ready. The owner chose this minimal client-only fix instead.
