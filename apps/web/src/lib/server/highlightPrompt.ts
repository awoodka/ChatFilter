function truncatePromptLine(s: string, n: number): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

export function deriveVibeFromLongTerm(text: string): string | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) return undefined;
  const firstLine = raw
    .split("\n")
    .map((x) => x.trim())
    .find((line) => line && !/^[\s*#_\->=]+$/.test(line) && !/^\*\*[^*]+\*\*$/.test(line) && !/^#{1,6}\s/.test(line)) ?? "";
  if (!firstLine) return undefined;
  return truncatePromptLine(firstLine, 180);
}

export type FeedbackExample = {
  messageText: string;
  score: number | null;
  reason: string | null;
};

export function buildHighlightUserPrompt(input: {
  longTermProfileText: string;
  currentGame?: string;
  vibe?: string;
  transcriptLines: string[];
  recentChatLines: string[];
  visualContext?: string;
  candidateMessageText: string;
  upvotedExamples?: FeedbackExample[];
  downvotedExamples?: FeedbackExample[];
}): string {
  const longTermProfile = truncatePromptLine(input.longTermProfileText || "(empty)", 2400);
  const currentGame = truncatePromptLine(input.currentGame || "an unknown game", 120);
  const vibe = truncatePromptLine(input.vibe || "not specified", 180);
  const transcriptText = input.transcriptLines.length
    ? input.transcriptLines
        .slice(-8)
        .map((line) => truncatePromptLine(line, 220))
        .filter(Boolean)
        .join("\n")
    : "(no transcript available)";
  const recentChatText = input.recentChatLines.length
    ? input.recentChatLines
        .slice(-10)
        .map((line) => truncatePromptLine(line, 220))
        .filter(Boolean)
        .join("\n")
    : "(no recent chat)";
  const candidateMessage = truncatePromptLine(input.candidateMessageText, 500);
  const visualContext = input.visualContext?.trim() || "";

  const feedbackLines: string[] = [];
  if (input.upvotedExamples?.length) {
    feedbackLines.push("Messages the streamer confirmed as GOOD picks (use these to calibrate):");
    for (const ex of input.upvotedExamples) {
      const text = truncatePromptLine(ex.messageText, 200);
      const scoreTag = ex.score != null ? ` [scored ${Math.round(ex.score)}]` : "";
      const reasonTag = ex.reason ? ` — ${truncatePromptLine(ex.reason, 120)}` : "";
      feedbackLines.push(`  + "${text}"${scoreTag}${reasonTag}`);
    }
  }
  if (input.downvotedExamples?.length) {
    feedbackLines.push("Messages the streamer marked as BAD picks (avoid selecting similar messages):");
    for (const ex of input.downvotedExamples) {
      const text = truncatePromptLine(ex.messageText, 200);
      const scoreTag = ex.score != null ? ` [scored ${Math.round(ex.score)}]` : "";
      const reasonTag = ex.reason ? ` — ${truncatePromptLine(ex.reason, 120)}` : "";
      feedbackLines.push(`  - "${text}"${scoreTag}${reasonTag}`);
    }
  }
  const feedbackSection = feedbackLines.length ? `\n${feedbackLines.join("\n")}\n` : "";

  return `This streamer's personality and preferences:
${longTermProfile}
${feedbackSection}
Right now they are playing ${currentGame || "an unknown game"}. The stream vibe is: ${vibe || "not specified"}.

Here is what the streamer has been saying on stream recently (transcript):
${transcriptText}

Here is what chat has been talking about recently:
${recentChatText}

Here is what is visually happening on stream right now:
${visualContext || "(no visual context available)"}

The candidate chat message to evaluate:
"${candidateMessage}"

Remember: use the streamer profile above to judge humor and engagement - what matters is whether THIS streamer would react, not whether it's generically funny. Score each axis 0-10, compute total, and return JSON only.`;
}
