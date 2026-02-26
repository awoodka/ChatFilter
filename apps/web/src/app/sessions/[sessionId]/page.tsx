"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const NAME_COLORS = [
  "#58a6ff",
  "#9f7aea",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#22d3ee",
  "#a3e635",
  "#fb7185",
  "#c084fc",
];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function colorForName(username: string | null): string {
  if (!username) return "#adadb8";
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length] ?? NAME_COLORS[0]!;
}

function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

type GoodMessage = {
  ts_ms: number;
  username: string | null;
  text: string;
  score: number | null;
  reason: string | null;
};

type SessionDetail = {
  sessionId: string;
  channel: string;
  updatedAt: number;
  counts: { seen: number; filtered: number; highlighted: number };
  goodMessages: GoodMessage[];
};

export default function SessionDetailPage() {
  const params = useParams();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (cancelled || !isRecord(j) || j["ok"] !== true || !isRecord(j["session"])) return;
        const s = j["session"] as Record<string, unknown>;
        const counts = isRecord(s["counts"]) ? s["counts"] as Record<string, unknown> : {};
        const rawGood = Array.isArray(s["goodMessages"]) ? s["goodMessages"] : [];
        const goodMessages: GoodMessage[] = rawGood.filter(isRecord).map((m: Record<string, unknown>) => ({
          ts_ms: Number(m["ts_ms"] ?? 0),
          username: typeof m["username"] === "string" ? m["username"] : null,
          text: String(m["text"] ?? ""),
          score: typeof m["score"] === "number" ? m["score"] : null,
          reason: typeof m["reason"] === "string" ? m["reason"] : null,
        }));
        if (!cancelled) {
          setSession({
            sessionId: String(s["sessionId"] ?? ""),
            channel: String(s["channel"] ?? ""),
            updatedAt: Number(s["updatedAt"] ?? 0),
            counts: {
              seen: Number(counts["seen"] ?? 0),
              filtered: Number(counts["filtered"] ?? 0),
              highlighted: Number(counts["highlighted"] ?? 0),
            },
            goodMessages,
          });
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const handleGenerateSummary = async () => {
    if (!sessionId) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?summary=true`, { cache: "no-store" });
      const j = (await r.json()) as unknown;
      if (!isRecord(j)) {
        setSummaryError("Failed to generate summary");
        return;
      }
      if (typeof j["summary"] === "string") {
        setSummary(j["summary"]);
      } else if (typeof j["summaryError"] === "string") {
        setSummaryError(j["summaryError"]);
      } else {
        setSummaryError("Failed to generate summary");
      }
    } catch (err: unknown) {
      setSummaryError(err instanceof Error ? err.message : "Failed to generate summary");
    } finally {
      setSummaryLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="twitch-page">
        <div className="twitch-shell max-w-4xl">
          <div className="text-sm twitch-muted">Loading session...</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="twitch-page">
        <div className="twitch-shell max-w-4xl">
          <div className="text-sm text-amber-300">Session not found.</div>
          <Link className="twitch-link mt-2 inline-block text-sm" href="/sessions">Back to sessions</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-4xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{session.channel || "Session"}</h1>
          <Link className="twitch-button-secondary inline-flex !h-8 items-center !text-xs" href="/sessions">
            Back to sessions
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span>
            {new Date(session.updatedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
            {" \u00b7 "}
            {new Date(session.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span>Seen: <span className="font-semibold text-blue-300">{formatCount(session.counts.seen)}</span></span>
          <span>Filtered: <span className="font-semibold text-[#cab0ff]">{formatCount(session.counts.filtered)}</span></span>
          <span>Highlighted: <span className="font-semibold text-emerald-300">{formatCount(session.counts.highlighted)}</span></span>
        </div>

        {summary ? (
          <div className="twitch-card-soft mt-4 p-4">
            <div className="mb-1 text-xs font-medium text-zinc-200">AI Session Summary</div>
            <div className="whitespace-pre-wrap text-sm text-zinc-300">{summary}</div>
          </div>
        ) : (
          <div className="mt-4">
            <button
              className="twitch-button-secondary !text-xs"
              disabled={summaryLoading}
              onClick={handleGenerateSummary}
            >
              {summaryLoading ? "Generating summary..." : "Generate Summary"}
            </button>
            {summaryError ? <div className="mt-1 text-xs text-amber-300">{summaryError}</div> : null}
          </div>
        )}

        <div className="twitch-card mt-5 overflow-hidden">
          <div className="border-b border-[var(--border)] bg-[#111118] px-4 py-3">
            <div className="text-sm font-semibold uppercase tracking-wide text-zinc-200">
              Highlighted messages ({session.goodMessages.length})
            </div>
          </div>
          <div className="max-h-[72vh] overflow-auto bg-[#0b0b10] px-2 py-2">
            {session.goodMessages.length === 0 ? (
              <div className="p-3 text-sm text-zinc-400">No highlighted messages in this session.</div>
            ) : (
              <div>
                {session.goodMessages.map((m, idx) => (
                  <div
                    key={`${m.ts_ms}-${idx}`}
                    className="flex items-center border-l-2 border-transparent px-2 py-1 text-[14px] leading-6"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="mr-2 text-[11px] text-zinc-500">{formatTime(m.ts_ms)}</span>
                      <span className="mr-2 font-semibold" style={{ color: colorForName(m.username) }}>
                        {m.username ?? "unknown"}:
                      </span>
                      <span className="text-zinc-100">{m.text}</span>
                      {typeof m.score === "number" ? (
                        <span className="ml-2 text-[11px] text-zinc-500">({Math.round(m.score)})</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
