## ChatFilter (MVP)

This repo downloads **timestamped Twitch VOD chat**, generates a **timestamped transcript**, converts chat to a canonical **JSONL** format, then filters it down to ~**20%** of messages for downstream scoring/labeling.

### What you get per import

For a VOD id `<vodId>`, artifacts are written to:

- `data/vods/<vodId>/raw/chat.json` (TwitchDownloader output)
- `data/vods/<vodId>/raw/audio.mp3` (yt-dlp extracted audio)
- `data/vods/<vodId>/raw/transcript_verbose.json` (ASR verbose JSON)
- `data/vods/<vodId>/canonical/chat.jsonl` (canonical JSONL)
- `data/vods/<vodId>/runs/<runId>/filtered.jsonl` (kept messages)
- `data/vods/<vodId>/runs/<runId>/metrics.json` (filter metrics)

### Prerequisites

- **TwitchDownloaderCLI** (either on PATH, or downloaded to `tools/TwitchDownloaderCLI`)
- **yt-dlp** (either on PATH, or downloaded to `tools/yt-dlp`)
- **ffmpeg + ffprobe** (either on PATH, or downloaded to `tools/ffmpeg/ffmpeg` and `tools/ffmpeg/ffprobe`)
- **Python 3.10+**
- **Node 18+**
- **OPENAI_API_KEY** environment variable (for transcript generation)

### Setup

From repo root:

```bash
# (Optional) if you don't already have these installed globally,
# the repo can use the local copies in tools/
ls -la tools
```

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e backend/chatfilter

cd apps/web
npm run dev
```

In a separate shell (or before starting dev), export:

```bash
export OPENAI_API_KEY="..."
```

### Use

Open the web UI and paste a VOD URL like:

`https://www.twitch.tv/videos/1234567890`

Then click **Import**.

### Notes / caveats

- This MVP runs the full pipeline synchronously in a single request. For long VODs you’ll want to convert this to a background job + progress polling.\n
- TwitchDownloader chat JSON schemas vary slightly across versions; the converter is intentionally tolerant but may need tweaks once you pick a specific TwitchDownloader release.\n

### Python note

The Next.js server sets `PYTHONPATH` automatically to include `backend/chatfilter/src`, so the API can run `python3 -m chatfilter ...` even if you don’t install the package. Installing it editable is still recommended for local dev ergonomics.

