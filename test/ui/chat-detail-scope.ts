import {
  TRANSCRIPT_DETAIL_SCOPE,
  type TranscriptDetailScope,
} from "../../ui/chat/transcript-memory.js";

/** Mount option helper that injects a transcript detail scope into an isolated component test. */
export function detailProvide(scope: TranscriptDetailScope): Record<symbol, TranscriptDetailScope> {
  return { [TRANSCRIPT_DETAIL_SCOPE]: scope };
}
