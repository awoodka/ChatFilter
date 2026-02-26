import { NextResponse } from "next/server";

import { readJobStatus } from "@/lib/job";
import { updateLiveSessionThreshold } from "@/lib/server/liveSession";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: { sessionId?: string; threshold?: number };
  try {
    body = (await req.json()) as { sessionId?: string; threshold?: number };
  } catch {
    return jsonError("Invalid JSON body");
  }

  const sessionId = String(body.sessionId ?? "").trim();
  if (!sessionId) return jsonError("Missing sessionId");

  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return jsonError("Invalid threshold (0-100)");
  }

  const status = await readJobStatus(sessionId);
  if (!status) return jsonError("Session not found", 404);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Session not found", 404);

  const updated = updateLiveSessionThreshold(sessionId, threshold);
  if (!updated) return jsonError("Session runner not active", 404);

  return NextResponse.json({ ok: true, threshold });
}
