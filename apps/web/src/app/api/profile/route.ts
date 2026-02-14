import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { getOrCreateUserProfile, updateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

type ProfileUpdateBody = {
  twitchChannelUrl?: string;
  bots?: string[];
  emotes?: string[];
  longTermCache?: string;
  streamQuestionnaire?: Record<string, string>;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function normalizeTwitchChannelOrUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  const m = withoutAt.match(/^https?:\/\/(www\.)?twitch\.tv\/([a-zA-Z0-9_]+)\/?$/i);
  if (m?.[2]) return `https://www.twitch.tv/${m[2].toLowerCase()}`;
  return withoutAt.toLowerCase();
}

function isValidTwitchChannelOrUrl(value: string): boolean {
  if (!value) return true;
  if (/^[a-zA-Z0-9_]{3,25}$/.test(value)) return true;
  return /^https?:\/\/(www\.)?twitch\.tv\/[a-zA-Z0-9_]{3,25}\/?$/i.test(value);
}

function parseStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    out.push(v);
    if (out.length >= 500) break;
  }
  return out;
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    const k = key.trim();
    if (!k) continue;
    out[k] = item.trim();
    if (Object.keys(out).length >= 100) break;
  }
  return out;
}

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;
  const profile = getOrCreateUserProfile(auth.user.id);
  return NextResponse.json({
    ok: true,
    profile: {
      twitchChannelUrl: profile.twitchChannelUrl,
      bots: profile.bots,
      emotes: profile.emotes,
      longTermCache: profile.longTermCache,
      streamQuestionnaire: profile.streamQuestionnaire,
      updatedAt: profile.updatedAt,
    },
  });
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: ProfileUpdateBody;
  try {
    body = (await req.json()) as ProfileUpdateBody;
  } catch {
    return jsonError("Invalid JSON body.");
  }

  const profile = getOrCreateUserProfile(auth.user.id);
  const twitchChannelUrl = normalizeTwitchChannelOrUrl(String(body.twitchChannelUrl ?? profile.twitchChannelUrl ?? ""));
  if (!isValidTwitchChannelOrUrl(twitchChannelUrl)) {
    return jsonError("Enter a valid Twitch channel (e.g. ludwig) or Twitch URL.");
  }
  const bots = body.bots === undefined ? profile.bots : parseStringList(body.bots);
  if (bots === null) return jsonError("bots must be an array of strings.");
  const emotes = body.emotes === undefined ? profile.emotes : parseStringList(body.emotes);
  if (emotes === null) return jsonError("emotes must be an array of strings.");
  const longTermCache =
    body.longTermCache === undefined
      ? profile.longTermCache
      : typeof body.longTermCache === "string"
        ? body.longTermCache
        : null;
  if (longTermCache === null) return jsonError("longTermCache must be a string.");
  const streamQuestionnaire =
    body.streamQuestionnaire === undefined ? profile.streamQuestionnaire : parseStringRecord(body.streamQuestionnaire);
  if (streamQuestionnaire === null) return jsonError("streamQuestionnaire must be an object of string values.");
  const updated = updateUserProfile({
    ...profile,
    twitchChannelUrl,
    bots,
    emotes,
    longTermCache,
    streamQuestionnaire,
  });
  return NextResponse.json({
    ok: true,
    profile: {
      twitchChannelUrl: updated.twitchChannelUrl,
      bots: updated.bots,
      emotes: updated.emotes,
      longTermCache: updated.longTermCache,
      streamQuestionnaire: updated.streamQuestionnaire,
      updatedAt: updated.updatedAt,
    },
  });
}
