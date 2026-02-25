import { getDb } from "@/lib/server/db";

export type LiveContext = {
  vibe?: string;
  currentGame: string;
  recentEvents: string[];
  streamStats: {
    msgsPerMin: number;
    uniqueChattersApprox: number;
    keptRate: number;
    highlightRate: number;
  };
  recentChatSample: string[];
  visualContext?: string;
  detectedGame?: string;
  updatedAtMs: number;
};

const MAX_EVENT_ITEMS = 5;
const MAX_CHAT_SAMPLES = 5;
const MAX_EVENT_LEN = 220;
const MAX_CHAT_LEN = 220;
const MAX_VIBE_LEN = 180;
const MAX_GAME_LEN = 120;
const MAX_VISUAL_CONTEXT_LEN = 500;

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function sanitizeLines(items: string[], maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const value = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseLiveContextJson(text: string): LiveContext | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const statsRaw = rec["streamStats"];
    if (typeof statsRaw !== "object" || statsRaw === null) return null;
    const stats = statsRaw as Record<string, unknown>;
    const currentGame = typeof rec["currentGame"] === "string" ? rec["currentGame"] : "";
    const recentEvents = Array.isArray(rec["recentEvents"])
      ? rec["recentEvents"].filter((x): x is string => typeof x === "string")
      : [];
    const recentChatSample = Array.isArray(rec["recentChatSample"])
      ? rec["recentChatSample"].filter((x): x is string => typeof x === "string")
      : [];
    return normalizeLiveContext({
      vibe: typeof rec["vibe"] === "string" ? rec["vibe"] : undefined,
      currentGame,
      recentEvents,
      streamStats: {
        msgsPerMin: Number(stats["msgsPerMin"] ?? 0),
        uniqueChattersApprox: Number(stats["uniqueChattersApprox"] ?? 0),
        keptRate: Number(stats["keptRate"] ?? 0),
        highlightRate: Number(stats["highlightRate"] ?? 0),
      },
      recentChatSample,
      visualContext: typeof rec["visualContext"] === "string" ? rec["visualContext"] : undefined,
      detectedGame: typeof rec["detectedGame"] === "string" ? rec["detectedGame"] : undefined,
      updatedAtMs: Number(rec["updatedAtMs"] ?? Date.now()),
    });
  } catch {
    return null;
  }
}

export function normalizeLiveContext(input: LiveContext): LiveContext {
  return {
    vibe: input.vibe?.trim().slice(0, MAX_VIBE_LEN) || undefined,
    currentGame: String(input.currentGame ?? "").trim().slice(0, MAX_GAME_LEN),
    recentEvents: sanitizeLines(input.recentEvents ?? [], MAX_EVENT_ITEMS, MAX_EVENT_LEN),
    streamStats: {
      msgsPerMin: Math.max(0, Number(input.streamStats.msgsPerMin) || 0),
      uniqueChattersApprox: Math.max(0, Math.floor(Number(input.streamStats.uniqueChattersApprox) || 0)),
      keptRate: clampPercent(Number(input.streamStats.keptRate)),
      highlightRate: clampPercent(Number(input.streamStats.highlightRate)),
    },
    recentChatSample: sanitizeLines(input.recentChatSample ?? [], MAX_CHAT_SAMPLES, MAX_CHAT_LEN),
    visualContext: input.visualContext?.trim().slice(0, MAX_VISUAL_CONTEXT_LEN) || undefined,
    detectedGame: input.detectedGame?.trim().slice(0, MAX_GAME_LEN) || undefined,
    updatedAtMs: Number.isFinite(input.updatedAtMs) ? input.updatedAtMs : Date.now(),
  };
}

export function getLiveContext(userId: string, sessionId: string): LiveContext | null {
  const db = getDb();
  const row = db
    .prepare("SELECT live_context_json FROM live_contexts WHERE user_id = ? AND session_id = ? LIMIT 1")
    .get(userId, sessionId) as { live_context_json: string } | undefined;
  if (!row?.live_context_json) return null;
  return parseLiveContextJson(row.live_context_json);
}

export function upsertLiveContext(userId: string, sessionId: string, channel: string, context: LiveContext): LiveContext {
  const db = getDb();
  const normalized = normalizeLiveContext(context);
  const updatedAt = Date.now();
  db.prepare(
    `INSERT INTO live_contexts (user_id, session_id, channel, live_context_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       channel = excluded.channel,
       live_context_json = excluded.live_context_json,
       updated_at = excluded.updated_at`,
  ).run(userId, sessionId, channel, JSON.stringify(normalized), updatedAt);
  return normalized;
}
