import {
  listMessagePage,
  OpencodeHttpError,
  type OpencodeMessage,
  type OpencodeMessagePage,
} from "../opencode/client.js";
import type { MessageProjector } from "./projection.js";

export const PROJECTED_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export interface ProjectedPageOptions {
  limit: number;
  before?: string;
  project: MessageProjector;
}

function isTooLarge(error: unknown): boolean {
  return error instanceof OpencodeHttpError && error.code === "messages_too_large";
}

/**
 * Read a history page with the 48 MiB raw cap. On `messages_too_large`, fall back to single-message
 * reads (still 48 MiB each) and accumulate the requested page. Each read reserves and yields the
 * shared heap budget.
 */
export async function readProjectedPage(
  endpoint: string,
  sessionId: string,
  options: ProjectedPageOptions,
): Promise<OpencodeMessagePage> {
  try {
    const page = await listMessagePage(endpoint, sessionId, {
      limit: options.limit,
      ...(options.before === undefined ? {} : { before: options.before }),
      project: options.project,
    });
    return page;
  } catch (error) {
    if (!isTooLarge(error)) throw error;
  }

  const collected: OpencodeMessage[] = [];
  let cursor = options.before;
  let nextCursor: string | undefined;
  while (collected.length < options.limit) {
    const page = await listMessagePage(endpoint, sessionId, {
      limit: 1,
      ...(cursor === undefined ? {} : { before: cursor }),
      project: options.project,
    });
    const message = page.messages[0];
    if (message === undefined) break;
    collected.push(message);
    nextCursor = page.nextCursor;
    if (nextCursor === undefined) break;
    cursor = nextCursor;
  }
  return {
    messages: collected.reverse(),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function projectedResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
