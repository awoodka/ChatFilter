import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { NextResponse } from "next/server";

import { appendJobLog, JobStatus, readJobStatus, writeJobStatus } from "@/lib/job";
import { runCommandStreaming } from "@/lib/proc";
import { extractVodId, legacyCachesDir, userCachesDir, vodDir } from "@/lib/vod";
import { getEvalServerConfig } from "@/lib/server/evalConfig";
import { LongTermCache, SessionCache, ShortTermCache, readJson, writeJson } from "@/lib/server/caches";
import { createJudgeRateLimiter, scoreWithRetries } from "@/lib/server/judge";
import { buildHighlightUserPrompt, deriveVibeFromLongTerm } from "@/lib/server/highlightPrompt";
import { getOrCreateUserProfile, updateUserProfile } from "@/lib/server/userProfile";
import { userOwnsVod } from "@/lib/server/vodOwnership";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toChatMsg(obj: Record<string, unknown>): ChatMsg | null {
  const ts_ms = obj["ts_ms"];
  const text = obj["text"];
  if (typeof ts_ms !== "number") return null;
  if (typeof text !== "string") return null;
  const username = typeof obj["username"] === "string" ? obj["username"] : null;
  const user_id = typeof obj["user_id"] === "string" ? obj["user_id"] : null;
  return { ts_ms, text, username, user_id };
}

type TranscriptSeg = {
  start_ms: number;
  end_ms: number;
  text: string;
};

function toTranscriptSeg(obj: Record<string, unknown>): TranscriptSeg | null {
  const start_ms = obj["start_ms"];
  const end_ms = obj["end_ms"];
  const text = obj["text"];
  if (typeof start_ms !== "number") return null;
  if (typeof end_ms !== "number") return null;
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return { start_ms, end_ms, text: t };
}

function clampTopN<K>(entries: Array<[K, number]>, n: number): Array<[K, number]> {
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, n);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "he",
  "her",
  "his",
  "i",
  "im",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "u",
  "ur",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

function normForTokens(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensForTopics(s: string): string[] {
  const t = normForTokens(s);
  if (!t) return [];
  return t
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !STOPWORDS.has(x) && !/^\d+$/.test(x));
}

type EvalRequest = {
  vodUrlOrId: string;
  // Paths are optional; if omitted we auto-pick latest artifacts under data/vods/<vodId>/...
  canonicalChatJsonl?: string;
  filteredJsonl?: string;
  transcriptJsonl?: string;
  // Optional: dashboard-controlled scope (does NOT allow editing prompts/caches/models).
  // - "full": score all candidate messages (can be expensive)
  // - "first_n": score first N candidate messages (chronological)
  scope?: "full" | "first_n";
  firstN?: number;
  // Optional: resume a previously failed eval job by reusing its existing artifacts/results file.
  resumeJobId?: string;
};

function tsLine(line: string) {
  return `[${new Date().toISOString()}] ${line}\n`;
}

