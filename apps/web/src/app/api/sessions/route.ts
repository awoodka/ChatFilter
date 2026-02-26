import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { listUserSessions } from "@/lib/server/sessionList";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const sessions = listUserSessions(auth.user.id);
  return NextResponse.json({ ok: true, sessions });
}
