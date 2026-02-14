import { NextResponse } from "next/server";

import { appendJobLog, readJobStatus, writeJobStatus } from "@/lib/job";
import { requestStopLiveSession } from "@/lib/server/liveSession";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function tsLine(line: string) {
  return `[${new Date().toISOString()}] ${line}\n`;
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: { sessionId?: string };
  try {
    body = (await req.json()) as { sessionId?: string };
  } catch {
    return jsonError("Invalid JSON body");
  }
  const sessionId = String(body.sessionId ?? "").trim();
  if (!sessionId) return jsonError("Missing sessionId");

  const status = await readJobStatus(sessionId);
  if (!status) return jsonError("Session not found", 404);
  if (status.type !== "live") return jsonError("Not a live session", 400);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Session not found", 404);

  const requested = await requestStopLiveSession(sessionId);
  await appendJobLog(sessionId, tsLine("stop requested"));
  await writeJobStatus({ ...status, updatedAt: Date.now(), step: "stopping" });
  return NextResponse.json({ ok: true, sessionId, stopRequested: requested });
}

