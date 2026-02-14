import crypto from "node:crypto";

import { hash, verify } from "@node-rs/argon2";

import { getDb } from "@/lib/server/db";

export const SESSION_COOKIE_NAME = "chatfilter_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export type AuthUser = {
  id: string;
  username: string;
  createdAt: number;
};

type DbUserRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
};

type DbSessionWithUserRow = {
  session_id: string;
  user_id: string;
  username: string;
  created_at: number;
  expires_at: number;
};

export type SessionValidationResult = {
  user: AuthUser;
  sessionId: string;
  expiresAt: number;
};

export function sanitizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(username: string): string | null {
  if (username.length < 3) return "Username must be at least 3 characters.";
  if (username.length > 32) return "Username must be 32 characters or less.";
  if (!/^[a-z0-9_]+$/.test(username)) {
    return "Username can only use lowercase letters, numbers, and underscores.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password must be 128 characters or less.";
  return null;
}

function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function sessionExpiresAtMs(): number {
  return Date.now() + SESSION_TTL_MS;
}

export async function hashPassword(password: string): Promise<string> {
  return await hash(password, {
    algorithm: 2, // Argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return await verify(passwordHash, password);
}

export function createUser(opts: { username: string; passwordHash: string }): AuthUser {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, opts.username, opts.passwordHash, now, now);
  return { id, username: opts.username, createdAt: now };
}

export function findUserByUsername(username: string): DbUserRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, username, password_hash, created_at, updated_at FROM users WHERE username = ? LIMIT 1")
    .get(username) as DbUserRow | undefined;
  return row ?? null;
}

export function getUserById(userId: string): AuthUser | null {
  const db = getDb();
  const row = db.prepare("SELECT id, username, created_at FROM users WHERE id = ? LIMIT 1").get(userId) as
    | { id: string; username: string; created_at: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export function createSession(userId: string): { token: string; sessionId: string; expiresAt: number } {
  const db = getDb();
  const sessionId = crypto.randomUUID();
  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = Date.now();
  const expiresAt = sessionExpiresAtMs();
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, userId, tokenHash, expiresAt, createdAt);
  return { token, sessionId, expiresAt };
}

export function revokeSessionByToken(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

export function revokeSessionsForUser(userId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteExpiredSessions(): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

export function validateSessionToken(token: string): SessionValidationResult | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.expires_at, u.username, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
       LIMIT 1`,
    )
    .get(hashSessionToken(token)) as DbSessionWithUserRow | undefined;

  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }

  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      username: row.username,
      createdAt: row.created_at,
    },
  };
}

export function parseSessionTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((x) => x.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(idx + 1).trim();
    return value || null;
  }
  return null;
}

export function getAuthUserFromRequest(request: Request): AuthUser | null {
  const cookieHeader = request.headers.get("cookie");
  const token = parseSessionTokenFromCookieHeader(cookieHeader);
  if (!token) return null;
  return validateSessionToken(token)?.user ?? null;
}

export function sessionCookieConfig(token: string, expiresAt: number) {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  };
}

export function clearSessionCookieConfig() {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  };
}

export function readUserIdFromJobMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const userId = meta["userId"];
  return typeof userId === "string" ? userId : null;
}
