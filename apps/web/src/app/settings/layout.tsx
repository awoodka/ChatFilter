import type { ReactNode } from "react";
import Link from "next/link";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-6xl">
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <Link className="twitch-link text-sm" href="/">
            Back
          </Link>
        </div>
        <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="twitch-card h-fit p-3">
            <nav className="flex flex-col gap-1">
              <Link className="twitch-link rounded-md px-2 py-1.5 text-sm" href="/settings/profile">
                Profile
              </Link>
              <Link className="twitch-link rounded-md px-2 py-1.5 text-sm" href="/settings/stream">
                Stream
              </Link>
            </nav>
          </aside>
          <section>{children}</section>
        </div>
      </div>
    </div>
  );
}
