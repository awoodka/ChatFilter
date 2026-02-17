"use client";

import Link from "next/link";

export default function Home() {
  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-5xl">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">ChatFilter</h1>
        </div>

        <div className="mt-3 text-sm twitch-muted">
          Choose a workflow. Testing tools are stable now; Live MVP is the next build-out surface.
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Link
            href="/eval"
            className="twitch-card block p-5 transition-colors hover:border-[#9147ff]"
          >
            <div className="text-base font-medium">Testing dashboard</div>
            <div className="mt-1 text-sm twitch-muted">
              Run offline evals on imported VODs, inspect metrics, and review high-scoring + read-aloud chats.
            </div>
            <div className="mt-3 text-xs twitch-link">Open /eval</div>
          </Link>

          <Link
            href="/live"
            className="twitch-card block p-5 transition-colors hover:border-[#9147ff]"
          >
            <div className="text-base font-medium">Main MVP (Live)</div>
            <div className="mt-1 text-sm twitch-muted">
              Connect Twitch IRC + local transcription input to surface live &quot;good chats&quot; in real time.
            </div>
            <div className="mt-3 text-xs twitch-link">Open /live</div>
          </Link>
        </div>

        <div className="twitch-card mt-6 p-5">
          <h2 className="text-base font-medium">Prereqs</h2>
          <ul className="mt-2 list-disc pl-5 text-sm twitch-muted">
            <li>
              <code className="twitch-code">TwitchDownloaderCLI</code>{" "}
              available on PATH
            </li>
            <li>
              <code className="twitch-code">yt-dlp</code> available on PATH
            </li>
            <li>
              <code className="twitch-code">OPENAI_API_KEY</code> set for transcription
            </li>
            <li>
              Python package installed:{" "}
              <code className="twitch-code">pip install -e backend/chatfilter</code>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
