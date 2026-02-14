"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  return (
    <div className="twitch-page">
      <div className="twitch-shell max-w-xl">
        <div className="twitch-card p-6">
          <h1 className="text-xl font-semibold">Log in</h1>
          <p className="twitch-muted mt-1 text-sm">Use your ChatFilter account to access eval and live dashboards.</p>

          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setErrorText(null);
              setIsLoading(true);
              try {
                const r = await fetch("/api/auth/login", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ username, password }),
                });
                const j = (await r.json()) as unknown;
                if (!isRecord(j) || j["ok"] !== true) {
                  const msg = isRecord(j) && typeof j["error"] === "string" ? j["error"] : "Login failed.";
                  setErrorText(msg);
                  return;
                }
                const params = new URLSearchParams(window.location.search);
                const nextPath = params.get("next") || "/";
                router.push(nextPath);
                router.refresh();
              } catch (err: unknown) {
                setErrorText(err instanceof Error ? err.message : String(err));
              } finally {
                setIsLoading(false);
              }
            }}
          >
            <label className="text-sm font-medium" htmlFor="login_username">
              Username
            </label>
            <input
              id="login_username"
              className="twitch-input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <label className="text-sm font-medium" htmlFor="login_password">
              Password
            </label>
            <input
              id="login_password"
              type="password"
              className="twitch-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button type="submit" className="twitch-button-primary mt-1" disabled={isLoading}>
              {isLoading ? "Logging in..." : "Log in"}
            </button>
          </form>

          {errorText ? <div className="mt-3 text-sm text-red-300">{errorText}</div> : null}

          <div className="mt-5 text-sm">
            <span className="twitch-muted">Need an account? </span>
            <Link className="twitch-link" href="/signup">
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
