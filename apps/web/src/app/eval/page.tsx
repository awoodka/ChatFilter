"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

type JobStatus = {
  jobId: string;
  type?: string;
  state: "queued" | "running" | "succeeded" | "failed";
  step?: string;
  error?: string;
};

type EvalResultsResponse = {
  ok: boolean;
  jobId: string;
  threshold_score_exclusive: number;
  minScore: number;
  total_results_scanned: number;
  high_scoring: Array<Record<string, unknown>>;
  read_aloud?: Array<Record<string, unknown>>;
  scanned?: Array<Record<string, unknown>>;
  scanned_limit?: number;
  summary: Record<string, unknown>;
};

type HighScoringMsg = {
  ts_ms: number;
  score: number;
  text: string;
  username: string | null;
  user_id: string | null;
  label_read_aloud: boolean | null;
  reason: string | null;
};

function toHighScoringMsg(obj: Record<string, unknown>): HighScoringMsg | null {
  const ts_ms = obj["ts_ms"];
  const score = obj["score"];
  const text = obj["text"];
  if (typeof ts_ms !== "number") return null;
  if (typeof score !== "number") return null;
  if (typeof text !== "string") return null;
  const username = typeof obj["username"] === "string" ? obj["username"] : null;
  const user_id = typeof obj["user_id"] === "string" ? obj["user_id"] : null;
  const label_read_aloud = typeof obj["label_read_aloud"] === "boolean" ? obj["label_read_aloud"] : null;
  const reason = typeof obj["reason"] === "string" ? obj["reason"] : null;
  return { ts_ms, score, text, username, user_id, label_read_aloud, reason };
}

