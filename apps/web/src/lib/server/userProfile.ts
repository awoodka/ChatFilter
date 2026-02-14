import { getDb } from "@/lib/server/db";

export type UserProfile = {
  userId: string;
  longTermCache: string;
  bots: string[];
  emotes: string[];
  twitchChannelUrl: string;
  streamQuestionnaire: Record<string, string>;
  updatedAt: number;
};

const DEFAULT_LONG_TERM_CACHE = `Long-term streamer + audience profile (user-specific):
- Humor style preferences:
- Favorite recurring jokes / memes:
- Things to avoid / disliked patterns:
- Preferred reaction hooks:
`;

function safeJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, 200);
  } catch {
    return [];
  }
}

function normalizeList(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const value = raw.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 500) break;
  }
  return out;
}

function safeJsonRecord(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      const normalizedKey = key.trim();
      if (!normalizedKey) continue;
      out[normalizedKey] = value.trim();
      if (Object.keys(out).length >= 100) break;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeQuestionnaire(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof value !== "string") continue;
    out[normalizedKey] = value.trim();
    if (Object.keys(out).length >= 100) break;
  }
  return out;
}

export function defaultUserProfile(userId: string): UserProfile {
  return {
    userId,
    longTermCache: DEFAULT_LONG_TERM_CACHE,
    bots: [],
    emotes: [],
    twitchChannelUrl: "",
    streamQuestionnaire: {},
    updatedAt: Date.now(),
  };
}

export function getOrCreateUserProfile(userId: string): UserProfile {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT user_id, long_term_cache_json, bots_json, emotes_json, twitch_channel_url, stream_questionnaire_json, updated_at FROM user_profiles WHERE user_id = ? LIMIT 1",
    )
    .get(userId) as
    | {
        user_id: string;
        long_term_cache_json: string;
        bots_json: string;
        emotes_json: string;
        twitch_channel_url: string;
        stream_questionnaire_json: string;
        updated_at: number;
      }
    | undefined;

  if (!row) {
    const profile = defaultUserProfile(userId);
    db.prepare(
      `INSERT INTO user_profiles (user_id, long_term_cache_json, bots_json, emotes_json, twitch_channel_url, stream_questionnaire_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      profile.userId,
      profile.longTermCache,
      JSON.stringify(profile.bots),
      JSON.stringify(profile.emotes),
      profile.twitchChannelUrl,
      JSON.stringify(profile.streamQuestionnaire),
      profile.updatedAt,
    );
    return profile;
  }

  return {
    userId: row.user_id,
    longTermCache: row.long_term_cache_json,
    bots: safeJsonArray(row.bots_json),
    emotes: safeJsonArray(row.emotes_json),
    twitchChannelUrl: typeof row.twitch_channel_url === "string" ? row.twitch_channel_url : "",
    streamQuestionnaire: safeJsonRecord(row.stream_questionnaire_json),
    updatedAt: row.updated_at,
  };
}

export function updateUserProfile(profile: UserProfile): UserProfile {
  const db = getDb();
  const updated: UserProfile = {
    ...profile,
    bots: normalizeList(profile.bots),
    emotes: normalizeList(profile.emotes),
    streamQuestionnaire: normalizeQuestionnaire(profile.streamQuestionnaire),
    updatedAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO user_profiles (user_id, long_term_cache_json, bots_json, emotes_json, twitch_channel_url, stream_questionnaire_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       long_term_cache_json = excluded.long_term_cache_json,
       bots_json = excluded.bots_json,
       emotes_json = excluded.emotes_json,
       twitch_channel_url = excluded.twitch_channel_url,
       stream_questionnaire_json = excluded.stream_questionnaire_json,
       updated_at = excluded.updated_at`,
  ).run(
    updated.userId,
    updated.longTermCache,
    JSON.stringify(updated.bots),
    JSON.stringify(updated.emotes),
    updated.twitchChannelUrl.trim(),
    JSON.stringify(updated.streamQuestionnaire),
    updated.updatedAt,
  );
  return updated;
}
