import { NextResponse } from "next/server";

import { readJobStatus } from "@/lib/job";
import { getLiveContext } from "@/lib/server/liveContext";
import { readLatestLiveContextFile } from "@/lib/server/liveSession";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const { sessionId } = await params;
  if (!sessionId) return jsonError("Missing sessionId");

  const status = await readJobStatus(sessionId);
  if (!status) return jsonError("Session not found", 404);
  if (status.type !== "live") return jsonError("Not a live session", 400);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Session not found", 404);

  const [dbContext, latestContextFile] = await Promise.all([
    Promise.resolve(getLiveContext(auth.user.id, sessionId)),
    readLatestLiveContextFile(sessionId),
  ]);

  return NextResponse.json({
    ok: true,
    sessionId,
    dbContext,
    latestContextFile,
  });
}
