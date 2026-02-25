"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LiveStatus, loadLiveSnapshot, saveLiveSnapshotPatch } from "@/lib/live/sessionSnapshot";

type LiveIndicatorState = "checking" | "live" | "idle" | "error";
type TimelinePoint = {
  tsMs: number;
  seen: number;
  filtered: number;
  highlighted: number;
};

type Totals = {
  seen: number;
  filtered: number;
  highlighted: number;
  dropped: number;
  filteredOnly: number;
};

type LiveStatsResponse = {
  ok: true;
  windowHours: number;
  bucketMinutes: number;
  windowStartMs: number;
  windowEndMs: number;
  timeline: TimelinePoint[];
  totals: {
    window: Totals;
    allTime: Totals;
  };
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isLiveStatus(x: unknown): x is LiveStatus {
  if (!isRecord(x)) return false;
  const state = x["state"];
  const jobId = x["jobId"];
  return typeof jobId === "string" && (state === "queued" || state === "running" || state === "succeeded" || state === "failed");
}

function isTotals(x: unknown): x is Totals {
  if (!isRecord(x)) return false;
  return (
    isFiniteNumber(x["seen"]) &&
    isFiniteNumber(x["filtered"]) &&
    isFiniteNumber(x["highlighted"]) &&
    isFiniteNumber(x["dropped"]) &&
    isFiniteNumber(x["filteredOnly"])
  );
}

function isTimelinePoint(x: unknown): x is TimelinePoint {
  if (!isRecord(x)) return false;
  return isFiniteNumber(x["tsMs"]) && isFiniteNumber(x["seen"]) && isFiniteNumber(x["filtered"]) && isFiniteNumber(x["highlighted"]);
}

function isLiveStatsResponse(x: unknown): x is LiveStatsResponse {
  if (!isRecord(x) || x["ok"] !== true) return false;
  const totals = x["totals"];
  if (!isRecord(totals) || !isTotals(totals["window"]) || !isTotals(totals["allTime"])) return false;
  const timeline = x["timeline"];
  if (!Array.isArray(timeline) || !timeline.every(isTimelinePoint)) return false;
  return isFiniteNumber(x["windowHours"]) && isFiniteNumber(x["bucketMinutes"]) && isFiniteNumber(x["windowStartMs"]) && isFiniteNumber(x["windowEndMs"]);
}

function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

type TimeRange = "24h" | "7d" | "all";

const TIME_RANGE_CONFIG: Record<TimeRange, { windowHours: number; bucketMinutes: number; label: string }> = {
  "24h": { windowHours: 24, bucketMinutes: 60, label: "24h" },
  "7d": { windowHours: 168, bucketMinutes: 360, label: "7d" },
  "all": { windowHours: 0, bucketMinutes: 1440, label: "All" },
};

function formatBucketLabel(tsMs: number, range: TimeRange): string {
  const d = new Date(tsMs);
  if (range === "24h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "7d") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function buildPolylinePoints(timeline: TimelinePoint[], key: "seen" | "filtered" | "highlighted", maxY: number): string {
  const viewWidth = 840;
  const viewHeight = 250;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 34;
  const innerWidth = Math.max(1, viewWidth - padLeft - padRight);
  const innerHeight = Math.max(1, viewHeight - padTop - padBottom);
  const n = Math.max(1, timeline.length);
  return timeline
    .map((point, idx) => {
      const x = n <= 1 ? padLeft : padLeft + (idx / (n - 1)) * innerWidth;
      const y = padTop + (1 - point[key] / maxY) * innerHeight;
      return `${x},${y}`;
    })
    .join(" ");
}

function TimelineGraph({ timeline, range }: { timeline: TimelinePoint[]; range: TimeRange }) {
  const maxY = Math.max(1, ...timeline.map((p) => Math.max(p.seen, p.filtered, p.highlighted)));
  const viewWidth = 840;
  const viewHeight = 250;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 34;
  const innerWidth = Math.max(1, viewWidth - padLeft - padRight);
  const innerHeight = Math.max(1, viewHeight - padTop - padBottom);
  const gridTicks = [0, 0.25, 0.5, 0.75, 1];
  const first = timeline[0];
  const middle = timeline[Math.floor(timeline.length / 2)];
  const last = timeline[Math.max(0, timeline.length - 1)];

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1 text-zinc-200">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#60a5fa]" />
          Seen
        </span>
        <span className="inline-flex items-center gap-1 text-zinc-200">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#a78bfa]" />
          Filtered
        </span>
        <span className="inline-flex items-center gap-1 text-zinc-200">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#34d399]" />
          Highlighted
        </span>
      </div>
      <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} className="h-60 w-full">
        {gridTicks.map((tick) => {
          const y = padTop + (1 - tick) * innerHeight;
          const value = Math.round(maxY * tick);
          return (
            <g key={tick}>
              <line x1={padLeft} y1={y} x2={padLeft + innerWidth} y2={y} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <text x={padLeft - 8} y={y + 4} textAnchor="end" fill="#9ca3af" fontSize="10">
                {value}
              </text>
            </g>
          );
        })}

        <polyline
          points={buildPolylinePoints(timeline, "seen", maxY)}
          fill="none"
          stroke="#60a5fa"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={buildPolylinePoints(timeline, "filtered", maxY)}
          fill="none"
          stroke="#a78bfa"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={buildPolylinePoints(timeline, "highlighted", maxY)}
          fill="none"
          stroke="#34d399"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {first ? (
          <text x={padLeft} y={viewHeight - 10} textAnchor="start" fill="#9ca3af" fontSize="10">
            {formatBucketLabel(first.tsMs, range)}
          </text>
        ) : null}
        {middle ? (
          <text x={padLeft + innerWidth / 2} y={viewHeight - 10} textAnchor="middle" fill="#9ca3af" fontSize="10">
            {formatBucketLabel(middle.tsMs, range)}
          </text>
        ) : null}
        {last ? (
          <text x={padLeft + innerWidth} y={viewHeight - 10} textAnchor="end" fill="#9ca3af" fontSize="10">
            {formatBucketLabel(last.tsMs, range)}
          </text>
        ) : null}
      </svg>
    </div>
  );
}

