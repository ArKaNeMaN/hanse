#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("fake-opencode 1.2.3");
  process.exit(0);
}

const portIndex = args.indexOf("--port");
const port = portIndex === -1 ? 0 : Number(args[portIndex + 1]);

if (process.env.FAKE_OPENCODE_RECORD !== undefined) {
  writeFileSync(
    process.env.FAKE_OPENCODE_RECORD,
    JSON.stringify({ argv: args, cwd: process.cwd(), env: { ...process.env }, pid: process.pid }),
  );
}

console.log(`fake-opencode serve on ${port}`);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

server.listen(port, "0.0.0.0", () => {
  console.log("fake-opencode listening");
});

if (process.env.FAKE_OPENCODE_EXIT_CODE !== undefined) {
  setTimeout(() => process.exit(Number(process.env.FAKE_OPENCODE_EXIT_CODE)), 200);
}

function stop() {
  console.log("fake-opencode stopping");
  if (process.env.FAKE_OPENCODE_SIGNALS !== undefined) {
    writeFileSync(process.env.FAKE_OPENCODE_SIGNALS, "SIGTERM\n", { flag: "a" });
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
}

if (process.env.FAKE_OPENCODE_IGNORE_TERM !== "1") {
  process.on("SIGTERM", stop);
}
process.on("SIGINT", stop);
