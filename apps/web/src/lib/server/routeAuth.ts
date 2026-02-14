import { NextResponse } from "next/server";

import { getAuthUserFromRequest } from "@/lib/server/auth";
import { JobStatus } from "@/lib/job";

export type AuthenticatedUser = {
  id: string;
  username: string;
  createdAt: number;
};

export function jsonUnauthorized() {
  return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
}

export function requireAuthUser(request: Request): { user: AuthenticatedUser; error: null } | { user: null; error: NextResponse } {
  const user = getAuthUserFromRequest(request);
  if (!user) return { user: null, error: jsonUnauthorized() };
  return { user, error: null };
}

export function isJobOwnedByUser(job: JobStatus, userId: string): boolean {
  const meta = job.meta;
  if (!meta) return false;
  const ownerId = meta["userId"];
  return typeof ownerId === "string" && ownerId === userId;
}
