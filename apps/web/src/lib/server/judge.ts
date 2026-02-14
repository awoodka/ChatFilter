type LogFn = (line: string) => Promise<void> | void;

export type JudgeRateLimiter = {
  waitForSlot: () => Promise<void>;
  onRateLimited: (ms: number) => void;
};

export function createJudgeRateLimiter(maxRpm: number): JudgeRateLimiter {
  const rpm = Math.max(1, Math.floor(maxRpm));
  const requestTimes: number[] = [];
  let globalCooldownUntilMs = 0;
  return {
    async waitForSlot() {
      while (true) {
        const now = Date.now();
        if (now < globalCooldownUntilMs) {
          await sleepMs(Math.max(25, globalCooldownUntilMs - now));
          continue;
        }
        while (requestTimes.length > 0 && requestTimes[0]! <= now - 60_000) requestTimes.shift();
        if (requestTimes.length < rpm) {
          requestTimes.push(now);
          return;
        }
        const waitMs = Math.max(25, 60_000 - (now - requestTimes[0]!) + 5);
        await sleepMs(waitMs);
      }
    },
    onRateLimited(ms: number) {
      globalCooldownUntilMs = Math.max(globalCooldownUntilMs, Date.now() + Math.max(0, ms));
    },
  };
}

export async function scoreWithRetries(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  limiter: JudgeRateLimiter;
  maxAttempts?: number;
  appendLog?: LogFn;
}): Promise<{ relevance: number; humor: number; engagement: number; score: number; reason: string }> {
  const { apiKey, model, systemPrompt, userPrompt, limiter, appendLog } = opts;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 6));
  const url = "https://api.openai.com/v1/chat/completions";
  const payload = {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  let resp: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await limiter.waitForSlot();
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      lastErr = err;
      resp = null;
    }

    if (resp && resp.ok) {
      try {
        const j = (await resp.json()) as unknown;
        let content = "";
        if (isRecord(j)) {
          const choices = j["choices"];
          if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
            const msgObj = choices[0]["message"];
            if (isRecord(msgObj) && typeof msgObj["content"] === "string") {
              content = msgObj["content"];
            }
          }
        }
        let relevance = 0;
        let humor = 0;
        let engagement = 0;
        let score = 0;
        let reason = "";
        try {
          const parsed = JSON.parse(content);
          const record = isRecord(parsed) ? parsed : {};
          relevance = clampAxis(record["relevance"]);
          humor = clampAxis(record["humor"]);
          engagement = clampAxis(record["engagement"]);
          const parsedScore = Number(record["score"]);
          score = Number.isFinite(parsedScore) ? clampScore(parsedScore) : computeTotalScore(relevance, humor, engagement);
          reason = String(record["reason"] ?? "");
        } catch {
          reason = `non_json: ${String(content).slice(0, 200)}`;
          relevance = 0;
          humor = 0;
          engagement = 0;
          score = 0;
        }
        return { relevance, humor, engagement, score, reason };
      } catch (err: unknown) {
        // e.g. "terminated" while reading body
        lastErr = err;
        resp = null;
      }
    }

    const status = resp?.status ?? 0;
    const shouldRetry = status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    if (!shouldRetry) break;

    const retryAfterMs = resp ? parseRetryAfterMs(resp.headers) : null;
    const jitterMs = Math.floor(Math.random() * 250);
    const backoffMs = Math.min(30_000, Math.max(retryAfterMs ?? 0, 750 * Math.pow(2, attempt - 1) + jitterMs));
    if (status === 429) limiter.onRateLimited(backoffMs);
    await appendLog?.(
      `openai retry attempt=${attempt}/${maxAttempts} status=${status} backoff_ms=${backoffMs}${retryAfterMs !== null ? ` retry_after_ms=${retryAfterMs}` : ""} ${lastErr instanceof Error ? `err=${lastErr.message}` : ""}`,
    );
    await sleepMs(backoffMs);
  }

  const status = resp?.status ?? 0;
  const requestId = resp ? headerPick(resp.headers, "x-request-id") : null;
  const cfRay = resp ? headerPick(resp.headers, "cf-ray") : null;
  let errText = "";
  try {
    errText = resp ? await resp.text() : "";
  } catch {
    errText = "";
  }
  await appendLog?.(
    `openai_error status=${status} request_id=${requestId ?? "unknown"} cf_ray=${cfRay ?? "unknown"} body_len=${errText.length} body_preview=${JSON.stringify(
      safePreview(errText, 500),
    )}`,
  );
  if (lastErr) {
    const le = lastErr instanceof Error ? lastErr.stack ?? lastErr.message : String(lastErr);
    await appendLog?.(`openai_fetch_exception ${safePreview(le, 1000)}`);
  }
  const msg =
    status === 403
      ? `OpenAI 403 Forbidden (check billing/model access/API key). request_id=${requestId ?? "unknown"} cf_ray=${cfRay ?? "unknown"}`
      : `LLM judge call failed: ${status || "no_response"} request_id=${requestId ?? "unknown"} cf_ray=${cfRay ?? "unknown"}`;
  throw new Error(msg);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function clampAxis(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function computeTotalScore(relevance: number, humor: number, engagement: number): number {
  return Math.round(((relevance + humor + engagement) / 30) * 100);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerPick(headers: Headers, key: string): string | null {
  try {
    return headers.get(key);
  } catch {
    return null;
  }
}

function safePreview(s: string, n: number): string {
  const t = String(s ?? "");
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const s = raw.trim();
  const sec = Number(s);
  if (Number.isFinite(sec) && sec >= 0) return Math.floor(sec * 1000);
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const ms = t - Date.now();
    return ms > 0 ? ms : 0;
  }
  return null;
}
