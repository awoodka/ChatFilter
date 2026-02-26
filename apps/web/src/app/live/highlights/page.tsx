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

function playAlertBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.3;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => ctx.close();
  } catch {
    // ignore audio errors
  }
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
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState(90);
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  const [metrics, setMetrics] = useState<{ seen: number; kept: number; scored: number; highlighted: number; retries429: number } | null>(null);
  const [rates, setRates] = useState<{ seenPerMin: number; scoredPerMin: number; highlightedPerMin: number } | null>(null);
  const prevSnapshotRef = useRef<{ counts: { seen: number; kept: number; scored: number; highlighted: number; retries429: number }; tsMs: number } | null>(null);
  const prevGoodCountRef = useRef<number>(0);

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
      const rawMetrics = isRecord(j["metrics"]) ? j["metrics"] as Record<string, unknown> : null;
      const rawCounts = rawMetrics && isRecord(rawMetrics["counts"]) ? rawMetrics["counts"] as Record<string, unknown> : null;
      if (rawCounts) {
        setMetrics({
          seen: Number(rawCounts["seen"] ?? 0),
          kept: Number(rawCounts["kept"] ?? 0),
          scored: Number(rawCounts["scored"] ?? 0),
          highlighted: Number(rawCounts["highlighted"] ?? 0),
          retries429: Number(rawCounts["retries429"] ?? 0),
        });
      }
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

  // Alert detection
  useEffect(() => {
    if (!alertEnabled) {
      prevGoodCountRef.current = goodMessages.length;
      return;
    }
    const prevCount = prevGoodCountRef.current;
    if (goodMessages.length > prevCount) {
      const newMsgs = goodMessages.slice(prevCount);
      const alertKeys: string[] = [];
      for (let i = prevCount; i < goodMessages.length; i++) {
        const m = goodMessages[i]!;
        if (typeof m.score === "number" && m.score >= alertThreshold) {
          alertKeys.push(`${m.ts_ms}-${i}`);
        }
      }
      if (alertKeys.length > 0) {
        playAlertBeep();
        setFlashKeys((prev) => {
          const next = new Set(prev);
          for (const k of alertKeys) next.add(k);
          return next;
        });
        setTimeout(() => {
          setFlashKeys((prev) => {
            const next = new Set(prev);
            for (const k of alertKeys) next.delete(k);
            return next;
          });
        }, 1500);
      }
    }
    prevGoodCountRef.current = goodMessages.length;
  }, [goodMessages, alertEnabled, alertThreshold]);

  // Compute per-minute rates from metrics deltas
  useEffect(() => {
    if (!metrics) return;
    const now = Date.now();
    const prev = prevSnapshotRef.current;
    if (prev) {
      const dtSec = (now - prev.tsMs) / 1000;
      if (dtSec >= 2) {
        const dSeen = metrics.seen - prev.counts.seen;
        const dScored = metrics.scored - prev.counts.scored;
        const dHighlighted = metrics.highlighted - prev.counts.highlighted;
        setRates({
          seenPerMin: Math.round((dSeen / dtSec) * 60),
          scoredPerMin: Math.round((dScored / dtSec) * 60),
          highlightedPerMin: Math.round((dHighlighted / dtSec) * 60),
        });
        prevSnapshotRef.current = { counts: { ...metrics }, tsMs: now };
      }
    } else {
      prevSnapshotRef.current = { counts: { ...metrics }, tsMs: now };
    }
  }, [metrics]);

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-4xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Live Highlighted Chat</h1>
          <Link
            className="twitch-button-secondary inline-flex !h-8 items-center !text-xs"
            href={sessionId ? `/live?sessionId=${encodeURIComponent(sessionId)}` : "/live"}
          >
            Back to Filter
          </Link>
        </div>

        <div className="twitch-card mt-5 overflow-hidden">
          <div className="border-b border-[var(--border)] bg-[#111118] px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold uppercase tracking-wide text-zinc-200">Twitch-style highlights feed</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAlertEnabled((v) => !v)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                    alertEnabled
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                      : "border-[var(--border)] bg-[#121217] text-zinc-400"
                  }`}
                >
                  {alertEnabled ? "Alerts on" : "Alerts off"}
                </button>
                {alertEnabled ? (
                  <input
                    type="number"
                    value={alertThreshold}
                    min={60}
                    max={100}
                    step={1}
                    onChange={(e) => setAlertThreshold(Math.max(60, Math.min(100, Number(e.target.value) || 90)))}
                    className="twitch-input w-12 text-center text-[11px] !h-6"
                    title="Alert score threshold"
                  />
                ) : null}
                <div className={`text-xs font-semibold ${isRunning ? "text-emerald-300" : "text-zinc-400"}`}>
                  {status ? `state=${status.state}` : "No active session"}
                </div>
              </div>
            </div>
            {isRunning && metrics ? (
              <div className="mt-1.5 space-y-0.5 text-[11px] text-zinc-500">
                {rates ? (
                  <div>
                    Chat: {rates.seenPerMin}/min{" · "}Scored: {rates.scoredPerMin}/min{" · "}Highlights: {rates.highlightedPerMin}/min{" · "}
                    <span className={metrics.retries429 > 0 ? "text-amber-400" : ""}>429s: {metrics.retries429}</span>
                    {rates.seenPerMin > 0 && rates.scoredPerMin === 0 ? (
                      <span className="ml-2 text-amber-400">Scoring paused</span>
                    ) : null}
                  </div>
                ) : null}
                <div>
                  Total: {metrics.seen.toLocaleString()} seen{" · "}{metrics.scored.toLocaleString()} scored{" · "}{metrics.highlighted.toLocaleString()} highlighted
                </div>
              </div>
            ) : null}
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
                  const isFlashing = flashKeys.has(fbKey);
                  return (
                    <div
                      key={fbKey}
                      data-index={idx}
                      onClick={() => setSelectedIndex(idx)}
                      className={`group flex items-center px-2 py-1 text-[14px] leading-6 cursor-pointer transition-colors ${
                        isFlashing
                          ? "animate-pulse border-l-2 border-emerald-400 bg-emerald-500/10"
                          : isSelected ? "border-l-2 border-[#9147ff] bg-[#9147ff]/5" : "border-l-2 border-transparent"
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
                        {isSelected && m.relevance != null && m.humor != null && m.engagement != null ? (
                          <div className="mt-0.5 text-[11px] text-zinc-500">
                            <span>Relevance: {Math.round(m.relevance)}</span>
                            <span className="ml-2">Humor: {Math.round(m.humor)}</span>
                            <span className="ml-2">Engagement: {Math.round(m.engagement)}</span>
                            {m.reason ? <span className="ml-2 truncate italic">&ldquo;{m.reason}&rdquo;</span> : null}
                          </div>
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
