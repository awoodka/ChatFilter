"use client";

import { useEffect, useMemo, useState } from "react";

type StreamQuestionKey = "vibe" | "love_reacting_to" | "ignore" | "recurring_bits" | "humor_style";

const QUESTION_DEFS: Array<{ key: StreamQuestionKey; prompt: string }> = [
  {
    key: "vibe",
    prompt: "How would you describe your stream's vibe/personality? (e.g. funny, chill, competitive, chaotic)",
  },
  {
    key: "love_reacting_to",
    prompt: "What kind of chat messages do you love reacting to? (e.g. roasts, questions, callbacks, inside jokes)",
  },
  {
    key: "ignore",
    prompt: "What kind of messages do you typically ignore or find annoying? (e.g. generic greetings, backseat gaming)",
  },
  {
    key: "recurring_bits",
    prompt: "What are recurring bits, memes, or lore in your community?",
  },
  {
    key: "humor_style",
    prompt: "Describe your humor style in a few words (e.g. sarcastic, deadpan, wholesome, self-deprecating)",
  },
];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    out[key] = item;
  }
  return out;
}

export default function StreamSettingsPage() {
  const [questionnaire, setQuestionnaire] = useState<Record<string, string>>({});
  const [longTermCache, setLongTermCache] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [successText, setSuccessText] = useState<string | null>(null);

  const hasAnyAnswer = useMemo(
    () => QUESTION_DEFS.some((q) => Boolean((questionnaire[q.key] ?? "").trim())),
    [questionnaire],
  );

  const persistProfile = async (payload: { streamQuestionnaire?: Record<string, string>; longTermCache?: string }, success: string) => {
    setErrorText(null);
    setSuccessText(null);
    setIsSaving(true);
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as unknown;
      if (!isRecord(j) || j["ok"] !== true || !isRecord(j["profile"])) {
        const msg = isRecord(j) && typeof j["error"] === "string" ? j["error"] : "Failed to save stream settings.";
        setErrorText(msg);
        return false;
      }
      const profile = j["profile"];
      if (typeof profile["longTermCache"] === "string") setLongTermCache(profile["longTermCache"]);
      setQuestionnaire(toStringRecord(profile["streamQuestionnaire"]));
      setSuccessText(success);
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
        if (cancelled) return;
        setQuestionnaire(toStringRecord(profile["streamQuestionnaire"]));
        if (typeof profile["longTermCache"] === "string") setLongTermCache(profile["longTermCache"]);
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
    <div className="space-y-6">
      <div className="twitch-card p-5">
        <h2 className="text-base font-medium">Guided questions</h2>
        <p className="twitch-muted mt-1 text-sm">
          Answer these in your own words. Each response auto-saves when the field loses focus.
        </p>
        <div className="mt-4 space-y-4">
          {QUESTION_DEFS.map((q) => (
            <div key={q.key} className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor={`stream_question_${q.key}`}>
                {q.prompt}
              </label>
              <textarea
                id={`stream_question_${q.key}`}
                className="twitch-input min-h-24"
                value={questionnaire[q.key] ?? ""}
                disabled={isLoading || isSaving || isGenerating}
                onChange={(e) =>
                  setQuestionnaire((prev) => ({
                    ...prev,
                    [q.key]: e.target.value,
                  }))
                }
                onBlur={() => {
                  const next = { ...questionnaire, [q.key]: questionnaire[q.key] ?? "" };
                  void persistProfile({ streamQuestionnaire: next }, "Questionnaire updated.");
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="twitch-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">Generated profile</h2>
          <button
            type="button"
            className="twitch-button-primary"
            disabled={isLoading || isSaving || isGenerating || !hasAnyAnswer}
            onClick={async () => {
              setErrorText(null);
              setSuccessText(null);
              setIsGenerating(true);
              try {
                const r = await fetch("/api/profile/generate", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({}),
                });
                const j = (await r.json()) as unknown;
                if (!isRecord(j) || j["ok"] !== true || typeof j["generated"] !== "string") {
                  const msg = isRecord(j) && typeof j["error"] === "string" ? j["error"] : "Failed to generate profile.";
                  setErrorText(msg);
                  return;
                }
                setLongTermCache(j["generated"]);
                setSuccessText("Generated new profile.");
              } catch (err: unknown) {
                setErrorText(err instanceof Error ? err.message : String(err));
              } finally {
                setIsGenerating(false);
              }
            }}
          >
            {isGenerating ? "Generating..." : "Generate profile"}
          </button>
        </div>
        <p className="twitch-muted mt-1 text-sm">
          Review and edit your long-term profile. Changes auto-save when this field loses focus.
        </p>
        <textarea
          className="twitch-input mt-4 min-h-56"
          value={longTermCache}
          disabled={isLoading || isSaving || isGenerating}
          onChange={(e) => setLongTermCache(e.target.value)}
          onBlur={() => {
            void persistProfile({ longTermCache }, "Long-term profile updated.");
          }}
        />
      </div>

      {errorText ? <div className="text-sm text-red-300">{errorText}</div> : null}
      {successText ? <div className="text-sm text-green-300">{successText}</div> : null}
    </div>
  );
}
