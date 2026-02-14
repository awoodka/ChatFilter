import fsSync from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import { NextResponse } from "next/server";

import { readJobStatus } from "@/lib/job";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

type EvalSummary = {
  threshold_score_exclusive?: number;
  paths?: Record<string, string>;
} & Record<string, unknown>;

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const { jobId } = await params;
  if (!jobId) return jsonError("Missing jobId");

  const status = await readJobStatus(jobId);
  if (!status) return jsonError("Job not found", 404);
  if (!isJobOwnedByUser(status, auth.user.id)) return jsonError("Job not found", 404);
  if (status.type !== "eval") return jsonError("Not an eval job", 400);
  if (status.state !== "succeeded") return jsonError(`Job not ready (state=${status.state})`, 409);

  const artifacts = status.artifacts ?? {};
  const summaryPath = artifacts["summaryJson"] ?? artifacts["summary.json"] ?? artifacts["summaryJsonl"];
  const resultsPath = artifacts["resultsJsonl"] ?? artifacts["results.jsonl"];
  if (!summaryPath || !resultsPath) {
    return jsonError("Missing eval artifacts on job status (expected summaryJson + resultsJsonl)", 500);
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") ?? "1000")));
  const scannedLimit = Math.max(1, Math.min(50_000, Number(url.searchParams.get("scannedLimit") ?? String(limit))));

  let summary: EvalSummary;
  try {
    summary = JSON.parse(await fs.readFile(summaryPath, "utf-8")) as EvalSummary;
  } catch {
    return jsonError("Failed to read summary.json", 500);
  }

  const threshold = typeof summary.threshold_score_exclusive === "number" ? summary.threshold_score_exclusive : 80;
  const minScoreParam = url.searchParams.get("minScore");
  const minScore = minScoreParam === null ? threshold + 0.0001 : Number(minScoreParam);

  const high: Array<Record<string, unknown>> = [];
  const readAloud: Array<Record<string, unknown>> = [];
  const scanned: Array<Record<string, unknown>> = [];
  let total = 0;

  const stream = fsSync.createReadStream(resultsPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      total += 1;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      const score = obj["score"];
      if (typeof score !== "number") continue;
      if (scanned.length < scannedLimit) scanned.push(obj);
      const label = obj["label_read_aloud"];
      if (label === true) readAloud.push(obj);
      if (score > minScore) high.push(obj);
      if (scanned.length >= scannedLimit && high.length >= limit && readAloud.length >= limit) break;
    }
  } finally {
    rl.close();
    stream.close();
  }

  high.sort((a, b) => Number(b["score"] ?? 0) - Number(a["score"] ?? 0));
  readAloud.sort((a, b) => Number(b["score"] ?? 0) - Number(a["score"] ?? 0));
  scanned.sort((a, b) => Number(a["ts_ms"] ?? 0) - Number(b["ts_ms"] ?? 0));

  return NextResponse.json({
    ok: true,
    jobId,
    threshold_score_exclusive: threshold,
    minScore,
    total_results_scanned: total,
    high_scoring: high,
    read_aloud: readAloud.slice(0, limit),
    scanned,
    scanned_limit: scannedLimit,
    summary,
    paths: { summaryPath, resultsPath, ...(summary.paths ?? {}) },
  });
}

