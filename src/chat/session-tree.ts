import type { OpencodeSession } from "../opencode/client.js";

function asNode(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function validID(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usableParentID(value: unknown, id: string): string | undefined {
  const node = asNode(value);
  if (node === null) return undefined;
  const parentID = node.parentID;
  if (typeof parentID !== "string" || parentID.trim().length === 0 || parentID === id) {
    return undefined;
  }
  return parentID;
}

/**
 * Collect a session id followed by its descendants in upstream order.
 *
 * Mirrors the browser tree helpers: invalid ids are skipped, the first occurrence of a duplicate
 * id wins, and a missing/blank/non-string/self/unknown `parentID` makes a session a root. The
 * traversal is cycle-safe and the root id is always first, even when it is absent from the list.
 *
 * Pure: no database, locks, or I/O.
 */
export function collectSessionSubtreeIDs(sessions: OpencodeSession[], rootID: string): string[] {
  const root = validID(rootID);
  if (root === undefined) return [];

  const list: readonly unknown[] = Array.isArray(sessions) ? sessions : [];
  const nodes = new Map<string, unknown>();
  const order: string[] = [];
  for (const entry of list) {
    const node = asNode(entry);
    if (node === null) continue;
    const id = validID(node.id);
    if (id === undefined || nodes.has(id)) continue;
    nodes.set(id, node);
    order.push(id);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const id of order) {
    const parentID = usableParentID(nodes.get(id), id);
    if (parentID === undefined || !nodes.has(parentID)) continue;
    const children = childrenByParent.get(parentID);
    if (children === undefined) childrenByParent.set(parentID, [id]);
    else children.push(id);
  }

  const collected: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    collected.push(current);
    const children = childrenByParent.get(current);
    if (children === undefined) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return collected;
}
