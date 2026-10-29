/**
 * Per-document marker for successful skill writes.
 *
 * The skills inventory trusts its boot props on the first render. After a write in this document,
 * that boot snapshot is stale, so a later client navigation back to an inventory must refetch even
 * when the original boot route still matches. A full document load resets the module.
 */
let mutated = false;

export function markSkillsMutated(): void {
  mutated = true;
}

export function hasSkillsMutated(): boolean {
  return mutated;
}
