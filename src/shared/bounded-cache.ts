/**
 * Insert into a `Map` while keeping its size at or below `max`.
 *
 * TTL-only caches still need a size bound because entries whose keys are never read again are
 * otherwise only removed on read/invalidate. A non-positive `max` is treated as `1`. Re-setting an
 * existing key refreshes its insertion order, so the oldest key wins eviction.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  const limit = Math.max(max, 1);
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
