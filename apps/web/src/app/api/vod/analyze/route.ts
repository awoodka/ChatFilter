import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { appendJobLog, JobStatus, writeJobStatus } from "@/lib/job";
import { resolveTool, runCommandStreaming } from "@/lib/proc";
import { extractVodId } from "@/lib/vod";
import { requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

type AnalyzeRequest = {
  vodUrl: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function tsLine(line: string) {
  return `[${new Date().toISOString()}] ${line}\n`;
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
  ffmpegPath: string;
  inputAudioPath: string;
  outDir: string;
  segmentSeconds: number;
  onLog: (line: string) => Promise<void>;
}) {
  const { ffmpegPath, inputAudioPath, outDir, segmentSeconds, onLog } = opts;

  await fs.mkdir(outDir, { recursive: true });
  const outTemplate = path.join(outDir, "seg_%04d.mp3");

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

const GPT_SYSTEM_PROMPT = `You are an expert at analyzing Twitch streamers. You will receive a transcript
from the first hour of a Twitch VOD. Analyze the streamer's personality and
fill in exactly 5 fields for a chat filtering system.

Return ONLY a JSON object with these exact keys:
{
  "vibe": "2-4 sentences describing the stream's overall vibe/personality",
  "love_reacting_to": "2-4 sentences describing what chat messages they love engaging with",
  "ignore": "2-4 sentences describing what they tend to ignore or find annoying",
  "recurring_bits": "List any recurring bits, memes, catchphrases, or community lore",
  "humor_style": "1-2 sentences describing their humor style"
}

Be specific and grounded in the transcript. If mostly gameplay with little talking,
do your best with what's available. No text outside the JSON.`;

const QUESTIONNAIRE_KEYS = ["vibe", "love_reacting_to", "ignore", "recurring_bits", "humor_style"];

async function runAnalyzeJob(jobId: string, body: AnalyzeRequest, user: { id: string; username: string }) {
  const createdAt = Date.now();
  let job: JobStatus = {
    jobId,
    type: "vod_analyze",
    state: "running",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: user.id, username: user.username },
  };
  await writeJobStatus(job);
  await appendJobLog(jobId, tsLine("job start"));

  const vodId = extractVodId(body.vodUrl ?? "");
  if (!vodId) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Could not extract VOD id from URL" };
    await writeJobStatus(job);
    await appendJobLog(jobId, tsLine(`error: ${job.error}`));
    return;
  }

  const repoRoot = path.join(process.cwd(), "..", "..");
  const ytdlpLocal = path.join(repoRoot, "tools", "yt-dlp");
  const ffmpegDir = path.join(repoRoot, "tools", "ffmpeg");
  const ytdlp = resolveTool(process.env.YTDLP_PATH, ytdlpLocal, "yt-dlp");

  job = { ...job, updatedAt: Date.now(), vodId };
  await writeJobStatus(job);

  const workDir = path.join(repoRoot, "data", "jobs", jobId);
  await fs.mkdir(workDir, { recursive: true });

  const logLine = async (line: string, stream?: "stdout" | "stderr") => {
    const prefix = stream ? `${stream}: ` : "";
    await appendJobLog(jobId, tsLine(prefix + line));
  };

  // Step 1: Audio download (first hour only)
  job = { ...job, updatedAt: Date.now(), step: "audio_download" };
  await writeJobStatus(job);
  await logLine("step audio_download");

  const audioPath = path.join(workDir, "audio.mp3");
  const audioTemplate = path.join(workDir, "audio.%(ext)s");
  let ffmpegLocationArg: string[] = [];
  try {
    await fs.access(path.join(ffmpegDir, "ffmpeg"));
    await fs.access(path.join(ffmpegDir, "ffprobe"));
    ffmpegLocationArg = ["--ffmpeg-location", ffmpegDir];
    await logLine(`using ffmpeg from ${ffmpegDir}`);
  } catch {
    await logLine(`ffmpeg not found in ${ffmpegDir}; relying on PATH`);
  }

  const ytdlpRes = await runCommandStreaming(
    ytdlp,
    [
      "-x",
      "--audio-format",
      "mp3",
      "--no-playlist",
      "--download-sections",
      "*0:00:00-1:00:00",
      ...ffmpegLocationArg,
      "--output",
      audioTemplate,
      body.vodUrl,
    ],
    { onLine: (l, s) => void logLine(l, s) },
  );
  if (ytdlpRes.code !== 0) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "yt-dlp audio download failed" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // Step 2: Transcribe
  job = { ...job, updatedAt: Date.now(), step: "transcribe" };
  await writeJobStatus(job);
  await logLine("step transcribe");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Missing OPENAI_API_KEY env var" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1";
  await logLine(`transcribe model=${transcribeModel}`);

  const ffmpegPath = resolveTool(process.env.FFMPEG_PATH, path.join(ffmpegDir, "ffmpeg"), "ffmpeg");
  await logLine(`ffmpeg=${ffmpegPath}`);

  const segmentsDir = path.join(workDir, "transcribe_segments");
  let segmentPaths: string[] = [];
  try {
    segmentPaths = await splitAudioForTranscription({
      jobId,
      ffmpegPath,
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

  let fullTranscript = "";
  for (let i = 0; i < segmentPaths.length; i++) {
    const segPath = segmentPaths[i]!;
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

    const segs = Array.isArray(trJson.segments) ? trJson.segments : [];
    if (segs.length > 0) {
      for (const s of segs) {
        const text = (s.text ?? "").trim();
        if (text) fullTranscript += text + " ";
      }
    } else if (trJson.text) {
      fullTranscript += trJson.text.trim() + " ";
    }
  }

  fullTranscript = fullTranscript.trim();
  await logLine(`transcription complete: ${fullTranscript.length} chars`);

  if (!fullTranscript) {
    job = { ...job, state: "failed", updatedAt: Date.now(), error: "Transcription produced no text" };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // Step 3: GPT analysis
  job = { ...job, updatedAt: Date.now(), step: "analysis" };
  await writeJobStatus(job);
  await logLine("step analysis");

  // Truncate transcript to 100k chars if needed
  const truncatedTranscript = fullTranscript.length > 100_000 ? fullTranscript.slice(0, 100_000) : fullTranscript;

  const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: GPT_SYSTEM_PROMPT },
        { role: "user", content: truncatedTranscript },
      ],
      temperature: 0.7,
    }),
  });

  if (!gptRes.ok) {
    const errText = await gptRes.text();
    job = { ...job, state: "failed", updatedAt: Date.now(), error: `GPT analysis failed: ${gptRes.status}` };
    await writeJobStatus(job);
    await logLine(errText);
    return;
  }

  const gptJson = (await gptRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawContent = gptJson.choices?.[0]?.message?.content ?? "";
  await logLine(`GPT response length: ${rawContent.length} chars`);

  // Parse JSON, stripping markdown fences if present
  let questionnaire: Record<string, string>;
  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    questionnaire = JSON.parse(cleaned) as Record<string, string>;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    job = { ...job, state: "failed", updatedAt: Date.now(), error: `Failed to parse GPT response as JSON: ${msg}` };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    await logLine(`raw GPT response: ${rawContent}`);
    return;
  }

  // Validate all 5 keys present
  const missingKeys = QUESTIONNAIRE_KEYS.filter((k) => typeof questionnaire[k] !== "string");
  if (missingKeys.length > 0) {
    job = {
      ...job,
      state: "failed",
      updatedAt: Date.now(),
      error: `GPT response missing keys: ${missingKeys.join(", ")}`,
    };
    await writeJobStatus(job);
    await logLine(`error: ${job.error}`);
    return;
  }

  // Step 4: Complete
  job = {
    ...job,
    state: "succeeded",
    updatedAt: Date.now(),
    step: "done",
    meta: { ...job.meta, questionnaire },
  };
  await writeJobStatus(job);
  await logLine("job done");
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: AnalyzeRequest;
  try {
    body = (await req.json()) as AnalyzeRequest;
  } catch {
    return jsonError("Invalid JSON body");
  }

  const vodUrl = String(body.vodUrl ?? "").trim();
  if (!vodUrl) return jsonError("Missing vodUrl");

  const vodId = extractVodId(vodUrl);
  if (!vodId) return jsonError("Could not extract VOD ID from URL. Use a Twitch VOD URL like https://www.twitch.tv/videos/1234567890");

  const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const createdAt = Date.now();
  await writeJobStatus({
    jobId,
    type: "vod_analyze",
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    step: "init",
    meta: { userId: auth.user.id, username: auth.user.username },
  });

  setTimeout(() => {
    void runAnalyzeJob(jobId, { vodUrl }, auth.user);
  }, 10);

  return NextResponse.json({ ok: true, jobId });
}
