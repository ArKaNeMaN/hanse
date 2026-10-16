import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SqliteDatabase } from "../store/index.js";

export type PrincipalKind = "human" | "agent" | "system";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  name: string;
  createdAt: string;
}

export interface CreatedPrincipal {
  principal: Principal;
  token: string;
}

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  name: string;
  secret_hash: string | null;
  created_at: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHashes(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function rowToPrincipal(row: PrincipalRow): Principal {
  return { id: row.id, kind: row.kind, name: row.name, createdAt: row.created_at };
}

export function createPrincipal(
  db: SqliteDatabase,
  input: { kind: PrincipalKind; name: string },
): CreatedPrincipal {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO principals (id, kind, name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.kind, input.name, hashToken(token), createdAt);
  return { principal: { id, kind: input.kind, name: input.name, createdAt }, token };
}

export function getPrincipal(db: SqliteDatabase, id: string): Principal | undefined {
  const row = db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as
    | PrincipalRow
    | undefined;
  return row === undefined ? undefined : rowToPrincipal(row);
}

export function listPrincipals(db: SqliteDatabase): Principal[] {
  return (db.prepare("SELECT * FROM principals ORDER BY created_at").all() as PrincipalRow[]).map(
    rowToPrincipal,
  );
}

export function verifyToken(db: SqliteDatabase, token: string): Principal | undefined {
  const hashed = hashToken(token);
  const rows = db.prepare("SELECT * FROM principals").all() as PrincipalRow[];
  for (const row of rows) {
    if (row.secret_hash !== null && equalHashes(row.secret_hash, hashed)) {
      return rowToPrincipal(row);
    }
  }
  return undefined;
}
