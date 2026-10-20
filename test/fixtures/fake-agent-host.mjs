import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const index = process.argv.indexOf("--spec");
const specFile = index === -1 ? undefined : process.argv[index + 1];
if (specFile === undefined) {
  console.error("fake-agent-host: --spec is required");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specFile, "utf8"));
const runtimeDir = path.join(spec.stateDir, "runtime");
mkdirSync(runtimeDir, { recursive: true });

if (process.env.FAKE_HOST_RECORD !== undefined) {
  writeFileSync(
    process.env.FAKE_HOST_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), env: { ...process.env }, pid: process.pid }),
  );
}
if (process.env.FAKE_HOST_STARTS !== undefined) {
  writeFileSync(process.env.FAKE_HOST_STARTS, `${process.pid}\n`, { flag: "a" });
}
if (process.env.FAKE_HOST_SIGNALS !== undefined) {
  process.on("SIGTERM", () => {
    writeFileSync(process.env.FAKE_HOST_SIGNALS, "SIGTERM\n", { flag: "a" });
  });
}

console.log(`fake-host ${spec.appId} stdout on ${spec.port}`);
console.error(`fake-host ${spec.appId} stderr`);
if (spec.env.FAKE_BIG_LOG === "1") {
  process.stdout.write(`${"X".repeat(2048)}\n`);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(`fake-host ${spec.appId}`);
});

writeFileSync(
  path.join(runtimeDir, "host-status.json"),
  JSON.stringify({
    hanseVersion: "fake-hanse",
    opencodeVersion: "fake-opencode",
    specHash: spec.specHash,
    state: "running",
    pid: process.pid,
    port: spec.port,
    startedAt: new Date().toISOString(),
  }),
);

server.listen(spec.port, "127.0.0.1", () => {
  console.log(`fake-host ${spec.appId} listening`);
});

function stop() {
  console.log(`fake-host ${spec.appId} stopping`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
