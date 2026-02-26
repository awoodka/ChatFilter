"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SessionItem = {
  sessionId: string;
  channel: string;
  updatedAt: number;
  seen: number;
  filtered: number;
  highlighted: number;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/sessions", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (cancelled || !isRecord(j) || j["ok"] !== true) return;
        const rawSessions = Array.isArray(j["sessions"]) ? j["sessions"] : [];
        const parsed: SessionItem[] = rawSessions.filter(isRecord).map((s: Record<string, unknown>) => ({
          sessionId: String(s["sessionId"] ?? ""),
          channel: String(s["channel"] ?? ""),
          updatedAt: Number(s["updatedAt"] ?? 0),
          seen: Number(s["seen"] ?? 0),
          filtered: Number(s["filtered"] ?? 0),
          highlighted: Number(s["highlighted"] ?? 0),
        }));
        if (!cancelled) setSessions(parsed);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-4xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <Link className="twitch-link text-sm" href="/">Back</Link>
        </div>

        {isLoading ? (
          <div className="mt-4 text-sm twitch-muted">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="mt-4 text-sm twitch-muted">No sessions recorded yet. Start a live session to begin.</div>
        ) : (
          <div className="mt-4 space-y-3">
            {sessions.map((s) => (
              <Link
                key={s.sessionId}
                href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                className="twitch-card block p-4 transition-colors hover:border-[#9147ff]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">{s.channel || "Unknown channel"}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {new Date(s.updatedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                      {" \u00b7 "}
                      {new Date(s.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div className="text-center">
                      <div className="font-semibold text-blue-300">{formatCount(s.seen)}</div>
                      <div className="text-zinc-500">seen</div>
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-[#cab0ff]">{formatCount(s.filtered)}</div>
                      <div className="text-zinc-500">filtered</div>
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-emerald-300">{formatCount(s.highlighted)}</div>
                      <div className="text-zinc-500">highlighted</div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
