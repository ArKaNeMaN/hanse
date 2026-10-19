import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        normalized[key] = normalize(item);
      }
    }
    return normalized;
  }
  return value;
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively and
 * `undefined` object properties are omitted. Arrays keep their order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** SHA-256 hex digest of an exact string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable SHA-256 hash of a JSON-compatible value. */
export function hashValue(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
