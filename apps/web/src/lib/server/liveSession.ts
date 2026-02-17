import fsSync from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

import { appendJobLog, JobStatus, readJobStatus, writeJobStatus } from "@/lib/job";
import { runCommand } from "@/lib/proc";
import { createJudgeRateLimiter, scoreWithRetries } from "@/lib/server/judge";
import { LiveContext, upsertLiveContext } from "@/lib/server/liveContext";
import { getEvalServerConfig } from "@/lib/server/evalConfig";
import { dataRootDir } from "@/lib/vod";

type LiveStartRequest = {
  sessionId: string;
  userId: string;
  channelOrUrl: string;
  currentGame?: string;
  thresholdScoreExclusive: number;
  longTermCacheText: string;
  bots: string[];
  emotes: string[];
};

type LiveMsg = {
  ts_ms: number;
  username: string | null;
  text: string;
  score?: number | null;
  reason?: string | null;
  relevance?: number | null;
  humor?: number | null;
  engagement?: number | null;
};

type LiveContextDebugFile = {
  timestamp_ms: number;
  context: LiveContext;
  counts: {
    seen: number;
    kept: number;
    scored: number;
    highlighted: number;
    retries429: number;
  };
  transcript_tail: string[];
  recent_chat_sample: string[];
};

type RunnerState = {
  stopRequested: boolean;
  scoreAbortController: AbortController | null;
};

const LIVE_RUNNERS = new Map<string, RunnerState>();
const DEFAULT_TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export function liveRootDir(): string {
  return path.join(dataRootDir(), "live");
}

export function liveSessionDir(sessionId: string): string {
  return path.join(liveRootDir(), sessionId);
}

function livePath(sessionId: string, name: string): string {
  return path.join(liveSessionDir(sessionId), name);
}

function stopFlagPath(sessionId: string): string {
  return livePath(sessionId, "stop.requested");
}

function tsLine(line: string): string {
  return `[${new Date().toISOString()}] ${line}\n`;
}

function truncateLine(s: string, n: number): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

function deriveVibeFromLongTerm(text: string): string | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) return undefined;
  const firstLine = raw.split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  if (!firstLine) return undefined;
  return truncateLine(firstLine, 180);
}

function pct(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return Math.max(0, Math.min(1, num / den));
}

function extractChannel(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
  if (m?.[1]) return m[1].toLowerCase();
  if (/^[a-zA-Z0-9_]+$/.test(s)) return s.toLowerCase();
  return null;
}

type LiveFilterDecision = {
  keep: boolean;
  drop_reason?: string;
  score?: number;
  override?: boolean;
  chorus_rep?: boolean;
  cleaned_text?: string;
};

type LiveFilterInput = {
  ts_ms: number;
  text: string;
  tags?: Record<string, unknown>;
};

type LiveTranscribeProvider = "local" | "openai" | "auto";

