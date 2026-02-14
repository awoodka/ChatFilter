import { NextResponse } from "next/server";

import {
  createSession,
  createUser,
  hashPassword,
  sanitizeUsername,
  sessionCookieConfig,
  validatePassword,
  validateUsername,
} from "@/lib/server/auth";
import { getOrCreateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

type SignupBody = {
  username?: string;
  password?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: Request) {
  let body: SignupBody;
  try {
    body = (await req.json()) as SignupBody;
  } catch {
    return jsonError("Invalid JSON body.");
  }

  const username = sanitizeUsername(String(body.username ?? ""));
  const password = String(body.password ?? "");

  const usernameErr = validateUsername(username);
  if (usernameErr) return jsonError(usernameErr, 400);
  const passwordErr = validatePassword(password);
  if (passwordErr) return jsonError(passwordErr, 400);

  const passwordHash = await hashPassword(password);
  try {
    const user = createUser({ username, passwordHash });
    getOrCreateUserProfile(user.id);
    const session = createSession(user.id);
    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, username: user.username, createdAt: user.createdAt },
    });
    res.cookies.set(sessionCookieConfig(session.token, session.expiresAt));
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("unique")) {
      return jsonError("Username already exists.", 409);
    }
    return jsonError("Failed to create account.", 500);
  }
}
