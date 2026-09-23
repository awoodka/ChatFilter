# ChatFilter

ChatFilter is a local web app I built in February 2026 for two kinds of Twitch streamers. Small streamers
usually don't have much of a chat yet, so they never get practice talking to one. ChatFilter can generate
a simulated chat that reacts to what's actually happening on your stream. Big streamers have the opposite
problem: chat moves too fast to read, and the interesting messages get buried under emotes and copypasta.
For them it watches the live chat, drops the junk, scores what's left with an LLM, and keeps a short feed
of the messages worth reacting to.

It runs on one machine (a Next.js app, a small Python package, SQLite and some files on disk). I'm not
actively working on it anymore, and there are no tests.

## How live highlighting works

When you start a session on `/live`, the app joins the channel's chat anonymously over Twitch IRC.
Usernames on your bot list are dropped right away. Everything else goes through a long-running Python
process (`chatfilter filter-live-stream`) that throws out `!gamble` commands, one-word messages, the same
word repeated, links, and messages that are mostly emotes or emoji, including your channel's own emotes.
It also handles chat "choruses": once five or more people send the same message within 30 seconds, it
keeps one copy and drops the rest.

Meanwhile the app pulls the stream's audio (using Twitch's playback token, with streamlink as a fallback), cuts
it into 3-second chunks with ffmpeg and transcribes them, either locally with faster-whisper or through
OpenAI's whisper-1. If you set a Gemini key, it also grabs 12 frames every 60 seconds and asks Gemini 2.5
Flash what game is on screen and what's going on.

Each message that makes it through the filter is scored by gpt-4.1-mini with that context in the prompt:
your streamer profile, the last 8 transcript lines, the last 10 chat messages, what's on screen, and
examples of messages you've liked and disliked. The model rates relevance, humor and engagement from 0 to
10 each, and the total is scaled to 0–100. Anything above your threshold (80 by default) lands in the feed
at `/live/highlights`. For quieter streams there's a dynamic mode. You pick a target rate (2 a minute by
default), and if nothing has cleared the threshold in that long, the best message since the last
highlight gets promoted anyway and tagged `[dynamic]`.

## Teaching it your taste

On the highlights page you can thumbs-up or thumbs-down any message, or move with `j`/`k` and vote with
`u`/`d`. Votes go into the good and bad chat examples in your profile, and a running session picks them up
within a minute, so there's no need to restart. Once you have at least five votes, with at least one
downvote among them, the app works out a threshold halfway between the average score of what you liked
and what you didn't (kept between 60 and 95) and pre-fills the slider on `/live` with it.

The profile starts from a five-question questionnaire on `/settings/stream` about your stream's vibe, the
messages you love reacting to, what to ignore, your recurring bits and your sense of humor. An LLM turns
your answers and your votes into a longer profile, which you can edit by hand. If you'd rather not answer
the questions yourself, `/settings/vod-analysis` transcribes the first hour of one of your VODs and
suggests answers.

## Practice chat

`/practice` generates a simulated chat for you to talk to. If you're streaming with a live session running,
it reads the latest transcript and the detected game, so the fake messages react to what you're doing right
then. If you're not live, you type in what you're playing (say, Valorant or Just Chatting) and it works from
that and your profile. It borrows the humor style from your profile but leaves out inside jokes and running bits, to keep the
practice about what's happening on stream.

## Checking it against old VODs

`/eval` is for tuning the threshold and prompt before going live. You give it a Twitch VOD link, and it
downloads the chat with TwitchDownloaderCLI and the audio with yt-dlp, transcribes it with whisper-1 and
runs the same Python filter. To have something to grade against, `chatfilter align` labels a message as
"read aloud" when something the streamer says in the next 90 seconds overlaps it closely enough (at least
72% token overlap, for messages of four or more words). Those labels are rough. They catch messages the
streamer read out and miss ones they reacted to without reading. A separate scoring job then runs the LLM
over the messages and reports precision and recall for the top 1 and top 3 messages in each 30-second
window, plus precision and recall at your threshold.

## Past sessions and the dashboard

Past sessions are listed on `/sessions`, and each one can get a 3–5 bullet recap written by gpt-4.1-mini.
The dashboard at `/` shows whether a session is running and charts how many messages were seen, filtered
and highlighted.

