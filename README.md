## ChatFilter

Real-time Twitch chat highlighting tool. Connects to a live stream, filters chat through a Python pre-filter, scores each message with an LLM on relevance/humor/engagement, and surfaces the best messages for the streamer to react to.

### Features

**Live Chat Highlighting** (`/live`)
- Connects to Twitch IRC, filters spam/bots via a Python subprocess, then scores surviving messages with OpenAI
- Three scoring axes (0-10 each): relevance to stream context, humor fit for this streamer, engagement likelihood
- Configurable score threshold with optional dynamic mode that auto-promotes the best message if highlights go quiet
- Real-time audio transcription (local Whisper or OpenAI API) so scoring knows what the streamer is saying
- Optional video analysis via Gemini Vision for game detection and visual context

**Streamer Feedback System** (`/live/highlights`)
- Thumbs up/down on highlighted messages during a live session
- Upvotes add to a "Good chat examples" section in the streamer profile; downvotes add to "Bad chat examples"
- Feedback refreshes in the scoring prompt every 60 seconds mid-session (no restart needed)
- Feedback patterns are incorporated when regenerating the streamer profile

**Practice Chat** (`/practice`)
- AI-generated simulated chat for streamers to practice reacting to
- Automatically pulls the live transcript from an active session so generated messages react to actual gameplay
- Uses the streamer's humor profile but avoids inside jokes to keep practice grounded in real stream context

**VOD Evaluation** (`/eval`)
- Import a Twitch VOD: downloads chat + audio, transcribes, filters, and scores all messages offline
- Compare scored messages against read-aloud ground-truth labels
- Useful for tuning thresholds and prompts before going live

**Streamer Profile** (`/settings/stream`)
- Five-question guided questionnaire (vibe, reaction preferences, ignore patterns, recurring bits, humor style)
- AI-generated long-term profile from questionnaire answers + feedback data
- Good/bad chat example sections updated automatically by feedback or manually edited

**Dashboard** (`/`)
- Live session status monitor
- Analytics: messages seen/filtered/highlighted over time with timeline graph and distribution chart

### Architecture

```
apps/web/          Next.js 16 frontend + API routes (TypeScript)
backend/chatfilter/ Python package for live chat pre-filtering
tools/             Optional local binaries (ffmpeg, TwitchDownloaderCLI, yt-dlp)
data/              SQLite database + VOD artifacts + live session files
```

**Scoring pipeline:** Twitch IRC -> Python pre-filter (spam, bots, emote-only) -> OpenAI scoring (relevance + humor + engagement) -> threshold gate -> highlighted feed

**Data storage:** SQLite via better-sqlite3 for user accounts, profiles, feedback, and metrics. File-based JSONL for live session chat/transcript/scored/highlighted logs.

### Prerequisites

- **Node 18+**
- **Python 3.10+**
- **ffmpeg** (on PATH or at `tools/ffmpeg/ffmpeg`)
- **OPENAI_API_KEY** environment variable (required for scoring and transcription)
- **GEMINI_API_KEY** environment variable (optional, enables video analysis)
- **TwitchDownloaderCLI** (only needed for VOD import)
- **yt-dlp** (only needed for VOD import)

### Setup

```bash
# Python environment
python -m venv .venv
source .venv/bin/activate
pip install -e backend/chatfilter

# Web app
cd apps/web
npm install
npm run dev
```

Set environment variables before starting:

```bash
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."          # optional, enables video analysis
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for scoring and transcription |
| `GEMINI_API_KEY` | No | - | Google Gemini API key for video frame analysis |
| `LIVE_TRANSCRIBE_PROVIDER` | No | `local` | Transcription backend: `local`, `openai`, or `auto` |
| `LIVE_LOCAL_WHISPER_MODEL` | No | `base` | Local Whisper model size (`tiny.en`, `base`, `small`, etc.) |
| `LIVE_LOCAL_WHISPER_DEVICE` | No | `cpu` | Device for local Whisper (`cpu`, `cuda`) |
| `LIVE_VISION_INTERVAL_MS` | No | `60000` | How often to capture frames for video analysis (ms) |
| `EVAL_MODEL` | No | `gpt-4.1-mini` | OpenAI model used for chat scoring |
| `EVAL_JUDGE_MAX_RPM` | No | `120` | Rate limit for scoring API calls (requests/min) |

### Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard with live status and analytics |
| `/live` | Live session control panel |
| `/live/highlights` | Highlighted messages feed with feedback buttons |
| `/practice` | AI-generated practice chat using live transcript |
| `/eval` | VOD import and offline evaluation |
| `/settings/profile` | Twitch channel link, bot list, emote list |
| `/settings/stream` | Streamer questionnaire, good/bad examples, profile generation |

### API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/live/start` | POST | Start a live session |
| `/api/live/stop` | POST | Stop a live session |
| `/api/live/[sessionId]` | GET | Poll session status and feed |
| `/api/live/[sessionId]/context` | GET | Current live context snapshot |
| `/api/live/feedback` | POST | Submit upvote/downvote on a highlighted message |
| `/api/practice/generate` | POST | Generate practice chat messages |
| `/api/profile` | GET/POST | Read/update user profile |
| `/api/profile/generate` | POST | AI-generate streamer profile from questionnaire |
| `/api/home/live-stats` | GET | Dashboard analytics data |
| `/api/vod/import` | POST | Start VOD import job |
| `/api/eval/judge` | POST | Start evaluation scoring job |
