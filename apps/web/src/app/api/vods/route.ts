import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { dataRootDir } from "@/lib/vod";
import { requireAuthUser } from "@/lib/server/routeAuth";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;
  const vodsDir = path.join(dataRootDir(), "vods");
  try {
    const entries = await fs.readdir(vodsDir, { withFileTypes: true });
    const vodIds = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    return NextResponse.json({ ok: true, vodIds });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(`Failed to list VODs: ${msg}`, 500);
  }
}

