"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { clearLiveSnapshot, loadLiveSnapshot } from "@/lib/live/sessionSnapshot";

function isLiveMvpRoute(pathname: string): boolean {
  return pathname === "/live" || pathname === "/live/highlights";
}

export default function LiveSnapshotRouteGuard() {
  const pathname = usePathname();
  const prevPathRef = useRef<string | null>(null);

  useEffect(() => {
    const current = String(pathname ?? "");
    const prev = prevPathRef.current;
    const currentIsLive = isLiveMvpRoute(current);
    const prevIsLive = prev ? isLiveMvpRoute(prev) : false;

    const snapshot = loadLiveSnapshot();
    const canClearSnapshot = Boolean(snapshot && !snapshot.isRunning);

    // On first mount, clear stale snapshots unless we're already on one of the live pages.
    if (prev === null) {
      if (!currentIsLive && canClearSnapshot) clearLiveSnapshot();
      prevPathRef.current = current;
      return;
    }

    // Keep active live sessions across the app; only clear inactive snapshots when leaving live routes.
    if (prevIsLive && !currentIsLive && canClearSnapshot) {
      clearLiveSnapshot();
    }

    prevPathRef.current = current;
  }, [pathname]);

  return null;
}