function DistributionPie({ totals }: { totals: Totals }) {
  const segments = [
    { key: "highlighted", label: "Highlighted", value: totals.highlighted, color: "#34d399" },
    { key: "filteredOnly", label: "Filtered (not highlighted)", value: totals.filteredOnly, color: "#a78bfa" },
    { key: "dropped", label: "Dropped by filter", value: totals.dropped, color: "#52525b" },
  ];
  const seenTotal = Math.max(0, totals.seen);
  let cursor = 0;
  const gradientStops = segments
    .map((segment) => {
      const start = cursor;
      const pct = seenTotal <= 0 ? 0 : (segment.value / seenTotal) * 100;
      cursor += pct;
      return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    })
    .join(", ");

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative h-40 w-40 shrink-0">
        <div
          className="h-40 w-40 rounded-full border border-[var(--border)]"
          style={{ background: seenTotal > 0 ? `conic-gradient(${gradientStops})` : "#1f1f23" }}
        />
        <div className="absolute inset-[22%] flex items-center justify-center rounded-full border border-[var(--border)] bg-[#0f0f13] text-center">
          <div>
            <div className="text-[11px] twitch-muted">Seen</div>
            <div className="text-sm font-semibold">{formatCount(seenTotal)}</div>
          </div>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        {segments.map((segment) => {
          const pct = seenTotal > 0 ? (segment.value / seenTotal) * 100 : 0;
          return (
            <div key={segment.key} className="flex items-center justify-between gap-4">
              <div className="inline-flex items-center gap-2 text-zinc-200">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: segment.color }} />
                {segment.label}
              </div>
              <div className="text-zinc-300">
                {formatCount(segment.value)} ({pct.toFixed(1)}%)
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const [liveIndicator, setLiveIndicator] = useState<LiveIndicatorState>("checking");
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [stats, setStats] = useState<LiveStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");

  useEffect(() => {
    let cancelled = false;

    const refreshLiveIndicator = async () => {
      const snapshot = loadLiveSnapshot();
      if (!snapshot?.sessionId) {
        if (!cancelled) {
          setLiveSessionId(null);
          setLiveIndicator("idle");
        }
        return;
      }

      if (!cancelled) {
        setLiveSessionId(snapshot.sessionId);
        setLiveIndicator("checking");
      }

      try {
        const r = await fetch(`/api/live/${encodeURIComponent(snapshot.sessionId)}`, { cache: "no-store" });
        const j = (await r.json()) as unknown;
        const status = isRecord(j) ? j["status"] : null;
        if (!isRecord(j) || j["ok"] !== true || !isLiveStatus(status)) {
          const errorText = isRecord(j) && typeof j["error"] === "string" ? j["error"].toLowerCase() : "";
          const missingSession = r.status === 404 || errorText.includes("not found");
          if (missingSession) {
            saveLiveSnapshotPatch({ sessionId: snapshot.sessionId, status: null, isRunning: false });
            if (!cancelled) setLiveIndicator("idle");
            return;
          }
          if (!cancelled) setLiveIndicator(snapshot.isRunning ? "error" : "idle");
          return;
        }
        const isLive = status.state === "queued" || status.state === "running";
        saveLiveSnapshotPatch({ sessionId: snapshot.sessionId, status, isRunning: isLive });
        if (!cancelled) setLiveIndicator(isLive ? "live" : "idle");
      } catch {
        if (!cancelled) setLiveIndicator(snapshot.isRunning ? "error" : "idle");
      }
    };

    void refreshLiveIndicator();
    const id = window.setInterval(() => {
      void refreshLiveIndicator();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatsLoading(true);

    const cfg = TIME_RANGE_CONFIG[timeRange];
    const refreshStats = async () => {
      try {
        const r = await fetch(
          `/api/home/live-stats?windowHours=${cfg.windowHours}&bucketMinutes=${cfg.bucketMinutes}`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as unknown;
        if (!isLiveStatsResponse(j)) {
          const message = isRecord(j) && typeof j["error"] === "string" ? j["error"] : "Failed to load live stats.";
          if (!cancelled) setStatsError(message);
          return;
        }
        if (!cancelled) {
          setStats(j);
          setStatsError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) setStatsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };

    void refreshStats();
    const id = window.setInterval(() => {
      void refreshStats();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [timeRange]);

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-5xl">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">ChatFilter</h1>
        </div>

        <div className="twitch-card mt-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Live monitor status</div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Link
              href={liveSessionId ? `/live?sessionId=${encodeURIComponent(liveSessionId)}` : "/live"}
              className="twitch-button-secondary inline-flex items-center"
            >
              Open live monitor
            </Link>
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-semibold ${
                liveIndicator === "live"
                  ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                  : liveIndicator === "checking"
                    ? "border-[#9147ff]/40 bg-[#9147ff]/10 text-[#d6bcff]"
                    : liveIndicator === "error"
                      ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                      : "border-[var(--border)] bg-[#121217] text-zinc-300"
              }`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  liveIndicator === "live"
                    ? "bg-emerald-300"
                    : liveIndicator === "checking"
                      ? "bg-[#c9a3ff]"
                      : liveIndicator === "error"
                    ? "bg-amber-300"
                        : "bg-zinc-500"
                }`}
              />
              {liveIndicator === "live"
                ? "LIVE"
                : liveIndicator === "checking"
                  ? "Checking..."
                  : liveIndicator === "error"
                    ? "Status unavailable"
                    : "Not running"}
            </div>
          </div>
        </div>

        <div className="twitch-card mt-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Your live chat analytics</h2>
            <div className="twitch-muted text-xs">Per-account tracking</div>
          </div>
          {statsError ? <div className="mt-2 text-xs text-amber-300">{statsError}</div> : null}

          {stats ? (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="twitch-card-soft p-3">
                  <div className="twitch-muted text-[11px]">Seen (all-time)</div>
                  <div className="mt-1 text-xl font-semibold text-blue-300">{formatCount(stats.totals.allTime.seen)}</div>
                </div>
                <div className="twitch-card-soft p-3">
                  <div className="twitch-muted text-[11px]">Filtered (all-time)</div>
                  <div className="mt-1 text-xl font-semibold text-[#cab0ff]">{formatCount(stats.totals.allTime.filtered)}</div>
                </div>
                <div className="twitch-card-soft p-3">
                  <div className="twitch-muted text-[11px]">Highlighted (all-time)</div>
                  <div className="mt-1 text-xl font-semibold text-emerald-300">{formatCount(stats.totals.allTime.highlighted)}</div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
                <div className="twitch-card-soft p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-zinc-200">
                      {timeRange === "all" ? "All-time activity" : `Last ${stats.windowHours}h activity`}
                    </div>
                    <div className="flex gap-1">
                      {(Object.keys(TIME_RANGE_CONFIG) as TimeRange[]).map((key) => (
                        <button
                          key={key}
                          onClick={() => setTimeRange(key)}
                          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            timeRange === key
                              ? "bg-[#9147ff] text-white"
                              : "bg-[var(--panel)] text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {TIME_RANGE_CONFIG[key].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <TimelineGraph timeline={stats.timeline} range={timeRange} />
                </div>
                <div className="twitch-card-soft p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-200">Seen message distribution (all-time)</div>
                  <DistributionPie totals={stats.totals.allTime} />
                </div>
              </div>
            </>
          ) : statsLoading ? (
            <div className="mt-2 text-xs twitch-muted">Loading analytics...</div>
          ) : (
            <div className="mt-2 text-xs twitch-muted">No live analytics yet. Start Live MVP to begin tracking.</div>
          )}
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Link
            href="/eval"
            className="twitch-card block p-5 transition-colors hover:border-[#9147ff]"
          >
            <div className="text-base font-medium">Testing dashboard</div>
            <div className="mt-1 text-sm twitch-muted">
              Run offline evals on imported VODs, inspect metrics, and review high-scoring + read-aloud chats.
            </div>
            <div className="mt-3 text-xs twitch-link">Open /eval</div>
          </Link>
          <Link
            href="/practice"
            className="twitch-card block p-5 transition-colors hover:border-[#9147ff]"
          >
            <div className="text-base font-medium">Practice chat</div>
            <div className="mt-1 text-sm twitch-muted">
              Generate AI chat messages to practice reacting to during streams.
            </div>
            <div className="mt-3 text-xs twitch-link">Open /practice</div>
          </Link>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Prereqs</h2>
          <ul className="mt-2 list-disc pl-5 text-sm twitch-muted">
            <li>
              <code className="twitch-code">TwitchDownloaderCLI</code>{" "}
              available on PATH
            </li>
            <li>
              <code className="twitch-code">yt-dlp</code> available on PATH
            </li>
            <li>
              <code className="twitch-code">OPENAI_API_KEY</code> set for transcription
            </li>
            <li>
              Python package installed:{" "}
              <code className="twitch-code">pip install -e backend/chatfilter</code>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
