import { NextResponse } from "next/server";

import { readJobStatus } from "@/lib/job";
import { isJobOwnedByUser, requireAuthUser } from "@/lib/server/routeAuth";
import { getOrCreateUserProfile } from "@/lib/server/userProfile";
import { getEvalServerConfig } from "@/lib/server/evalConfig";
import { readLatestLiveContextFile } from "@/lib/server/liveSession";

export const runtime = "nodejs";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function extractContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;
  const message = firstChoice["message"];
  if (!isRecord(message)) return null;
  return typeof message["content"] === "string" ? message["content"].trim() : null;
}

function buildSystemPrompt(streamerProfile: string, currentGame: string | undefined, transcript: string[]): string {
  const transcriptBlock = transcript.length > 0
    ? `\nRECENT STREAMER TRANSCRIPT (what the streamer has been saying on stream):\n${transcript.join("\n")}\n`
    : "";

  return `You generate realistic simulated Twitch chat messages for a streamer to practice reacting to.

STREAMER PROFILE (use ONLY the humor style from this — do NOT use inside jokes, recurring bits, or community memes):
${streamerProfile}

${currentGame ? `CURRENT GAME: ${currentGame}` : ""}
${transcriptBlock}
Chat messages MUST be grounded in what is actually happening on stream. Use the transcript and game context to drive the conversation. Messages should react to gameplay moments, comment on what the streamer just said, ask questions about the current situation, or make jokes about what's visually/audibly happening.

DO NOT generate:
- Inside jokes, community memes, or running bits
- References to stream lore or recurring community themes
- Generic Twitch chat that could apply to any stream

DO generate a mix of:
- Reactions to specific gameplay moments or streamer commentary ("wait did you just miss that shot lol", "that callout was so wrong")
- Questions about what's happening ("what build are you running?", "why did you go there?")
- Jokes tied to the current situation using the streamer's humor style
- Simple reactions and emote-like text that are contextually appropriate ("LULW that timing", "PogChamp")
- Mid-tier comments on the current game/topic

Use varied fake usernames. Keep messages authentic to the current moment on stream.

If recent chat messages are provided, continue the conversation naturally — some messages should respond to or riff off what was said before.

Return ONLY a valid JSON array, no extra text:
[{"username": "...", "text": "..."}, ...]`;
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  let currentGame: string | undefined;
  let recentMessages: string[] = [];
  let transcript: string[] = [];
  let sessionId: string | undefined;
  let messageCount = 5;

  try {
    const body = (await req.json()) as unknown;
    if (isRecord(body)) {
      if (typeof body["currentGame"] === "string") currentGame = body["currentGame"];
      if (Array.isArray(body["recentMessages"])) {
        recentMessages = body["recentMessages"].filter((x): x is string => typeof x === "string").slice(-10);
      }
      if (Array.isArray(body["transcript"])) {
        transcript = body["transcript"].filter((x): x is string => typeof x === "string").slice(-12);
      }
      if (typeof body["sessionId"] === "string" && body["sessionId"].trim()) {
        sessionId = body["sessionId"].trim();
      }
      if (typeof body["messageCount"] === "number" && body["messageCount"] >= 1 && body["messageCount"] <= 20) {
        messageCount = body["messageCount"];
      }
    }
  } catch {
    // use defaults
  }

  // Pull transcript and game from the live session if one is active
  if (sessionId) {
    const jobStatus = await readJobStatus(sessionId);
    if (jobStatus && jobStatus.type === "live" && isJobOwnedByUser(jobStatus, auth.user.id)) {
      const ctx = await readLatestLiveContextFile(sessionId);
      if (ctx) {
        // Pull transcript tail from live context
        if (Array.isArray(ctx["transcript_tail"])) {
          const liveTrans = (ctx["transcript_tail"] as unknown[])
            .filter((x): x is string => typeof x === "string")
            .slice(-12);
          if (liveTrans.length > 0) transcript = liveTrans;
        }
        // Pull game from live context if not manually set
        const ctxObj = isRecord(ctx["context"]) ? ctx["context"] : null;
        if (!currentGame && ctxObj) {
          const detected = typeof ctxObj["detectedGame"] === "string" ? ctxObj["detectedGame"] : "";
          const configured = typeof ctxObj["currentGame"] === "string" ? ctxObj["currentGame"] : "";
          const game = (detected && detected !== "unknown" ? detected : configured).trim();
          if (game) currentGame = game;
        }
      }
    }
  }

  const profile = getOrCreateUserProfile(auth.user.id);
  const evalConfig = await getEvalServerConfig();

  const streamerProfile = profile.longTermCache || evalConfig.longTermCache;

  const systemPrompt = buildSystemPrompt(streamerProfile, currentGame, transcript);

  let userPrompt = `Generate ${messageCount} chat messages.`;
  if (recentMessages.length > 0) {
    userPrompt += `\n\nRecent chat for context:\n${recentMessages.join("\n")}`;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: evalConfig.model,
      temperature: 0.9,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json(
      { ok: false, error: `OpenAI request failed (${response.status}): ${text.slice(0, 240)}` },
      { status: 502 },
    );
  }

  const payload = (await response.json()) as unknown;
  const raw = extractContent(payload);
  if (!raw) {
    return NextResponse.json({ ok: false, error: "OpenAI returned an empty response." }, { status: 502 });
  }

  let messages: Array<{ username: string; text: string }>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    messages = parsed
      .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m["username"] === "string" && typeof m["text"] === "string")
      .map((m) => ({ username: m["username"] as string, text: m["text"] as string }));
  } catch {
    return NextResponse.json({ ok: false, error: "Failed to parse generated messages." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, messages });
}
