import fs from "node:fs/promises";
import { NextResponse } from "next/server";

import { jobLogPath, readJobStatus } from "@/lib/job";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = requireAuthUser(_req);
  if (auth.error) return auth.error;

  const { jobId } = await params;
  if (!jobId) return jsonError("Missing jobId");

  const status = await readJobStatus(jobId);
  if (!status) return jsonError("Job not found", 404);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Job not found", 404);

  let logTail = "";
  try {
    const log = await fs.readFile(jobLogPath(jobId), "utf-8");
    const lines = log.split("\n");
    logTail = lines.slice(Math.max(0, lines.length - 300)).join("\n");
  } catch {
    // ignore missing log
  }

  return NextResponse.json({ ok: true, status, logTail });
}

