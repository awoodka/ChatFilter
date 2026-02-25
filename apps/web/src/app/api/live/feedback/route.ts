import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { insertUserFeedback, pushGoodChatExample, pushBadChatExample } from "@/lib/server/userFeedback";

export const runtime = "nodejs";

type FeedbackBody = {
  tsMs: number;
  messageText: string;
  messageUsername?: string;
  messageScore?: number;
  messageReason?: string;
  messageRelevance?: number;
  messageHumor?: number;
  messageEngagement?: number;
  feedback: "up" | "down";
  sessionId?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;

  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return jsonError("Invalid JSON body");
  }

  if (body.feedback !== "up" && body.feedback !== "down") {
    return jsonError("feedback must be 'up' or 'down'");
  }
  if (typeof body.messageText !== "string" || !body.messageText.trim()) {
    return jsonError("messageText must be a non-empty string");
  }
  if (typeof body.tsMs !== "number" || !Number.isFinite(body.tsMs)) {
    return jsonError("tsMs must be a finite number");
  }

  const row = insertUserFeedback({
    userId: auth.user.id,
    tsMs: body.tsMs,
    messageText: body.messageText,
    messageUsername: body.messageUsername,
    messageScore: body.messageScore,
    messageReason: body.messageReason,
    messageRelevance: body.messageRelevance,
    messageHumor: body.messageHumor,
    messageEngagement: body.messageEngagement,
    feedback: body.feedback,
    sessionId: body.sessionId,
  });

  if (body.feedback === "up") {
    pushGoodChatExample(auth.user.id, body.messageText);
  } else {
    pushBadChatExample(auth.user.id, body.messageText);
  }

  return NextResponse.json({ ok: true, feedbackId: row.id });
}
