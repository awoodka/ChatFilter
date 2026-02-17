import { getDb } from "@/lib/server/db";

type TotalsInput = {
  seen: number;
  filtered: number;
  highlighted: number;
};

export type LiveMetricTotals = TotalsInput & {
  dropped: number;
  filteredOnly: number;
};

export type LiveMetricTimelinePoint = {
  tsMs: number;
  seen: number;
  filtered: number;
  highlighted: number;
};

export type UserLiveMetricStats = {
  windowHours: number;
  bucketMinutes: number;
  windowStartMs: number;
  windowEndMs: number;
  timeline: LiveMetricTimelinePoint[];
  totals: {
    window: LiveMetricTotals;
    allTime: LiveMetricTotals;
  };
};

function clampInt(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function normalizeTotals(input: TotalsInput): LiveMetricTotals {
  const seen = clampInt(input.seen);
  const filtered = Math.min(seen, clampInt(input.filtered));
  const highlighted = Math.min(filtered, clampInt(input.highlighted));
  return {
    seen,
    filtered,
    highlighted,
    dropped: Math.max(0, seen - filtered),
    filteredOnly: Math.max(0, filtered - highlighted),
  };
}

export function recordUserLiveMetricDeltas(input: {
  userId: string;
  sessionId: string;
  tsMs?: number;
  seenDelta: number;
  filteredDelta: number;
  highlightedDelta: number;
}): void {
  const seen = clampInt(input.seenDelta);
  const filtered = clampInt(input.filteredDelta);
  const highlighted = clampInt(input.highlightedDelta);
  if (seen <= 0 && filtered <= 0 && highlighted <= 0) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO user_live_metric_events
      (user_id, session_id, ts_ms, seen_delta, filtered_delta, highlighted_delta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.userId, input.sessionId, input.tsMs ?? Date.now(), seen, filtered, highlighted);
}

export function readUserLiveMetricStats(input: {
  userId: string;
  windowHours?: number;
  bucketMinutes?: number;
}): UserLiveMetricStats {
  const db = getDb();
  const windowHours = Math.max(1, Math.min(168, Math.floor(input.windowHours ?? 24)));
  const bucketMinutes = Math.max(5, Math.min(180, Math.floor(input.bucketMinutes ?? 60)));
  const nowMs = Date.now();
  const bucketMs = bucketMinutes * 60_000;
  const rawWindowStartMs = nowMs - windowHours * 60 * 60_000;
  const windowStartMs = Math.floor(rawWindowStartMs / bucketMs) * bucketMs;
  const bucketCount = Math.max(1, Math.ceil((nowMs - windowStartMs) / bucketMs));

  const timeline: LiveMetricTimelinePoint[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    timeline.push({
      tsMs: windowStartMs + i * bucketMs,
      seen: 0,
      filtered: 0,
      highlighted: 0,
    });
  }

  const rows = db
    .prepare(
      `SELECT ts_ms, seen_delta, filtered_delta, highlighted_delta
       FROM user_live_metric_events
       WHERE user_id = ? AND ts_ms >= ? AND ts_ms <= ?
       ORDER BY ts_ms ASC`,
    )
    .all(input.userId, windowStartMs, nowMs) as Array<{
    ts_ms: number;
    seen_delta: number;
    filtered_delta: number;
    highlighted_delta: number;
  }>;

  for (const row of rows) {
    const idx = Math.floor((Number(row.ts_ms) - windowStartMs) / bucketMs);
    if (idx < 0 || idx >= timeline.length) continue;
    const point = timeline[idx];
    if (!point) continue;
    point.seen += clampInt(Number(row.seen_delta));
    point.filtered += clampInt(Number(row.filtered_delta));
    point.highlighted += clampInt(Number(row.highlighted_delta));
  }

  const windowRaw: TotalsInput = timeline.reduce(
    (acc, point) => {
      acc.seen += point.seen;
      acc.filtered += point.filtered;
      acc.highlighted += point.highlighted;
      return acc;
    },
    { seen: 0, filtered: 0, highlighted: 0 },
  );

  const allTimeRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(seen_delta), 0) AS seen,
         COALESCE(SUM(filtered_delta), 0) AS filtered,
         COALESCE(SUM(highlighted_delta), 0) AS highlighted
       FROM user_live_metric_events
       WHERE user_id = ?`,
    )
    .get(input.userId) as { seen: number; filtered: number; highlighted: number } | undefined;

  return {
    windowHours,
    bucketMinutes,
    windowStartMs,
    windowEndMs: nowMs,
    timeline,
    totals: {
      window: normalizeTotals(windowRaw),
      allTime: normalizeTotals({
        seen: Number(allTimeRow?.seen ?? 0),
        filtered: Number(allTimeRow?.filtered ?? 0),
        highlighted: Number(allTimeRow?.highlighted ?? 0),
      }),
    },
  };
}
