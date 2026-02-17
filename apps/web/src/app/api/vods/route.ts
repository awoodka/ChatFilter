import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/server/routeAuth";
import { backfillUserVodLinksFromImportJobs, listUserVods } from "@/lib/server/vodOwnership";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: Request) {
  const auth = requireAuthUser(req);
  if (auth.error) return auth.error;
  try {
    let vods = listUserVods(auth.user.id);
    if (vods.length === 0) {
      const linked = await backfillUserVodLinksFromImportJobs(auth.user.id);
      if (linked > 0) vods = listUserVods(auth.user.id);
    }
    return NextResponse.json({
      ok: true,
      vods,
      // keep old key for compatibility
      vodIds: vods.map((v) => v.vodId),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(`Failed to list VODs: ${msg}`, 500);
  }
}
