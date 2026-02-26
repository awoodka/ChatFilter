"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import {
  LiveFeedMessage,
  LiveStatus,
  loadLiveSnapshot,
  saveLiveSnapshotPatch,
  toLiveFeedMessage,
} from "@/lib/live/sessionSnapshot";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const TWITCH_NAME_COLORS = [
  "#FF0000", "#0000FF", "#00FF00", "#B22222", "#FF7F50",
  "#9ACD32", "#FF4500", "#2E8B57", "#DAA520", "#D2691E",
  "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F",
];

function usernameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TWITCH_NAME_COLORS[Math.abs(hash) % TWITCH_NAME_COLORS.length]!;
}

export default function LivePage() {
  const searchParams = useSearchParams();
  const [linkedChannelUrl, setLinkedChannelUrl] = useState("");
  const [threshold, setThreshold] = useState(80);
  const [dynamicThreshold, setDynamicThreshold] = useState(false);
  const [targetRate, setTargetRate] = useState(2);

  const [calibratedThreshold, setCalibratedThreshold] = useState<number | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logText, setLogText] = useState("{ }");
  const [chatMessages, setChatMessages] = useState<LiveFeedMessage[]>([]);
  const [goodMessages, setGoodMessages] = useState<LiveFeedMessage[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [metricsText, setMetricsText] = useState<string>("{ }");
  const [contextText, setContextText] = useState<string>("{ }");
  const [showDebug, setShowDebug] = useState(false);
  const [hasRestoredSnapshot, setHasRestoredSnapshot] = useState(false);
  const thresholdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goodChatRef = useRef<HTMLDivElement | null>(null);
  const incomingChatRef = useRef<HTMLDivElement | null>(null);
  const logsRef = useRef<HTMLPreElement | null>(null);
  const pollRef = useRef<(sid: string) => Promise<void>>(async () => {});

  const canStart = Boolean(linkedChannelUrl.trim());
  const thresholdSliderStyle = { "--slider-fill": `${threshold}%` } as CSSProperties;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/profile", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true || !isRecord(j["profile"])) return;
        const profile = j["profile"];
        if (cancelled) return;
        if (typeof profile["twitchChannelUrl"] === "string" && profile["twitchChannelUrl"].trim()) {
          setLinkedChannelUrl(profile["twitchChannelUrl"]);
        } else {
          setLinkedChannelUrl("");
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch calibrated threshold on mount and pre-populate the slider
  // Skip overriding if user already has an active session (snapshot preserves their choice)
  useEffect(() => {
    const snap = loadLiveSnapshot();
    if (snap?.isRunning) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/home/live-stats?windowHours=24&bucketMinutes=60", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (cancelled || !isRecord(j) || j["ok"] !== true) return;
        const ct = j["calibratedThreshold"];
        if (typeof ct === "number" && Number.isFinite(ct)) {
          setCalibratedThreshold(ct);
          setThreshold(ct);
        }
      } catch {
        // ignore — fall back to default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setLogText(`sessionId=${sid} state=${s.state} step=${s.step ?? ""}\n\n${typeof j["logTail"] === "string" ? j["logTail"] : ""}`);
      const chat = Array.isArray(j["chat"]) ? j["chat"] : [];
      const good = Array.isArray(j["good"]) ? j["good"] : [];
      setChatMessages(chat.map(toLiveFeedMessage).filter((x): x is LiveFeedMessage => Boolean(x)));
      setGoodMessages(good.map(toLiveFeedMessage).filter((x): x is LiveFeedMessage => Boolean(x)));
      setMetricsText(JSON.stringify(j["metrics"] ?? {}, null, 2));
      try {
        const rc = await fetch(`/api/live/${sid}/context`, { cache: "no-store" });
        const jc = (await rc.json()) as unknown;
        setContextText(JSON.stringify(jc, null, 2));
      } catch {
        // ignore context panel failures; live poll should continue
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
        setLinkedChannelUrl(snap.linkedChannelUrl);
        setThreshold(snap.threshold);
        setDynamicThreshold(snap.dynamicThreshold);
        setTargetRate(snap.targetRate);
        setSessionId(snap.sessionId);
        setStatus(snap.status);
        setIsRunning(snap.isRunning);
        setLogText(snap.logText);
        setChatMessages(snap.chatMessages);
        setGoodMessages(snap.goodMessages);
        setErrorText(snap.errorText);
        setMetricsText(snap.metricsText);
        setContextText(snap.contextText);
      }
      const sid = sidFromQuery || snap?.sessionId || "";
      if (sid) {
        setSessionId(sid);
        setIsRunning(true);
        setTimeout(() => void poll(sid), 150);
      }
      setHasRestoredSnapshot(true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [poll, searchParams]);

  useEffect(() => {
    if (!hasRestoredSnapshot) return;
    saveLiveSnapshotPatch({
      linkedChannelUrl,
      threshold,
      dynamicThreshold,
      targetRate,
      sessionId,
      status,
      isRunning,
      logText,
      chatMessages,
      goodMessages,
      errorText,
      metricsText,
      contextText,
    });
  }, [
    linkedChannelUrl,
    threshold,
    dynamicThreshold,
    targetRate,
    sessionId,
    status,
    isRunning,
    logText,
    chatMessages,
    goodMessages,
    errorText,
    metricsText,
    contextText,
    hasRestoredSnapshot,
  ]);

  useEffect(() => {
    if (goodChatRef.current) {
      goodChatRef.current.scrollTop = goodChatRef.current.scrollHeight;
    }
  }, [goodMessages]);

  useEffect(() => {
    if (incomingChatRef.current) {
      incomingChatRef.current.scrollTop = incomingChatRef.current.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logText]);

  return (
    <div className="twitch-page">
      <div className="twitch-shell">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Filter</h1>
          <div className="flex items-center gap-3">
            <Link className="twitch-link text-sm" href="/">
              Back
            </Link>
          </div>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Start live session</h2>
          <div className="twitch-muted mt-2 text-xs">
            IRC login is locked to anonymous mode for this MVP.
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <div className="flex items-center justify-between">
                <label className="twitch-muted text-xs font-medium">Highlight threshold</label>
                <div className="flex items-center gap-2">
                  {calibratedThreshold !== null && threshold === calibratedThreshold ? (
                    <span className="text-[10px] text-[#d6bcff]">Auto-calibrated from feedback</span>
                  ) : null}
                  <span className="twitch-muted text-xs">{threshold}</span>
                </div>
              </div>
              <div className="mt-1 flex h-10 items-center">
                <input
                  type="range"
                  value={threshold}
                  min={0}
                  max={100}
                  step={1}
                  disabled={dynamicThreshold}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(100, Number(e.target.value || "80")));
                    setThreshold(val);
                    if (isRunning && sessionId) {
                      if (thresholdTimerRef.current) clearTimeout(thresholdTimerRef.current);
                      thresholdTimerRef.current = setTimeout(() => {
                        void fetch("/api/live/threshold", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ sessionId, threshold: val }),
                        });
                      }, 300);
                    }
                  }}
                  style={thresholdSliderStyle}
                  className={`twitch-slider${dynamicThreshold ? " opacity-40 cursor-not-allowed" : ""}`}
                />
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <div className="flex h-10 items-center gap-2">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setDynamicThreshold((v) => !v)}
                className={`rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                  isRunning
                    ? "opacity-40 cursor-not-allowed border-[var(--border)] bg-[#121217] text-zinc-400"
                    : dynamicThreshold
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                      : "border-[var(--border)] bg-[#121217] text-zinc-400"
                }`}
              >
                {dynamicThreshold ? "Dynamic on" : "Dynamic off"}
              </button>
              {dynamicThreshold ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    value={targetRate}
                    min={0.5}
                    max={30}
                    step={0.5}
                    disabled={isRunning}
                    onChange={(e) => setTargetRate(Math.max(0.5, Math.min(30, Number(e.target.value) || 2)))}
                    className={`twitch-input w-14 text-center text-xs${isRunning ? " opacity-40 cursor-not-allowed" : ""}`}
                  />
                  <span className="twitch-muted text-xs whitespace-nowrap">msg/min</span>
                </div>
              ) : null}
              </div>
            </div>
          </div>

          <div className="twitch-muted mt-2 text-[11px]">
            Stream channel is loaded from your profile settings:{" "}
            {linkedChannelUrl ? <span className="font-medium text-zinc-200">{linkedChannelUrl}</span> : "(not configured)"}
          </div>
          {!linkedChannelUrl ? (
            <div className="mt-2 text-xs">
              <Link className="twitch-link" href="/settings/profile">
                Set your Twitch channel in Settings
              </Link>
            </div>
          ) : null}

          <div className="twitch-muted mt-3 text-xs">
            MVP captures stream audio server-side from Twitch HLS, then chunks and transcribes with Whisper.
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                className="twitch-button-primary"
                disabled={isRunning || !canStart}
                onClick={async () => {
                  setErrorText(null);
                  setIsRunning(true);
                  setLogText("Starting live session...");
                  const r = await fetch("/api/live/start", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      thresholdScoreExclusive: threshold,
                      dynamicThreshold,
                      targetRate,
                    }),
                  });
                  const j = (await r.json()) as unknown;
                  const sid = isRecord(j) && typeof j["sessionId"] === "string" ? j["sessionId"] : null;
                  if (!sid) {
                    setIsRunning(false);
                    setLogText(JSON.stringify(j, null, 2));
                    return;
                  }
                  setSessionId(sid);
                  setLogText(`Live session started: ${sid}\nPolling...`);
                  setTimeout(() => void poll(sid), 250);
                }}
              >
                {isRunning ? `Running${sessionId ? ` (${sessionId})` : ""}...` : "Start live session"}
              </button>
              <button
                className="twitch-button-secondary"
                disabled={!sessionId || isRunning === false}
                onClick={async () => {
                  if (!sessionId) return;
                  await fetch("/api/live/stop", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionId }),
                  });
                  setLogText((prev) => `${prev}\nStop requested...`);
                }}
              >
                Stop
              </button>
            </div>
            <Link
              href={sessionId ? `/live/highlights?sessionId=${encodeURIComponent(sessionId)}` : "/live/highlights"}
              className="twitch-button-secondary inline-flex items-center"
            >
              Open live highlighted chat
            </Link>
          </div>

          {status ? (
            <div className="twitch-muted mt-2 text-xs">
              state={status.state} step={status.step ?? ""} {status.error ? `error=${status.error}` : ""}
            </div>
          ) : null}

          {errorText ? (
            <pre className="twitch-scroll mt-3 max-h-[260px] overflow-auto p-3 text-xs">{errorText}</pre>
          ) : null}
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {/* Highlighted chat */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[#18181b] px-4 py-2">
              <span className="text-sm font-semibold">Highlighted Chat</span>
              <span className="text-xs text-[#adadb8]">{goodMessages.length} messages</span>
            </div>
            <div ref={goodChatRef} className="flex-1 overflow-auto bg-[#0e0e10] px-4 py-2" style={{ maxHeight: 480, minHeight: 320 }}>
              {goodMessages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-[#adadb8]">
                  Waiting for highlighted messages...
                </div>
              ) : (
                <div className="space-y-1">
                  {goodMessages.map((m, idx) => {
                    const name = m.username ?? "unknown";
                    return (
                      <div key={`${m.ts_ms}-${idx}`} className="leading-6 hover:bg-[#1f1f23]/60">
                        {typeof m.score === "number" ? (
                          <span className="mr-1.5 inline-block rounded bg-[#9147ff]/20 px-1 py-px align-middle text-[10px] font-medium text-[#bf94ff]">
                            {Math.round(m.score)}
                          </span>
                        ) : null}
                        <span className="text-[13px] font-bold" style={{ color: usernameColor(name) }}>
                          {name}
                        </span>
                        <span className="text-[#efeff1]">: </span>
                        <span className="text-[13px] text-[#efeff1]">{m.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* All chat */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[#18181b] px-4 py-2">
              <span className="text-sm font-semibold">All Chat</span>
              <span className="text-xs text-[#adadb8]">{chatMessages.length} messages</span>
            </div>
            <div ref={incomingChatRef} className="flex-1 overflow-auto bg-[#0e0e10] px-4 py-2" style={{ maxHeight: 480, minHeight: 320 }}>
              {chatMessages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-[#adadb8]">
                  Waiting for chat messages...
                </div>
              ) : (
                <div className="space-y-1">
                  {chatMessages.map((m, idx) => {
                    const name = m.username ?? "unknown";
                    return (
                      <div key={`${m.ts_ms}-${idx}`} className="leading-6 hover:bg-[#1f1f23]/60">
                        <span className="text-[13px] font-bold" style={{ color: usernameColor(name) }}>
                          {name}
                        </span>
                        <span className="text-[#efeff1]">: </span>
                        <span className="text-[13px] text-[#efeff1]">{m.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-center">
          <button
            type="button"
            className="twitch-button-secondary text-xs"
            onClick={() => setShowDebug((v) => !v)}
          >
            {showDebug ? "Hide debug" : "Show debug"}
          </button>
        </div>

        {showDebug && (
          <>
            <div className="twitch-card mt-4 p-5">
              <h2 className="text-base font-medium">Live metrics</h2>
              <pre className="twitch-scroll mt-3 max-h-[220px] overflow-auto p-3 text-xs">
                {metricsText}
              </pre>
            </div>

            <div className="twitch-card mt-4 p-5">
              <h2 className="text-base font-medium">Live context</h2>
              <pre className="twitch-scroll mt-3 max-h-[220px] overflow-auto p-3 text-xs">
                {contextText}
              </pre>
            </div>

            <div className="twitch-card mt-4 p-5">
              <h2 className="text-base font-medium">Logs</h2>
              <pre
                ref={logsRef}
                className="twitch-scroll mt-3 max-h-[420px] overflow-auto p-3 text-xs"
              >
                {logText}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
