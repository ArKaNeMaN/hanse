import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface Sealed {
  cipher: string;
  nonce: string;
}

export function loadOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    if (!lstatSync(keyPath).isFile()) {
      throw new Error("secret key must be a regular file");
    }
    const key = readFileSync(keyPath);
    if (key.length !== KEY_BYTES) {
      throw new Error(`secret key must be ${KEY_BYTES} bytes`);
    }
    // Enforce the expected mode on legacy/restored files; creation below already sets it.
    chmodSync(keyPath, 0o600);
    return key;
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}

export function seal(key: Buffer, plaintext: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: Buffer.concat([encrypted, tag]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

export function open(key: Buffer, sealed: Sealed): string {
  const data = Buffer.from(sealed.cipher, "base64");
  const tag = data.subarray(data.length - 16);
  const encrypted = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