## Running it

You'll need Node 20.9 or newer (Next 16 won't start on 18), Python 3.10+, ffmpeg and an OpenAI API key.
From the repo root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e "backend/chatfilter[whisper]"

cd apps/web
npm install
export OPENAI_API_KEY=sk-...
npm run dev
```

Keep the virtualenv at the repo root as `.venv`, since live sessions look for `.venv/bin/python` there
before falling back to `python3`. The `whisper` extra installs faster-whisper for local transcription,
which is the default. If you don't want it, set `LIVE_TRANSCRIBE_PROVIDER=openai` instead. Start the app
from `apps/web`, because it keeps its data two levels up in `data/`: the SQLite database at `data/app.db`
and each live session's logs under `data/live/`. Then open http://localhost:3000, create an account (it
only exists in that local database), link your channel on `/settings/profile` and fill in the
questionnaire.

The VOD features also need TwitchDownloaderCLI and yt-dlp. For each tool the app checks an env var first,
then a `tools/` folder at the repo root if you've made one (`tools/TwitchDownloaderCLI`, `tools/yt-dlp`,
`tools/ffmpeg/ffmpeg`), then your PATH. `tools/` is gitignored.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | required | Scoring, transcription, profile generation |
| `GEMINI_API_KEY` | unset | Turns on screen analysis during live sessions |
| `EVAL_MODEL` | `gpt-4.1-mini` | Model that scores messages live, in practice chat and in evals |
| `EVAL_JUDGE_MAX_RPM` | `120` | Rate limit on scoring calls, per minute |
| `LIVE_TRANSCRIBE_PROVIDER` | `local` | `local`, `openai`, or `auto` (local, falling back to OpenAI) |
| `LIVE_LOCAL_WHISPER_MODEL` | `base` | faster-whisper model size (`tiny.en`, `base`, `small`, ...) |
| `LIVE_LOCAL_WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `LIVE_VISION_INTERVAL_MS` | `60000` | How often frames go to Gemini |
| `TWITCHDOWNLOADER_PATH`, `YTDLP_PATH`, `FFMPEG_PATH` | unset | Tool locations (live sessions also read `LIVE_FFMPEG_PATH`) |
| `TWITCH_CLIENT_ID`, `TWITCH_OAUTH_TOKEN` | unset | Optional, used when fetching the stream's playback token |

Profile generation, VOD analysis and session recaps always use gpt-4.1-mini, whatever `EVAL_MODEL` says.
There are about 30 more `EVAL_*` and `LIVE_*` settings for tuning. They're read in
`apps/web/src/lib/server/evalConfig.ts`, `apps/web/src/lib/server/liveSession.ts` and
`apps/web/src/app/api/eval/judge/route.ts`, with their defaults next to them.

## Pages

| Route | What's there |
|---|---|
| `/` | Dashboard |
| `/live` | Start and stop a session, set the threshold and dynamic mode |
| `/live/highlights` | The highlight feed, with voting |
| `/practice` | Practice chat |
| `/eval` | VOD import and offline scoring (linked from the dashboard) |
| `/sessions`, `/sessions/[sessionId]` | Past sessions and their recaps |
| `/settings/profile` | Twitch channel, bot list, emote list |
| `/settings/stream` | Questionnaire, good and bad examples, profile generation |
| `/settings/vod-analysis` | Suggested questionnaire answers from a VOD |
| `/settings/feedback` | Every vote you've made |
| `/login`, `/signup` | Local accounts |

## Layout

```
apps/web/            Next.js app: pages in src/app, API routes in src/app/api, server code in src/lib/server
backend/chatfilter/  Python package (stdlib only, plus the optional whisper extra): filter-live-stream, filter, convert, align
```

The Python package has its own [README](backend/chatfilter/README.md) with the CLI commands.

## Things to know

It relies on Twitch's unofficial web endpoints (the GQL playback-token query and the HLS stream, with the
public web client ID), so it can break whenever Twitch changes them. Live sessions run inside the Next
server process and spawn ffmpeg and Python, so it needs a long-running Node process and won't work on a
serverless host. Everything it stores, your account included, lives in `data/`.
