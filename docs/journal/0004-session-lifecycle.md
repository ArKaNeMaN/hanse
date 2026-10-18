# 0004 - Lazy chat sessions and deletion

Status: implemented and verified (2026-10-19). Not committed; the owner did not ask for a commit.

## Context

The chat workspace created an empty opencode session as soon as it opened (or when the list was
empty), and the "New session" action created another one immediately. Opening the chat repeatedly
therefore accumulated empty sessions. There was also no way to remove a session from the rail.

## What changed

- **Lazy creation.** `assets/chat.js` now boots into a client-side draft when the app has no sessions
  instead of calling `POST /sessions`. "New session" resets the thread to a draft and creates nothing.
  The first successful send calls `POST /api/apps/:app/sessions` and then posts the prompt to the new
  session. Session creation and the prompt share the existing send guard.
- **Deletion.** `DELETE /api/apps/:app/sessions/:sid` is a human-only endpoint (`403` for agent
  principals) that proxies opencode `DELETE /session/:id`. It returns `{ "deleted": true }` on success
  and `502` when opencode rejects the request.
- **Session rail.** Each session row is a wrapper with the select button and a trash action. Deletion
  asks for confirmation, disables the row while the request runs, and shows failures inline above the
  list. Deleting the active session selects the next one; deleting the last one returns to the draft.
- **Shared icon.** `trash` was added to the `src/http/ui.ts` icon sprite.

## Decisions

- The draft is client-side state (`sessionId === null`); no placeholder session or coordinator-side
  record is created.
- No session is created when a draft has not sent anything, including when the page is reopened.
- A failed first send keeps the newly created session active so the restored draft can be retried;
  auto-deleting it on failure was rejected because a network error can happen after the prompt was
  accepted.
- Deletion is human-only even though listing and prompting are also available to agent principals,
  matching the destructive-operation policy used by the git API.
- Confirmation uses the browser `confirm()` dialog. A custom native `<dialog>` can replace it later if
  the session rail grows more actions.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are green.
- `test/chat-page.test.ts` covers human deletion, agent `403` without starting the runtime, and `502`
  propagation from opencode.
- Headless browser QA against a fake opencode server verified: no session request on boot with an
  empty list; exactly one session created by the first send; "New session" creates nothing; deletion
  of the active session selects the remaining session; deleting the last session returns to the draft.

## Remaining

- No rename action; the opencode-generated title still changes after the first prompt.
- Existing empty sessions are not cleaned up automatically; they can now be deleted from the rail.
