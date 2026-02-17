import { NextResponse } from "next/server";

import { JobStatus, writeJobStatus } from "@/lib/job";
import { startLiveSession } from "@/lib/server/liveSession";
import { requireAuthUser } from "@/lib/server/routeAuth";
import { getOrCreateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

type LiveStartBody = {
  currentGame?: string;
  thresholdScoreExclusive?: number;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: LiveStartBody;
  try {
    body = (await req.json()) as LiveStartBody;
  } catch {
    return jsonError("Invalid JSON body");
  }
  const currentGame = String(body.currentGame ?? "").trim();
  const threshold = Number(body.thresholdScoreExclusive ?? 80);

  const sessionId = `live_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const createdAt = Date.now();
  const profile = getOrCreateUserProfile(auth.user.id);
  const channelOrUrl = String(profile.twitchChannelUrl ?? "").trim();
  if (!channelOrUrl) {
    return jsonError("Set your Twitch channel in Settings > Profile before starting Live MVP.");
  }
  const status: JobStatus = {
    jobId: sessionId,
    type: "live",
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: auth.user.id, username: auth.user.username },
  };
  await writeJobStatus(status);
  setTimeout(
    () =>
      void startLiveSession({
        sessionId,
        userId: auth.user.id,
        channelOrUrl,
        currentGame,
        thresholdScoreExclusive: Number.isFinite(threshold) ? threshold : 80,
        longTermCacheText: profile.longTermCache,
        bots: profile.bots,
        emotes: profile.emotes,
      }),
    10,
  );

  return NextResponse.json({ ok: true, sessionId });
}
