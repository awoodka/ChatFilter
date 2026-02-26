"use client";

import { useEffect, useState } from "react";

type FeedbackRow = {
  id: number;
  tsMs: number;
  messageText: string;
  messageUsername: string | null;
  messageScore: number | null;
  feedback: "up" | "down";
  sessionId: string | null;
  createdAt: number;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const PAGE_SIZE = 50;

export default function SettingsFeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/feedback?limit=${PAGE_SIZE}&offset=${offset}`, { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (cancelled || !isRecord(j) || j["ok"] !== true) return;
        const rawRows = Array.isArray(j["rows"]) ? j["rows"] : [];
        const parsed: FeedbackRow[] = rawRows
          .filter(isRecord)
          .map((row: Record<string, unknown>) => ({
            id: Number(row["id"]),
            tsMs: Number(row["tsMs"]),
            messageText: String(row["messageText"] ?? ""),
            messageUsername: typeof row["messageUsername"] === "string" ? row["messageUsername"] : null,
            messageScore: typeof row["messageScore"] === "number" ? row["messageScore"] : null,
            feedback: row["feedback"] === "down" ? ("down" as const) : ("up" as const),
            sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : null,
            createdAt: Number(row["createdAt"]),
          }));
        if (!cancelled) {
          setRows(parsed);
          setTotal(typeof j["total"] === "number" ? j["total"] : 0);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [offset]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div>
      <h2 className="text-lg font-semibold">Feedback history</h2>
      <p className="twitch-muted mt-1 text-sm">Review past upvotes and downvotes on highlighted messages.</p>

      {isLoading ? (
        <div className="mt-4 text-sm twitch-muted">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="mt-4 text-sm twitch-muted">No feedback recorded yet.</div>
      ) : (
        <>
          <div className="mt-4 space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="twitch-card-soft flex items-start gap-3 p-3">
                <div className={`mt-0.5 text-base ${row.feedback === "up" ? "text-emerald-400" : "text-red-400"}`}>
                  {row.feedback === "up" ? "\u25B2" : "\u25BC"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-100 truncate">{row.messageText}</div>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                    {row.messageUsername ? <span>{row.messageUsername}</span> : null}
                    {row.messageScore !== null ? <span>Score: {Math.round(row.messageScore)}</span> : null}
                    <span>{new Date(row.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              className="twitch-button-secondary !text-xs"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <span className="text-xs twitch-muted">
              Page {currentPage} of {totalPages} ({total} total)
            </span>
            <button
              className="twitch-button-secondary !text-xs"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
