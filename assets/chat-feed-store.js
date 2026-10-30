/**
 * Copy-first chat feed store.
 *
 * Stage 3A copies the frozen legacy `createThreadStore` shape out of `assets/chat.js` so the SPA
 * can own the same plain object/Maps without editing or importing the legacy page client. Until
 * Stage 9, `assets/chat.js` remains the behavior oracle; this module must stay a plain ESM copy
 * with no imports (no `ui/`, no legacy client, no server modules).
 */

/**
 * @param {string | null} id
 * @returns {{
 *   sessionID: string | null,
 *   generation: number,
 *   turnGeneration: number,
 *   order: string[],
 *   messages: Map<string, unknown>,
 *   activePromptID: string | null,
 *   queue: string[],
 *   openParts: Set<string>,
 *   lastSeqByStream: Map<string, number>,
 *   currentStreamID: string | null,
 *   pendingDeltas: Map<string, string>,
 *   agentStatus: { type?: string } | null
 * }}
 */
export function createThreadStore(id) {
  return {
    sessionID: id,
    generation: 0,
    turnGeneration: 0,
    order: [],
    messages: new Map(),
    activePromptID: null,
    queue: [],
    openParts: new Set(),
    lastSeqByStream: new Map(),
    currentStreamID: null,
    pendingDeltas: new Map(),
    agentStatus: null,
  };
}