class PythonLiveFilterClient {
  private readonly proc;
  private readonly pending: Array<{
    resolve: (v: LiveFilterDecision) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;
  private readonly stderrRl;
  private readonly stdoutRl;

  constructor(opts: { pythonBin: string; env: NodeJS.ProcessEnv; onStderrLine: (line: string) => void; knownEmotes: string[] }) {
    const args = [
      "-m",
      "chatfilter",
      "filter-live-stream",
      ...opts.knownEmotes.slice(0, 200).flatMap((e) => ["--known-emote", e]),
    ];
    this.proc = spawn(opts.pythonBin, args, {
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdoutRl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.stderrRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });

    this.stdoutRl.on("line", (line) => {
      const next = this.pending.shift();
      if (!next) return;
      try {
        const obj = JSON.parse(line) as LiveFilterDecision;
        next.resolve({
          keep: Boolean(obj.keep),
          drop_reason: typeof obj.drop_reason === "string" ? obj.drop_reason : undefined,
          score: typeof obj.score === "number" ? obj.score : undefined,
          override: typeof obj.override === "boolean" ? obj.override : undefined,
          chorus_rep: typeof obj.chorus_rep === "boolean" ? obj.chorus_rep : undefined,
          cleaned_text: typeof obj.cleaned_text === "string" ? obj.cleaned_text : undefined,
        });
      } catch (err: unknown) {
        next.reject(new Error(`Invalid live filter response: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    this.stderrRl.on("line", opts.onStderrLine);

    this.proc.on("exit", (code, signal) => {
      const msg = `live filter process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.closed = true;
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        next?.reject(new Error(msg));
      }
    });
  }

  async filter(msg: LiveFilterInput): Promise<LiveFilterDecision> {
    if (this.closed || !this.proc.stdin.writable) throw new Error("Live filter process is not running");
    return await new Promise<LiveFilterDecision>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.proc.stdin.write(JSON.stringify(msg) + "\n", "utf-8", (err) => {
        if (!err) return;
        const next = this.pending.pop();
        next?.reject(err);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    this.stdoutRl.close();
    this.stderrRl.close();
    this.proc.kill();
  }
}

class LocalWhisperClient {
  private readonly proc;
  private readonly pending: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;
  private readonly stderrRl;
  private readonly stdoutRl;
  private startupFatal: string | null = null;
  private stopping = false;

  constructor(opts: {
    pythonBin: string;
    model: string;
    device: string;
    computeType: string;
    onStderrLine: (line: string) => void;
  }) {
    const py = `
import base64
import json
import sys
import tempfile

try:
    from faster_whisper import WhisperModel
except Exception as e:
    print(json.dumps({"fatal": f"missing_faster_whisper: {e}"}), flush=True)
    sys.exit(2)

model_name = sys.argv[1] if len(sys.argv) > 1 else "base"
device = sys.argv[2] if len(sys.argv) > 2 else "cpu"
compute_type = sys.argv[3] if len(sys.argv) > 3 else "int8"

try:
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
except Exception as e:
    print(json.dumps({"fatal": f"whisper_model_init_failed: {e}"}), flush=True)
    sys.exit(3)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception as e:
        print(json.dumps({"error": f"bad_request_json: {e}"}), flush=True)
        continue
    audio_b64 = req.get("audio_b64")
    if not isinstance(audio_b64, str) or not audio_b64:
        print(json.dumps({"error": "missing_audio_b64"}), flush=True)
        continue
    try:
        audio_bytes = base64.b64decode(audio_b64)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
            f.write(audio_bytes)
            f.flush()
            segments, _ = model.transcribe(f.name, vad_filter=True, beam_size=1)
        text = " ".join([(seg.text or "").strip() for seg in segments]).strip()
        print(json.dumps({"text": text}), flush=True)
    except Exception as e:
        print(json.dumps({"error": f"transcribe_failed: {e}"}), flush=True)
`;
    this.proc = spawn(opts.pythonBin, ["-u", "-c", py, opts.model, opts.device, opts.computeType], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.stdoutRl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.stderrRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });

    this.stdoutRl.on("line", (line) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // ignore bad stdout line; it'll surface via timeout/exit on requests.
      }
      const rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
      const fatal = rec && typeof rec["fatal"] === "string" ? rec["fatal"] : null;
      if (fatal) {
        this.startupFatal = fatal;
      }

      const next = this.pending.shift();
      if (!next) return;
      if (fatal) {
        next.reject(new Error(fatal));
        return;
      }
      if (rec && typeof rec["error"] === "string") {
        next.reject(new Error(String(rec["error"])));
        return;
      }
      if (rec && typeof rec["text"] === "string") {
        next.resolve(String(rec["text"]).trim());
        return;
      }
      next.resolve("");
    });

    this.stderrRl.on("line", opts.onStderrLine);
    this.proc.on("exit", (code, signal) => {
      const msg = this.startupFatal
        ? `local whisper exited: ${this.startupFatal}`
        : this.stopping
          ? "local whisper stopped"
          : `local whisper process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.closed = true;
      while (this.pending.length > 0) {
        this.pending.shift()?.reject(new Error(msg));
      }
    });
  }

  async transcribeWav(wavBuffer: Buffer): Promise<string> {
    if (this.startupFatal) throw new Error(this.startupFatal);
    if (this.closed || !this.proc.stdin.writable) throw new Error("Local whisper process is not running");
    return await new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      const line = JSON.stringify({ audio_b64: wavBuffer.toString("base64") }) + "\n";
      this.proc.stdin.write(line, "utf-8", (err) => {
        if (!err) return;
        const next = this.pending.pop();
        next?.reject(err);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.stopping = true;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    this.stdoutRl.close();
    this.stderrRl.close();
    this.proc.kill();
  }
}

async function writeLiveStatus(status: JobStatus): Promise<void> {
  await writeJobStatus(status);
}

async function appendJsonl(p: string, obj: unknown): Promise<void> {
  await fs.appendFile(p, JSON.stringify(obj) + "\n", "utf-8");
}

async function tailJsonl(p: string, limit: number): Promise<Array<Record<string, unknown>>> {
  try {
    const txt = await fs.readFile(p, "utf-8");
    const lines = txt.split("\n").filter(Boolean);
    const out: Array<Record<string, unknown>> = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try {
        const obj = JSON.parse(line) as unknown;
        if (typeof obj === "object" && obj !== null) out.push(obj as Record<string, unknown>);
      } catch {
        // ignore bad line
      }
    }
    return out;
  } catch {
    return [];
  }
}

type TwitchPlaybackTokenResponse = {
  data?: {
    streamPlaybackAccessToken?: {
      signature?: string;
      value?: string;
    };
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function wrapPcmS16leToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm], 44 + dataSize);
}

async function resolveTwitchHlsMasterPlaylist(channel: string): Promise<string> {
  const twitchClientId = String(process.env.TWITCH_CLIENT_ID ?? "").trim() || DEFAULT_TWITCH_WEB_CLIENT_ID;
  const oauth = String(process.env.TWITCH_OAUTH_TOKEN ?? "").trim();
  const headers: Record<string, string> = {
    "Client-ID": twitchClientId,
    "Content-Type": "application/json",
  };
  if (oauth) headers["Authorization"] = `OAuth ${oauth}`;

  const gqlBody = {
    operationName: "PlaybackAccessToken_Template",
    query:
      "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }",
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: "",
      playerType: "site",
    },
  };

  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers,
    body: JSON.stringify(gqlBody),
  });
  if (!res.ok) {
    throw new Error(`twitch gql token request failed status=${res.status}`);
  }
  const json = (await res.json()) as TwitchPlaybackTokenResponse;
  const token = json.data?.streamPlaybackAccessToken?.value;
  const sig = json.data?.streamPlaybackAccessToken?.signature;
  if (!token || !sig) {
    throw new Error("twitch playback token missing; stream may be offline or require auth");
  }

  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    fast_bread: "true",
    player_backend: "mediaplayer",
    playlist_include_framerate: "true",
    reassignments_supported: "true",
    supported_codecs: "av1,h264",
    sig,
    token,
    p: String(Math.floor(Math.random() * 1_000_000)),
  });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channel)}.m3u8?${params.toString()}`;
}

async function resolveTwitchHlsViaStreamlink(channel: string): Promise<string | null> {
  const streamlinkCmd = String(process.env.STREAMLINK_PATH ?? "streamlink").trim() || "streamlink";
  const out = await runCommand(streamlinkCmd, ["--stream-url", `https://www.twitch.tv/${channel}`, "best"], {});
  if (out.code !== 0) return null;
  const url = out.stdout
    .split("\n")
    .map((x) => x.trim())
    .find((x) => /^https?:\/\//i.test(x));
  return url || null;
}

async function resolveLiveAudioHlsUrl(channel: string): Promise<string> {
  try {
    return await resolveTwitchHlsMasterPlaylist(channel);
  } catch (primaryErr: unknown) {
    const fallback = await resolveTwitchHlsViaStreamlink(channel);
    if (fallback) return fallback;
    throw new Error(
      `failed to resolve twitch hls for ${channel}: ${
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      }`,
    );
  }
}

async function transcribeChunkWithOpenAiWhisper(wavBuffer: Buffer): Promise<string> {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env var");
  const model = String(process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1").trim() || "whisper-1";

  let attempt = 0;
  while (attempt < 4) {
    attempt += 1;
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), `live_chunk_${Date.now()}.wav`);

    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < 4) {
          await sleep(300 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`openai transcription failed status=${res.status} body=${truncateLine(text, 220)}`);
      }
      const json = (await res.json()) as unknown;
      if (typeof json === "object" && json !== null && typeof (json as Record<string, unknown>)["text"] === "string") {
        return String((json as Record<string, unknown>)["text"]).trim();
      }
      return "";
    } catch (err: unknown) {
      if (attempt >= 4) throw err instanceof Error ? err : new Error(String(err));
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
  return "";
}

function resolveTranscribeProvider(): LiveTranscribeProvider {
  const raw = String(process.env.LIVE_TRANSCRIBE_PROVIDER ?? "local")
    .trim()
    .toLowerCase();
  if (raw === "openai") return "openai";
  if (raw === "auto") return "auto";
  return "local";
}

function parsePrivmsg(line: string): { username: string | null; text: string } | null {
  const m = line.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.+)$/);
  if (!m) return null;
  return { username: m[1] ?? null, text: m[2] ?? "" };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "aborted");
}

export async function startLiveSession(req: LiveStartRequest): Promise<void> {
  const { sessionId } = req;
  const channel = extractChannel(req.channelOrUrl);
  if (!channel) throw new Error("Invalid channel or stream URL");
  const threshold = Math.max(0, Math.min(100, Number(req.thresholdScoreExclusive)));

  const cfg = await getEvalServerConfig();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env var");
  const apiKeyRequired: string = apiKey;
  const repoRoot = path.join(process.cwd(), "..", "..");
  const venvPython = path.join(repoRoot, ".venv", "bin", "python");
  const pythonBin =
    String(process.env.LIVE_PYTHON_BIN ?? process.env.PYTHON_BIN ?? "").trim() ||
    (fsSync.existsSync(venvPython) ? venvPython : "python3");
  const ffmpegEnv = String(process.env.LIVE_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "").trim();
  const bundledFfmpeg = path.join(repoRoot, "tools", "ffmpeg", "ffmpeg");
  const ffmpegCmd = ffmpegEnv || (fsSync.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");
  const pythonPath = path.join(repoRoot, "backend", "chatfilter", "src");
  const pyEnv = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}:${process.env.PYTHONPATH}` : pythonPath,
  };
  const liveFilter = new PythonLiveFilterClient({
    pythonBin,
    env: pyEnv,
    knownEmotes: req.emotes,
    onStderrLine: (line) => {
      void appendJobLog(sessionId, tsLine(`live-filter stderr: ${line}`));
    },
  });
  const transcribeProvider = resolveTranscribeProvider();
  const localWhisperModel = String(process.env.LIVE_LOCAL_WHISPER_MODEL ?? "base").trim() || "base";
  const localWhisperDevice = String(process.env.LIVE_LOCAL_WHISPER_DEVICE ?? "cpu").trim() || "cpu";
  const localWhisperComputeType = String(process.env.LIVE_LOCAL_WHISPER_COMPUTE_TYPE ?? "int8").trim() || "int8";
  let localWhisper: LocalWhisperClient | null = null;
  if (transcribeProvider === "local" || transcribeProvider === "auto") {
    localWhisper = new LocalWhisperClient({
      pythonBin,
      model: localWhisperModel,
      device: localWhisperDevice,
      computeType: localWhisperComputeType,
      onStderrLine: (line) => {
        void appendJobLog(sessionId, tsLine(`local-whisper stderr: ${line}`));
      },
    });
  }
  let localWhisperDisabled = false;
  const transcribeAudioChunk = async (wavBuffer: Buffer): Promise<string> => {
    if (transcribeProvider === "openai") {
      return await transcribeChunkWithOpenAiWhisper(wavBuffer);
    }
    if (localWhisper && !localWhisperDisabled) {
      try {
        return await localWhisper.transcribeWav(wavBuffer);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (transcribeProvider === "local") throw new Error(`local whisper failed: ${msg}`);
        localWhisperDisabled = true;
        await appendJobLog(sessionId, tsLine(`local whisper disabled after error; falling back to OpenAI: ${truncateLine(msg, 200)}`));
      }
    }
    return await transcribeChunkWithOpenAiWhisper(wavBuffer);
  };

  const sessionDir = liveSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const chatPath = livePath(sessionId, "chat.jsonl");
  const transcriptPath = livePath(sessionId, "transcript.jsonl");
  const scoredPath = livePath(sessionId, "scored.jsonl");
  const goodPath = livePath(sessionId, "good.jsonl");
  const metricsPath = livePath(sessionId, "metrics.json");
  const latestPath = livePath(sessionId, "latest.json");
  const latestContextPath = livePath(sessionId, "latest_context.json");
  const stopPath = stopFlagPath(sessionId);
  try {
    await fs.unlink(stopPath);
  } catch {
    // ignore; no existing stop flag
  }

  const status: JobStatus = {
    jobId: sessionId,
    type: "live",
    state: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    step: "init",
    channel,
    artifacts: { sessionDir, chatPath, transcriptPath, scoredPath, goodPath, metricsPath, latestPath, latestContextPath },
    meta: {
      userId: req.userId,
      thresholdScoreExclusive: threshold,
      hlsChannel: channel,
      transcribeProvider,
      currentGame: String(req.currentGame ?? "").trim(),
      model: cfg.model,
    },
  };
  await writeLiveStatus(status);
  await appendJobLog(sessionId, tsLine(`live session start channel=${channel}`));
  await appendJobLog(sessionId, tsLine(`python runtime=${pythonBin}`));
  await appendJobLog(
    sessionId,
    tsLine(
      transcribeProvider === "openai"
        ? "transcription provider=openai"
        : `transcription provider=${transcribeProvider} local_model=${localWhisperModel} device=${localWhisperDevice} compute_type=${localWhisperComputeType}`,
    ),
  );
  await appendJobLog(sessionId, tsLine("resolving twitch live hls playlist"));
  const hlsAudioUrl = await resolveLiveAudioHlsUrl(channel);
  await appendJobLog(sessionId, tsLine(`resolved hls playlist ${truncateLine(hlsAudioUrl, 180)}`));

  const scoreAbortController = new AbortController();
  const runner: RunnerState = { stopRequested: false, scoreAbortController };
  LIVE_RUNNERS.set(sessionId, runner);

  function abortScoring() {
    if (!scoreAbortController.signal.aborted) scoreAbortController.abort();
  }

  async function shouldStop(): Promise<boolean> {
    if (runner.stopRequested) {
      abortScoring();
      return true;
    }
    if (fsSync.existsSync(stopPath)) {
      abortScoring();
      return true;
    }
    const s = await readJobStatus(sessionId);
    if (!s) return false;
    if (s.step === "stopping") {
      abortScoring();
      return true;
    }
    return false;
  }

  const limiter = createJudgeRateLimiter(Math.max(1, Number(process.env.EVAL_JUDGE_MAX_RPM ?? 120)));
  const botUsernames = new Set(
    req.bots
      .map((name) => String(name ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const recentChat: LiveMsg[] = [];
  const recentTranscript: Array<{ ts_ms: number; text: string }> = [];
  const transcriptTail: string[] = [];
  const recentScored: Array<{ ts_ms: number; text: string; score: number; reason: string }> = [];
  const inFlightScoring = new Set<Promise<void>>();
  const chatterLastSeenMs = new Map<string, number>();
  const counts = {
    seen: 0,
    kept: 0,
    scored: 0,
    highlighted: 0,
    retries429: 0,
  };

  async function flushLatest() {
    const chat = (await tailJsonl(chatPath, 200)).slice(-200);
    const good = (await tailJsonl(goodPath, 200)).slice(-200);
    await fs.writeFile(latestPath, JSON.stringify({ chat, good }, null, 2), "utf-8");
    await fs.writeFile(
      metricsPath,
      JSON.stringify(
        {
          sessionId,
          channel,
          counts,
          updated_at_ms: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  function buildRecentEvents(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (value: string) => {
      const line = truncateLine(value, 220);
      if (!line) return;
      const k = line.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(line);
    };
    for (const row of recentScored.slice(-16).reverse()) {
      if (row.score < Math.max(65, threshold - 5)) continue;
      add(`${row.text} (${row.reason || "strong reaction potential"})`);
      if (out.length >= 3) break;
    }
    for (const t of transcriptTail.slice(-12).reverse()) {
      add(t);
      if (out.length >= 5) break;
    }
    return out.slice(0, 5);
  }

  function buildLiveContext(nowMs: number): LiveContext {
    const tenMinutesAgo = nowMs - 10 * 60_000;
    for (const [user, seenMs] of chatterLastSeenMs.entries()) {
      if (seenMs < tenMinutesAgo) chatterLastSeenMs.delete(user);
    }
    return {
      vibe: deriveVibeFromLongTerm(req.longTermCacheText || cfg.longTermCache || ""),
      currentGame: String(req.currentGame ?? "").trim(),
      recentEvents: buildRecentEvents(),
      streamStats: {
        msgsPerMin: Math.round((recentChat.length / 10) * 10) / 10,
        uniqueChattersApprox: chatterLastSeenMs.size,
        keptRate: pct(counts.kept, counts.seen),
        highlightRate: pct(counts.highlighted, counts.scored),
      },
      recentChatSample: recentChat
        .slice(-5)
        .map((m) => truncateLine(m.text, 220))
        .filter(Boolean),
      updatedAtMs: nowMs,
    };
  }

  let latestLiveContext: LiveContext | null = null;
  let lastContextPersistMs = 0;
  async function maybePersistLiveContext(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - lastContextPersistMs < 60_000) return;
    try {
      const nextContext = buildLiveContext(nowMs);
      const persisted = upsertLiveContext(req.userId, sessionId, channel ?? "", nextContext);
      latestLiveContext = persisted;
      const debugPayload: LiveContextDebugFile = {
        timestamp_ms: nowMs,
        context: persisted,
        counts: { ...counts },
        transcript_tail: transcriptTail.slice(-8).map((x) => truncateLine(x, 200)),
        recent_chat_sample: recentChat.slice(-8).map((x) => truncateLine(x.text, 200)),
      };
      await fs.writeFile(latestContextPath, JSON.stringify(debugPayload, null, 2), "utf-8");
      lastContextPersistMs = nowMs;
    } catch (err: unknown) {
      await appendJobLog(
        sessionId,
        tsLine(`live-context persist warning: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  async function scoreAndEmit(msg: LiveMsg) {
    if (await shouldStop()) return;
    const liveCtx = latestLiveContext ?? buildLiveContext(Date.now());
    const longTermProfile = truncateLine(req.longTermCacheText || cfg.longTermCache || "(empty)", 2400);
    const currentGame = truncateLine(liveCtx.currentGame || "an unknown game", 120);
    const vibe = truncateLine(liveCtx.vibe || "not specified", 180);
    const transcriptText = transcriptTail.length
      ? transcriptTail
          .slice(-8)
          .map((line) => truncateLine(line, 220))
          .filter(Boolean)
          .join("\n")
      : "(no transcript available)";
    const recentChatText = recentChat.length
      ? recentChat
          .slice(-10)
          .map((m) => truncateLine(m.text, 220))
          .filter(Boolean)
          .join("\n")
      : "(no recent chat)";
    const candidateMessage = truncateLine(msg.text, 500);
    const userPrompt = `This streamer's personality and preferences:
${longTermProfile}

Right now they are playing ${currentGame || "an unknown game"}. The stream vibe is: ${vibe || "not specified"}.

Here is what the streamer has been saying on stream recently (transcript):
${transcriptText}

Here is what chat has been talking about recently:
${recentChatText}

The candidate chat message to evaluate:
"${candidateMessage}"

Remember: use the streamer profile above to judge humor and engagement - what matters is whether THIS streamer would react, not whether it's generically funny. Score each axis 0-10, compute total, and return JSON only.`;
    const res = await scoreWithRetries({
      apiKey: apiKeyRequired,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      userPrompt,
      limiter,
      signal: scoreAbortController.signal,
      appendLog: async (line) => {
        if (line.includes("status=429")) counts.retries429 += 1;
        await appendJobLog(sessionId, tsLine(line));
      },
    });
    if (scoreAbortController.signal.aborted || (await shouldStop())) return;
    counts.scored += 1;
    recentScored.push({
      ts_ms: msg.ts_ms,
      text: msg.text,
      score: res.score,
      reason: typeof res.reason === "string" ? res.reason : "",
    });
    if (recentScored.length > 180) recentScored.shift();
    const row = {
      ts_ms: msg.ts_ms,
      username: msg.username,
      text: msg.text,
      relevance: res.relevance,
      humor: res.humor,
      engagement: res.engagement,
      score: res.score,
      reason: res.reason,
    };
    await appendJsonl(scoredPath, row);
    if (res.score > threshold) {
      counts.highlighted += 1;
      await appendJsonl(goodPath, row);
    }
  }

  // Twitch IRC client (simple)
  const socket = new net.Socket();
  socket.setEncoding("utf8");
  const nick = `justinfan${Math.floor(Math.random() * 100000)}`.toLowerCase();
  const pass = "PASS SCHMOOPIIE";

  let ircBuffer = "";
  socket.on("data", (chunk: string) => {
    ircBuffer += chunk;
    const parts = ircBuffer.split("\r\n");
    ircBuffer = parts.pop() ?? "";
    for (const line of parts) {
      if (!line) continue;
      if (runner.stopRequested || fsSync.existsSync(stopPath)) {
        socket.destroy();
        return;
      }
      if (line.startsWith("PING ")) {
        socket.write(line.replace("PING", "PONG") + "\r\n");
        continue;
      }
      const parsed = parsePrivmsg(line);
      if (!parsed) continue;
      counts.seen += 1;
      void (async () => {
        const row: LiveMsg = { ts_ms: Date.now(), username: parsed.username, text: parsed.text };
        const usernameLc = typeof row.username === "string" ? row.username.trim().toLowerCase() : "";
        if (usernameLc && botUsernames.has(usernameLc)) return;
        let decision: LiveFilterDecision;
        try {
          decision = await liveFilter.filter({ ts_ms: row.ts_ms, text: row.text, tags: {} });
        } catch (err: unknown) {
          void appendJobLog(sessionId, tsLine(`live-filter error: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        if (!decision.keep) return;
        const cleanedText = decision.cleaned_text?.trim();
        if (cleanedText) row.text = cleanedText;
        counts.kept += 1;
        if (row.username) chatterLastSeenMs.set(row.username.toLowerCase(), row.ts_ms);
        recentChat.push(row);
        if (recentChat.length > 150) recentChat.shift();
        void appendJsonl(chatPath, row);
        const scorePromise = (async () => {
          try {
            await scoreAndEmit(row);
          } catch (err: unknown) {
            if (isAbortError(err)) return;
            await appendJobLog(sessionId, tsLine(`score error: ${err instanceof Error ? err.message : String(err)}`));
          }
        })();
        inFlightScoring.add(scorePromise);
        void scorePromise.finally(() => {
          inFlightScoring.delete(scorePromise);
        });
      })();
    }
  });
  socket.on("error", (err) => {
    void appendJobLog(sessionId, tsLine(`irc socket error: ${err.message}`));
  });
  socket.on("close", () => {
    void appendJobLog(sessionId, tsLine("irc socket closed"));
  });
  socket.connect(6667, "irc.chat.twitch.tv", () => {
    socket.write(`${pass}\r\n`);
    socket.write(`NICK ${nick}\r\n`);
    socket.write(`JOIN #${channel}\r\n`);
    void appendJobLog(sessionId, tsLine(`irc connected nick=${nick} channel=${channel}`));
  });

  // Server-side Twitch HLS -> ffmpeg PCM stream -> chunked Whisper transcription.
  const sampleRate = 16_000;
  const chunkSec = Math.max(2, Number(process.env.LIVE_TRANSCRIBE_CHUNK_SECONDS ?? 3));
  const bytesPerSecond = sampleRate * 2;
  const chunkBytes = chunkSec * bytesPerSecond;
  const maxPendingChunks = Math.max(2, Number(process.env.LIVE_TRANSCRIBE_MAX_PENDING_CHUNKS ?? 4));
  async function transcribeLoop() {
    let chunkIndex = 0;
    let consecutiveStreamFailures = 0;

    while (!(await shouldStop())) {
      const ffArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        hlsAudioUrl,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "s16le",
        "pipe:1",
      ];
      const ffProc = spawn(ffmpegCmd, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const ffErrLines: string[] = [];
      ffProc.on("error", (err) => {
        ffErrLines.push(`spawn error: ${err.message}`);
        if (ffErrLines.length > 8) ffErrLines.shift();
      });
      const ffErrRl = readline.createInterface({ input: ffProc.stderr, crlfDelay: Infinity });
      ffErrRl.on("line", (line) => {
        if (!line) return;
        ffErrLines.push(line);
        if (ffErrLines.length > 8) ffErrLines.shift();
      });

      let pcmRemainder = Buffer.alloc(0);
      const pendingPcmChunks: Buffer[] = [];
      let droppedChunks = 0;
      let workerRunning = false;
      let ffClosed = false;
      let ffCloseCode: number | null = null;
      let ffCloseSignal: NodeJS.Signals | null = null;

      const processPending = async () => {
        if (workerRunning) return;
        workerRunning = true;
        try {
          while (pendingPcmChunks.length > 0 && !(await shouldStop())) {
            const pcm = pendingPcmChunks.shift();
            if (!pcm) continue;
            const chunkSeq = chunkIndex;
            chunkIndex += 1;
            const wavBuffer = wrapPcmS16leToWav(pcm, sampleRate, 1);
            let text = "";
            try {
              text = await transcribeAudioChunk(wavBuffer);
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if ((await shouldStop()) || errMsg === "local whisper stopped") {
                break;
              }
              await appendJobLog(
                sessionId,
                tsLine(`whisper transcription error: ${errMsg}`),
              );
              continue;
            }
            const clean = text.trim();
            if (!clean) continue;
            const startSec = chunkSeq * chunkSec;
            const ts_ms = Date.now();
            const row = { ts_ms, start_sec: startSec, end_sec: startSec + chunkSec, text: clean };
            await appendJsonl(transcriptPath, row);
            recentTranscript.push({ ts_ms, text: clean });
            transcriptTail.push(clean);
            if (recentTranscript.length > 300) recentTranscript.shift();
            if (transcriptTail.length > 30) transcriptTail.shift();
            await maybePersistLiveContext(true);
          }
        } finally {
          workerRunning = false;
        }
      };

      ffProc.stdout.on("data", (chunk: Buffer) => {
        if (ffClosed) return;
        pcmRemainder = Buffer.concat([pcmRemainder, chunk]);
        while (pcmRemainder.length >= chunkBytes) {
          const pcmChunk = Buffer.from(pcmRemainder.subarray(0, chunkBytes));
          pcmRemainder = Buffer.from(pcmRemainder.subarray(chunkBytes));
          if (pendingPcmChunks.length >= maxPendingChunks) {
            pendingPcmChunks.shift();
            droppedChunks += 1;
            if (droppedChunks === 1 || droppedChunks % 5 === 0) {
              void appendJobLog(
                sessionId,
                tsLine(`transcription backlog detected; dropped chunks=${droppedChunks}`),
              );
            }
          }
          pendingPcmChunks.push(pcmChunk);
          void processPending();
        }
      });

      const closePromise = new Promise<void>((resolve) => {
        ffProc.on("close", (code, signal) => {
          ffClosed = true;
          ffCloseCode = code;
          ffCloseSignal = signal;
          resolve();
        });
      });

      while (!(await shouldStop()) && !ffClosed) {
        await flushLatest();
        await maybePersistLiveContext(false);
        await sleep(1200);
      }

      if (await shouldStop()) {
        try {
          ffProc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }

      await closePromise;
      ffErrRl.close();
      await processPending();

      if (await shouldStop()) break;

      consecutiveStreamFailures += 1;
      const errTail = ffErrLines.length ? ` stderr=${truncateLine(ffErrLines.join(" | "), 220)}` : "";
      await appendJobLog(
        sessionId,
        tsLine(`ffmpeg live audio stream ended code=${ffCloseCode ?? "null"} signal=${ffCloseSignal ?? "null"}${errTail}`),
      );
      if (consecutiveStreamFailures >= 6) {
        throw new Error("ffmpeg live stream repeatedly exited; stopping transcription");
      }
      await sleep(Math.min(5000, 800 * consecutiveStreamFailures));
      await appendJobLog(sessionId, tsLine("restarting ffmpeg live audio stream"));
    }
  }

  status.step = "live";
  status.updatedAt = Date.now();
  await writeLiveStatus(status);

  try {
    await transcribeLoop();
    while (!(await shouldStop())) {
      await flushLatest();
      await maybePersistLiveContext(false);
      await new Promise((r) => setTimeout(r, 1200));
      // keep service alive until stop; chat scoring continues on socket callbacks
    }
    socket.destroy();
    abortScoring();
    await Promise.allSettled(Array.from(inFlightScoring));
    await flushLatest();
    await maybePersistLiveContext(true);
    const done = await readJobStatus(sessionId);
    const finalStatus: JobStatus = {
      ...(done ?? status),
      state: "succeeded",
      updatedAt: Date.now(),
      step: "stopped",
    };
    await writeLiveStatus(finalStatus);
    await appendJobLog(sessionId, tsLine("live session stopped"));
  } catch (err: unknown) {
    socket.destroy();
    abortScoring();
    await Promise.allSettled(Array.from(inFlightScoring));
    await maybePersistLiveContext(true);
    const msg = err instanceof Error ? err.message : String(err);
    const failed = await readJobStatus(sessionId);
    const finalStatus: JobStatus = {
      ...(failed ?? status),
      state: "failed",
      updatedAt: Date.now(),
      step: "failed",
      error: msg,
    };
    await writeLiveStatus(finalStatus);
    await appendJobLog(sessionId, tsLine(`live session failed: ${msg}`));
  } finally {
    liveFilter.close();
    localWhisper?.close();
    runner.scoreAbortController = null;
    LIVE_RUNNERS.delete(sessionId);
  }
}

export async function requestStopLiveSession(sessionId: string): Promise<boolean> {
  const r = LIVE_RUNNERS.get(sessionId);
  if (r) {
    r.stopRequested = true;
    r.scoreAbortController?.abort();
  }
  try {
    await fs.mkdir(liveSessionDir(sessionId), { recursive: true });
    await fs.writeFile(stopFlagPath(sessionId), "1\n", "utf-8");
  } catch {
    // ignore; route still marks status step=stopping
  }
  return Boolean(r);
}

export async function readLiveFeed(sessionId: string): Promise<{ chat: Array<Record<string, unknown>>; good: Array<Record<string, unknown>> }> {
  const latestPath = livePath(sessionId, "latest.json");
  try {
    const obj = JSON.parse(await fs.readFile(latestPath, "utf-8")) as unknown;
    if (typeof obj === "object" && obj !== null) {
      const rec = obj as Record<string, unknown>;
      const chat = Array.isArray(rec["chat"]) ? (rec["chat"] as Array<Record<string, unknown>>) : [];
      const good = Array.isArray(rec["good"]) ? (rec["good"] as Array<Record<string, unknown>>) : [];
      return { chat, good };
    }
    return { chat: [], good: [] };
  } catch {
    return { chat: await tailJsonl(livePath(sessionId, "chat.jsonl"), 200), good: await tailJsonl(livePath(sessionId, "good.jsonl"), 200) };
  }
}

export async function readLiveMetrics(sessionId: string): Promise<Record<string, unknown> | null> {
  const p = livePath(sessionId, "metrics.json");
  try {
    const obj = JSON.parse(await fs.readFile(p, "utf-8")) as unknown;
    if (typeof obj === "object" && obj !== null) return obj as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export async function readLatestLiveContextFile(sessionId: string): Promise<Record<string, unknown> | null> {
  const p = livePath(sessionId, "latest_context.json");
  try {
    const obj = JSON.parse(await fs.readFile(p, "utf-8")) as unknown;
    if (typeof obj === "object" && obj !== null) return obj as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export async function readLiveLogTail(sessionId: string): Promise<string> {
  try {
    const p = path.join(dataRootDir(), "jobs", sessionId, "log.txt");
    const stream = fsSync.createReadStream(p, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
      if (lines.length > 300) lines.shift();
    }
    rl.close();
    stream.close();
    return lines.join("\n");
  } catch {
    return "";
  }
}
