import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ClientChannel } from "ssh2";
import type { AgentTokenIdentity } from "../mcp/agent-tokens.js";
import { open, seal } from "../secrets/crypto.js";
import type { SqliteDatabase } from "../store/index.js";
import { actionHash, actionPreview, commandBytes, waitForApproval } from "./approvals.js";
import { connectSsh, openSftp, type SshConnection } from "./connection.js";
import { type RunSshKeygen, validatePrivateKey } from "./keys.js";
import { openAppDestination, readAppFile, remotePath, remotePathInside } from "./paths.js";
import { type HostCredentialInput, SshStore } from "./store.js";
import {
  APPROVAL_WAIT_MS,
  BUSY_WAIT_MS,
  COMMAND_DEFAULT_SEC,
  COMMAND_MAX_BYTES,
  COMMAND_MAX_SEC,
  FILE_CAP_BYTES,
  GLOBAL_INFLIGHT,
  IDLE_DEFAULT_SEC,
  IDLE_MAX_SEC,
  IDLE_MIN_SEC,
  OPERATIONS_PER_HOUR,
  OUTPUT_CAP_BYTES,
  PENDING_HOST_KEY_SEC,
  PER_HOST_INFLIGHT,
  type SshAction,
  type SshApproval,
  type SshApprovalPendingResult,
  type SshApprovalView,
  type SshAuditEntry,
  type SshDownloadInput,
  SshError,
  type SshExecInput,
  type SshExecResult,
  type SshGrant,
  type SshHost,
  type SshHostView,
  type SshTestResult,
  type SshTransferResult,
  type SshUploadInput,
  TRANSFER_TIMEOUT_MS,
  WAITERS_PER_APPROVAL,
} from "./types.js";

export interface SshServiceOptions {
  db: SqliteDatabase;
  secretKey: Buffer;
  workspaceRoot: string;
  agentsHome: string;
  now?: () => Date;
  connect?: typeof connectSsh;
  approvalWaitMs?: number;
  approvalPollMs?: number;
  busyWaitMs?: number;
  transferTimeoutMs?: number;
  runSshKeygen?: RunSshKeygen;
}

export interface CreateHostRequest {
  name: string;
  address: string;
  port?: number;
  username: string;
  privateKey: string;
  requireApproval?: boolean;
  approvalIdleSec?: number;
  remoteRoot?: string | null;
}

export interface UpdateHostRequest {
  name?: string;
  address?: string;
  port?: number;
  username?: string;
  privateKey?: string;
  requireApproval?: boolean;
  approvalIdleSec?: number;
  remoteRoot?: string | null;
}

interface AuditPatch {
  exitCode?: number | null;
  errorCode?: string | null;
  bytesOut?: number | null;
  truncated?: boolean;
  presentedFingerprint?: string | null;
  detail?: Record<string, unknown> | null;
}

interface OperationRequest {
  commandHash: string;
  commandPreview: string;
  commandBytes: number;
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function errorCode(error: unknown): SshError {
  if (error instanceof SshError) return error;
  return new SshError(
    "ssh_transport_error",
    error instanceof Error ? error.message : String(error),
  );
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function bounded(value: string, cap = OUTPUT_CAP_BYTES): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= cap) return { value, truncated: false };
  return { value: buffer.subarray(0, cap).toString("utf8"), truncated: true };
}

function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f)) {
      out += character;
    }
  }
  return out;
}

function bitsForType(type: string): number | null {
  if (type === "ssh-ed25519" || type === "ecdsa-sha2-nistp256") return 256;
  if (type === "ecdsa-sha2-nistp384") return 384;
  if (type === "ecdsa-sha2-nistp521") return 521;
  return null;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 128 || hasControl(name)) {
    throw new SshError("ssh_invalid_argument", "Host name must be 1-128 printable characters");
  }
  return name;
}

function validateAddress(value: string): string {
  const address = value.trim();
  if (
    address.length === 0 ||
    address.length > 255 ||
    !/^[A-Za-z0-9._:[\]-]+$/.test(address) ||
    address.includes("/") ||
    /\s/.test(address)
  ) {
    throw new SshError("ssh_invalid_argument", "Host address must be a hostname or IP literal");
  }
  return address;
}