export default function EvalPage() {
  const [vodIds, setVodIds] = useState<string[]>([]);
  const [vodId, setVodId] = useState<string>("");
  const [scope, setScope] = useState<"full" | "first_n">("full");
  const [firstN, setFirstN] = useState<number>(500);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logText, setLogText] = useState("{ }");
  const [results, setResults] = useState<EvalResultsResponse | null>(null);
  const [messages, setMessages] = useState<HighScoringMsg[] | null>(null);
  const [readAloudMessages, setReadAloudMessages] = useState<HighScoringMsg[] | null>(null);
  const [scannedMessages, setScannedMessages] = useState<HighScoringMsg[] | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);

  const loadVodIds = async () => {
    const r = await fetch("/api/vods", { cache: "no-store" });
    const j = (await r.json()) as unknown;
    if (!isRecord(j) || j["ok"] !== true) return;
    const ids = j["vodIds"];
    if (!Array.isArray(ids)) return;
    const cleaned = ids.filter((x) => typeof x === "string");
    setVodIds(cleaned);
    if (!vodId && cleaned.length > 0) setVodId(cleaned[0]!);
  };

  const initialJobId = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("jobId");
  }, []);

  const loadResults = async (jid: string) => {
    setResultsError(null);
    setResults(null);
    setMessages(null);
    setReadAloudMessages(null);
    setScannedMessages(null);
    try {
      const r = await fetch(`/api/jobs/${jid}/eval-results?scannedLimit=50000`, { cache: "no-store" });
      const j = (await r.json()) as unknown;
      if (!isRecord(j) || j["ok"] !== true) {
        setResultsError(`Failed to load eval results: ${JSON.stringify(j, null, 2)}`);
        return;
      }
      const parsed = j as unknown as EvalResultsResponse;
      setResults(parsed);
      const msgs = (parsed.high_scoring ?? [])
        .map((x) => (isRecord(x) ? toHighScoringMsg(x) : null))
        .filter((x): x is HighScoringMsg => Boolean(x))
        .sort((a, b) => b.score - a.score);
      setMessages(msgs);

      const read = (parsed.read_aloud ?? [])
        .map((x) => (isRecord(x) ? toHighScoringMsg(x) : null))
        .filter((x): x is HighScoringMsg => Boolean(x))
        .sort((a, b) => b.score - a.score);
      setReadAloudMessages(read);

      const scanned = (parsed.scanned ?? [])
        .map((x) => (isRecord(x) ? toHighScoringMsg(x) : null))
        .filter((x): x is HighScoringMsg => Boolean(x))
        .sort((a, b) => a.ts_ms - b.ts_ms);
      setScannedMessages(scanned);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResultsError(`Failed to load eval results: ${msg}`);
    }
  };

  const poll = async (jid: string) => {
    const r = await fetch(`/api/jobs/${jid}`, { cache: "no-store" });
    const j = (await r.json()) as unknown;
    if (isRecord(j) && j["ok"] === true && isRecord(j["status"])) {
      const s = j["status"] as unknown as JobStatus;
      setJobStatus(s);
      const header = `jobId=${s.jobId} type=${s.type ?? ""} state=${s.state} step=${s.step ?? ""}\n\n`;
      setLogText(header + (j.logTail ?? ""));
      if (s.state === "succeeded" || s.state === "failed") {
        setIsRunning(false);
        if (s.state === "succeeded") void loadResults(jid);
        return;
      }
      setTimeout(() => void poll(jid), 1500);
    } else {
      setIsRunning(false);
      setLogText(JSON.stringify(j, null, 2));
    }
  };

  useEffect(() => {
    if (!initialJobId) return;
    setJobId(initialJobId);
    setIsRunning(true);
    void poll(initialJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/vods", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true) return;
        const ids = j["vodIds"];
        if (!Array.isArray(ids)) return;
        const cleaned = ids.filter((x) => typeof x === "string");
        if (!cancelled) setVodIds(cleaned);
        if (!cancelled && !vodId && cleaned.length > 0) setVodId(cleaned[0]!);
      } catch {
        // ignore (dashboard still works with manual VOD id entry later if needed)
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="twitch-page">
      <div className="twitch-shell">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Eval dashboard</h1>
          <Link className="twitch-link text-sm" href="/">
            Back
          </Link>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Import a Twitch VOD</h2>
          <p className="twitch-muted mt-1 text-sm">
            Paste a Twitch VOD URL to download chat + audio, transcribe, convert to JSONL, and filter messages for eval.
          </p>
          <VodImportForm onImported={async () => void loadVodIds()} />
        </div>

        <div className="twitch-card mt-6 p-5">
          <label className="text-sm font-medium">Imported VOD</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={vodId}
              onChange={(e) => setVodId(e.target.value)}
              className="twitch-input"
            >
              {vodIds.length === 0 ? (
                <option value="">No imported VODs found</option>
              ) : (
                vodIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div>
              <label className="twitch-muted text-xs font-medium">How many messages to score</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "full" | "first_n")}
                className="twitch-input mt-1"
              >
                <option value="full">Whole VOD (all filtered messages)</option>
                <option value="first_n">First N filtered messages (chronological)</option>
              </select>
            </div>
            <div>
              <label className="twitch-muted text-xs font-medium">N (only if “First N”)</label>
              <input
                type="number"
                value={firstN}
                min={1}
                step={1}
                disabled={scope !== "first_n"}
                onChange={(e) => setFirstN(Math.max(1, Math.floor(Number(e.target.value || "1"))))}
                className="twitch-input mt-1"
              />
              <div className="twitch-muted mt-1 text-[11px]">Server enforces an upper cap for safety.</div>
            </div>
          </div>

          <div className="twitch-muted mt-3 text-xs">
            Eval config (model, prompts, caches, threshold) is server-controlled and not editable from the UI.
          </div>

          <button
            className="twitch-button-primary mt-4"
            disabled={isRunning || !vodId.trim()}
            onClick={async () => {
              setIsRunning(true);
              setLogText("Starting eval job…");
              setResults(null);
              setMessages(null);
              setReadAloudMessages(null);
              setScannedMessages(null);
              setResultsError(null);
              setJobStatus(null);
              const res = await fetch("/api/eval/judge", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  vodUrlOrId: vodId.trim(),
                  scope,
                  firstN: scope === "first_n" ? firstN : undefined,
                }),
              });
              const json = (await res.json()) as unknown;
              const jid = isRecord(json) && typeof json["jobId"] === "string" ? json["jobId"] : null;
              if (jid) {
                setJobId(jid);
                const params = new URLSearchParams(window.location.search);
                params.set("jobId", jid);
                window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
                setLogText(`Job started: ${jid}\nPolling logs…`);
                setTimeout(() => void poll(jid), 500);
              } else {
                setIsRunning(false);
                setLogText(JSON.stringify(json, null, 2));
              }
            }}
          >
            {isRunning ? `Running${jobId ? ` (${jobId})` : ""}…` : "Run evaluation"}
          </button>

          {jobId && jobStatus?.state === "failed" && !isRunning ? (
            <button
              className="twitch-button-secondary mt-2"
              onClick={async () => {
                setIsRunning(true);
                setLogText(`Resuming failed job… (${jobId})`);
                setResults(null);
                setMessages(null);
                setReadAloudMessages(null);
                setScannedMessages(null);
                setResultsError(null);
                const res = await fetch("/api/eval/judge", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    vodUrlOrId: vodId.trim(),
                    scope,
                    firstN: scope === "first_n" ? firstN : undefined,
                    resumeJobId: jobId,
                  }),
                });
                const json = (await res.json()) as unknown;
                const jid = isRecord(json) && typeof json["jobId"] === "string" ? json["jobId"] : null;
                if (jid) {
                  setJobId(jid);
                  setTimeout(() => void poll(jid), 500);
                } else {
                  setIsRunning(false);
                  setLogText(JSON.stringify(json, null, 2));
                }
              }}
            >
              Resume failed job
            </button>
          ) : null}
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Results</h2>
          {resultsError ? (
            <pre className="twitch-scroll mt-3 overflow-auto p-3 text-xs">
              {resultsError}
            </pre>
          ) : results ? (
            <div className="mt-3 grid gap-4">
              <pre className="twitch-scroll overflow-auto p-3 text-xs">
                {JSON.stringify(results.summary, null, 2)}
              </pre>

              <div className="twitch-card-soft p-3">
                <div className="text-sm font-medium">
                  High-scoring chat (score &gt; {results.threshold_score_exclusive})
                </div>
                <div className="twitch-muted mt-1 text-xs">
                  Showing {messages?.length ?? 0} messages (sorted by score desc)
                </div>

                <div className="twitch-scroll mt-3 max-h-[360px] overflow-auto p-2">
                  {messages && messages.length > 0 ? (
                    <div className="space-y-2">
                      {messages.map((m, idx) => (
                        <div key={`${m.ts_ms}-${idx}`} className="twitch-card-soft p-2 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="twitch-muted text-xs">
                              <span className="font-medium text-zinc-100">{m.username ?? "unknown"}</span>
                              <span className="ml-2">ts_ms={m.ts_ms}</span>
                              {typeof m.label_read_aloud === "boolean" ? (
                                <span className="ml-2">label={m.label_read_aloud ? "read" : "not_read"}</span>
                              ) : null}
                            </div>
                            <div className="text-xs font-medium">score={m.score.toFixed(1)}</div>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                          {m.reason ? <div className="twitch-muted mt-1 text-xs">{m.reason}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="twitch-muted p-2 text-xs">(none yet)</div>
                  )}
                </div>
              </div>

              <div className="twitch-card-soft p-3">
                <div className="text-sm font-medium">Read-aloud chat (ground truth label=true)</div>
                <div className="twitch-muted mt-1 text-xs">
                  Showing {readAloudMessages?.length ?? 0} messages (sorted by score desc; low scores here are “missed gems”)
                </div>

                <div className="twitch-scroll mt-3 max-h-[360px] overflow-auto p-2">
                  {readAloudMessages && readAloudMessages.length > 0 ? (
                    <div className="space-y-2">
                      {readAloudMessages.map((m, idx) => (
                        <div key={`${m.ts_ms}-${idx}`} className="twitch-card-soft p-2 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="twitch-muted text-xs">
                              <span className="font-medium text-zinc-100">{m.username ?? "unknown"}</span>
                              <span className="ml-2">ts_ms={m.ts_ms}</span>
                              <span className="ml-2">label=read</span>
                            </div>
                            <div className="text-xs font-medium">
                              score={m.score.toFixed(1)}{" "}
                              {results ? (
                                m.score > results.threshold_score_exclusive ? (
                                  <span className="text-green-400">(hit)</span>
                                ) : (
                                  <span className="text-amber-300">(miss)</span>
                                )
                              ) : null}
                            </div>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                          {m.reason ? <div className="twitch-muted mt-1 text-xs">{m.reason}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="twitch-muted p-2 text-xs">(none yet)</div>
                  )}
                </div>
              </div>

              <div className="twitch-card-soft p-3">
                <div className="text-sm font-medium">Scanned chat (all messages scored in this eval)</div>
                <div className="twitch-muted mt-1 text-xs">
                  Showing {scannedMessages?.length ?? 0} / {results.total_results_scanned} scored messages (chronological)
                  {typeof results.scanned_limit === "number" ? `; scannedLimit=${results.scanned_limit}` : ""}
                </div>

                <div className="twitch-scroll mt-3 max-h-[360px] overflow-auto p-2">
                  {scannedMessages && scannedMessages.length > 0 ? (
                    <div className="space-y-2">
                      {scannedMessages.map((m, idx) => (
                        <div key={`${m.ts_ms}-${idx}`} className="twitch-card-soft p-2 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="twitch-muted text-xs">
                              <span className="font-medium text-zinc-100">{m.username ?? "unknown"}</span>
                              <span className="ml-2">ts_ms={m.ts_ms}</span>
                              {typeof m.label_read_aloud === "boolean" ? (
                                <span className="ml-2">label={m.label_read_aloud ? "read" : "not_read"}</span>
                              ) : null}
                            </div>
                            <div className="text-xs font-medium">score={m.score.toFixed(1)}</div>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="twitch-muted p-2 text-xs">(none yet)</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="twitch-muted mt-3 text-sm">Run an evaluation to populate results.</div>
          )}
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Logs</h2>
          <pre className="twitch-scroll mt-3 max-h-[520px] overflow-auto p-3 text-xs">
            {logText}
          </pre>
        </div>
      </div>
    </div>
  );
}

function VodImportForm({ onImported }: { onImported?: () => Promise<void> | void }) {
  const [isRunning, setIsRunning] = useState(false);
  const [resultText, setResultText] = useState("{ }");
  const [jobId, setJobId] = useState<string | null>(null);

  const pollJob = async (jid: string) => {
    try {
      const r = await fetch(`/api/jobs/${jid}`, { cache: "no-store" });
      const j = (await r.json()) as unknown;
      if (!isRecord(j) || j["ok"] !== true || !isRecord(j["status"])) {
        setResultText(`Failed to load job status for ${jid}.\n\n${JSON.stringify(j, null, 2)}`);
        setIsRunning(false);
        return;
      }
      const s = j["status"] as unknown as JobStatus;
      const header = `jobId=${s.jobId} type=${s.type ?? ""} state=${s.state} step=${s.step ?? ""}\n\n`;
      setResultText(header + (typeof j["logTail"] === "string" ? j["logTail"] : ""));
      if (s.state === "succeeded" || s.state === "failed") {
        setIsRunning(false);
        if (s.state === "succeeded") await onImported?.();
        return;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResultText(`Polling error for ${jid}: ${msg}`);
      setIsRunning(false);
      return;
    }
    setTimeout(() => void pollJob(jid), 1500);
  };

  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setIsRunning(true);
        setResultText("Starting job…");
        setJobId(null);
        const form = e.currentTarget as HTMLFormElement;
        const fd = new FormData(form);
        const vodUrl = String(fd.get("vodUrl") ?? "");
        const channel = String(fd.get("channel") ?? "");
        try {
          const res = await fetch("/api/vod/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vodUrl, channel: channel || undefined, targetKeep: 0.2 }),
          });
          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const json = (await res.json()) as unknown;
            const jid = isRecord(json) && typeof json["jobId"] === "string" ? json["jobId"] : null;
            if (jid) {
              setJobId(jid);
              setResultText(`Job started: ${jid}\nPolling logs…`);
              setTimeout(() => void pollJob(jid), 500);
            } else {
              setResultText(JSON.stringify(json, null, 2));
              setIsRunning(false);
            }
          } else {
            const txt = await res.text();
            setResultText(`Non-JSON response (status ${res.status}).\n\n${txt}`);
            setIsRunning(false);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          setResultText(`Request failed: ${msg}`);
          setIsRunning(false);
        }
      }}
    >
      <label className="text-sm font-medium" htmlFor="evalVodUrl">
        VOD URL
      </label>
      <input
        id="evalVodUrl"
        name="vodUrl"
        placeholder="https://www.twitch.tv/videos/1234567890"
        className="twitch-input"
        required
      />
      <label className="text-sm font-medium" htmlFor="evalChannel">
        Channel (optional)
      </label>
      <input
        id="evalChannel"
        name="channel"
        placeholder="streamername"
        className="twitch-input"
      />
      <button
        type="submit"
        className="twitch-button-primary mt-2"
        disabled={isRunning}
      >
        {isRunning ? `Import running${jobId ? ` (${jobId})` : ""}…` : "Import (download + transcribe + convert + filter)"}
      </button>
      <pre className="twitch-scroll mt-3 max-h-[360px] overflow-auto p-3 text-xs">
        {resultText}
      </pre>
    </form>
  );
}

