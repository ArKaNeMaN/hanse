import type { SqliteDatabase } from "../store/index.js";
import { type Principal, type PrincipalKind, verifyToken } from "./principals.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function authenticate(db: SqliteDatabase, authorization: string | undefined): Principal {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (token === undefined || token.length === 0) {
    throw new AuthError("missing bearer token");
  }
  const principal = verifyToken(db, token);
  if (principal === undefined) {
    throw new AuthError("invalid token");
  }
  return principal;
}

export function requireKind(principal: Principal, kinds: readonly PrincipalKind[]): void {
  if (!kinds.includes(principal.kind)) {
    throw new AuthError(`principal "${principal.name}" (${principal.kind}) is not permitted`);
  }
}
