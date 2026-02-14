import { NextResponse } from "next/server";

import { readJobStatus } from "@/lib/job";
import { readLiveFeed, readLiveLogTail, readLiveMetrics } from "@/lib/server/liveSession";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const auth = requireAuthUser(_req);
  if (auth.error) return auth.error;

  const { sessionId } = await params;
  if (!sessionId) return jsonError("Missing sessionId");

  const status = await readJobStatus(sessionId);
  if (!status) return jsonError("Session not found", 404);
  if (status.type !== "live") return jsonError("Not a live session", 400);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Session not found", 404);

  const [feed, metrics, logTail] = await Promise.all([readLiveFeed(sessionId), readLiveMetrics(sessionId), readLiveLogTail(sessionId)]);
  return NextResponse.json({
    ok: true,
    sessionId,
    status,
    chat: feed.chat,
    good: feed.good,
    metrics,
    logTail,
  });
}

