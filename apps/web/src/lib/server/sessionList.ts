import path from "node:path";

import { getDb } from "@/lib/server/db";
import { liveSessionDir, tailJsonl } from "@/lib/server/liveSession";

export type SessionListItem = {
  sessionId: string;
  channel: string;
  updatedAt: number;
  seen: number;
  filtered: number;
  highlighted: number;
};

export type SessionDetail = {
  sessionId: string;
  channel: string;
  updatedAt: number;
  counts: { seen: number; filtered: number; highlighted: number };
  goodMessages: Array<Record<string, unknown>>;
};

type SessionDbRow = {
  session_id: string;
  channel: string;
  updated_at: number;
  seen: number;
  filtered: number;
  highlighted: number;
};

export function listUserSessions(userId: string): SessionListItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT lc.session_id, lc.channel, lc.updated_at,
              COALESCE(SUM(m.seen_delta), 0) AS seen,
              COALESCE(SUM(m.filtered_delta), 0) AS filtered,
              COALESCE(SUM(m.highlighted_delta), 0) AS highlighted
       FROM live_contexts lc
       LEFT JOIN user_live_metric_events m
         ON m.user_id = lc.user_id AND m.session_id = lc.session_id
       WHERE lc.user_id = ?
       GROUP BY lc.session_id
       ORDER BY lc.updated_at DESC
       LIMIT 50`,
    )
    .all(userId) as SessionDbRow[];

  return rows.map((r) => ({
    sessionId: r.session_id,
    channel: r.channel,
    updatedAt: r.updated_at,
    seen: r.seen,
    filtered: r.filtered,
    highlighted: r.highlighted,
  }));
}

export async function getSessionDetail(userId: string, sessionId: string): Promise<SessionDetail | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT session_id, channel, updated_at FROM live_contexts WHERE user_id = ? AND session_id = ? LIMIT 1")
    .get(userId, sessionId) as { session_id: string; channel: string; updated_at: number } | undefined;

  if (!row) return null;

  const goodPath = path.join(liveSessionDir(sessionId), "good.jsonl");
  const goodMessages = await tailJsonl(goodPath, 200);

  // Try to read metrics
  let counts = { seen: 0, filtered: 0, highlighted: 0 };
  const metricRow = db
    .prepare(
      `SELECT COALESCE(SUM(seen_delta), 0) AS seen,
              COALESCE(SUM(filtered_delta), 0) AS filtered,
              COALESCE(SUM(highlighted_delta), 0) AS highlighted
       FROM user_live_metric_events
       WHERE user_id = ? AND session_id = ?`,
    )
    .get(userId, sessionId) as { seen: number; filtered: number; highlighted: number } | undefined;
  if (metricRow) {
    counts = { seen: metricRow.seen, filtered: metricRow.filtered, highlighted: metricRow.highlighted };
  }

  return {
    sessionId: row.session_id,
    channel: row.channel,
    updatedAt: row.updated_at,
    counts,
    goodMessages,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function extractContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;
  const message = firstChoice["message"];
  if (!isRecord(message)) return null;
  return typeof message["content"] === "string" ? message["content"].trim() : null;
}

export async function generateSessionSummary(goodMessages: Array<Record<string, unknown>>): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  // Take top 20 messages by score
  const sorted = [...goodMessages]
    .filter((m) => typeof m["score"] === "number")
    .sort((a, b) => (Number(b["score"]) || 0) - (Number(a["score"]) || 0))
    .slice(0, 20);

  const messagesPayload = sorted.map((m) => ({
    username: m["username"] ?? "unknown",
    text: m["text"] ?? "",
    score: m["score"],
    reason: m["reason"] ?? "",
  }));

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Given highlighted Twitch chat messages from a stream session, produce a 3-5 bullet recap summarizing the key moments, themes, and standout messages. Be concise and specific.",
        },
        { role: "user", content: JSON.stringify(messagesPayload) },
      ],
      max_tokens: 400,
    }),
  });

  const payload = (await response.json()) as unknown;
  const content = extractContent(payload);
  if (!content) throw new Error("Failed to generate summary");
  return content;
}
