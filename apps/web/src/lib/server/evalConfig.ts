import fs from "node:fs/promises";

export type EvalServerConfig = {
  model: string;
  maxMessages: number;
  contextMessages: number;
  labelWindowSec: number;
  trialWindowMinutes: number;
  useAllTrialWindowMessages: boolean;
  streamerKey: string;
  sessionUpdateMinutes: number;
  shortTermChatWindowSize: number;
  shortTermLookbackMs: number;
  thresholdScoreExclusive: number; // score > threshold
  systemPrompt: string;
  longTermCache: string;
};

const DEFAULT_SYSTEM_PROMPT = `You are a Twitch chat analyst. Your job is to evaluate a single chat message and predict how likely the streamer is to engage with it — whether by reading it aloud, laughing, responding, or using it to create entertaining content.

You will be given context about WHO this streamer is, WHAT is happening on stream right now, and WHAT chat has been saying recently. Use all of this context to make your judgment.

Score the candidate message on these three axes (each 0-10):

1. Relevance — How connected is this message to what is currently happening on stream? Consider the game being played, what the streamer just said, and the current stream topic. A message does not need to directly reference the stream to score well here — tangentially related humor or callbacks count. Score 0 if completely unrelated filler.

2. Humor / Entertainment — How funny, clever, or entertaining is this message given this specific streamer's personality and what their audience finds funny? Use the streamer profile to calibrate — what one streamer finds hilarious another might ignore. Score 0 for generic/low-effort messages.

3. Engagement likelihood — How likely is the streamer to actually acknowledge this message? Consider: Does it have a natural hook (question, roast, callback, hot take)? Is it the kind of thing this specific streamer tends to react to based on their profile? Would reading this message create good content? Score 0 for messages the streamer would scroll past.

Compute a total score: total = round((relevance + humor + engagement) / 30 * 100)

IMPORTANT RULES:
- Questions do NOT automatically score higher. A boring question scores low. A witty non-question scores high.
- Messages that are generic greetings, backseat gaming, copypasta, emote spam, or low-effort filler should score very low across all axes.
- Use the streamer's profile to understand their specific taste — not a generic idea of "funny."
- Use the transcript and recent chat to understand timing and context — a message that would be mediocre in isolation might be perfect right after something specific happened on stream.
- If the recent chat shows a conversation thread, a message that cleverly continues or subverts it should score higher.

Output ONLY valid JSON with no extra text:
{"relevance": <0-10>, "humor": <0-10>, "engagement": <0-10>, "score": <0-100>, "reason": "<one sentence explaining why this would or would not get a reaction>"}`;

const DEFAULT_LONG_TERM_CACHE =
  "No streamer profile configured yet. Score based on general engagement patterns — prioritize messages that are contextually relevant, clever or funny, and have a natural reaction hook.";

async function maybeReadFile(p: string | undefined): Promise<string | null> {
  if (!p) return null;
  try {
    const txt = await fs.readFile(p, "utf-8");
    return txt;
  } catch {
    return null;
  }
}

export async function getEvalServerConfig(): Promise<EvalServerConfig> {
  const systemPrompt =
    process.env.EVAL_SYSTEM_PROMPT ??
    (await maybeReadFile(process.env.EVAL_SYSTEM_PROMPT_FILE)) ??
    DEFAULT_SYSTEM_PROMPT;
  const longTermCache =
    process.env.EVAL_LONG_TERM_CACHE ??
    (await maybeReadFile(process.env.EVAL_LONG_TERM_CACHE_FILE)) ??
    DEFAULT_LONG_TERM_CACHE;

  const model = process.env.EVAL_MODEL ?? "gpt-4.1-mini";
  const maxMessages = Number(process.env.EVAL_MAX_MESSAGES ?? 200);
  const contextMessages = Number(process.env.EVAL_CONTEXT_MESSAGES ?? 10);
  const labelWindowSec = Number(process.env.EVAL_LABEL_WINDOW_SEC ?? 90);
  // <= 0 means "entire VOD" (no time-window cutoff)
  const trialWindowMinutes = Number(process.env.EVAL_TRIAL_WINDOW_MINUTES ?? -1);
  const useAllTrialWindowMessagesRaw = String(process.env.EVAL_TRIAL_USE_ALL_MESSAGES ?? "1").toLowerCase();
  const useAllTrialWindowMessages =
    useAllTrialWindowMessagesRaw === "1" ||
    useAllTrialWindowMessagesRaw === "true" ||
    useAllTrialWindowMessagesRaw === "yes" ||
    useAllTrialWindowMessagesRaw === "y";
  const streamerKey = String(process.env.EVAL_STREAMER_KEY ?? "default");
  const sessionUpdateMinutes = Number(process.env.EVAL_SESSION_UPDATE_MINUTES ?? 10);
  const shortTermChatWindowSize = Number(process.env.EVAL_SHORT_TERM_CHAT_WINDOW_SIZE ?? 10);
  const shortTermLookbackMs = Number(process.env.EVAL_SHORT_TERM_LOOKBACK_MS ?? 60_000);
  const thresholdScoreExclusive = Number(process.env.EVAL_THRESHOLD_SCORE_EXCLUSIVE ?? 80);

  return {
    model,
    maxMessages: Number.isFinite(maxMessages) ? maxMessages : 200,
    contextMessages: Number.isFinite(contextMessages) ? contextMessages : 10,
    labelWindowSec: Number.isFinite(labelWindowSec) ? labelWindowSec : 90,
    trialWindowMinutes: Number.isFinite(trialWindowMinutes) ? trialWindowMinutes : -1,
    useAllTrialWindowMessages,
    streamerKey: streamerKey.trim() || "default",
    sessionUpdateMinutes: Number.isFinite(sessionUpdateMinutes) && sessionUpdateMinutes > 0 ? sessionUpdateMinutes : 10,
    shortTermChatWindowSize:
      Number.isFinite(shortTermChatWindowSize) && shortTermChatWindowSize > 0 ? shortTermChatWindowSize : 10,
    shortTermLookbackMs: Number.isFinite(shortTermLookbackMs) && shortTermLookbackMs > 0 ? shortTermLookbackMs : 60_000,
    thresholdScoreExclusive: Number.isFinite(thresholdScoreExclusive) ? thresholdScoreExclusive : 80,
    systemPrompt: String(systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
    longTermCache: String(longTermCache ?? DEFAULT_LONG_TERM_CACHE),
  };
}
