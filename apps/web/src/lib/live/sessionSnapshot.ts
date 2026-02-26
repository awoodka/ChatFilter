export type LiveStatus = {
  jobId: string;
  type?: string;
  state: "queued" | "running" | "succeeded" | "failed";
  step?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

export type LiveFeedMessage = {
  ts_ms: number;
  text: string;
  username: string | null;
  score: number | null;
  reason: string | null;
  relevance?: number | null;
  humor?: number | null;
  engagement?: number | null;
};

export type LiveSessionSnapshot = {
  sessionId: string | null;
  status: LiveStatus | null;
  isRunning: boolean;
  logText: string;
  chatMessages: LiveFeedMessage[];
  goodMessages: LiveFeedMessage[];
  errorText: string | null;
  metricsText: string;
  contextText: string;
  currentGame: string;
  threshold: number;
  dynamicThreshold: boolean;
  targetRate: number;
  linkedChannelUrl: string;
  feedbackGiven: Record<string, "up" | "down">;
  updatedAt: number;
};

const LIVE_SNAPSHOT_STORAGE_KEY = "chatfilter_live_snapshot_v1";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toLiveStatus(x: unknown): LiveStatus | null {
  if (!isRecord(x)) return null;
  const jobId = x["jobId"];
  const state = x["state"];
  if (typeof jobId !== "string") return null;
  if (state !== "queued" && state !== "running" && state !== "succeeded" && state !== "failed") return null;
  return {
    jobId,
    state,
    type: typeof x["type"] === "string" ? x["type"] : undefined,
    step: typeof x["step"] === "string" ? x["step"] : undefined,
    error: typeof x["error"] === "string" ? x["error"] : undefined,
    meta: isRecord(x["meta"]) ? x["meta"] : undefined,
  };
}

export function toLiveFeedMessage(x: unknown): LiveFeedMessage | null {
  if (!isRecord(x)) return null;
  const ts_ms = x["ts_ms"];
  const text = x["text"];
  if (typeof ts_ms !== "number" || typeof text !== "string") return null;
  const username = typeof x["username"] === "string" ? x["username"] : null;
  const score = typeof x["score"] === "number" ? x["score"] : null;
  const reason = typeof x["reason"] === "string" ? x["reason"] : null;
  const relevance = typeof x["relevance"] === "number" ? x["relevance"] : null;
  const humor = typeof x["humor"] === "number" ? x["humor"] : null;
  const engagement = typeof x["engagement"] === "number" ? x["engagement"] : null;
  return { ts_ms, text, username, score, reason, relevance, humor, engagement };
}

function defaultSnapshot(): LiveSessionSnapshot {
  return {
    sessionId: null,
    status: null,
    isRunning: false,
    logText: "{ }",
    chatMessages: [],
    goodMessages: [],
    errorText: null,
    metricsText: "{ }",
    contextText: "{ }",
    currentGame: "",
    threshold: 80,
    dynamicThreshold: false,
    targetRate: 2,
    linkedChannelUrl: "",
    feedbackGiven: {},
    updatedAt: Date.now(),
  };
}

export function loadLiveSnapshot(): LiveSessionSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LIVE_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const base = defaultSnapshot();
    const chatMessages = Array.isArray(parsed["chatMessages"])
      ? parsed["chatMessages"].map(toLiveFeedMessage).filter((m): m is LiveFeedMessage => Boolean(m)).slice(-250)
      : [];
    const goodMessages = Array.isArray(parsed["goodMessages"])
      ? parsed["goodMessages"].map(toLiveFeedMessage).filter((m): m is LiveFeedMessage => Boolean(m)).slice(-250)
      : [];
    return {
      ...base,
      sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : null,
      status: toLiveStatus(parsed["status"]),
      isRunning: parsed["isRunning"] === true,
      logText: typeof parsed["logText"] === "string" ? parsed["logText"] : base.logText,
      chatMessages,
      goodMessages,
      errorText: typeof parsed["errorText"] === "string" ? parsed["errorText"] : null,
      metricsText: typeof parsed["metricsText"] === "string" ? parsed["metricsText"] : base.metricsText,
      contextText: typeof parsed["contextText"] === "string" ? parsed["contextText"] : base.contextText,
      currentGame: typeof parsed["currentGame"] === "string" ? parsed["currentGame"] : "",
      threshold:
        typeof parsed["threshold"] === "number" && Number.isFinite(parsed["threshold"])
          ? Math.max(0, Math.min(100, Math.round(parsed["threshold"])))
          : base.threshold,
      dynamicThreshold: parsed["dynamicThreshold"] === true,
      targetRate:
        typeof parsed["targetRate"] === "number" && Number.isFinite(parsed["targetRate"])
          ? Math.max(0.5, Math.min(30, parsed["targetRate"]))
          : base.targetRate,
      linkedChannelUrl: typeof parsed["linkedChannelUrl"] === "string" ? parsed["linkedChannelUrl"] : "",
      feedbackGiven:
        isRecord(parsed["feedbackGiven"])
          ? Object.fromEntries(
              Object.entries(parsed["feedbackGiven"] as Record<string, unknown>).filter(
                ([, v]) => v === "up" || v === "down",
              ),
            ) as Record<string, "up" | "down">
          : {},
      updatedAt: typeof parsed["updatedAt"] === "number" ? parsed["updatedAt"] : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveLiveSnapshotPatch(patch: Partial<LiveSessionSnapshot>): void {
  if (typeof window === "undefined") return;
  try {
    const base = loadLiveSnapshot() ?? defaultSnapshot();
    const next: LiveSessionSnapshot = {
      ...base,
      ...patch,
      chatMessages: Array.isArray(patch.chatMessages) ? patch.chatMessages.slice(-250) : base.chatMessages,
      goodMessages: Array.isArray(patch.goodMessages) ? patch.goodMessages.slice(-250) : base.goodMessages,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(LIVE_SNAPSHOT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function clearLiveSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LIVE_SNAPSHOT_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}
