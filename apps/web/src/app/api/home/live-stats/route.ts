import { NextResponse } from "next/server";

import { readUserLiveMetricStats } from "@/lib/server/liveUserStats";
import { requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function parseIntParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const windowHours = parseIntParam(url.searchParams.get("windowHours"), 24);
  const bucketMinutes = parseIntParam(url.searchParams.get("bucketMinutes"), 60);
  const stats = readUserLiveMetricStats({
    userId: auth.user.id,
    windowHours,
    bucketMinutes,
  });
  return NextResponse.json({ ok: true, ...stats });
}
