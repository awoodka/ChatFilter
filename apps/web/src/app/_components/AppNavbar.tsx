"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export default function AppNavbar() {
  const [username, setUsername] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true || j["authenticated"] !== true || !isRecord(j["user"])) return;
        const user = j["user"];
        if (!cancelled && typeof user["username"] === "string") setUsername(user["username"]);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="app-navbar">
      <div className="app-navbar-inner">
        <div className="flex items-center gap-3">
          <Link href="/" className="app-navbar-brand">
            ChatFilter
          </Link>
          <div className="twitch-pill hidden md:inline-flex">Realtime chat highlight tooling</div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/live" className="twitch-button-secondary inline-flex !h-8 items-center !text-xs">
            Filter
          </Link>
          <Link href="/sessions" className="twitch-button-secondary inline-flex !h-8 items-center !text-xs">
            Sessions
          </Link>
          <Link href="/practice" className="twitch-button-secondary inline-flex !h-8 items-center !text-xs">
            Practice Chat
          </Link>
          <Link href="/settings" className="twitch-button-secondary inline-flex !h-8 items-center !text-xs">
            Settings
          </Link>
          <button
            className="twitch-button-secondary !h-8 !text-xs"
            disabled={isLoggingOut}
            onClick={async () => {
              setIsLoggingOut(true);
              try {
                await fetch("/api/auth/logout", { method: "POST" });
              } finally {
                window.location.href = "/login";
              }
            }}
          >
            {isLoggingOut ? "Logging out..." : `Logout${username ? ` ${username}` : ""}`}
          </button>
        </div>
      </div>
    </header>
  );
}
