import fs from "node:fs/promises";

export type LongTermCache = {
    version: 1;
    updated_at_ms: number;
    streamer_style_summary: string;
    positive_examples: string[]; // short messages the streamer engaged with (sanitized, no usernames)
};

export type SessionCache = {
    version: 1;
    updated_at_ms: number;
    window_start_ts_ms: number | null; // start of current 10-min window (chat ts)
    window_end_ts_ms: number | null; // end of current 10-min window (chat ts)
    top_chatters: Array<{ id: string; count: number }>;
    top_topics: Array<{ token: string; count: number }>;
    repeated_phrases: Array<{ phrase: string; count: number }>;
};

export type ShortTermCache = {
    version: 1;
    updated_at_ms: number;
    recent_chat: string[]; // rolling window of recent canonical chat (text only)
    transcript_last_60s: string[]; // rolling window of transcript lines
    live_metrics: {
        msgs_last_60s: number;
        msgs_per_min: number;
    };
};

export async function readJson<T>(p: string): Promise<T | null> {
    try {
        const txt = await fs.readFile(p, "utf-8");
        return JSON.parse(txt) as T;
    } catch {
        return null;
    }
}

export async function writeJson(p: string, obj: unknown): Promise<void> {
    const txt = JSON.stringify(obj, null, 2);
    await fs.writeFile(p, txt, "utf-8");
}

