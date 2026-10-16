import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package name, mirrored here so the CLI can print it without reading the manifest. */
export const PACKAGE_NAME = "hanse";

/** Fallback version used when package.json cannot be read. */
const FALLBACK_VERSION = "0.0.0-pre";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readVersion(): string {
  try {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (isRecord(manifest) && typeof manifest.version === "string") {
      return manifest.version;
    }
    return FALLBACK_VERSION;
  } catch {
    // Reading the manifest is best-effort; a missing or broken manifest must not crash the CLI.
    return FALLBACK_VERSION;
  }
}

export const VERSION: string = readVersion();
