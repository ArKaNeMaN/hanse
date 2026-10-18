import { connect, createServer } from "node:net";
import path from "node:path";
import type { SqliteDatabase } from "../store/index.js";
import { launchInstance, type RunningInstance } from "./launcher.js";

export interface ManagedApp {
  id: string;
  projectId: string;
  appKey: string;
  appDir: string;
}

interface Entry {
  run: RunningInstance;
  endpoint: string;
}

const PORT_BASE = 4100;
const PORT_COUNT = 100;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`opencode instance did not start on port ${port}`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

export class InstanceManager {
  readonly #db: SqliteDatabase;
  readonly #runtimeRoot: string;
  readonly #running = new Map<string, Entry>();
  #nextPort = PORT_BASE;

  constructor(db: SqliteDatabase, runtimeRoot: string) {
    this.#db = db;
    this.#runtimeRoot = runtimeRoot;
  }

  async ensure(app: ManagedApp): Promise<string> {
    const existing = this.#running.get(app.id);
    if (existing !== undefined && existing.run.process.exitCode === null) {
      return existing.endpoint;
    }
    const port = await this.#allocatePort();
    const run = launchInstance(this.#db, {
      appId: app.id,
      identity: { projectId: app.projectId, app: app.appKey },
      appDir: app.appDir,
      runtimeRoot: path.join(this.#runtimeRoot, "projects", app.projectId),
      port,
      coordinatorCommand: ["hanse", "mcp"],
      authSource: process.env.HANSE_AUTH_FILE,
    });
    this.#running.set(app.id, { run, endpoint: run.endpoint });
    await waitForPort(port, 10000);
    return run.endpoint;
  }

  stopAll(): void {
    for (const entry of this.#running.values()) {
      entry.run.process.kill("SIGTERM");
    }
    this.#running.clear();
  }

  async #allocatePort(): Promise<number> {
    for (let attempt = 0; attempt < PORT_COUNT; attempt += 1) {
      const port = PORT_BASE + ((this.#nextPort - PORT_BASE + attempt) % PORT_COUNT);
      if (await portFree(port)) {
        this.#nextPort = port + 1;
        return port;
      }
    }
    throw new Error("no free port for an opencode instance");
  }
}