function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function newestCanonicalChat(vodId: string): Promise<string | null> {
  const canonical = path.join(vodDir(vodId), "canonical");
  const files = (await listFiles(canonical)).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length === 0) return null;
  // choose the most recently modified jsonl
  const withStats = await Promise.all(
    files.map(async (f) => {
      const full = path.join(canonical, f);
      const st = await fs.stat(full);
      return { full, mtimeMs: st.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0]?.full ?? null;
}

async function newestTranscript(vodId: string): Promise<string | null> {
  const raw = path.join(vodDir(vodId), "raw");
  const dirs = await listDirs(raw);
  // job dirs start with job_
  const jobDirs = dirs.filter((d) => d.startsWith("job_"));
  const withStats = await Promise.all(
    jobDirs.map(async (d) => {
      const full = path.join(raw, d);
      const st = await fs.stat(full);
      return { full, mtimeMs: st.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const d of withStats) {
    const p = path.join(d.full, "transcript.jsonl");
    if (await fileExists(p)) return p;
  }
  return null;
}

type ChatMsg = {
  ts_ms: number;
  text: string;
  username?: string | null;
  user_id?: string | null;
};

function msgKey(m: { ts_ms: number; text: string; user_id?: string | null }): string {
  return `${m.ts_ms}|${m.user_id ?? ""}|${m.text}`;
}

async function labelsForWantedKeysFromJsonl(opts: {
  labeledChatJsonl: string;
  wantedKeys: Set<string>;
  onProgress?: (found: number, wanted: number) => Promise<void>;
}): Promise<Map<string, boolean>> {
  const { labeledChatJsonl, wantedKeys, onProgress } = opts;
  const out = new Map<string, boolean>();
  if (wantedKeys.size === 0) return out;

  const stream = fsSync.createReadStream(labeledChatJsonl, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      const ts_ms = obj["ts_ms"];
      const text = obj["text"];
      if (typeof ts_ms !== "number" || typeof text !== "string") continue;
      const user_id = typeof obj["user_id"] === "string" ? obj["user_id"] : null;
      const key = msgKey({ ts_ms, text, user_id });
      if (!wantedKeys.has(key)) continue;
      out.set(key, Boolean(obj["label_read_aloud"]));
      if (out.size % 25 === 0) await onProgress?.(out.size, wantedKeys.size);
      if (out.size >= wantedKeys.size) break;
    }
  } finally {
    rl.close();
    stream.close();
  }
  return out;
}

async function readJsonl<T>(p: string, limit?: number): Promise<T[]> {
  const txt = await fs.readFile(p, "utf-8");
  const lines = txt.split("\n").filter(Boolean);
  const slice = typeof limit === "number" ? lines.slice(0, limit) : lines;
  const out: T[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ignore
    }
  }
  return out;
}

async function runEvalJob(jobId: string, body: EvalRequest, user: { id: string; username: string }) {
  const cfg = await getEvalServerConfig();
  const userProfile = getOrCreateUserProfile(user.id);
  const existing = await readJobStatus(jobId);
  const createdAt = existing?.createdAt ?? Date.now();
  let job: JobStatus = {
    jobId,
    type: "eval",
    state: "running",
    createdAt,
    updatedAt: createdAt,
    step: "init",
  };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine("job start"));

  const vodId = extractVodId(body.vodUrlOrId ?? "");
  if (!vodId) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Could not extract VOD id" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }
  if (!userOwnsVod(user.id, vodId)) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "VOD is not associated with this account" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }

  const model = cfg.model;
  const maxMessages = cfg.maxMessages;
  const contextMessages = cfg.contextMessages;
  const labelWindowSec = cfg.labelWindowSec;
  const trialWindowMinutes = cfg.trialWindowMinutes;
  const useAllTrialWindowMessages = cfg.useAllTrialWindowMessages;
  const longTermCache = userProfile.longTermCache || cfg.longTermCache;
  const streamerKey = cfg.streamerKey;
  const sessionUpdateMinutes = cfg.sessionUpdateMinutes;
  const shortTermChatWindowSize = cfg.shortTermChatWindowSize;
  const shortTermLookbackMs = cfg.shortTermLookbackMs;
  const thresholdScore = cfg.thresholdScoreExclusive; // score > threshold
  const clientMaxFirstNCap = 10_000;

  const canonicalChatJsonl = body.canonicalChatJsonl ?? (await newestCanonicalChat(vodId));
  const transcriptJsonl = body.transcriptJsonl ?? (await newestTranscript(vodId));

  if (!canonicalChatJsonl || !(await fileExists(canonicalChatJsonl))) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Missing canonicalChatJsonl" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }
  if (!transcriptJsonl || !(await fileExists(transcriptJsonl))) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Missing transcriptJsonl" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }

  // Output artifact paths:
  // - if this jobId already has artifacts (resume), reuse them
  // - else create a new eval dir for this job
  const existingArtifacts = existing?.type === "eval" ? (existing.artifacts ?? {}) : {};
  const existingOutDir = typeof existingArtifacts["outDir"] === "string" ? existingArtifacts["outDir"] : null;
  const existingResults = typeof existingArtifacts["resultsJsonl"] === "string" ? existingArtifacts["resultsJsonl"] : null;
  const existingSummary = typeof existingArtifacts["summaryJson"] === "string" ? existingArtifacts["summaryJson"] : null;
  const existingLabeled = typeof existingArtifacts["labeledChatJsonl"] === "string" ? existingArtifacts["labeledChatJsonl"] : null;

  const isResume = Boolean(existingOutDir && existingResults);

  let outDir: string;
  let resultsJsonl: string;
  let summaryJson: string;
  let labeledChatJsonl: string;
  let filteredJsonl: string;
  const filteredMetricsJsonName = "filtered_live_equivalent.metrics.json";

  if (isResume && existingOutDir && existingResults) {
    outDir = existingOutDir;
    resultsJsonl = existingResults;
    summaryJson = existingSummary ?? path.join(outDir, "summary.json");
    labeledChatJsonl = existingLabeled ?? path.join(outDir, "labeled_chat.jsonl");
    filteredJsonl = path.join(outDir, "filtered_live_equivalent.jsonl");
    await fs.mkdir(outDir, { recursive: true });
  } else {
    const evalDir = path.join(vodDir(vodId), "evals");
    await fs.mkdir(evalDir, { recursive: true });
    const evalId = `eval_${Date.now()}_${jobId}`;
    outDir = path.join(evalDir, evalId);
    await fs.mkdir(outDir, { recursive: true });
    resultsJsonl = path.join(outDir, "results.jsonl");
    summaryJson = path.join(outDir, "summary.json");
    labeledChatJsonl = path.join(outDir, "labeled_chat.jsonl");
    filteredJsonl = path.join(outDir, "filtered_live_equivalent.jsonl");
    await fs.writeFile(resultsJsonl, "", "utf-8");
  }

  // JSON cache files (act as our 3 caches)
  const cacheDir = userCachesDir(user.id, streamerKey);
  const legacyCacheDir = legacyCachesDir(streamerKey);
  await fs.mkdir(cacheDir, { recursive: true });
  const longTermCachePath = path.join(cacheDir, "long_term.json");
  const sessionCachePath = path.join(cacheDir, "session.json");
  const shortTermCachePath = path.join(cacheDir, "short_term.json");
  const legacyLongTermCachePath = path.join(legacyCacheDir, "long_term.json");
  const legacySessionCachePath = path.join(legacyCacheDir, "session.json");
  const legacyShortTermCachePath = path.join(legacyCacheDir, "short_term.json");

  const repoRoot = path.join(process.cwd(), "..", "..");
  const pythonPath = path.join(repoRoot, "backend", "chatfilter", "src");
  const pyEnv = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}:${process.env.PYTHONPATH}` : pythonPath,
  };
  const knownEmotes = userProfile.emotes.filter((x) => x.trim()).slice(0, 200);

  job = {
    ...job,
    updatedAt: Date.now(),
    vodId,
    step: "align",
    meta: {
      model,
      maxMessages,
      contextMessages,
      labelWindowSec,
      trialWindowMinutes,
      useAllTrialWindowMessages,
      canonicalChatJsonl,
      filteredJsonl,
      transcriptJsonl,
      thresholdScore,
    },
    artifacts: { resultsJsonl, summaryJson, outDir, labeledChatJsonl },
  };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine(`step align (python chatfilter align) resume=${isResume ? 1 : 0}`));

  // If labeled chat already exists (resume), skip expensive align step.
  if (!(await fileExists(labeledChatJsonl))) {
    const pyAlign = await runCommandStreaming(
      "python3",
      [
        "-m",
        "chatfilter",
        "align",
        "--chat",
        canonicalChatJsonl,
        "--transcript",
        transcriptJsonl,
        "--output",
        labeledChatJsonl,
        "--window-sec",
        String(labelWindowSec),
      ],
      { env: pyEnv, onLine: (l, s) => void appendJobLog(jobId, tsLine(`${s}: ${l}`)) },
    );
    if (pyAlign.code !== 0) {
      job = { ...job, state: "failed", updatedAt: Date.now(), error: "Python chatfilter align failed" };
      await writeJobStatus(job);
      await appendJobLog(jobId, tsLine(`error: ${job.error}`));
      return;
    }
  } else {
    await appendJobLog(jobId, tsLine(`align skipped (labeled_chat.jsonl already exists)`));
  }

  // Recompute a live-equivalent filtered file for eval so offline scoring uses the same filter logic as live.
  // `chatfilter filter` uses the same hard filter core (`evaluate_live_candidate`) as live mode.
  // We set target-keep=1.0 so no additional quantile thinning is applied.
  job = { ...job, updatedAt: Date.now(), step: "filter_live_equivalent" };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine(`step filter_live_equivalent target_keep=1.0 resume=${isResume ? 1 : 0}`));
  if (!(isResume && (await fileExists(filteredJsonl)))) {
    const pyFilter = await runCommandStreaming(
      "python3",
      [
        "-m",
        "chatfilter",
        "filter",
        "--input",
        canonicalChatJsonl,
        "--output",
        filteredJsonl,
        "--metrics",
        path.join(outDir, filteredMetricsJsonName),
        "--target-keep",
        "1.0",
        ...knownEmotes.flatMap((e) => ["--known-emote", e]),
      ],
      { env: pyEnv, onLine: (l, s) => void appendJobLog(jobId, tsLine(`${s}: ${l}`)) },
    );
    if (pyFilter.code !== 0) {
      job = { ...job, state: "failed", updatedAt: Date.now(), error: "Python chatfilter filter (live-equivalent) failed" };
      await writeJobStatus(job);
      await appendJobLog(jobId, tsLine(`error: ${job.error}`));
      return;
    }
  } else {
    await appendJobLog(jobId, tsLine(`filter_live_equivalent skipped (existing output)`));
  }

  job = { ...job, updatedAt: Date.now(), step: "load" };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine(`loading canonical+filtered+transcript`));

  const canonical = await readJsonl<Record<string, unknown>>(canonicalChatJsonl);
  const filtered = await readJsonl<Record<string, unknown>>(filteredJsonl);
  const transcriptRows = await readJsonl<Record<string, unknown>>(transcriptJsonl);
  const transcriptSegs: TranscriptSeg[] = transcriptRows
    .map(toTranscriptSeg)
    .filter((s): s is TranscriptSeg => Boolean(s))
    .sort((a, b) => a.start_ms - b.start_ms);

  // sample from filtered messages deterministically:
  // - if trialWindowMinutes <= 0: entire VOD
  // - else: first N minutes (relative to earliest filtered message timestamp)
  const trialWindowMs = trialWindowMinutes <= 0 ? null : Math.max(0, Math.floor(trialWindowMinutes * 60_000));
  let minTsMs: number | null = null;
  for (const row of filtered) {
    const m = toChatMsg(row);
    if (!m) continue;
    if (minTsMs === null || m.ts_ms < minTsMs) minTsMs = m.ts_ms;
  }
  const cutoffTsMs = trialWindowMs === null || minTsMs === null ? null : minTsMs + trialWindowMs;

  const candidatesInWindow: ChatMsg[] = [];
  for (const row of filtered) {
    const m = toChatMsg(row);
    if (!m) continue;
    if (cutoffTsMs === null || m.ts_ms <= cutoffTsMs) candidatesInWindow.push(m);
  }
  candidatesInWindow.sort((a, b) => a.ts_ms - b.ts_ms); // simulate live
  const requestedScope = body.scope ?? "full";
  let candidates: ChatMsg[] = candidatesInWindow;
  let scopeNote = "";
  if (requestedScope === "first_n") {
    const nRaw = body.firstN;
    const n = Math.max(1, Math.min(clientMaxFirstNCap, typeof nRaw === "number" && Number.isFinite(nRaw) ? Math.floor(nRaw) : maxMessages));
    candidates = candidatesInWindow.slice(0, n);
    scopeNote = `first_n=${n} (cap=${clientMaxFirstNCap})`;
  } else {
    // default "full": still respect server toggle if explicitly configured off (safety)
    candidates = useAllTrialWindowMessages ? candidatesInWindow : candidatesInWindow.slice(0, maxMessages);
    scopeNote = useAllTrialWindowMessages ? "full" : `full_requested_but_server_capped_to_maxMessages=${maxMessages}`;
  }
  await appendJobLog(
    jobId,
    tsLine(
      [
        `trial window selection:`,
        `- trialWindowMinutes=${trialWindowMinutes} (${trialWindowMinutes <= 0 ? "full_vod" : "windowed"})`,
        `- minTsMs=${minTsMs ?? "null"} cutoffTsMs=${cutoffTsMs ?? "null"}`,
        `- inWindow=${candidatesInWindow.length}`,
        `- requestScope=${requestedScope} (${scopeNote})`,
        `- useAllTrialWindowMessages=${useAllTrialWindowMessages}`,
        `- maxMessages=${maxMessages} used=${candidates.length}`,
      ].join(" "),
    ),
  );

  // Precompute context: for each candidate, take the previous N canonical messages.
  const canonicalMsgs: ChatMsg[] = canonical.map(toChatMsg).filter((m): m is ChatMsg => Boolean(m)).sort((a, b) => a.ts_ms - b.ts_ms);

  // Load/init caches from JSON files
  let longCache =
    (await readJson<LongTermCache>(longTermCachePath)) ??
    (await readJson<LongTermCache>(legacyLongTermCachePath)) ??
    ({
      version: 1,
      updated_at_ms: Date.now(),
      streamer_style_summary: String(longTermCache ?? ""),
      positive_examples: [],
    } satisfies LongTermCache);

  let sessionCache: SessionCache =
    (await readJson<SessionCache>(sessionCachePath)) ??
    (await readJson<SessionCache>(legacySessionCachePath)) ??
    ({
      version: 1,
      updated_at_ms: Date.now(),
      window_start_ts_ms: null,
      window_end_ts_ms: null,
      top_chatters: [],
      top_topics: [],
      repeated_phrases: [],
    } satisfies SessionCache);

  let shortCache: ShortTermCache =
    (await readJson<ShortTermCache>(shortTermCachePath)) ??
    (await readJson<ShortTermCache>(legacyShortTermCachePath)) ??
    ({
      version: 1,
      updated_at_ms: Date.now(),
      recent_chat: [],
      transcript_last_60s: [],
      live_metrics: { msgs_last_60s: 0, msgs_per_min: 0 },
    } satisfies ShortTermCache);

  await writeJson(longTermCachePath, longCache);
  await writeJson(sessionCachePath, sessionCache);
  await writeJson(shortTermCachePath, shortCache);

  // Session cache stats (incremental up to each candidate timestamp)
  const tokenCounts = new Map<string, number>();
  const userCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  let canonicalIdxForSession = 0;
  let canonicalIdxForShort = 0;
  let transcriptIdxForShort = 0;
  const recentChatWindow: ChatMsg[] = [];
  const recentChatTimes: number[] = [];
  const recentTranscriptWindow: Array<{ end_ms: number; text: string }> = [];

  let nextSessionUpdateTsMs: number | null = null;
  const sessionUpdateMs = Math.max(60_000, Math.floor(sessionUpdateMinutes * 60_000));
  let lastCacheFlushWallMs = 0;
  const flushEveryNCandidates = 10; // keep files "live" on disk while eval runs
  const flushEveryWallMs = 2_000;

  function ingestForSession(m: ChatMsg) {
    const uid = m.user_id ?? m.username ?? "";
    if (uid) userCounts.set(uid, (userCounts.get(uid) ?? 0) + 1);
    for (const tok of tokensForTopics(m.text)) tokenCounts.set(tok, (tokenCounts.get(tok) ?? 0) + 1);
    const phrase = normForTokens(m.text);
    if (phrase.length >= 12 && phrase.length <= 80) phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
  }

  function maybeUpdateSessionCache(ts_ms: number) {
    if (nextSessionUpdateTsMs === null) nextSessionUpdateTsMs = ts_ms + sessionUpdateMs;
    if (ts_ms < nextSessionUpdateTsMs) return;
    // advance by whole steps to avoid drifting if there are gaps
    while (nextSessionUpdateTsMs !== null && ts_ms >= nextSessionUpdateTsMs) nextSessionUpdateTsMs += sessionUpdateMs;

    // store a compact session snapshot every ~10 minutes
    const topUsers = clampTopN(Array.from(userCounts.entries()), 10).map(([id, count]) => ({ id, count }));
    const topTopics = clampTopN(Array.from(tokenCounts.entries()), 20).map(([token, count]) => ({ token, count }));
    const repeated = clampTopN(
      Array.from(phraseCounts.entries()).filter(([, c]) => c >= 5),
      10,
    ).map(([phrase, count]) => ({ phrase, count }));

    sessionCache = {
      version: 1,
      updated_at_ms: Date.now(),
      window_start_ts_ms: sessionCache.window_start_ts_ms ?? ts_ms,
      window_end_ts_ms: ts_ms,
      top_chatters: topUsers,
      top_topics: topTopics,
      repeated_phrases: repeated,
    };
    void writeJson(sessionCachePath, sessionCache);
  }

  function advanceShortTerm(ts_ms: number) {
    // roll chat window based on canonical messages up to ts_ms
    while (canonicalIdxForShort < canonicalMsgs.length && canonicalMsgs[canonicalIdxForShort]!.ts_ms <= ts_ms) {
      const m = canonicalMsgs[canonicalIdxForShort]!;
      recentChatWindow.push(m);
      recentChatTimes.push(m.ts_ms);
      if (recentChatWindow.length > shortTermChatWindowSize) recentChatWindow.shift();
      canonicalIdxForShort += 1;
    }
    // compute msgs/min from last 60s of canonical message timestamps
    const cutoff = ts_ms - 60_000;
    while (recentChatTimes.length > 0 && recentChatTimes[0]! < cutoff) recentChatTimes.shift();

    // roll transcript window based on transcript segments up to ts_ms
    const tCutoff = ts_ms - shortTermLookbackMs;
    while (transcriptIdxForShort < transcriptSegs.length && transcriptSegs[transcriptIdxForShort]!.start_ms <= ts_ms) {
      const s = transcriptSegs[transcriptIdxForShort]!;
      recentTranscriptWindow.push({ end_ms: s.end_ms, text: s.text });
      transcriptIdxForShort += 1;
    }
    while (recentTranscriptWindow.length > 0 && recentTranscriptWindow[0]!.end_ms < tCutoff) recentTranscriptWindow.shift();

    shortCache = {
      version: 1,
      updated_at_ms: Date.now(),
      recent_chat: recentChatWindow.map((m) => m.text),
      transcript_last_60s: recentTranscriptWindow.map((x) => x.text).slice(-8),
      live_metrics: {
        msgs_last_60s: recentChatTimes.length,
        msgs_per_min: recentChatTimes.length,
      },
    };
  }

  const wantedKeys = new Set<string>(candidates.map((c) => msgKey({ ts_ms: c.ts_ms, text: c.text, user_id: c.user_id ?? null })));
  await appendJobLog(jobId, tsLine(`collecting labels for candidates (wanted=${wantedKeys.size})`));
  const labelByKey = await labelsForWantedKeysFromJsonl({
    labeledChatJsonl,
    wantedKeys,
    onProgress: async (found, wanted) => appendJobLog(jobId, tsLine(`labels found ${found}/${wanted}`)),
  });
  const missingLabels = wantedKeys.size - labelByKey.size;
  if (missingLabels > 0) {
    await appendJobLog(jobId, tsLine(`warning: missing labels for ${missingLabels}/${wantedKeys.size} candidates (defaulting to false)`));
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Missing OPENAI_API_KEY env var" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }
  const apiKeyRequired: string = apiKey;

  job = {
    ...job,
    updatedAt: Date.now(),
    step: "judge",
    artifacts: { ...(job.artifacts ?? {}), resultsJsonl, summaryJson, outDir, labeledChatJsonl },
  };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine(`judge model=${model} candidates=${candidates.length}`));

  // Resume support: if results.jsonl already has entries, skip those msg_keys.
  const alreadyScored = new Set<string>();
  const scored: Array<{ ts_ms: number; score: number; label: boolean; msg_key: string }> = [];
  if (isResume && (await fileExists(resultsJsonl))) {
    const stream = fsSync.createReadStream(resultsJsonl, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(obj)) continue;
        const k = obj["msg_key"];
        const ts = obj["ts_ms"];
        const sc = obj["score"];
        const lab = obj["label_read_aloud"];
        if (typeof k === "string") alreadyScored.add(k);
        if (typeof k === "string" && typeof ts === "number" && typeof sc === "number") {
          scored.push({ msg_key: k, ts_ms: ts, score: sc, label: lab === true });
        }
      }
    } finally {
      rl.close();
      stream.close();
    }
    await appendJobLog(jobId, tsLine(`resume: loaded already_scored=${alreadyScored.size}`));
  }

  type PreparedCandidate = {
    i: number;
    msg: ChatMsg;
    key: string;
    label: boolean;
    userPrompt: string;
  };
  const prepared: PreparedCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const msg = candidates[i]!;
    const key = msgKey({ ts_ms: msg.ts_ms, text: msg.text, user_id: msg.user_id ?? null });
    const label = labelByKey.get(key) ?? false;

    // advance session cache up to this timestamp (simulate live cache updates)
    while (canonicalIdxForSession < canonicalMsgs.length && canonicalMsgs[canonicalIdxForSession]!.ts_ms <= msg.ts_ms) {
      ingestForSession(canonicalMsgs[canonicalIdxForSession]!);
      canonicalIdxForSession += 1;
    }

    // Always keep session cache time bounds moving, even if we haven't hit the 10-min refresh boundary yet.
    if (sessionCache.window_start_ts_ms === null) sessionCache.window_start_ts_ms = msg.ts_ms;
    sessionCache.window_end_ts_ms = msg.ts_ms;

    maybeUpdateSessionCache(msg.ts_ms);
    advanceShortTerm(msg.ts_ms);

    // Persist rolling cache files periodically so you can watch them update during a run.
    const nowWall = Date.now();
    if (i === 0 || (i + 1) % flushEveryNCandidates === 0 || nowWall - lastCacheFlushWallMs >= flushEveryWallMs) {
      lastCacheFlushWallMs = nowWall;
      shortCache.updated_at_ms = nowWall;
      sessionCache.updated_at_ms = nowWall;
      void writeJson(shortTermCachePath, shortCache);
      void writeJson(sessionCachePath, sessionCache);
    }

    if (alreadyScored.has(key)) {
      // we still advance caches, but skip the OpenAI call + re-writing results
      if ((i + 1) % 250 === 0) await appendJobLog(jobId, tsLine(`resume: skipping already-scored ${i + 1}/${candidates.length}`));
      continue;
    }

    const ctx = shortCache.recent_chat.slice(-contextMessages);
    const onStream = shortCache.transcript_last_60s;

    const userPrompt = buildHighlightUserPrompt({
      longTermProfileText: longCache.streamer_style_summary || cfg.longTermCache || "(empty)",
      currentGame: "an unknown game",
      vibe: deriveVibeFromLongTerm(longCache.streamer_style_summary || cfg.longTermCache || ""),
      transcriptLines: onStream,
      recentChatLines: ctx.slice(-contextMessages),
      candidateMessageText: msg.text,
    });
    prepared.push({ i, msg, key, label, userPrompt });
  }

  // Parallel judge workers (API calls only); prompt preparation stays sequential for cache correctness.
  const judgeConcurrencyRaw = Number(process.env.EVAL_JUDGE_CONCURRENCY ?? 4);
  const judgeConcurrency = Math.max(1, Math.min(32, Number.isFinite(judgeConcurrencyRaw) ? Math.floor(judgeConcurrencyRaw) : 4));
  const judgeMaxRpmRaw = Number(process.env.EVAL_JUDGE_MAX_RPM ?? 120);
  const judgeMaxRpm = Math.max(1, Number.isFinite(judgeMaxRpmRaw) ? Math.floor(judgeMaxRpmRaw) : 120);
  await appendJobLog(
    jobId,
    tsLine(
      `judge parallel config: prepared=${prepared.length} already_scored=${alreadyScored.size} concurrency=${judgeConcurrency} max_rpm=${judgeMaxRpm}`,
    ),
  );

  const limiter = createJudgeRateLimiter(judgeMaxRpm);

  async function scorePrepared(
    task: PreparedCandidate,
  ): Promise<{ relevance: number; humor: number; engagement: number; score: number; reason: string }> {
    return await scoreWithRetries({
      apiKey: apiKeyRequired,
      model,
      systemPrompt: cfg.systemPrompt,
      userPrompt: task.userPrompt,
      limiter,
      maxAttempts: 6,
      appendLog: async (line) => appendJobLog(jobId, tsLine(line)),
    });
  }

  let nextTaskIdx = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let fatalErrMsg: string | null = null;
  const totalToScore = prepared.length;
  async function worker(workerId: number) {
    while (true) {
      if (fatalErrMsg) return;
      const idx = nextTaskIdx;
      nextTaskIdx += 1;
      if (idx >= totalToScore) return;
      const task = prepared[idx]!;
      try {
        if ((idx + 1) % 100 === 0 || idx === 0) {
          await appendJobLog(
            jobId,
            tsLine(
              `scoring ${idx + 1}/${totalToScore} (candidate=${task.i + 1}/${candidates.length}) ts_ms=${task.msg.ts_ms} label=${task.label ? 1 : 0} worker=${workerId}`,
            ),
          );
        }
        const { relevance, humor, engagement, score, reason } = await scorePrepared(task);
        scored.push({ ts_ms: task.msg.ts_ms, score, label: task.label, msg_key: task.key });
        const line =
          JSON.stringify(
            {
              msg_key: task.key,
              ts_ms: task.msg.ts_ms,
              username: task.msg.username ?? null,
              user_id: task.msg.user_id ?? null,
              text: task.msg.text,
              relevance,
              humor,
              engagement,
              score,
              reason,
              label_read_aloud: task.label,
            },
            null,
            0,
          ) + "\n";
        writeChain = writeChain.then(() => fs.appendFile(resultsJsonl, line, "utf-8"));
      } catch (err: unknown) {
        fatalErrMsg = err instanceof Error ? err.message : String(err);
        return;
      }
    }
  }

  const workerCount = Math.min(judgeConcurrency, Math.max(1, totalToScore));
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
  await writeChain;
  if (fatalErrMsg) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: fatalErrMsg };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${fatalErrMsg}`));
    return;
  }

  // Simple metric: Precision@1 and @3 per 30s bucket
  const buckets = new Map<number, Array<{ ts_ms: number; score: number; label: boolean }>>();
  for (const r of scored) {
    const b = Math.floor(r.ts_ms / 30_000) * 30_000;
    const arr = buckets.get(b) ?? [];
    arr.push({ ts_ms: r.ts_ms, score: r.score, label: r.label });
    buckets.set(b, arr);
  }

  let p1Sum = 0;
  let p3Sum = 0;
  let r1Sum = 0;
  let r3Sum = 0;
  let bucketCount = 0;
  let bucketWithPosCount = 0;
  for (const arr of buckets.values()) {
    arr.sort((a, b) => b.score - a.score);
    const top1 = arr.slice(0, 1);
    const top3 = arr.slice(0, 3);
    const p1 = top1.length ? (top1[0]!.label ? 1 : 0) : 0;
    const p3 = top3.length ? top3.filter((x) => x.label).length / top3.length : 0;
    p1Sum += p1;
    p3Sum += p3;
    const pos = arr.filter((x) => x.label).length;
    if (pos > 0) {
      bucketWithPosCount += 1;
      const r1 = top1.length ? top1.filter((x) => x.label).length / pos : 0;
      const r3 = top3.length ? top3.filter((x) => x.label).length / pos : 0;
      r1Sum += r1;
      r3Sum += r3;
    }
    bucketCount += 1;
  }

  // Threshold metrics (score > 80)
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of scored) {
    const pred = r.score > thresholdScore;
    if (pred && r.label) tp += 1;
    else if (pred && !r.label) fp += 1;
    else if (!pred && r.label) fn += 1;
    else tn += 1;
  }
  const thresholdPrecision = tp + fp > 0 ? tp / (tp + fp) : null;
  const thresholdRecall = tp + fn > 0 ? tp / (tp + fn) : null;

  const summary = {
    vodId,
    userId: user.id,
    model,
    candidates_scored: candidates.length,
    label_window_sec: labelWindowSec,
    context_messages: contextMessages,
    trial_window_minutes: trialWindowMinutes,
    full_vod: trialWindowMinutes <= 0,
    use_all_trial_window_messages: useAllTrialWindowMessages,
    request_scope: requestedScope,
    request_first_n: requestedScope === "first_n" ? (typeof body.firstN === "number" ? body.firstN : null) : null,
    threshold_score_exclusive: thresholdScore,
    buckets: bucketCount,
    precision_at_1: bucketCount ? p1Sum / bucketCount : null,
    precision_at_3: bucketCount ? p3Sum / bucketCount : null,
    recall_at_1: bucketWithPosCount ? r1Sum / bucketWithPosCount : null,
    recall_at_3: bucketWithPosCount ? r3Sum / bucketWithPosCount : null,
    threshold_confusion: { tp, fp, tn, fn, precision: thresholdPrecision, recall: thresholdRecall },
    paths: {
      canonicalChatJsonl,
      filteredJsonl,
      transcriptJsonl,
      labeledChatJsonl,
      resultsJsonl,
      summaryJson,
      cacheDir,
      longTermCachePath,
      sessionCachePath,
      shortTermCachePath,
    },
  };

  await fs.writeFile(summaryJson, JSON.stringify(summary, null, 2), "utf-8");
  // End-of-stream update: persist long-term cache (append some engaged examples from this VOD)
  const positives = scored
    .filter((x) => x.label)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((x) => {
      // pull message text from results file is expensive; we can approximate by using msg_key suffix after last pipe
      const parts = x.msg_key.split("|");
      return parts.length >= 3 ? parts.slice(2).join("|") : x.msg_key;
    })
    .map((t) => String(t).slice(0, 180))
    .filter(Boolean);
  const merged = Array.from(new Set([...(longCache.positive_examples ?? []), ...positives])).slice(0, 50);
  longCache = { ...longCache, updated_at_ms: Date.now(), positive_examples: merged };
  await writeJson(longTermCachePath, longCache);
  updateUserProfile({
    userId: user.id,
    longTermCache: longCache.streamer_style_summary,
    bots: userProfile.bots,
    emotes: userProfile.emotes,
    twitchChannelUrl: userProfile.twitchChannelUrl,
    streamQuestionnaire: userProfile.streamQuestionnaire,
    updatedAt: Date.now(),
  });
  await writeJson(sessionCachePath, { ...sessionCache, updated_at_ms: Date.now() });
  await writeJson(shortTermCachePath, { ...shortCache, updated_at_ms: Date.now() });
  job = { ...job, state: "succeeded", updatedAt: Date.now(), step: "done", artifacts: { ...job.artifacts, ...summary.paths } };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine("eval done"));
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;
  const user = auth.user;

  let body: EvalRequest;
  try {
    body = (await req.json()) as EvalRequest;
  } catch {
    return jsonError("Invalid JSON body");
  }
  if (!body?.vodUrlOrId || typeof body.vodUrlOrId !== "string") return jsonError("Missing vodUrlOrId");
  const vodId = extractVodId(body.vodUrlOrId ?? "");
  if (!vodId) return jsonError("Could not extract VOD id", 400);
  if (!userOwnsVod(user.id, vodId)) return jsonError("VOD not found", 404);

  const resumeJobId = typeof body.resumeJobId === "string" ? body.resumeJobId.trim() : "";
  if (resumeJobId) {
    const existing = await readJobStatus(resumeJobId);
    if (!existing) return jsonError("resumeJobId not found", 404);
    if (existing.type !== "eval") return jsonError("resumeJobId is not an eval job", 400);
    if (existing.state !== "failed") return jsonError(`resumeJobId must be failed (state=${existing.state})`, 409);
    if (!isJobOwnedByUser(existing, user.id)) return jsonError("Not found", 404);
    const updatedAt = Date.now();
    const status: JobStatus = { ...existing, state: "queued", updatedAt, step: "init", error: undefined };
    await writeJobStatus(status);
    setTimeout(() => void runEvalJob(resumeJobId, { ...body, resumeJobId: undefined }, user), 10);
    return NextResponse.json({ ok: true, jobId: resumeJobId, resumed: true });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const createdAt = Date.now();
  const status: JobStatus = {
    jobId,
    type: "eval",
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: user.id, username: user.username },
  };
  await writeJobStatus(status);
  setTimeout(() => void runEvalJob(jobId, body, user), 10);
  return NextResponse.json({ ok: true, jobId, resumed: false });
}
