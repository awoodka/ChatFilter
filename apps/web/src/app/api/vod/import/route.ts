import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { appendJobLog, JobStatus, writeJobStatus } from "@/lib/job";
import { runCommandStreaming } from "@/lib/proc";
import { extractVodId, vodCanonicalDir, vodRawDir, vodRunsDir } from "@/lib/vod";
import { requireAuthUser } from "@/lib/server/routeAuth";
import { getOrCreateUserProfile } from "@/lib/server/userProfile";
import { linkVodToUser } from "@/lib/server/vodOwnership";

export const runtime = "nodejs";

type ImportRequest = {
  vodUrl: string;
  vodName: string;
  twitchDownloaderPath?: string; // optional override
  ytDlpPath?: string; // optional override
};

function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

function tsLine(line: string) {
  return `[${new Date().toISOString()}] ${line}\n`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function splitAudioForTranscription(opts: {
  jobId: string;
  ffmpegDir: string;
  inputAudioPath: string;
  outDir: string;
  segmentSeconds: number;
  onLog: (line: string) => Promise<void>;
}) {
  const { ffmpegDir, inputAudioPath, outDir, segmentSeconds, onLog } = opts;
  const ffmpegPath = path.join(ffmpegDir, "ffmpeg");

  await fs.mkdir(outDir, { recursive: true });
  const outTemplate = path.join(outDir, "seg_%04d.mp3");

  // Re-encode to a small, API-friendly format and segment.
  // - mono 16kHz
  // - low bitrate to keep chunks small
  await onLog(`ffmpeg split: input=${inputAudioPath} segmentSeconds=${segmentSeconds}`);
  const res = await runCommandStreaming(
    ffmpegPath,
    [
      "-hide_banner",
      "-y",
      "-i",
      inputAudioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "32k",
      "-f",
      "segment",
      "-segment_time",
      String(segmentSeconds),
      "-reset_timestamps",
      "1",
      outTemplate,
    ],
    { onLine: async (l, s) => void onLog(`${s}: ${l}`) },
  );
  if (res.code !== 0) {
    throw new Error("ffmpeg split failed");
  }

  const files = (await listFiles(outDir))
    .filter((f) => f.startsWith("seg_") && f.endsWith(".mp3"))
    .sort();
  if (files.length === 0) {
    throw new Error("ffmpeg split produced no segments");
  }
  await onLog(`ffmpeg split complete: segments=${files.length}`);
  return files.map((f) => path.join(outDir, f));
}

type VerboseTranscript = {
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
};

async function runImportJob(jobId: string, body: ImportRequest, user: { id: string; username: string }) {
  const createdAt = Date.now();
  let job: JobStatus = {
    jobId,
    type: "import",
    state: "running",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: user.id, username: user.username },
  };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine(`job start`));

  const vodId = extractVodId(body.vodUrl ?? "");
  if (!vodId) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Could not extract VOD id from URL" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }

  const repoRoot = path.join(process.cwd(), "..", "..");
  const tdLocal = path.join(repoRoot, "tools", "TwitchDownloaderCLI");
  const ytdlpLocal = path.join(repoRoot, "tools", "yt-dlp");
  const ffmpegDir = path.join(repoRoot, "tools", "ffmpeg");
  const td = body.twitchDownloaderPath ?? process.env.TWITCHDOWNLOADER_PATH ?? tdLocal ?? "TwitchDownloaderCLI";
  const ytdlp = body.ytDlpPath ?? process.env.YTDLP_PATH ?? ytdlpLocal ?? "yt-dlp";
  const profile = getOrCreateUserProfile(user.id);
  const knownEmotes = profile.emotes.filter((x) => x.trim()).slice(0, 200);

  job = { ...job, updatedAt: Date.now(), vodId };
  await writeJobStatus(job);

  const rawDir = vodRawDir(vodId);
  const canonicalDir = vodCanonicalDir(vodId);
  const runsDir = vodRunsDir(vodId);
  const runId = `run_${Date.now()}`;
  const runDir = path.join(runsDir, runId);

  // Use job-scoped raw artifacts to avoid collisions and interactive overwrite prompts.
  const rawJobDir = path.join(rawDir, jobId);

  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(rawJobDir, { recursive: true });
  await fs.mkdir(canonicalDir, { recursive: true });
  await fs.mkdir(runDir, { recursive: true });

  const logLine = async (line: string, stream?: "stdout" | "stderr") => {
    const prefix = stream ? `${stream}: ` : "";
    await appendJobLog(jobId, tsLine(prefix + line));
  };

  // 1) Download chat
  job = { ...job, updatedAt: Date.now(), step: "chatdownload" };
  await writeJobStatus(job);
  await logLine(`step chatdownload`);

  const tdChatJson = path.join(rawJobDir, "chat.json");
  const tdRes = await runCommandStreaming(td, ["chatdownload", "--id", vodId, "--output", tdChatJson], {
    onLine: (l, s) => void logLine(l, s),
  });
  if (tdRes.code !== 0) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "TwitchDownloader chatdownload failed" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // 2) Download audio
  job = { ...job, updatedAt: Date.now(), step: "audio_download" };
  await writeJobStatus(job);
  await logLine(`step audio_download`);

  const audioPath = path.join(rawJobDir, "audio.mp3");
  const audioTemplate = path.join(rawJobDir, "audio.%(ext)s");
  let ffmpegLocationArg: string[] = [];
  try {
    await fs.access(path.join(ffmpegDir, "ffmpeg"));
    await fs.access(path.join(ffmpegDir, "ffprobe"));
    ffmpegLocationArg = ["--ffmpeg-location", ffmpegDir];
    await logLine(`using ffmpeg from ${ffmpegDir}`);
  } catch {
    // fall back to PATH; yt-dlp will error if missing
    await logLine(`ffmpeg not found in ${ffmpegDir}; relying on PATH`);
  }

  const ytdlpRes = await runCommandStreaming(ytdlp, [
    "-x",
    "--audio-format",
    "mp3",
    "--no-playlist",
    ...ffmpegLocationArg,
    "--output",
    audioTemplate,
    body.vodUrl,
  ], { onLine: (l, s) => void logLine(l, s) });
  if (ytdlpRes.code !== 0) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "yt-dlp audio download failed" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // 3) Transcribe
  job = { ...job, updatedAt: Date.now(), step: "transcribe" };
  await writeJobStatus(job);
  await logLine(`step transcribe`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Missing OPENAI_API_KEY env var" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // NOTE: `gpt-4o-mini-transcribe` currently rejects `response_format=verbose_json` (needed for timestamps).
  // `whisper-1` supports verbose JSON with segments/timestamps.
  const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1";
  await logLine(`transcribe model=${transcribeModel}`);

  // Chunked transcription: re-encode + split audio to avoid huge uploads and encoding issues.
  const ffmpegOk =
    (await fileExists(path.join(ffmpegDir, "ffmpeg"))) && (await fileExists(path.join(ffmpegDir, "ffprobe")));
  if (!ffmpegOk) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: `ffmpeg/ffprobe missing at ${ffmpegDir}` };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  const segmentsDir = path.join(rawJobDir, "transcribe_segments");
  let segmentPaths: string[] = [];
  try {
    segmentPaths = await splitAudioForTranscription({
      jobId,
      ffmpegDir,
      inputAudioPath: audioPath,
      outDir: segmentsDir,
      segmentSeconds: 600,
      onLog: (l) => logLine(l),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    job = { ...job, state: "failed", updatedAt: Date.now(), error: `Audio split failed: ${msg}` };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  const transcriptJsonl = path.join(rawJobDir, "transcript.jsonl");
  const transcriptVerboseDir = path.join(rawJobDir, "transcript_verbose_parts");
  await fs.mkdir(transcriptVerboseDir, { recursive: true });

  // write transcript.jsonl incrementally
  await fs.writeFile(transcriptJsonl, "", "utf-8");

  for (let i = 0; i < segmentPaths.length; i++) {
    const segPath = segmentPaths[i]!;
    const offsetMs = i * 600_000; // segmentSeconds * 1000
    await logLine(`transcribe chunk ${i + 1}/${segmentPaths.length}: ${path.basename(segPath)}`);

    const audioBuf = await fs.readFile(segPath);
    const form = new FormData();
    form.set("model", transcribeModel);
    form.set("response_format", "verbose_json");
    form.set("file", new Blob([audioBuf], { type: "audio/mpeg" }), path.basename(segPath));

    const trRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!trRes.ok) {
      const errText = await trRes.text();
      job = { ...job, state: "failed", updatedAt: Date.now(), error: `Transcription failed: ${trRes.status}` };
      await writeJobStatus(job);
      await logLine(errText);
      return;
    }
    const trJson = (await trRes.json()) as VerboseTranscript;

    // Save raw response per chunk for debugging.
    await fs.writeFile(
      path.join(transcriptVerboseDir, `chunk_${String(i).padStart(4, "0")}.json`),
      JSON.stringify(trJson, null, 2),
      "utf-8",
    );

    // Write JSONL segments with global timestamps.
    const segs = Array.isArray(trJson.segments) ? trJson.segments : [];
    if (segs.length > 0) {
      for (const s of segs) {
        const startMs = offsetMs + Math.round((s.start ?? 0) * 1000);
        const endMs = offsetMs + Math.round((s.end ?? 0) * 1000);
        const text = (s.text ?? "").trim();
        if (!text) continue;
        await fs.appendFile(
          transcriptJsonl,
          JSON.stringify({ start_ms: startMs, end_ms: endMs, text, chunk: i }, null, 0) + "\n",
          "utf-8",
        );
      }
    } else if (trJson.text) {
      const text = String(trJson.text).trim();
      if (text) {
        await fs.appendFile(
          transcriptJsonl,
          JSON.stringify({ start_ms: offsetMs, end_ms: offsetMs + 600_000, text, chunk: i }, null, 0) + "\n",
          "utf-8",
        );
      }
    }
  }

  // python env
  const pythonPath = path.join(repoRoot, "backend", "chatfilter", "src");
  const pyEnv = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}:${process.env.PYTHONPATH}` : pythonPath,
  };

  // 4) Convert
  job = { ...job, updatedAt: Date.now(), step: "convert_chat_jsonl" };
  await writeJobStatus(job);
  await logLine(`step convert_chat_jsonl`);

  const canonicalChatJsonl = path.join(canonicalDir, `chat_${jobId}.jsonl`);
  const pyConvert = await runCommandStreaming(
    "python3",
    [
      "-m",
      "chatfilter",
      "convert",
      "--input",
      tdChatJson,
      "--output",
      canonicalChatJsonl,
      "--vod-id",
      vodId,
    ],
    { env: pyEnv, onLine: (l, s) => void logLine(l, s) },
  );
  if (pyConvert.code !== 0) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Python chatfilter convert failed" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // 5) Filter
  job = { ...job, updatedAt: Date.now(), step: "filter" };
  await writeJobStatus(job);
  await logLine("step filter live_equivalent=true targetKeep=1.0");

  const filteredJsonl = path.join(runDir, "filtered.jsonl");
  const metricsJson = path.join(runDir, "metrics.json");
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
      metricsJson,
      "--target-keep",
      "1.0",
      ...knownEmotes.flatMap((e) => ["--known-emote", e]),
    ],
    { env: pyEnv, onLine: (l, s) => void logLine(l, s) },
  );
  if (pyFilter.code !== 0) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Python chatfilter filter failed" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  job = {
    ...job,
    state: "succeeded",
    updatedAt: Date.now(),
    step: "done",
    artifacts: {
      tdChatJson,
      audioPath,
      transcriptJsonl,
      canonicalChatJsonl,
      filteredJsonl,
      metricsJson,
    },
  };
  await writeJobStatus(job);
  linkVodToUser(user.id, vodId, body.vodName);
  await logLine(`job done runId=${runId}`);
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: ImportRequest;
  try {
    body = (await req.json()) as ImportRequest;
  } catch {
    return jsonError("Invalid JSON body");
  }
  const vodName = String(body.vodName ?? "").trim();
  if (!vodName) return jsonError("Missing vodName");

  const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const createdAt = Date.now();
  await writeJobStatus({
    jobId,
    type: "import",
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: auth.user.id, username: auth.user.username, vodName },
  });

  // fire-and-forget (MVP). For production, this should be a real job queue/worker.
  setTimeout(() => {
    void runImportJob(jobId, { ...body, vodName }, auth.user);
  }, 10);

  return NextResponse.json({ ok: true, jobId });
}
