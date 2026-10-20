/**
 * Runner-facing re-export of the shared fixed git operation validation.
 *
 * The implementation lives in `src/git/request.ts` so the coordinator, the runner server, and the
 * sandboxed `git-op` helper all enforce exactly the same fixed operation set.
 */
export {
  GIT_OPERATIONS,
  type GitOperation,
  type GitRequest,
  validateGitRequest,
} from "../git/request.js";
