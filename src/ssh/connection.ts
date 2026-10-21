import { Client, type ServerHostKeyAlgorithm, type SFTPWrapper } from "ssh2";
import { fingerprintOfBlob, hostKeyPublicText } from "./keys.js";
import { CONNECT_TIMEOUT_MS, SshError, type SshHost } from "./types.js";

export interface SshConnection {
  client: Client;
  presented: Buffer;
  presentedPin: { text: string; type: string; bits: number | null; fingerprint: string };
  banner?: string;
}

export interface ConnectOptions {
  host: SshHost;
  privateKey: string;
  ignorePin?: boolean;
  expectedFingerprint?: string | null;
}

const HOST_KEY_ALGORITHMS: ServerHostKeyAlgorithm[] = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
];

function mapConnectError(
  error: unknown,
  mismatch: boolean,
  presentedFingerprint?: string,
): SshError {
  if (mismatch) {
    return new SshError(
      "ssh_host_key_mismatch",
      "The remote host key does not match the pinned key",
      presentedFingerprint === undefined ? undefined : { presentedFingerprint },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) {
    return new SshError("ssh_connect_timeout", "The SSH connection timed out");
  }
  if (/authentication|permission denied|all configured authentication/i.test(message)) {
    return new SshError("ssh_auth_failed", "SSH authentication failed");
  }
  return new SshError("ssh_transport_error", message.length > 0 ? message : "SSH transport error");
}

export function connectSsh(options: ConnectOptions): Promise<SshConnection> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: Buffer | undefined;
    let banner: string | undefined;
    let mismatch = false;
    let presentedFingerprint: string | undefined;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      client.end();
      reject(mapConnectError(error, mismatch, presentedFingerprint));
    };

    client.on("banner", (message: string) => {
      banner = message;
    });
    client.on("error", fail);
    client.on("ready", () => {
      if (presented === undefined) {
        fail(new Error("the host did not present a key"));
        return;
      }
      if (settled) return;
      settled = true;
      resolve({
        client,
        presented,
        presentedPin: {
          ...hostKeyPublicText(presented),
          fingerprint: fingerprintOfBlob(presented),
        },
        ...(banner === undefined ? {} : { banner }),
      });
    });
    try {
      client.connect({
        host: options.host.address,
        port: options.host.port,
        username: options.host.username,
        privateKey: options.privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        tryKeyboard: false,
        algorithms: { serverHostKey: HOST_KEY_ALGORITHMS },
        hostVerifier: (key: Buffer) => {
          presented = Buffer.from(key);
          const fingerprint = fingerprintOfBlob(presented);
          presentedFingerprint = fingerprint;
          if (options.ignorePin === true) {
            return true;
          }
          const expected = options.expectedFingerprint ?? null;
          if (expected !== null && expected !== fingerprint) {
            mismatch = true;
            return false;
          }
          return true;
        },
      });
    } catch (error) {
      fail(error);
    }
  });
}

export function openSftp(client: Client, timeoutMs = CONNECT_TIMEOUT_MS): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SshError("ssh_connect_timeout", "The SFTP subsystem did not start")),
      timeoutMs,
    );
    client.sftp((error, sftp) => {
      clearTimeout(timer);
      if (error) {
        reject(new SshError("ssh_transport_error", error.message));
        return;
      }
      resolve(sftp);
    });
  });
}
