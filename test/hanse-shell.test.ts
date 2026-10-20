import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface ShellFixture {
  root: string;
  home: string;
  workspace: string;
  marker: string;
  script: string;
}

async function fixture(): Promise<ShellFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "hanse-shell-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const source = await readFile(path.join(process.cwd(), "shell", "hanse-shell"), "utf8");
  const script = path.join(root, "hanse-shell");
  await writeFile(
    script,
    source.replaceAll("/home/coder", home).replaceAll("/data/workspace", workspace),
    { mode: 0o755 },
  );
  await chmod(script, 0o755);

  return { root, home, workspace, marker: path.join(root, "marker"), script };
}

function run(
  shell: ShellFixture,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.script, args, {
      cwd: options.cwd ?? shell.workspace,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("hanse-shell", () => {
  it("does not source workspace or controlled-home startup files", async () => {
    const shell = await fixture();
    const payload = `#!/bin/sh\ntouch '${shell.marker}'\n`;
    for (const name of [".bashrc", ".bash_profile", ".profile"]) {
      await writeFile(path.join(shell.workspace, name), payload, { mode: 0o755 });
      await writeFile(path.join(shell.home, name), payload, { mode: 0o755 });
    }
    const bashEnv = path.join(shell.root, "bash-env.sh");
    await writeFile(bashEnv, payload, { mode: 0o755 });

    const result = await run(shell, ["-c", "printf '%s' ok"], {
      env: {
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        PROMPT_COMMAND: `touch '${shell.marker}'`,
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(await exists(shell.marker)).toBe(false);
  });

  it("does not import exported bash functions from the environment", async () => {
    const shell = await fixture();
    const result = await run(shell, ["-c", "hanse_pwn"], {
      env: {
        "BASH_FUNC_hanse_pwn%%": `() { touch '${shell.marker}'; }`,
      },
    });

    expect(result.code).toBe(127);
    expect(await exists(shell.marker)).toBe(false);
  });

  it("uses a controlled HOME, MISE data dir, and PATH", async () => {
    const shell = await fixture();
    const result = await run(shell, [
      "-c",
      'printf "%s\\n" "$HOME" "$MISE_DATA_DIR" "$PATH" "$BASH_ENV" "$PROMPT_COMMAND"',
    ]);
    const [home, miseDataDir, pathValue, bashEnv, promptCommand] = result.stdout.split("\n");

    expect(home).toBe(shell.home);
    expect(miseDataDir).toBe(path.join(shell.home, ".local/share/mise"));
    expect(pathValue).toContain(path.join(shell.home, ".local/share/mise/shims"));
    expect(pathValue).toContain("/usr/local/bin");
    expect(bashEnv).toBe("");
    expect(promptCommand).toBe("");
  });

  it("starts in the opened workspace folder and never outside it", async () => {
    const shell = await fixture();
    const nested = path.join(shell.workspace, "app");
    await mkdir(nested);

    const inside = await run(shell, ["-c", "pwd -P"], { cwd: nested });
    expect(inside.stdout.trim()).toBe(await realpath(nested));

    const outside = await run(shell, ["-c", "pwd -P"], { cwd: shell.root });
    expect(outside.stdout.trim()).toBe(await realpath(shell.workspace));
  });

  it("forwards shell arguments", async () => {
    const shell = await fixture();
    const result = await run(shell, ["-c", 'printf "%s" "$1"', "sh", "hello"]);
    expect(result.stdout).toBe("hello");
  });

  it("keeps code-server workspace trust restricted and auto-run disabled", async () => {
    const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain('"security.workspace.trust.enabled":true');
    expect(dockerfile).toContain('"security.workspace.trust.startupPrompt":"never"');
    expect(dockerfile).toContain('"security.workspace.trust.emptyWindow":false');
    expect(dockerfile).toContain('"task.autoDetect":"off"');
    expect(dockerfile).toContain('"extensions.autoCheckUpdates":false');
    expect(dockerfile).toContain('"extensions.autoUpdate":false');
  });
});
