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

export function getUserFeedbackPaginated(
  userId: string,
  opts?: { limit?: number; offset?: number; sessionId?: string },
): { rows: UserFeedbackRow[]; total: number } {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  const sessionId = opts?.sessionId?.trim() || null;

  const whereClause = sessionId
    ? "WHERE user_id = ? AND session_id = ?"
    : "WHERE user_id = ?";
  const params = sessionId ? [userId, sessionId] : [userId];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM user_feedback ${whereClause}`)
    .get(...params) as { cnt: number };

  const rows = db
    .prepare(`SELECT * FROM user_feedback ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as DbRow[];

  return { rows: rows.map(toRow), total: countRow.cnt };
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

export function getUserFeedbackAgreementStats(userId: string): {
  totalUp: number;
  totalDown: number;
  total: number;
  agreementRate: number | null;
  recentSessions: Array<{
    sessionId: string;
    up: number;
    down: number;
    rate: number;
    lastFeedbackAt: number;
  }>;
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
  const total = totalUp + totalDown;
  const agreementRate = total > 0 ? totalUp / total : null;

  const sessionRows = db
    .prepare(
      `SELECT session_id,
              SUM(CASE WHEN feedback = 'up' THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN feedback = 'down' THEN 1 ELSE 0 END) AS down,
              MAX(created_at) AS last_feedback_at
       FROM user_feedback
       WHERE user_id = ? AND session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY last_feedback_at DESC
       LIMIT 10`,
    )
    .all(userId) as Array<{ session_id: string; up: number; down: number; last_feedback_at: number }>;

  const recentSessions = sessionRows.map((r) => ({
    sessionId: r.session_id,
    up: r.up,
    down: r.down,
    rate: r.up + r.down > 0 ? r.up / (r.up + r.down) : 0,
    lastFeedbackAt: r.last_feedback_at,
  }));

  return { totalUp, totalDown, total, agreementRate, recentSessions };
}

export function computeCalibratedThreshold(userId: string): number | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT message_score, feedback FROM user_feedback
       WHERE user_id = ? AND message_score IS NOT NULL
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(userId) as Array<{ message_score: number; feedback: string }>;

  if (rows.length < 5) return null;

  const upScores = rows.filter((r) => r.feedback === "up").map((r) => r.message_score);
  const downScores = rows.filter((r) => r.feedback === "down").map((r) => r.message_score);

  if (downScores.length === 0) return null;

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const meanUp = upScores.length > 0 ? mean(upScores) : mean(downScores);
  const meanDown = mean(downScores);
  const calibrated = meanDown + 0.5 * (meanUp - meanDown);
  return Math.round(Math.min(95, Math.max(60, calibrated)));
}

export function getThresholdHistory(
  userId: string,
): Array<{ sessionId: string; threshold: number | null; lastFeedbackAt: number }> {
  const db = getDb();

  // Get distinct sessions ordered by their last feedback time
  const sessions = db
    .prepare(
      `SELECT session_id, MAX(created_at) AS last_feedback_at
       FROM user_feedback
       WHERE user_id = ? AND session_id IS NOT NULL AND message_score IS NOT NULL
       GROUP BY session_id
       ORDER BY last_feedback_at ASC`,
    )
    .all(userId) as Array<{ session_id: string; last_feedback_at: number }>;

  // For each session, compute cumulative calibrated threshold using all feedback up to that session
  return sessions.map((s) => {
    const rows = db
      .prepare(
        `SELECT message_score, feedback FROM user_feedback
         WHERE user_id = ? AND message_score IS NOT NULL AND created_at <= ?
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(userId, s.last_feedback_at) as Array<{ message_score: number; feedback: string }>;

    let threshold: number | null = null;
    if (rows.length >= 5) {
      const upScores = rows.filter((r) => r.feedback === "up").map((r) => r.message_score);
      const downScores = rows.filter((r) => r.feedback === "down").map((r) => r.message_score);
      if (downScores.length > 0) {
        const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const meanUp = upScores.length > 0 ? mean(upScores) : mean(downScores);
        const meanDown = mean(downScores);
        const calibrated = meanDown + 0.5 * (meanUp - meanDown);
        threshold = Math.round(Math.min(95, Math.max(60, calibrated)));
      }
    }

    return { sessionId: s.session_id, threshold, lastFeedbackAt: s.last_feedback_at };
  });
}

export function getSessionScoreDistribution(
  userId: string,
  sessionId: string,
): { buckets: Array<{ rangeStart: number; upCount: number; downCount: number }> } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT message_score, feedback FROM user_feedback
       WHERE user_id = ? AND session_id = ? AND message_score IS NOT NULL`,
    )
    .all(userId, sessionId) as Array<{ message_score: number; feedback: string }>;

  // Create 5-point bins from 60 to 100
  const bucketStarts = [60, 65, 70, 75, 80, 85, 90, 95];
  const buckets = bucketStarts.map((rangeStart) => ({ rangeStart, upCount: 0, downCount: 0 }));

  for (const r of rows) {
    const score = r.message_score;
    // Find the appropriate bucket
    let bucketIdx = bucketStarts.length - 1;
    for (let i = 0; i < bucketStarts.length - 1; i++) {
      if (score < bucketStarts[i + 1]!) {
        bucketIdx = i;
        break;
      }
    }
    if (r.feedback === "up") buckets[bucketIdx]!.upCount++;
    else buckets[bucketIdx]!.downCount++;
  }

  return { buckets };
}

export function getAllScoredFeedback(userId: string): Array<{ score: number; feedback: "up" | "down" }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT message_score, feedback FROM user_feedback
       WHERE user_id = ? AND message_score IS NOT NULL
       ORDER BY message_score ASC`,
    )
    .all(userId) as Array<{ message_score: number; feedback: string }>;
  return rows.map((r) => ({ score: r.message_score, feedback: r.feedback as "up" | "down" }));
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
