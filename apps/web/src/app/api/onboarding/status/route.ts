import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { defaultUserProfile, getOrCreateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const profile = getOrCreateUserProfile(auth.user.id);
  const defaults = defaultUserProfile(auth.user.id);

  const hasTwitchChannel = profile.twitchChannelUrl.trim().length > 0;
  const hasQuestionnaire = Object.values(profile.streamQuestionnaire).some((v) => v.trim().length > 0);
  const hasProfile = profile.longTermCache !== defaults.longTermCache;

  return NextResponse.json({
    ok: true,
    steps: { hasTwitchChannel, hasQuestionnaire, hasProfile },
  });
}