function validateUsername(value: string): string {
  const username = value.trim();
  if (
    username.length === 0 ||
    username.length > 64 ||
    /\s/.test(username) ||
    hasControl(username)
  ) {
    throw new SshError("ssh_invalid_argument", "SSH username must be 1-64 printable characters");
  }
  return username;
}

function validateRemoteRoot(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  const root = value.trim();
  if (!root.startsWith("/") || root.includes("\u0000") || root.split("/").includes("..")) {
    throw new SshError(
      "ssh_invalid_argument",
      "Remote root must be an absolute POSIX path without '..'",
    );
  }
  return path.posix.normalize(root);
}

function sftpCall<T>(
  invoke: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => invoke(resolve, reject));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SshError("ssh_transfer_timeout", message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class SshService {
  readonly #store: SshStore;
  readonly #secretKey: Buffer;
  readonly #workspaceRoot: string;
  readonly #agentsHome: string;
  readonly #now: () => Date;
  readonly #connect: typeof connectSsh;
  readonly #approvalWaitMs: number;
  readonly #approvalPollMs: number;
  readonly #busyWaitMs: number;
  readonly #transferTimeoutMs: number;
  readonly #runSshKeygen: RunSshKeygen | undefined;
  readonly #hostInflight = new Map<string, number>();
  readonly #waiters = new Map<string, number>();
  #globalInflight = 0;

  constructor(options: SshServiceOptions) {
    this.#store = new SshStore(options.db);
    this.#secretKey = options.secretKey;
    this.#workspaceRoot = realpathSync(options.workspaceRoot);
    this.#agentsHome = options.agentsHome;
    this.#now = options.now ?? (() => new Date());
    this.#connect = options.connect ?? connectSsh;
    this.#approvalWaitMs = options.approvalWaitMs ?? APPROVAL_WAIT_MS;
    this.#approvalPollMs = options.approvalPollMs ?? 250;
    this.#busyWaitMs = options.busyWaitMs ?? BUSY_WAIT_MS;
    this.#transferTimeoutMs = options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    this.#runSshKeygen = options.runSshKeygen;
    this.#store.markOrphaned(iso(this.#now));
  }

  listAllHosts(): Array<{ host: SshHost; credential: SshHostView["credential"] }> {
    return this.#store.listHosts();
  }

  listHosts(agent: AgentTokenIdentity): SshHostView[] {
    const hosts = this.#store.listAppHosts(agent.appId);
    const pending = this.#store.listPending(agent.appId, iso(this.#now));
    return hosts.map((host) => {
      const full = this.#store.getHost(host.id);
      return {
        ...host,
        credential: full?.credential ?? null,
        allowed: true,
        grant: this.#store.activeGrant(agent.appId, host.id, iso(this.#now)) ?? null,
        pendingApprovals: pending.filter((entry) => entry.hostId === host.id).length,
      };
    });
  }

  getHostView(hostId: string, agent?: AgentTokenIdentity): SshHostView | undefined {
    const full = this.#store.getHost(hostId);
    if (full === undefined) return undefined;
    const allowed = agent === undefined ? false : this.#store.isAllowed(agent.appId, hostId);
    return {
      ...full.host,
      credential: full.credential,
      allowed,
      grant:
        agent === undefined
          ? null
          : (this.#store.activeGrant(agent.appId, hostId, iso(this.#now)) ?? null),
      pendingApprovals:
        agent === undefined
          ? 0
          : this.#store
              .listPending(agent.appId, iso(this.#now))
              .filter((entry) => entry.hostId === hostId).length,
    };
  }

  createHost(input: CreateHostRequest, actor: string): SshHostView {
    const name = validateName(input.name);
    const address = validateAddress(input.address);
    const username = validateUsername(input.username);
    const port = input.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SshError("ssh_invalid_argument", "SSH port must be between 1 and 65535");
    }
    const idle = input.approvalIdleSec ?? IDLE_DEFAULT_SEC;
    if (!Number.isInteger(idle) || idle < IDLE_MIN_SEC || idle > IDLE_MAX_SEC) {
      throw new SshError("ssh_invalid_argument", "Approval idle duration is out of range");
    }
    if (this.#store.getHostByName(name) !== undefined) {
      throw new SshError("ssh_invalid_argument", "A host with that name already exists");
    }
    const validated = validatePrivateKey(input.privateKey, this.#runSshKeygen);
    const sealed = seal(this.#secretKey, input.privateKey.replace(/\r\n/g, "\n"));
    const now = iso(this.#now);
    const credential: HostCredentialInput = {
      cipher: sealed.cipher,
      nonce: sealed.nonce,
      publicKey: validated.publicKey,
      fingerprint: validated.fingerprint,
      keyType: validated.keyType,
      bits: validated.bits,
      validatedAt: validated.validatedAt,
      updatedAt: now,
      updatedBy: actor,
    };
    this.#store.createHost({
      id: randomUUID(),
      name,
      address,
      port,
      username,
      requireApproval: input.requireApproval ?? true,
      approvalIdleSec: idle,
      remoteRoot: validateRemoteRoot(input.remoteRoot),
      createdAt: now,
      credential,
    });
    const host = this.#store.getHostByName(name);
    if (host === undefined) throw new SshError("ssh_transport_error", "Host was not persisted");
    this.auditHost(host.host, "host.create", actor, { port });
    return this.getHostView(host.host.id) as SshHostView;
  }

  updateHost(hostId: string, input: UpdateHostRequest, actor: string): SshHostView {
    const existing = this.#store.getHost(hostId);
    if (existing === undefined) throw new SshError("ssh_host_not_allowed", "Host not found");
    const name = validateName(input.name ?? existing.host.name);
    const address = validateAddress(input.address ?? existing.host.address);
    const username = validateUsername(input.username ?? existing.host.username);
    const port = input.port ?? existing.host.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SshError("ssh_invalid_argument", "SSH port must be between 1 and 65535");
    }
    const idle = input.approvalIdleSec ?? existing.host.approvalIdleSec;
    if (!Number.isInteger(idle) || idle < IDLE_MIN_SEC || idle > IDLE_MAX_SEC) {
      throw new SshError("ssh_invalid_argument", "Approval idle duration is out of range");
    }
    const duplicate = this.#store.getHostByName(name);
    if (duplicate !== undefined && duplicate.host.id !== hostId) {
      throw new SshError("ssh_invalid_argument", "A host with that name already exists");
    }
    const now = iso(this.#now);
    this.#store.updateHostMetadata(hostId, {
      name,
      address,
      port,
      username,
      requireApproval: input.requireApproval ?? existing.host.requireApproval,
      approvalIdleSec: idle,
      remoteRoot:
        input.remoteRoot === undefined
          ? existing.host.remoteRoot
          : validateRemoteRoot(input.remoteRoot),
      updatedAt: now,
    });
    if (address !== existing.host.address || port !== existing.host.port) {
      this.#store.clearPin(hostId, now);
    }
    if (input.privateKey !== undefined) {
      const validated = validatePrivateKey(input.privateKey, this.#runSshKeygen);
      const sealed = seal(this.#secretKey, input.privateKey.replace(/\r\n/g, "\n"));
      this.#store.upsertCredential(hostId, {
        cipher: sealed.cipher,
        nonce: sealed.nonce,
        publicKey: validated.publicKey,
        fingerprint: validated.fingerprint,
        keyType: validated.keyType,
        bits: validated.bits,
        validatedAt: validated.validatedAt,
        updatedAt: now,
        updatedBy: actor,
      });
    }
    this.auditHost(existing.host, "host.update", actor, {
      addressChanged: address !== existing.host.address,
      portChanged: port !== existing.host.port,
      keyChanged: input.privateKey !== undefined,
    });
    return this.getHostView(hostId) as SshHostView;
  }

  deleteHost(hostId: string, actor: string): void {
    const existing = this.#store.getHost(hostId);
    if (existing === undefined) throw new SshError("ssh_host_not_allowed", "Host not found");
    this.auditHost(existing.host, "host.delete", actor, null);
    this.#store.deleteHost(hostId);
  }

  async testHost(hostId: string, options: { ignorePin?: boolean } = {}): Promise<SshTestResult> {
    const existing = this.#store.getHost(hostId);
    if (existing === undefined) throw new SshError("ssh_host_not_allowed", "Host not found");
    const privateKey = this.decryptKey(hostId);
    const now = iso(this.#now);
    const auditId = this.startHostAudit(existing.host, "test", now);
    let connection: SshConnection | undefined;
    try {
      connection = await this.#connect({
        host: existing.host,
        privateKey,
        ignorePin: options.ignorePin === true,
        expectedFingerprint: options.ignorePin === true ? null : existing.host.hostKeyFingerprint,
      });
      const previous = existing.host.hostKeyFingerprint;
      const fingerprint = connection.presentedPin.fingerprint;
      if (options.ignorePin === true) {
        this.#store.setPendingObservation(
          hostId,
          {
            text: connection.presentedPin.text,
            type: connection.presentedPin.type,
            fingerprint,
          },
          now,
        );
      } else {
        await this.ensurePin(existing.host, connection.presentedPin, now);
      }
      this.#store.clearMismatch(hostId, now);
      this.#store.finishAudit(auditId, {
        finishedAt: now,
        presentedFingerprint: fingerprint,
        detail: { authOk: true, ignorePin: options.ignorePin === true },
      });
      return {
        ok: true,
        authOk: true,
        fingerprint,
        previousFingerprint: previous,
        mismatch: previous !== null && previous !== fingerprint,
        ...(connection.banner === undefined ? {} : { serverBanner: connection.banner }),
      };
    } catch (error) {
      const sshError = errorCode(error);
      const fingerprint =
        typeof sshError.details?.presentedFingerprint === "string"
          ? sshError.details.presentedFingerprint
          : undefined;
      if (sshError.code === "ssh_host_key_mismatch" && fingerprint !== undefined) {
        this.#store.markMismatch(hostId, fingerprint, now);
      }
      this.#store.finishAudit(auditId, {
        finishedAt: now,
        errorCode: sshError.code,
        presentedFingerprint: fingerprint ?? null,
      });
      return {
        ok: false,
        authOk: false,
        code: sshError.code,
        message: sshError.message,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        previousFingerprint: existing.host.hostKeyFingerprint,
        mismatch: sshError.code === "ssh_host_key_mismatch",
      };
    } finally {
      connection?.client.end();
    }
  }

  rePin(hostId: string, fingerprint: string, actor: string): SshHostView {
    const existing = this.#store.getHost(hostId);
    if (existing === undefined) throw new SshError("ssh_host_not_allowed", "Host not found");
    const pending = this.#store.getPendingObservation(hostId);
    const now = iso(this.#now);
    if (
      pending === undefined ||
      pending.fingerprint !== fingerprint ||
      Date.parse(now) - Date.parse(pending.at) > PENDING_HOST_KEY_SEC * 1000
    ) {
      throw new SshError("ssh_invalid_argument", "No matching unexpired host-key observation");
    }
    const oldFingerprint = existing.host.hostKeyFingerprint;
    this.#store.setPin(
      hostId,
      {
        text: pending.text,
        type: pending.type,
        bits: bitsForType(pending.type),
        fingerprint: pending.fingerprint,
      },
      now,
    );
    this.auditHost(existing.host, "re-pin", actor, {
      oldFingerprint,
      newFingerprint: pending.fingerprint,
    });
    return this.getHostView(hostId) as SshHostView;
  }

  listPending(appId?: string): SshApprovalView[] {
    return this.#store.listPending(appId, iso(this.#now));
  }

  countPending(): number {
    return this.#store.countPending(iso(this.#now));
  }

  listGrants(appId: string): SshGrant[] {
    return this.#store.listGrants(appId);
  }

  decideApproval(
    approvalId: string,
    appId: string,
    decision: "approve" | "reject",
    actor: string,
  ): SshApproval {
    const approval = this.#store.getApproval(approvalId);
    if (approval === undefined || approval.appId !== appId) {
      throw new SshError("ssh_approval_expired", "The SSH approval was not found");
    }
    const host = this.#store.getHost(approval.hostId);
    if (host === undefined) throw new SshError("ssh_host_not_allowed", "Host not found");
    const result = this.#store.decideApproval({
      id: approvalId,
      appId,
      decision,
      actor,
      now: iso(this.#now),
      idleSec: host.host.approvalIdleSec,
      grantId: randomUUID(),
    });
    this.auditHost(host.host, `approval.${decision}`, actor, {
      approvalId,
      appId,
      grantId: result.grantId,
    });
    return result;
  }

  revokeGrant(grantId: string, actor: string): void {
    const grant = this.#store.getGrant(grantId);
    if (grant === undefined) throw new SshError("ssh_invalid_argument", "Grant not found");
    const host = this.#store.getHost(grant.hostId);
    this.#store.revokeGrant(grantId, iso(this.#now));
    if (host !== undefined) {
      this.auditHost(host.host, "grant.revoke", actor, { grantId, appId: grant.appId });
    }
  }

  replaceAppHosts(appId: string, hostIds: string[], actor: string): void {
    for (const hostId of hostIds) {
      if (this.#store.getHost(hostId) === undefined) {
        throw new SshError("ssh_host_not_allowed", "Host not found");
      }
    }
    this.#store.replaceAppHosts(appId, hostIds, actor, iso(this.#now));
  }

  listAudit(appId?: string, limit = 50, before?: number): SshAuditEntry[] {
    return this.#store.listAudit(limit, before, appId);
  }

  async exec(
    agent: AgentTokenIdentity,
    input: SshExecInput,
  ): Promise<SshExecResult | SshApprovalPendingResult> {
    const command = input.command;
    if (
      command.length === 0 ||
      Buffer.byteLength(command, "utf8") > COMMAND_MAX_BYTES ||
      command.includes("\u0000")
    ) {
      throw new SshError("ssh_invalid_argument", "Command must be 1-16 KiB and contain no NUL");
    }
    const timeoutSec = input.timeoutSec ?? COMMAND_DEFAULT_SEC;
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > COMMAND_MAX_SEC) {
      throw new SshError("ssh_invalid_argument", "Command timeout is out of range");
    }
    const preview = actionPreview(command);
    const hash = actionHash("exec", [command]);
    return this.withOperation(
      agent,
      input.hostId,
      "exec",
      { commandHash: hash, commandPreview: preview, commandBytes: commandBytes(command) },
      async (host, privateKey, audit) => {
        const connection = await this.connectHost(host, privateKey);
        try {
          const result = await this.runCommand(connection.client, command, timeoutSec * 1000);
          audit.exitCode = result.exitCode;
          audit.bytesOut = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
          audit.truncated = result.truncated.stdout || result.truncated.stderr;
          return {
            ok: true as const,
            host: host.name,
            command,
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            duration_ms: result.durationMs,
          };
        } finally {
          connection.client.end();
        }
      },
    );
  }

  async upload(
    agent: AgentTokenIdentity,
    input: SshUploadInput,
  ): Promise<SshTransferResult | SshApprovalPendingResult> {
    const appDir = this.resolveAppDir(agent);
    const file = readAppFile(appDir, input.localPath);
    if (file.size > FILE_CAP_BYTES) {
      throw new SshError("ssh_file_too_large", "The local file exceeds the 50 MiB limit");
    }
    const remote = remotePath(input.remotePath, null);
    const preview = `${input.localPath} -> ${remote} (${file.size} bytes)`;
    const hash = actionHash("upload", [input.localPath, input.remotePath, file.size]);
    return this.withOperation(
      agent,
      input.hostId,
      "upload",
      { commandHash: hash, commandPreview: preview, commandBytes: commandBytes(preview) },
      async (host, privateKey, audit) => {
        const connection = await this.connectHost(host, privateKey);
        const sftp = await openSftp(connection.client);
        const target = remotePath(input.remotePath, host.remoteRoot);
        try {
          await withTimeout(
            this.uploadSftp(sftp, target, file.data, host.remoteRoot),
            this.#transferTimeoutMs,
            "The upload exceeded the transfer deadline",
          );
          audit.bytesOut = file.size;
          return { ok: true as const, host: host.name, bytes: file.size, path: target };
        } finally {
          connection.client.end();
        }
      },
    );
  }

  async download(
    agent: AgentTokenIdentity,
    input: SshDownloadInput,
  ): Promise<SshTransferResult | SshApprovalPendingResult> {
    const appDir = this.resolveAppDir(agent);
    const remote = remotePath(input.remotePath, null);
    const preview = `${remote} -> ${input.localPath}`;
    const hash = actionHash("download", [input.remotePath, input.localPath]);
    return this.withOperation(
      agent,
      input.hostId,
      "download",
      { commandHash: hash, commandPreview: preview, commandBytes: commandBytes(preview) },
      async (host, privateKey, audit) => {
        const connection = await this.connectHost(host, privateKey);
        const sftp = await openSftp(connection.client);
        const target = remotePath(input.remotePath, host.remoteRoot);
        try {
          const data = await withTimeout(
            this.downloadSftp(sftp, target, host.remoteRoot),
            this.#transferTimeoutMs,
            "The download exceeded the transfer deadline",
          );
          const destination = openAppDestination(appDir, input.localPath);
          try {
            destination.write(data);
          } finally {
            destination.close();
          }
          audit.bytesOut = data.length;
          return { ok: true as const, host: host.name, bytes: data.length, path: input.localPath };
        } finally {
          connection.client.end();
        }
      },
    );
  }

  private async withOperation<T>(
    agent: AgentTokenIdentity,
    hostId: string,
    action: SshAction,
    request: OperationRequest,
    run: (host: SshHost, privateKey: string, audit: AuditPatch) => Promise<T>,
  ): Promise<T> {
    const existing = this.#store.getHost(hostId);
    if (existing === undefined || !this.#store.isAllowed(agent.appId, hostId)) {
      throw new SshError("ssh_host_not_allowed", "The host is not available to this application");
    }
    const now = iso(this.#now);
    const since = new Date(Date.parse(now) - 3600_000).toISOString();
    if (this.#store.countOperationsSince(agent.appId, hostId, since) >= OPERATIONS_PER_HOUR) {
      throw new SshError("ssh_rate_limited", "Too many SSH operations for this host");
    }

    let grant: SshGrant | undefined;
    let approvalId: string | null = null;
    if (existing.host.requireApproval) {
      grant = this.#store.activeGrant(agent.appId, hostId, now);
      if (grant === undefined) {
        const pending =
          this.#store.findPending(agent.appId, hostId, action, request.commandHash, now) ??
          this.#store.createPending({
            id: randomUUID(),
            appId: agent.appId,
            hostId,
            action,
            commandHash: request.commandHash,
            commandPreview: request.commandPreview,
            commandBytes: request.commandBytes,
            now,
            expiresAt: new Date(Date.parse(now) + 300_000).toISOString(),
          });
        approvalId = pending.id;
        const waiters = (this.#waiters.get(pending.id) ?? 0) + 1;
        if (waiters > WAITERS_PER_APPROVAL) {
          throw new SshError("ssh_busy", "Too many callers are waiting for this SSH approval");
        }
        this.#waiters.set(pending.id, waiters);
        let decided: SshApproval;
        try {
          decided = await waitForApproval(
            this.#store,
            pending.id,
            this.#approvalWaitMs,
            this.#approvalPollMs,
          );
        } finally {
          const remaining = (this.#waiters.get(pending.id) ?? 1) - 1;
          if (remaining <= 0) this.#waiters.delete(pending.id);
          else this.#waiters.set(pending.id, remaining);
        }
        if (decided.status === "rejected") {
          throw new SshError("ssh_approval_rejected", "The operator rejected the SSH request");
        }
        if (decided.status !== "approved") {
          throw new SshError("ssh_approval_pending", "Waiting for operator approval", {
            approval_id: pending.id,
            expires_at: pending.expiresAt,
          });
        }
        grant = this.#store.activeGrant(agent.appId, hostId, iso(this.#now));
        if (grant === undefined) {
          throw new SshError("ssh_approval_expired", "The SSH approval did not create a grant");
        }
      }
    }

    await this.acquireSlot(hostId);
    const audit: AuditPatch = {};
    const startedAt = iso(this.#now);
    let auditId: number;
    try {
      auditId = this.#store.startAudit({
        appId: agent.appId,
        projectId: agent.projectId,
        appKey: agent.appKey,
        hostId,
        hostName: existing.host.name,
        address: existing.host.address,
        username: existing.host.username,
        action,
        commandHash: request.commandHash,
        commandPreview: request.commandPreview,
        approvalId,
        grantId: grant?.id ?? null,
        startedAt,
      });
    } catch {
      this.releaseSlot(hostId);
      throw new SshError("ssh_audit_failed", "The SSH audit row could not be created");
    }
    let operationError: SshError | undefined;
    const finishAudit = (): void => {
      try {
        this.#store.finishAudit(auditId, {
          finishedAt: iso(this.#now),
          exitCode: audit.exitCode ?? null,
          errorCode: audit.errorCode ?? null,
          bytesOut: audit.bytesOut ?? null,
          truncated: audit.truncated === true,
          presentedFingerprint: audit.presentedFingerprint ?? null,
          detail: audit.detail ?? null,
        });
      } catch {
        if (operationError === undefined) {
          operationError = new SshError(
            "ssh_audit_failed",
            "The SSH audit row could not be updated",
          );
        }
      }
    };
    try {
      const privateKey = this.decryptKey(hostId);
      const result = await run(existing.host, privateKey, audit);
      if (grant !== undefined) {
        this.#store.touchGrant(
          grant.id,
          iso(this.#now),
          existing.host.approvalIdleSec,
          grant.absoluteExpiresAt,
        );
      }
      finishAudit();
      if (operationError !== undefined) throw operationError;
      return result;
    } catch (error) {
      operationError = errorCode(error);
      audit.errorCode = operationError.code;
      if (operationError.code === "ssh_host_key_mismatch") {
        const presented = operationError.details?.presentedFingerprint;
        if (typeof presented === "string") {
          audit.presentedFingerprint = presented;
          this.#store.markMismatch(hostId, presented, iso(this.#now));
        }
      }
      finishAudit();
      throw operationError;
    } finally {
      this.releaseSlot(hostId);
    }
  }

  private resolveAppDir(agent: AgentTokenIdentity): string {
    const info = this.#store.getAppPath(agent.appId);
    if (info === undefined) throw new SshError("ssh_invalid_argument", "Application not found");
    const dir = realpathSync(path.resolve(info.rootPath, info.appPath));
    if (!isInside(this.#workspaceRoot, dir)) {
      throw new SshError(
        "ssh_path_not_allowed",
        "The application directory is outside the workspace",
      );
    }
    return dir;
  }

  private decryptKey(hostId: string): string {
    const sealed = this.#store.getCredential(hostId);
    if (sealed === undefined) {
      throw new SshError(
        "ssh_credential_unavailable",
        "No SSH credential is configured for this host",
      );
    }
    try {
      return open(this.#secretKey, sealed);
    } catch {
      throw new SshError("ssh_credential_unavailable", "The SSH credential could not be decrypted");
    }
  }

  private async connectHost(host: SshHost, privateKey: string): Promise<SshConnection> {
    const connection = await this.#connect({
      host,
      privateKey,
      expectedFingerprint: host.hostKeyFingerprint,
    });
    await this.ensurePin(host, connection.presentedPin, iso(this.#now));
    return connection;
  }

  private async ensurePin(
    host: SshHost,
    pin: { text: string; type: string; bits: number | null; fingerprint: string },
    now: string,
  ): Promise<void> {
    if (host.hostKeyFingerprint !== null) {
      if (host.hostKeyFingerprint !== pin.fingerprint) {
        throw new SshError("ssh_host_key_mismatch", "The remote host key does not match", {
          presentedFingerprint: pin.fingerprint,
        });
      }
      return;
    }
    const won = this.#store.pinIfUnset(host.id, pin, now);
    if (!won) {
      const latest = this.#store.getHost(host.id)?.host;
      if (latest?.hostKeyFingerprint !== pin.fingerprint) {
        throw new SshError("ssh_host_key_mismatch", "The remote host key changed during pinning", {
          presentedFingerprint: pin.fingerprint,
        });
      }
    }
  }

  private runCommand(
    client: SshConnection["client"],
    command: string,
    timeoutMs: number,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: { stdout: boolean; stderr: boolean };
    durationMs: number;
  }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const finish = (code: number | null, signal: string | null, error?: SshError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve({
          exitCode: typeof code === "number" ? code : signal === null ? 0 : 1,
          stdout: stripControl(stdout),
          stderr: stripControl(stderr),
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
          durationMs: Date.now() - started,
        });
      };
      const timer = setTimeout(() => {
        try {
          client.end();
        } catch {
          // ignore
        }
        finish(null, null, new SshError("ssh_command_timeout", "The SSH command timed out"));
      }, timeoutMs);
      client.exec(command, { pty: false }, (error: Error | undefined, stream: ClientChannel) => {
        if (error) {
          finish(null, null, new SshError("ssh_transport_error", error.message));
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          const next = bounded(`${stdout}${chunk.toString("utf8")}`);
          stdout = next.value;
          stdoutTruncated = stdoutTruncated || next.truncated;
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          const next = bounded(`${stderr}${chunk.toString("utf8")}`);
          stderr = next.value;
          stderrTruncated = stderrTruncated || next.truncated;
        });
        stream.on("close", (code: number | null, signal: string | null) => {
          finish(code, signal);
        });
        stream.on("error", (streamError: Error) => {
          finish(null, null, new SshError("ssh_transport_error", streamError.message));
        });
      });
    });
  }

  private async uploadSftp(
    sftp: Awaited<ReturnType<typeof openSftp>>,
    target: string,
    data: Buffer,
    root: string | null,
  ): Promise<void> {
    const parent = path.posix.dirname(target);
    const realParent = await sftpCall<string>((resolve, reject) =>
      sftp.realpath(parent, (error, resolved) => (error ? reject(error) : resolve(resolved))),
    );
    if (root !== null && !remotePathInside(realParent, root)) {
      throw new SshError(
        "ssh_path_not_allowed",
        "The remote parent directory escapes the remote root",
      );
    }
    try {
      const stat = await sftpCall<{ isFile: () => boolean; isSymbolicLink: () => boolean }>(
        (resolve, reject) =>
          sftp.lstat(target, (error, attrs) => (error ? reject(error) : resolve(attrs))),
      );
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SshError("ssh_path_not_allowed", "The remote target is not a regular file");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such file|not found/i.test(message)) throw error;
    }
    const temp = `${target}.hanse-tmp-${randomUUID()}`;
    try {
      await sftpCall<void>((resolve, reject) =>
        sftp.writeFile(temp, data, { mode: 0o600 }, (error) => (error ? reject(error) : resolve())),
      );
      await sftpCall<void>((resolve, reject) =>
        sftp.rename(temp, target, (error) => (error ? reject(error) : resolve())),
      );
      await sftpCall<void>((resolve, reject) =>
        sftp.chmod(target, 0o600, (error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      await sftpCall<void>((resolve) => sftp.unlink(temp, () => resolve())).catch(() => undefined);
      throw error;
    }
  }

  private async downloadSftp(
    sftp: Awaited<ReturnType<typeof openSftp>>,
    target: string,
    root: string | null,
  ): Promise<Buffer> {
    const parent = path.posix.dirname(target);
    const realParent = await sftpCall<string>((resolve, reject) =>
      sftp.realpath(parent, (error, resolved) => (error ? reject(error) : resolve(resolved))),
    );
    if (root !== null && !remotePathInside(realParent, root)) {
      throw new SshError(
        "ssh_path_not_allowed",
        "The remote parent directory escapes the remote root",
      );
    }
    const stat = await sftpCall<{
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
      size: number;
    }>((resolve, reject) =>
      sftp.lstat(target, (error, attrs) => (error ? reject(error) : resolve(attrs))),
    );
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SshError("ssh_path_not_allowed", "The remote path is not a regular file");
    }
    if (stat.size > FILE_CAP_BYTES) {
      throw new SshError("ssh_file_too_large", "The remote file exceeds the 50 MiB limit");
    }
    return sftpCall<Buffer>((resolve, reject) =>
      sftp.readFile(target, (error, data) => (error ? reject(error) : resolve(data))),
    );
  }

  private startHostAudit(host: SshHost, action: string, startedAt: string): number {
    return this.#store.startAudit({
      appId: "",
      projectId: "",
      appKey: "",
      hostId: host.id,
      hostName: host.name,
      address: host.address,
      username: host.username,
      action,
      commandHash: null,
      commandPreview: null,
      approvalId: null,
      grantId: null,
      startedAt,
    });
  }

  private auditHost(
    host: SshHost,
    action: string,
    actor: string,
    detail: Record<string, unknown> | null,
  ): void {
    const now = iso(this.#now);
    const id = this.startHostAudit(host, action, now);
    this.#store.finishAudit(id, { finishedAt: now, detail: { actor, ...(detail ?? {}) } });
  }

  private async acquireSlot(hostId: string): Promise<void> {
    const deadline = Date.now() + this.#busyWaitMs;
    for (;;) {
      const host = this.#hostInflight.get(hostId) ?? 0;
      if (host < PER_HOST_INFLIGHT && this.#globalInflight < GLOBAL_INFLIGHT) {
        this.#hostInflight.set(hostId, host + 1);
        this.#globalInflight += 1;
        return;
      }
      if (Date.now() >= deadline) {
        throw new SshError("ssh_busy", "Too many SSH operations are in flight");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private releaseSlot(hostId: string): void {
    const host = this.#hostInflight.get(hostId) ?? 0;
    if (host <= 1) this.#hostInflight.delete(hostId);
    else this.#hostInflight.set(hostId, host - 1);
    this.#globalInflight = Math.max(0, this.#globalInflight - 1);
  }
}
