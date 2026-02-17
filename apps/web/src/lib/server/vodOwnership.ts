import { getDb } from "@/lib/server/db";
import { jobsRootDir, JobStatus } from "@/lib/job";
import fs from "node:fs/promises";
import path from "node:path";

type UserVodRow = {
  vod_id: string;
  vod_name: string;
  created_at: number;
};

export type UserVod = {
  vodId: string;
  vodName: string;
  createdAt: number;
};

function normalizeVodName(vodName: string, vodId: string): string {
  const trimmed = String(vodName ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return `VOD ${vodId}`;
  return trimmed.slice(0, 120);
}

export function linkVodToUser(userId: string, vodId: string, vodName: string): void {
  const now = Date.now();
  const db = getDb();
  const name = normalizeVodName(vodName, vodId);
  db.prepare(
    `INSERT INTO user_vods (user_id, vod_id, vod_name, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, vod_id) DO UPDATE SET
       vod_name = excluded.vod_name,
       created_at = excluded.created_at`,
  ).run(userId, vodId, name, now);
}

export function userOwnsVod(userId: string, vodId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 AS one FROM user_vods WHERE user_id = ? AND vod_id = ? LIMIT 1")
    .get(userId, vodId) as { one?: number } | undefined;
  return Boolean(row?.one);
}

export function listUserVodIds(userId: string): string[] {
  return listUserVods(userId).map((v) => v.vodId);
}

export function listUserVods(userId: string): UserVod[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT vod_id, vod_name, created_at FROM user_vods WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as UserVodRow[];
  return rows
    .filter((r) => /^\d+$/.test(String(r.vod_id)))
    .map((r) => {
      const vodId = String(r.vod_id);
      return {
        vodId,
        vodName: normalizeVodName(String(r.vod_name ?? ""), vodId),
        createdAt: Number(r.created_at) || 0,
      };
    });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export async function backfillUserVodLinksFromImportJobs(userId: string): Promise<number> {
  const root = jobsRootDir();
  let linked = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }

  for (const jobId of entries) {
    const statusPath = path.join(root, jobId, "status.json");
    let parsed: unknown = null;
    try {
      const txt = await fs.readFile(statusPath, "utf-8");
      parsed = JSON.parse(txt) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const status = parsed as JobStatus;
    if (status.type !== "import" || status.state !== "succeeded") continue;
    if (!isRecord(status.meta) || status.meta["userId"] !== userId) continue;
    const vodId = typeof status.vodId === "string" ? status.vodId : "";
    if (!/^\d+$/.test(vodId)) continue;
    if (userOwnsVod(userId, vodId)) continue;
    const fallbackName = `VOD ${vodId}`;
    const statusName =
      isRecord(status.meta) && typeof status.meta["vodName"] === "string" ? String(status.meta["vodName"]) : fallbackName;
    linkVodToUser(userId, vodId, statusName);
    linked += 1;
  }
  return linked;
}
