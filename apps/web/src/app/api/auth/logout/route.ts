import { NextResponse } from "next/server";

import { clearSessionCookieConfig, parseSessionTokenFromCookieHeader, revokeSessionByToken } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const token = parseSessionTokenFromCookieHeader(req.headers.get("cookie"));
  if (token) revokeSessionByToken(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearSessionCookieConfig());
  return res;
}
