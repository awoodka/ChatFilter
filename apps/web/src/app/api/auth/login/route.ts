import { NextResponse } from "next/server";

import {
  createSession,
  findUserByUsername,
  sanitizeUsername,
  sessionCookieConfig,
  validatePassword,
  verifyPassword,
} from "@/lib/server/auth";
import { getOrCreateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

type LoginBody = {
  username?: string;
  password?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: Request) {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return jsonError("Invalid JSON body.");
  }
  const username = sanitizeUsername(String(body.username ?? ""));
  const password = String(body.password ?? "");
  if (!username || !password) return jsonError("Username and password are required.");
  const passwordErr = validatePassword(password);
  if (passwordErr) return jsonError("Invalid credentials.", 401);

  const userRow = findUserByUsername(username);
  if (!userRow) return jsonError("Invalid credentials.", 401);

  const ok = await verifyPassword(password, userRow.password_hash);
  if (!ok) return jsonError("Invalid credentials.", 401);

  getOrCreateUserProfile(userRow.id);
  const session = createSession(userRow.id);
  const res = NextResponse.json({
    ok: true,
    user: { id: userRow.id, username: userRow.username, createdAt: userRow.created_at },
  });
  res.cookies.set(sessionCookieConfig(session.token, session.expiresAt));
  return res;
}
