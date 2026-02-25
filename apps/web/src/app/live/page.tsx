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

export default function LivePage() {
  const searchParams = useSearchParams();
  const [linkedChannelUrl, setLinkedChannelUrl] = useState("");
  const [threshold, setThreshold] = useState(80);
  const [dynamicThreshold, setDynamicThreshold] = useState(false);
  const [targetRate, setTargetRate] = useState(2);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logText, setLogText] = useState("{ }");
  const [chatMessages, setChatMessages] = useState<LiveFeedMessage[]>([]);
  const [goodMessages, setGoodMessages] = useState<LiveFeedMessage[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [metricsText, setMetricsText] = useState<string>("{ }");
  const [contextText, setContextText] = useState<string>("{ }");
  const [hasRestoredSnapshot, setHasRestoredSnapshot] = useState(false);
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
          <h1 className="text-2xl font-semibold tracking-tight">Live MVP</h1>
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
                <span className="twitch-muted text-xs">{threshold}</span>
              </div>
              <div className="mt-1 flex h-10 items-center">
                <input
                  type="range"
                  value={threshold}
                  min={0}
                  max={100}
                  step={1}
                  disabled={dynamicThreshold}
                  onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value || "80"))))}
                  style={thresholdSliderStyle}
                  className={`twitch-slider${dynamicThreshold ? " opacity-40 cursor-not-allowed" : ""}`}
                />
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <div className="flex h-10 items-center gap-2">
              <button
                type="button"
                onClick={() => setDynamicThreshold((v) => !v)}
                className={`rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                  dynamicThreshold
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
                    onChange={(e) => setTargetRate(Math.max(0.5, Math.min(30, Number(e.target.value) || 2)))}
                    className="twitch-input w-14 text-center text-xs"
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
          <div className="twitch-card p-4">
            <h3 className="text-sm font-medium">Good chats (score above threshold)</h3>
            <div ref={goodChatRef} className="twitch-scroll mt-2 max-h-[420px] overflow-auto p-2 text-sm">
              {goodMessages.length === 0 ? (
                <div className="twitch-muted text-xs">(none yet)</div>
              ) : (
                <div className="space-y-2">
                  {goodMessages.map((m, idx) => (
                    <div key={`${m.ts_ms}-${idx}`} className="twitch-card-soft p-2 text-sm">
                      <div className="twitch-muted text-xs">
                        <span className="font-medium text-zinc-100">{m.username ?? "unknown"}</span>
                        <span className="ml-2">ts_ms={m.ts_ms}</span>
                        {typeof m.score === "number" ? (
                          <span className="ml-2">
                            R:{Math.round(m.relevance ?? 0)} H:{Math.round(m.humor ?? 0)} E:{Math.round(m.engagement ?? 0)} |{" "}
                            {Math.round(m.score)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                      {m.reason ? <div className="twitch-muted mt-1 text-xs">{m.reason}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="twitch-card p-4">
            <h3 className="text-sm font-medium">Incoming live chat (filtered)</h3>
            <div ref={incomingChatRef} className="twitch-scroll mt-2 max-h-[420px] overflow-auto p-2 text-sm">
              {chatMessages.length === 0 ? (
                <div className="twitch-muted text-xs">(none yet)</div>
              ) : (
                <div className="space-y-2">
                  {chatMessages.map((m, idx) => (
                    <div key={`${m.ts_ms}-${idx}`} className="twitch-card-soft p-2 text-sm">
                      <div className="twitch-muted text-xs">
                        <span className="font-medium text-zinc-100">{m.username ?? "unknown"}</span>
                        <span className="ml-2">ts_ms={m.ts_ms}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Live metrics</h2>
          <pre className="twitch-scroll mt-3 max-h-[220px] overflow-auto p-3 text-xs">
            {metricsText}
          </pre>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Live context (debug)</h2>
          <pre className="twitch-scroll mt-3 max-h-[220px] overflow-auto p-3 text-xs">
            {contextText}
          </pre>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Logs</h2>
          <pre
            ref={logsRef}
            className="twitch-scroll mt-3 max-h-[420px] overflow-auto p-3 text-xs"
          >
            {logText}
          </pre>
        </div>
      </div>
    </div>
  );
}
