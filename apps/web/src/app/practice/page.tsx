"use client";

import Link from "next/link";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { loadLiveSnapshot } from "@/lib/live/sessionSnapshot";

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

function colorForName(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length] ?? NAME_COLORS[0]!;
}

function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type ChatMessage = {
  username: string;
  text: string;
  ts_ms: number;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export default function PracticeChatPage() {
  const [currentGame, setCurrentGame] = useState("");
  const [frequency, setFrequency] = useState(8);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);

  const chatRef = useRef<HTMLDivElement | null>(null);
  const bufferRef = useRef<ChatMessage[]>([]);
  const runningRef = useRef(false);
  const frequencyRef = useRef(frequency);
  const liveSessionIdRef = useRef<string | null>(null);
  const dripTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  // Detect active live session from snapshot
  useEffect(() => {
    const snap = loadLiveSnapshot();
    if (snap?.sessionId && snap.isRunning) {
      setLiveSessionId(snap.sessionId);
      liveSessionIdRef.current = snap.sessionId;
      if (snap.status?.meta && typeof snap.status.meta["currentGame"] === "string" && snap.status.meta["currentGame"]) {
        setCurrentGame(snap.status.meta["currentGame"]);
      }
    }
  }, []);

  // Keep refs in sync
  useEffect(() => { frequencyRef.current = frequency; }, [frequency]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { liveSessionIdRef.current = liveSessionId; }, [liveSessionId]);

  // Auto-scroll
  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const fetchBatch = useCallback(async () => {
    const recent = messagesRef.current.slice(-10).map((m) => `${m.username}: ${m.text}`);
    try {
      const res = await fetch("/api/practice/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentGame: currentGame.trim() || undefined,
          recentMessages: recent,
          sessionId: liveSessionIdRef.current || undefined,
          messageCount: 5,
        }),
      });
      const data = (await res.json()) as unknown;
      if (!isRecord(data) || data["ok"] !== true) {
        const errMsg = isRecord(data) && typeof data["error"] === "string" ? data["error"] : "Unknown error";
        setErrorText(errMsg);
        return;
      }
      setErrorText(null);
      const msgs = data["messages"] as Array<{ username: string; text: string }>;
      const stamped = msgs.map((m) => ({
        ...m,
        ts_ms: Date.now() + Math.random() * 1000,
      }));
      bufferRef.current.push(...stamped);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Fetch failed");
    }
  }, [currentGame]);

  const dripNext = useCallback(() => {
    if (!runningRef.current) return;

    if (bufferRef.current.length > 0) {
      const next = bufferRef.current.shift()!;
      next.ts_ms = Date.now();
      setMessages((prev) => [...prev, next]);
    }

    dripTimerRef.current = setTimeout(dripNext, frequencyRef.current * 1000);
  }, []);

  const scheduleFetch = useCallback(() => {
    if (!runningRef.current) return;

    // Fetch when buffer is running low
    if (bufferRef.current.length < 3) {
      fetchBatch();
    }

    // Check again soon
    fetchTimerRef.current = setTimeout(scheduleFetch, 3000);
  }, [fetchBatch]);

  const handleStart = useCallback(() => {
    setRunning(true);
    runningRef.current = true;
    setErrorText(null);

    // Kick off initial fetch
    fetchBatch();

    // Start dripping messages
    dripTimerRef.current = setTimeout(dripNext, frequencyRef.current * 1000);

    // Start fetch scheduler
    fetchTimerRef.current = setTimeout(scheduleFetch, 3000);
  }, [fetchBatch, dripNext, scheduleFetch]);

  const handleStop = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    if (dripTimerRef.current) { clearTimeout(dripTimerRef.current); dripTimerRef.current = null; }
    if (fetchTimerRef.current) { clearTimeout(fetchTimerRef.current); fetchTimerRef.current = null; }
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
    bufferRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (dripTimerRef.current) clearTimeout(dripTimerRef.current);
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    };
  }, []);

  const sliderStyle = { "--slider-fill": `${((frequency - 3) / (30 - 3)) * 100}%` } as CSSProperties;

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-4xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Practice Chat</h1>
          <Link
            className="twitch-button-secondary inline-flex !h-8 items-center !text-xs"
            href="/"
          >
            Back to Dashboard
          </Link>
        </div>

        {/* Settings */}
        <div className="twitch-card mt-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-200">Current game</label>
              <input
                type="text"
                className="twitch-input w-full"
                placeholder="e.g. Valorant, Just Chatting"
                value={currentGame}
                onChange={(e) => setCurrentGame(e.target.value)}
                disabled={running}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-200">
                Message frequency: <span className="text-zinc-400">{frequency}s</span>
              </label>
              <input
                type="range"
                min={3}
                max={30}
                step={1}
                value={frequency}
                onChange={(e) => setFrequency(Number(e.target.value))}
                disabled={running}
                className="twitch-slider mt-2 w-full"
                style={sliderStyle}
              />
              <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                <span>3s (fast)</span>
                <span>30s (slow)</span>
              </div>
            </div>
          </div>
          {liveSessionId ? (
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-300">
                Using live transcript from active session
              </span>
            </div>
          ) : (
            <div className="mt-4 text-sm text-zinc-500">
              No active live session detected. Start a live session to feed real-time transcript context.
            </div>
          )}
          <div className="mt-4 flex gap-3">
            {!running ? (
              <button className="twitch-button-primary" onClick={handleStart}>
                Start
              </button>
            ) : (
              <button className="twitch-button-secondary" onClick={handleStop}>
                Stop
              </button>
            )}
            <button
              className="twitch-button-secondary"
              onClick={handleClear}
              disabled={running || messages.length === 0}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Chat Feed */}
        <div className="twitch-card mt-5 overflow-hidden">
          <div className="border-b border-[var(--border)] bg-[#111118] px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold uppercase tracking-wide text-zinc-200">
                Simulated Chat
              </div>
              <div className={`text-xs font-semibold ${running ? "text-emerald-300" : "text-zinc-400"}`}>
                {running ? "Running" : "Stopped"}
                {messages.length > 0 ? ` \u00b7 ${messages.length} messages` : ""}
              </div>
            </div>
          </div>

          <div
            ref={chatRef}
            className="max-h-[72vh] min-h-[300px] overflow-auto bg-[#0b0b10] px-2 py-2"
          >
            {messages.length === 0 ? (
              <div className="p-3 text-sm text-zinc-400">
                {running ? "Generating messages\u2026" : "Click Start to begin generating practice chat messages."}
              </div>
            ) : (
              <div>
                {messages.map((m, idx) => (
                  <div key={`${m.ts_ms}-${idx}`} className="px-2 py-1 text-[14px] leading-6">
                    <span className="mr-2 text-[11px] text-zinc-500">{formatTime(m.ts_ms)}</span>
                    <span className="mr-2 font-semibold" style={{ color: colorForName(m.username) }}>
                      {m.username}:
                    </span>
                    <span className="text-zinc-100">{m.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {errorText ? (
          <div className="twitch-card mt-4 border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
