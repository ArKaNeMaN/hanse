#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  root: path.join(root, "ui"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (baseUrl === undefined) {
    throw new Error("Vite did not expose a local URL");
  }

  const url = `${baseUrl}main.ts`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  const source = await response.text();
  if (!source.includes("createApp")) {
    throw new Error("Vite returned main.ts without the createApp import");
  }
  process.stdout.write(`check:ui-dev ok (GET ${url} -> 200)\n`);
} catch (error) {
  process.stderr.write(`check:ui-dev failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  // Vite's optimizer can leave `close()` pending in a container without a writable cache; the
  // explicit exit below keeps this dev-only smoke from hanging. It is not part of the CI gate.
  server.httpServer?.closeAllConnections();
  void server.close();
}

setTimeout(() => process.exit(process.exitCode ?? 0), 100);
