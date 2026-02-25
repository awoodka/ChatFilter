import { getDb } from "@/lib/server/db";
import { getOrCreateUserProfile, updateUserProfile } from "@/lib/server/userProfile";

export type UserFeedbackRow = {
  id: number;
  userId: string;
  tsMs: number;
  messageText: string;
  messageUsername: string | null;
  messageScore: number | null;
  messageReason: string | null;
  messageRelevance: number | null;
  messageHumor: number | null;
  messageEngagement: number | null;
  feedback: "up" | "down";
  sessionId: string | null;
  createdAt: number;
};

type InsertInput = {
  userId: string;
  tsMs: number;
  messageText: string;
  messageUsername?: string | null;
  messageScore?: number | null;
  messageReason?: string | null;
  messageRelevance?: number | null;
  messageHumor?: number | null;
  messageEngagement?: number | null;
  feedback: "up" | "down";
  sessionId?: string | null;
};

type DbRow = {
  id: number;
  user_id: string;
  ts_ms: number;
  message_text: string;
  message_username: string | null;
  message_score: number | null;
  message_reason: string | null;
  message_relevance: number | null;
  message_humor: number | null;
  message_engagement: number | null;
  feedback: string;
  session_id: string | null;
  created_at: number;
};

function toRow(r: DbRow): UserFeedbackRow {
  return {
    id: r.id,
    userId: r.user_id,
    tsMs: r.ts_ms,
    messageText: r.message_text,
    messageUsername: r.message_username,
    messageScore: r.message_score,
    messageReason: r.message_reason,
    messageRelevance: r.message_relevance,
    messageHumor: r.message_humor,
    messageEngagement: r.message_engagement,
    feedback: r.feedback as "up" | "down",
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export function insertUserFeedback(input: InsertInput): UserFeedbackRow {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO user_feedback
        (user_id, ts_ms, message_text, message_username, message_score, message_reason,
         message_relevance, message_humor, message_engagement, feedback, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.tsMs,
      input.messageText,
      input.messageUsername ?? null,
      input.messageScore ?? null,
      input.messageReason ?? null,
      input.messageRelevance ?? null,
      input.messageHumor ?? null,
      input.messageEngagement ?? null,
      input.feedback,
      input.sessionId ?? null,
      now,
    );
  const row = db.prepare("SELECT * FROM user_feedback WHERE id = ?").get(result.lastInsertRowid) as DbRow;
  return toRow(row);
}

export function getUserFeedbackExamples(
  userId: string,
  opts?: { upLimit?: number; downLimit?: number },
): { upvoted: UserFeedbackRow[]; downvoted: UserFeedbackRow[] } {
  const db = getDb();
  const upLimit = opts?.upLimit ?? 10;
  const downLimit = opts?.downLimit ?? 5;

  const upRows = db
    .prepare(
      `SELECT * FROM user_feedback
       WHERE user_id = ? AND feedback = 'up'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, upLimit) as DbRow[];

  const downRows = db
    .prepare(
      `SELECT * FROM user_feedback
       WHERE user_id = ? AND feedback = 'down'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, downLimit) as DbRow[];

  return {
    upvoted: upRows.map(toRow),
    downvoted: downRows.map(toRow),
  };
}

const MAX_SECTION_EXAMPLES = 5;

function findSectionRange(text: string, header: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === header.toLowerCase());
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? "";
    if (!trimmed) continue;
    if (!trimmed.startsWith("-") && /^[A-Za-z].*:\s*$/.test(trimmed)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function extractSectionExamples(text: string, header: string): string[] {
  const range = findSectionRange(text, header);
  if (!range) return [];
  return text
    .split("\n")
    .slice(range.start + 1, range.end)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^-+\s*/, ""));
}

function upsertSection(longTermCache: string, header: string, examples: string[]): string {
  const sectionLines = [header, ...examples.map((l) => `- ${l}`)];
  const lines = longTermCache.split("\n");
  const range = findSectionRange(longTermCache, header);

  if (range) {
    const before = lines.slice(0, range.start);
    const after = lines.slice(range.end);
    if (examples.length === 0) {
      return [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    return [...before, ...sectionLines, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (examples.length === 0) return longTermCache;
  const trimmed = longTermCache.trim();
  if (!trimmed) return sectionLines.join("\n");
  return `${trimmed}\n\n${sectionLines.join("\n")}`.trim();
}

function pushChatExample(userId: string, messageText: string, header: string): void {
  const profile = getOrCreateUserProfile(userId);
  const existing = extractSectionExamples(profile.longTermCache, header);
  const cleaned = messageText.trim().replace(/\s+/g, " ");
  if (!cleaned) return;
  const filtered = existing.filter((e) => e !== cleaned);
  const updated = [cleaned, ...filtered].slice(0, MAX_SECTION_EXAMPLES);
  const newCache = upsertSection(profile.longTermCache, header, updated);
  updateUserProfile({ ...profile, longTermCache: newCache });
}

export function pushGoodChatExample(userId: string, messageText: string): void {
  pushChatExample(userId, messageText, "Good chat examples:");
}

export function pushBadChatExample(userId: string, messageText: string): void {
  pushChatExample(userId, messageText, "Bad chat examples:");
}

export function getUserFeedbackSummary(userId: string): {
  totalUp: number;
  totalDown: number;
  recentUpTexts: string[];
  recentDownTexts: string[];
} {
  const db = getDb();

  const counts = db
    .prepare(
      `SELECT feedback, COUNT(*) AS cnt FROM user_feedback
       WHERE user_id = ? GROUP BY feedback`,
    )
    .all(userId) as Array<{ feedback: string; cnt: number }>;

  const totalUp = counts.find((c) => c.feedback === "up")?.cnt ?? 0;
  const totalDown = counts.find((c) => c.feedback === "down")?.cnt ?? 0;

  const recentUp = db
    .prepare(
      `SELECT message_text FROM user_feedback
       WHERE user_id = ? AND feedback = 'up'
       ORDER BY created_at DESC LIMIT 10`,
    )
    .all(userId) as Array<{ message_text: string }>;

  const recentDown = db
    .prepare(
      `SELECT message_text FROM user_feedback
       WHERE user_id = ? AND feedback = 'down'
       ORDER BY created_at DESC LIMIT 10`,
    )
    .all(userId) as Array<{ message_text: string }>;

  return {
    totalUp,
    totalDown,
    recentUpTexts: recentUp.map((r) => r.message_text),
    recentDownTexts: recentDown.map((r) => r.message_text),
  };
}
