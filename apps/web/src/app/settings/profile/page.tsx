"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export default function SettingsProfilePage() {
  const [twitchChannelUrl, setTwitchChannelUrl] = useState("");
  const [bots, setBots] = useState<string[]>([]);
  const [emotes, setEmotes] = useState<string[]>([]);
  const [newBot, setNewBot] = useState("");
  const [newEmote, setNewEmote] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [successText, setSuccessText] = useState<string | null>(null);

  const persistProfile = async (opts: {
    twitchChannelUrl: string;
    bots: string[];
    emotes: string[];
    successMessage?: string;
  }) => {
    setErrorText(null);
    setSuccessText(null);
    setIsSaving(true);
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          twitchChannelUrl: opts.twitchChannelUrl,
          bots: opts.bots,
          emotes: opts.emotes,
        }),
      });
      const j = (await r.json()) as unknown;
      if (!isRecord(j) || j["ok"] !== true || !isRecord(j["profile"])) {
        const msg = isRecord(j) && typeof j["error"] === "string" ? j["error"] : "Failed to save settings.";
        setErrorText(msg);
        return false;
      }
      const profile = j["profile"];
      if (typeof profile["twitchChannelUrl"] === "string") setTwitchChannelUrl(profile["twitchChannelUrl"]);
      if (Array.isArray(profile["bots"])) {
        setBots(profile["bots"].filter((x): x is string => typeof x === "string"));
      }
      if (Array.isArray(profile["emotes"])) {
        setEmotes(profile["emotes"].filter((x): x is string => typeof x === "string"));
      }
      setSuccessText(opts.successMessage ?? "Saved.");
      return true;
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/profile", { cache: "no-store" });
        const j = (await r.json()) as unknown;
        if (!isRecord(j) || j["ok"] !== true || !isRecord(j["profile"])) return;
        const profile = j["profile"];
        if (!cancelled) {
          if (typeof profile["twitchChannelUrl"] === "string") {
            setTwitchChannelUrl(profile["twitchChannelUrl"]);
          }
          if (Array.isArray(profile["bots"])) {
            setBots(profile["bots"].filter((x): x is string => typeof x === "string"));
          }
          if (Array.isArray(profile["emotes"])) {
            setEmotes(profile["emotes"].filter((x): x is string => typeof x === "string"));
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="twitch-card p-5">
      <h2 className="text-base font-medium">Twitch account link</h2>
      <p className="twitch-muted mt-1 text-sm">
        Link your Twitch page to auto-populate the channel field on the Filter page.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          await persistProfile({ twitchChannelUrl, bots, emotes, successMessage: "Settings saved." });
        }}
      >
        <label className="text-sm font-medium" htmlFor="twitch_channel_link">
          Twitch channel or URL
        </label>
        <input
          id="twitch_channel_link"
          className="twitch-input"
          placeholder="ludwig or https://www.twitch.tv/ludwig"
          value={twitchChannelUrl}
          onChange={(e) => setTwitchChannelUrl(e.target.value)}
          disabled={isLoading || isSaving}
        />
        <div className="flex items-center gap-2">
          <button type="submit" className="twitch-button-primary" disabled={isLoading || isSaving}>
            {isSaving ? "Saving..." : "Save settings"}
          </button>
          <Link className="twitch-link text-sm" href="/live">
            Open Filter
          </Link>
        </div>
      </form>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <div className="twitch-card-soft p-4">
          <h3 className="text-sm font-medium">Bots</h3>
          <p className="twitch-muted mt-1 text-xs">Add bot usernames or bot names used in chat context.</p>
          <div className="mt-3 flex gap-2">
            <input
              className="twitch-input"
              placeholder="Add bot..."
              value={newBot}
              onChange={(e) => setNewBot(e.target.value)}
              disabled={isLoading || isSaving}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const value = newBot.trim();
                if (!value) return;
                if (bots.includes(value)) {
                  setNewBot("");
                  return;
                }
                const nextBots = [...bots, value];
                setBots(nextBots);
                setNewBot("");
                void persistProfile({
                  twitchChannelUrl,
                  bots: nextBots,
                  emotes,
                  successMessage: "Bots updated.",
                });
              }}
            />
            <button
              type="button"
              className="twitch-button-secondary"
              disabled={isLoading || isSaving}
              onClick={() => {
                const value = newBot.trim();
                if (!value) return;
                if (bots.includes(value)) {
                  setNewBot("");
                  return;
                }
                const nextBots = [...bots, value];
                setBots(nextBots);
                setNewBot("");
                void persistProfile({
                  twitchChannelUrl,
                  bots: nextBots,
                  emotes,
                  successMessage: "Bots updated.",
                });
              }}
            >
              Add
            </button>
          </div>
          <div className="mt-3 flex max-h-[220px] flex-col gap-2 overflow-auto">
            {bots.length === 0 ? (
              <div className="twitch-muted text-xs">(no bots added)</div>
            ) : (
              bots.map((item) => (
                <div key={item} className="twitch-card-soft flex items-center justify-between px-3 py-2 text-sm">
                  <span>{item}</span>
                  <button
                    type="button"
                    className="twitch-link text-xs"
                    disabled={isLoading || isSaving}
                    onClick={() => {
                      const nextBots = bots.filter((x) => x !== item);
                      setBots(nextBots);
                      void persistProfile({
                        twitchChannelUrl,
                        bots: nextBots,
                        emotes,
                        successMessage: "Bots updated.",
                      });
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="twitch-card-soft p-4">
          <h3 className="text-sm font-medium">Emotes</h3>
          <p className="twitch-muted mt-1 text-xs">Add emotes your chat commonly uses.</p>
          <div className="mt-3 flex gap-2">
            <input
              className="twitch-input"
              placeholder="Add emote..."
              value={newEmote}
              onChange={(e) => setNewEmote(e.target.value)}
              disabled={isLoading || isSaving}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const value = newEmote.trim();
                if (!value) return;
                if (emotes.includes(value)) {
                  setNewEmote("");
                  return;
                }
                const nextEmotes = [...emotes, value];
                setEmotes(nextEmotes);
                setNewEmote("");
                void persistProfile({
                  twitchChannelUrl,
                  bots,
                  emotes: nextEmotes,
                  successMessage: "Emotes updated.",
                });
              }}
            />
            <button
              type="button"
              className="twitch-button-secondary"
              disabled={isLoading || isSaving}
              onClick={() => {
                const value = newEmote.trim();
                if (!value) return;
                if (emotes.includes(value)) {
                  setNewEmote("");
                  return;
                }
                const nextEmotes = [...emotes, value];
                setEmotes(nextEmotes);
                setNewEmote("");
                void persistProfile({
                  twitchChannelUrl,
                  bots,
                  emotes: nextEmotes,
                  successMessage: "Emotes updated.",
                });
              }}
            >
              Add
            </button>
          </div>
          <div className="mt-3 flex max-h-[220px] flex-col gap-2 overflow-auto">
            {emotes.length === 0 ? (
              <div className="twitch-muted text-xs">(no emotes added)</div>
            ) : (
              emotes.map((item) => (
                <div key={item} className="twitch-card-soft flex items-center justify-between px-3 py-2 text-sm">
                  <span>{item}</span>
                  <button
                    type="button"
                    className="twitch-link text-xs"
                    disabled={isLoading || isSaving}
                    onClick={() => {
                      const nextEmotes = emotes.filter((x) => x !== item);
                      setEmotes(nextEmotes);
                      void persistProfile({
                        twitchChannelUrl,
                        bots,
                        emotes: nextEmotes,
                        successMessage: "Emotes updated.",
                      });
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {errorText ? <div className="mt-3 text-sm text-red-300">{errorText}</div> : null}
      {successText ? <div className="mt-3 text-sm text-green-300">{successText}</div> : null}
    </div>
  );
}
