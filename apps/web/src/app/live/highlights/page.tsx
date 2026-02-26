"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  LiveFeedMessage,
  LiveStatus,
  loadLiveSnapshot,
  saveLiveSnapshotPatch,
  toLiveFeedMessage,
} from "@/lib/live/sessionSnapshot";

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

export default function LiveHighlightsPage() {
  const searchParams = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [goodMessages, setGoodMessages] = useState<LiveFeedMessage[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hasRestoredSnapshot, setHasRestoredSnapshot] = useState(false);
  const [feedbackState, setFeedbackState] = useState<Map<string, "up" | "down">>(() => {
    const snap = loadLiveSnapshot();
    return snap ? new Map(Object.entries(snap.feedbackGiven)) : new Map();
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const submitFeedback = useCallback(
    async (msg: LiveFeedMessage, idx: number, direction: "up" | "down") => {
      const key = `${msg.ts_ms}-${idx}`;
      const existing = feedbackState.get(key);

      // Undo: clicking same direction again removes the vote (no API call)
      if (existing === direction) {
        setFeedbackState((prev) => {
          const next = new Map(prev);
          next.delete(key);
          saveLiveSnapshotPatch({ feedbackGiven: Object.fromEntries(next) });
          return next;
        });
        return;
      }

      // Set new direction optimistically
      setPendingKey(key);
      setFeedbackState((prev) => {
        const next = new Map(prev).set(key, direction);
        saveLiveSnapshotPatch({ feedbackGiven: Object.fromEntries(next) });
        return next;
      });
      try {
        const res = await fetch("/api/live/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tsMs: msg.ts_ms,
            messageText: msg.text,
            messageUsername: msg.username,
            messageScore: msg.score,
            messageReason: msg.reason,
            messageRelevance: msg.relevance,
            messageHumor: msg.humor,
            messageEngagement: msg.engagement,
            feedback: direction,
            sessionId,
          }),
        });
        const j = (await res.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true) {
          setFeedbackState((prev) => {
            const next = new Map(prev);
            next.delete(key);
            saveLiveSnapshotPatch({ feedbackGiven: Object.fromEntries(next) });
            return next;
          });
        }
      } catch {
        setFeedbackState((prev) => {
          const next = new Map(prev);
          next.delete(key);
          saveLiveSnapshotPatch({ feedbackGiven: Object.fromEntries(next) });
          return next;
        });
      } finally {
        setPendingKey(null);
      }
    },
    [sessionId, feedbackState],
  );
  const chatRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<(sid: string) => Promise<void>>(async () => {});

  const poll = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`/api/live/${sid}`, { cache: "no-store" });
      const j = (await r.json()) as unknown;
      if (!isRecord(j) || j["ok"] !== true || !isRecord(j["status"])) {
        setErrorText(`Failed to read live status: ${JSON.stringify(j, null, 2)}`);
        setIsRunning(false);
        return;
      }
      const s = j["status"] as unknown as LiveStatus;
      setStatus(s);
      const good = Array.isArray(j["good"]) ? j["good"] : [];
      setGoodMessages(good.map(toLiveFeedMessage).filter((x): x is LiveFeedMessage => Boolean(x)));
      if (s.state === "running" || s.state === "queued") {
        setIsRunning(true);
        setTimeout(() => void pollRef.current(sid), 1200);
      } else {
        setIsRunning(false);
      }
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setIsRunning(false);
    }
  }, []);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    const snap = loadLiveSnapshot();
    const sidFromQuery = String(searchParams.get("sessionId") ?? "").trim();
    const timer = window.setTimeout(() => {
      if (snap) {
        setSessionId(snap.sessionId);
        setStatus(snap.status);
        setIsRunning(snap.isRunning);
        setGoodMessages(snap.goodMessages);
        setErrorText(snap.errorText);
      }
      const sid = sidFromQuery || snap?.sessionId || "";
      if (!sid) return;
      setSessionId(sid);
      setIsRunning(true);
      setTimeout(() => void poll(sid), 120);
      setHasRestoredSnapshot(true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [poll, searchParams]);

  useEffect(() => {
    if (!hasRestoredSnapshot) return;
    saveLiveSnapshotPatch({
      sessionId,
      status,
      isRunning,
      goodMessages,
      errorText,
    });
  }, [sessionId, status, isRunning, goodMessages, errorText, hasRestoredSnapshot]);

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [goodMessages]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (goodMessages.length === 0) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.min(prev + 1, goodMessages.length - 1);
          const el = chatRef.current?.querySelector(`[data-index="${next}"]`);
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          const el = chatRef.current?.querySelector(`[data-index="${next}"]`);
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "u" && selectedIndex !== null) {
        e.preventDefault();
        const msg = goodMessages[selectedIndex];
        if (msg) void submitFeedback(msg, selectedIndex, "up");
      } else if (e.key === "d" && selectedIndex !== null) {
        e.preventDefault();
        const msg = goodMessages[selectedIndex];
        if (msg) void submitFeedback(msg, selectedIndex, "down");
      } else if (e.key === "Escape") {
        setSelectedIndex(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goodMessages, selectedIndex, submitFeedback]);

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-4xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Live Highlighted Chat</h1>
          <Link
            className="twitch-button-secondary inline-flex !h-8 items-center !text-xs"
            href={sessionId ? `/live?sessionId=${encodeURIComponent(sessionId)}` : "/live"}
          >
            Back to Live MVP
          </Link>
        </div>

        <div className="twitch-card mt-5 overflow-hidden">
          <div className="border-b border-[var(--border)] bg-[#111118] px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold uppercase tracking-wide text-zinc-200">Twitch-style highlights feed</div>
              <div className={`text-xs font-semibold ${isRunning ? "text-emerald-300" : "text-zinc-400"}`}>
                {status ? `state=${status.state}` : "No active session"}
              </div>
            </div>
          </div>

          <div
            ref={chatRef}
            className="max-h-[72vh] overflow-auto bg-[#0b0b10] px-2 py-2"
          >
            {goodMessages.length > 0 ? (
              <div className="mb-1 px-2 text-[11px] text-zinc-600">j/k navigate &middot; u/d vote</div>
            ) : null}
            {goodMessages.length === 0 ? (
              <div className="p-3 text-sm text-zinc-400">
                {sessionId ? "(No highlighted chat yet)" : "Start a live session first, then open this page."}
              </div>
            ) : (
              <div>
                {goodMessages.map((m, idx) => {
                  const fbKey = `${m.ts_ms}-${idx}`;
                  const fb = feedbackState.get(fbKey);
                  const isSelected = selectedIndex === idx;
                  const isPending = pendingKey === fbKey;
                  return (
                    <div
                      key={fbKey}
                      data-index={idx}
                      onClick={() => setSelectedIndex(idx)}
                      className={`group flex items-center px-2 py-1 text-[14px] leading-6 cursor-pointer ${
                        isSelected ? "border-l-2 border-[#9147ff] bg-[#9147ff]/5" : "border-l-2 border-transparent"
                      }`}
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
                      <div className={`ml-2 flex gap-1 shrink-0 ${fb || isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                        <button
                          disabled={isPending && fb !== "up"}
                          onClick={(e) => { e.stopPropagation(); void submitFeedback(m, idx, "up"); }}
                          className={`px-1.5 py-0.5 rounded text-sm ${fb === "up" ? "text-emerald-400" : "text-zinc-500 hover:text-emerald-400"} disabled:cursor-default`}
                          title={fb === "up" ? "Undo upvote" : "Good pick"}
                        >
                          {"\u25B2"}
                        </button>
                        <button
                          disabled={isPending && fb !== "down"}
                          onClick={(e) => { e.stopPropagation(); void submitFeedback(m, idx, "down"); }}
                          className={`px-1.5 py-0.5 rounded text-sm ${fb === "down" ? "text-red-400" : "text-zinc-500 hover:text-red-400"} disabled:cursor-default`}
                          title={fb === "down" ? "Undo downvote" : "Bad pick"}
                        >
                          {"\u25BC"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {errorText ? <pre className="twitch-scroll mt-4 max-h-[220px] overflow-auto p-3 text-xs">{errorText}</pre> : null}
      </div>
    </div>
  );
}
