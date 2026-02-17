function truncatePromptLine(s: string, n: number): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

export function deriveVibeFromLongTerm(text: string): string | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) return undefined;
  const firstLine = raw.split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  if (!firstLine) return undefined;
  return truncatePromptLine(firstLine, 180);
}

export function buildHighlightUserPrompt(input: {
  longTermProfileText: string;
  currentGame?: string;
  vibe?: string;
  transcriptLines: string[];
  recentChatLines: string[];
  candidateMessageText: string;
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

  return `This streamer's personality and preferences:
${longTermProfile}

Right now they are playing ${currentGame || "an unknown game"}. The stream vibe is: ${vibe || "not specified"}.

Here is what the streamer has been saying on stream recently (transcript):
${transcriptText}

Here is what chat has been talking about recently:
${recentChatText}

The candidate chat message to evaluate:
"${candidateMessage}"

Remember: use the streamer profile above to judge humor and engagement - what matters is whether THIS streamer would react, not whether it's generically funny. Score each axis 0-10, compute total, and return JSON only.`;
}
