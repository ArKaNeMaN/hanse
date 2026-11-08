// Gated because CI has no Docker. Run with:
//   HANSE_TEST_DOCKER=1 HANSE_TEST_SOAK_IMAGE=debian:bookworm-slim \
//     npx vitest run test/container-reaper.integration.test.ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const enabled =
  process.env.HANSE_TEST_DOCKER === "1" &&
  (process.env.HANSE_TEST_SOAK_IMAGE ?? "").trim().length > 0;

describe.skipIf(!enabled)("app container reaper (Docker integration)", () => {
  it("reaps orphaned grandchildren with --init as PID 1", () => {
    const image = (process.env.HANSE_TEST_SOAK_IMAGE ?? "").trim();
    const script = [
      "for i in $(seq 1 100); do ( (sleep 0.05 &) & ); done;",
      "sleep 1;",
      "z=0;",
      "for s in /proc/[0-9]*/status; do",
      "  grep -q '^State:[[:space:]]*Z' \"$s\" 2>/dev/null && z=$((z+1));",
      "done;",
      'echo "pid1=$(cat /proc/1/comm) zombies=$z";',
      'test "$z" -eq 0',
    ].join(" ");

    const output = execFileSync(
      "docker",
      ["run", "--rm", "--init", "--entrypoint", "/bin/sh", image, "-c", script],
      { encoding: "utf8", timeout: 60_000 },
    );

    expect(output).toContain("zombies=0");
    expect(output).not.toContain("pid1=sh");
  });
});
