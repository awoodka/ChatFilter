import path from "node:path";

export function extractVodId(vodUrl: string): string | null {
  // Typical: https://www.twitch.tv/videos/1234567890
  const m = vodUrl.match(/twitch\.tv\/videos\/(\d+)/i);
  if (m?.[1]) return m[1];
  // Allow raw numeric input in the URL field too
  if (/^\d+$/.test(vodUrl.trim())) return vodUrl.trim();
  return null;
}

export function dataRootDir(): string {
  // Next.js runs from apps/web; store artifacts at repoRoot/data
  return path.join(process.cwd(), "..", "..", "data");
}

function safePathSegment(input: string): string {
  const x = input.trim();
  if (!x) return "unknown";
  return x.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function userDataDir(userId: string): string {
  return path.join(dataRootDir(), "users", safePathSegment(userId));
}

export function userCachesDir(userId: string, streamerKey: string): string {
  return path.join(userDataDir(userId), "caches", safePathSegment(streamerKey));
}

export function legacyCachesDir(streamerKey: string): string {
  return path.join(dataRootDir(), "caches", safePathSegment(streamerKey));
}

export function vodDir(vodId: string): string {
  return path.join(dataRootDir(), "vods", vodId);
}

export function vodRawDir(vodId: string): string {
  return path.join(vodDir(vodId), "raw");
}

export function vodCanonicalDir(vodId: string): string {
  return path.join(vodDir(vodId), "canonical");
}

export function vodRunsDir(vodId: string): string {
  return path.join(vodDir(vodId), "runs");
}

