import { NextResponse } from "next/server";

import { parseSessionTokenFromCookieHeader, validateSessionToken } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const token = parseSessionTokenFromCookieHeader(req.headers.get("cookie"));
  if (!token) return NextResponse.json({ ok: true, authenticated: false });
  const validation = validateSessionToken(token);
  if (!validation) return NextResponse.json({ ok: true, authenticated: false });
  return NextResponse.json({ ok: true, authenticated: true, user: validation.user });
}
