import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { getUserFeedbackSummary } from "@/lib/server/userFeedback";
import { getOrCreateUserProfile, updateUserProfile } from "@/lib/server/userProfile";

export const runtime = "nodejs";

const SYSTEM_PROMPT =
  "You are building a streamer personality profile for a Twitch chat filtering system. Given the streamer's answers below, write a concise profile (8-12 bullet points) organized into these sections: Stream personality/vibe, What they love reacting to, What they ignore, Recurring bits/memes/lore, Audience humor norms. Be specific and actionable — a chat judge will use this to decide which messages the streamer would likely react to.";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function questionnaireToPrompt(answers: Record<string, string>): string {
  const get = (key: string) => (answers[key] ?? "").trim() || "(no answer provided)";
  return [
    "Streamer questionnaire answers:",
    "",
    `Vibe/personality:\n${get("vibe")}`,
    "",
    `Love reacting to:\n${get("love_reacting_to")}`,
    "",
    `Ignore/annoying messages:\n${get("ignore")}`,
    "",
    `Recurring bits/memes/lore:\n${get("recurring_bits")}`,
    "",
    `Humor style:\n${get("humor_style")}`,
  ].join("\n");
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

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  const profile = getOrCreateUserProfile(auth.user.id);
  let userPrompt = questionnaireToPrompt(profile.streamQuestionnaire);

  const fbSummary = getUserFeedbackSummary(auth.user.id);
  if (fbSummary.totalUp + fbSummary.totalDown > 0) {
    const lines: string[] = [];
    lines.push("");
    lines.push(`Feedback data (${fbSummary.totalUp} upvotes, ${fbSummary.totalDown} downvotes):`);
    if (fbSummary.recentUpTexts.length > 0) {
      lines.push("Messages the streamer marked as good picks:");
      for (const text of fbSummary.recentUpTexts) {
        lines.push(`  + "${text}"`);
      }
    }
    if (fbSummary.recentDownTexts.length > 0) {
      lines.push("Messages the streamer marked as bad picks:");
      for (const text of fbSummary.recentDownTexts) {
        lines.push(`  - "${text}"`);
      }
    }
    lines.push("Use these feedback patterns to refine the profile.");
    userPrompt += "\n" + lines.join("\n");
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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
  const generated = extractContent(payload);
  if (!generated) {
    return NextResponse.json({ ok: false, error: "OpenAI returned an empty response." }, { status: 502 });
  }

  const updated = updateUserProfile({
    ...profile,
    longTermCache: generated,
  });

  return NextResponse.json({
    ok: true,
    generated: updated.longTermCache,
    profile: {
      longTermCache: updated.longTermCache,
      streamQuestionnaire: updated.streamQuestionnaire,
      updatedAt: updated.updatedAt,
    },
  });
}
