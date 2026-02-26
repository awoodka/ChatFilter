import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { getUserFeedbackPaginated } from "@/lib/server/userFeedback";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const sessionId = url.searchParams.get("sessionId") || undefined;

  const result = getUserFeedbackPaginated(auth.user.id, { limit, offset, sessionId });

  return NextResponse.json({ ok: true, rows: result.rows, total: result.total });
}
