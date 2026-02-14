"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

type LiveStatus = {
  jobId: string;
  type?: string;
  state: "queued" | "running" | "succeeded" | "failed";
  step?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

type LiveFeedMessage = {
  ts_ms: number;
  text: string;
  username: string | null;
  score: number | null;
  reason: string | null;
  relevance?: number | null;
  humor?: number | null;
  engagement?: number | null;
};

function toLiveFeedMessage(x: unknown): LiveFeedMessage | null {
  if (!isRecord(x)) return null;
  const ts_ms = x["ts_ms"];
  const text = x["text"];
  if (typeof ts_ms !== "number" || typeof text !== "string") return null;
  const username = typeof x["username"] === "string" ? x["username"] : null;
  const score = typeof x["score"] === "number" ? x["score"] : null;
  const reason = typeof x["reason"] === "string" ? x["reason"] : null;
  const relevance = typeof x["relevance"] === "number" ? x["relevance"] : null;
  const humor = typeof x["humor"] === "number" ? x["humor"] : null;
  const engagement = typeof x["engagement"] === "number" ? x["engagement"] : null;
  return { ts_ms, text, username, score, reason, relevance, humor, engagement };
}

export default function LivePage() {
  const [useAnonymousIrc, setUseAnonymousIrc] = useState(true);
  const [token, setToken] = useState("");
  const [channelOrUrl, setChannelOrUrl] = useState("");
  const [currentGame, setCurrentGame] = useState("");
  const [threshold, setThreshold] = useState(80);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logText, setLogText] = useState("{ }");
  const [chatMessages, setChatMessages] = useState<LiveFeedMessage[]>([]);
  const [goodMessages, setGoodMessages] = useState<LiveFeedMessage[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [metricsText, setMetricsText] = useState<string>("{ }");
  const [contextText, setContextText] = useState<string>("{ }");
  const goodChatRef = useRef<HTMLDivElement | null>(null);
  const incomingChatRef = useRef<HTMLDivElement | null>(null);
  const logsRef = useRef<HTMLPreElement | null>(null);

  const canStart = useMemo(() => {
    const hasAuth = useAnonymousIrc || Boolean(token.trim());
    return hasAuth && Boolean(channelOrUrl.trim());
  }, [useAnonymousIrc, token, channelOrUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/profile", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true || !isRecord(j["profile"])) return;
        const profile = j["profile"];
        if (cancelled) return;
        if (typeof profile["twitchChannelUrl"] === "string" && profile["twitchChannelUrl"].trim() && !channelOrUrl.trim()) {
          setChannelOrUrl(profile["twitchChannelUrl"]);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
    // Load linked twitch once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = async (sid: string) => {
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
        setTimeout(() => void poll(sid), 1200);
      } else {
        setIsRunning(false);
      }
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setIsRunning(false);
    }
  };

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
            <Link className="twitch-link text-sm" href="/eval">
              Testing dashboard
            </Link>
          </div>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Start live session</h2>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <input
              id="useAnonymousIrc"
              type="checkbox"
              checked={useAnonymousIrc}
              onChange={(e) => setUseAnonymousIrc(e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="useAnonymousIrc" className="twitch-muted">
              Use anonymous IRC login (recommended for quick stream chat viewing)
            </label>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="twitch-muted text-xs font-medium">Twitch IRC OAuth token (optional)</label>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="oauth:xxxxxxxxxxxxxxxx"
                disabled={useAnonymousIrc}
                className="twitch-input mt-1"
              />
              <div className="twitch-muted mt-1 text-[11px]">
                {useAnonymousIrc ? "Anonymous mode uses PASS SCHMOOPIIE + justinfan nick." : "Token will be used for authenticated IRC login."}
              </div>
            </div>
            <div>
              <label className="twitch-muted text-xs font-medium">Channel or stream URL</label>
              <input
                value={channelOrUrl}
                onChange={(e) => setChannelOrUrl(e.target.value)}
                placeholder="ludwig or https://www.twitch.tv/ludwig"
                className="twitch-input mt-1"
              />
            </div>
            <div>
              <label className="twitch-muted text-xs font-medium">Highlight threshold</label>
              <input
                type="number"
                value={threshold}
                min={0}
                max={100}
                onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value || "80"))))}
                className="twitch-input mt-1"
              />
            </div>
            <div>
              <label className="twitch-muted text-xs font-medium">Current game (context hint)</label>
              <input
                value={currentGame}
                onChange={(e) => setCurrentGame(e.target.value)}
                placeholder="Marvel Rivals / League / Just Chatting"
                className="twitch-input mt-1"
              />
            </div>
          </div>

          <div className="twitch-muted mt-3 text-xs">
            MVP uses local faster-whisper transcription from a server-configured local audio source path, plus Twitch IRC for live chat.
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
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
                    token: useAnonymousIrc ? "" : token.trim(),
                    channelOrUrl: channelOrUrl.trim(),
                    currentGame: currentGame.trim(),
                    thresholdScoreExclusive: threshold,
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
