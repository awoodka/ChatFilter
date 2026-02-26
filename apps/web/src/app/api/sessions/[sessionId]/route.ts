import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { generateSessionSummary, getSessionDetail } from "@/lib/server/sessionList";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Missing sessionId" }, { status: 400 });
  }

  const session = await getSessionDetail(auth.user.id, sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const wantSummary = url.searchParams.get("summary") === "true";

  if (wantSummary) {
    try {
      const summary = await generateSessionSummary(session.goodMessages);
      return NextResponse.json({ ok: true, session, summary });
    } catch (err: unknown) {
      return NextResponse.json({
        ok: true,
        session,
        summaryError: err instanceof Error ? err.message : "Failed to generate summary",
      });
    }
  }

  return NextResponse.json({ ok: true, session });
}
