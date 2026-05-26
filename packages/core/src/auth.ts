import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export interface PasswordHash {
  algorithm: "scrypt";
  salt: string;
  hash: string;
  keyLength: number;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  assertPassword(password);
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  return {
    algorithm: "scrypt",
    salt,
    hash: derived.toString("base64url"),
    keyLength
  };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.algorithm !== "scrypt") {
    return false;
  }
  const derived = (await scrypt(password, stored.salt, stored.keyLength)) as Buffer;
  const expected = Buffer.from(stored.hash, "base64url");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function assertPassword(password: string): void {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
}
