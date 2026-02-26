"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type JobStatusResponse = {
  ok: boolean;
  status?: {
    state: string;
    step?: string;
    error?: string;
    meta?: Record<string, unknown>;
  };
  logTail?: string;
  error?: string;
};

type Questionnaire = {
  vibe: string;
  love_reacting_to: string;
  ignore: string;
  recurring_bits: string;
  humor_style: string;
};

const FIELD_LABELS: Record<keyof Questionnaire, string> = {
  vibe: "Stream Vibe / Personality",
  love_reacting_to: "What They Love Reacting To",
  ignore: "What They Ignore",
  recurring_bits: "Recurring Bits & Community Lore",
  humor_style: "Humor Style",
};

const QUESTIONNAIRE_KEYS: (keyof Questionnaire)[] = [
  "vibe",
  "love_reacting_to",
  "ignore",
  "recurring_bits",
  "humor_style",
];

function stepLabel(step: string | undefined): string {
  switch (step) {
    case "audio_download":
      return "Downloading audio (first hour)...";
    case "transcribe":
      return "Transcribing audio...";
    case "analysis":
      return "Analyzing transcript with GPT...";
    case "done":
      return "Complete";
    default:
      return "Starting...";
  }
}

export default function VodAnalysisPage() {
  const [vodUrl, setVodUrl] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<string | null>(null);
  const [jobStep, setJobStep] = useState<string | undefined>();
  const [jobError, setJobError] = useState<string | null>(null);
  const [logTail, setLogTail] = useState("");
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollJob = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/jobs/${id}`);
          const j = (await r.json()) as JobStatusResponse;
          if (!j.ok || !j.status) return;

          setJobState(j.status.state);
          setJobStep(j.status.step);
          if (j.logTail) setLogTail(j.logTail);

          if (j.status.state === "succeeded") {
            stopPolling();
            const q = j.status.meta?.questionnaire as Questionnaire | undefined;
            if (q) setQuestionnaire(q);
          } else if (j.status.state === "failed") {
            stopPolling();
            setJobError(j.status.error ?? "Job failed");
          }
        } catch {
          // ignore transient fetch errors
        }
      }, 2000);
    },
    [stopPolling],
  );

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startAnalysis = async () => {
    setErrorText(null);
    setJobError(null);
    setQuestionnaire(null);
    setApplied(false);
    setSubmitError(null);
    setLogTail("");
    setJobState(null);
    setJobStep(undefined);

    const url = vodUrl.trim();
    if (!url) {
      setErrorText("Please enter a Twitch VOD URL.");
      return;
    }

    try {
      const r = await fetch("/api/vod/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vodUrl: url }),
      });
      const j = (await r.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!j.ok || !j.jobId) {
        setErrorText(j.error ?? "Failed to start analysis.");
        return;
      }
      setJobId(j.jobId);
      setJobState("queued");
      pollJob(j.jobId);
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : String(err));
    }
  };

  const applyToProfile = async () => {
    if (!questionnaire) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamQuestionnaire: questionnaire }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        setSubmitError(j.error ?? "Failed to apply settings.");
        return;
      }
      setApplied(true);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isRunning = jobState === "queued" || jobState === "running";

  return (
    <div className="space-y-6">
      {/* Section A: Input */}
      <div className="twitch-card p-5">
        <h2 className="text-base font-medium">Analyze a VOD</h2>
        <p className="twitch-muted mt-1 text-sm">
          Paste a Twitch VOD URL to auto-generate your stream questionnaire answers. The system will
          transcribe the first hour of audio and analyze the streamer&apos;s personality.
        </p>
        <div className="mt-4 flex gap-3">
          <input
            type="text"
            className="twitch-input flex-1"
            placeholder="https://www.twitch.tv/videos/1234567890"
            value={vodUrl}
            disabled={isRunning}
            onChange={(e) => setVodUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isRunning) void startAnalysis();
            }}
          />
          <button
            type="button"
            className="twitch-button-primary whitespace-nowrap"
            disabled={isRunning || !vodUrl.trim()}
            onClick={() => void startAnalysis()}
          >
            {isRunning ? "Analyzing..." : "Analyze VOD"}
          </button>
        </div>
        {errorText && <p className="mt-2 text-sm text-red-300">{errorText}</p>}
      </div>

      {/* Section B: Progress */}
      {jobId && isRunning && (
        <div className="twitch-card p-5">
          <h2 className="text-base font-medium">Progress</h2>
          <p className="twitch-muted mt-1 text-sm">{stepLabel(jobStep)}</p>
          {logTail && (
            <pre className="mt-3 max-h-48 overflow-auto rounded bg-black/30 p-3 font-mono text-xs text-gray-300">
              {logTail.split("\n").slice(-30).join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* Job error */}
      {jobState === "failed" && jobError && (
        <div className="twitch-card border-red-500/30 p-5">
          <h2 className="text-base font-medium text-red-300">Analysis Failed</h2>
          <p className="mt-1 text-sm text-red-300">{jobError}</p>
          {logTail && (
            <pre className="mt-3 max-h-48 overflow-auto rounded bg-black/30 p-3 font-mono text-xs text-gray-300">
              {logTail.split("\n").slice(-20).join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* Section C: Results */}
      {questionnaire && (
        <div className="twitch-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">Suggested Answers</h2>
            {!applied && (
              <button
                type="button"
                className="twitch-button-primary"
                disabled={submitting}
                onClick={() => void applyToProfile()}
              >
                {submitting ? "Applying..." : "Apply to Stream Settings"}
              </button>
            )}
          </div>
          {applied && (
            <p className="mt-2 text-sm text-green-300">
              Applied to your stream settings.{" "}
              <Link className="twitch-link" href="/settings/stream">
                View Stream Settings
              </Link>
            </p>
          )}
          {submitError && <p className="mt-2 text-sm text-red-300">{submitError}</p>}
          <div className="mt-4 space-y-4">
            {QUESTIONNAIRE_KEYS.map((key) => (
              <div key={key} className="space-y-1.5">
                <label className="text-sm font-medium">{FIELD_LABELS[key]}</label>
                <textarea
                  className="twitch-input min-h-24"
                  value={questionnaire[key] ?? ""}
                  readOnly
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
