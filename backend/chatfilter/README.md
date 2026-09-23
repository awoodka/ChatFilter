## chatfilter (Python)

This package provides:
- `chatfilter convert`: convert TwitchDownloader chat JSON to canonical JSONL
- `chatfilter align`: weak-label canonical chat JSONL with a `label_read_aloud` field by matching transcript segments
- `chatfilter filter`: filter canonical JSONL down to a target keep ratio (default 20%) + metrics
- `chatfilter filter-live-stream`: the filter the live app uses. It reads one chat message per line as JSON on stdin (needs `text` and `ts_ms`) and writes a keep/drop decision per line to stdout, remembering recent messages so it can collapse choruses

### Install (dev)

From repo root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e backend/chatfilter
```

The package itself has no dependencies. Add the `whisper` extra (`pip install -e "backend/chatfilter[whisper]"`) to get faster-whisper, which the web app uses for local live transcription.

### Usage

```bash
chatfilter convert --input data/vods/<vodId>/raw/chat.json --output data/vods/<vodId>/canonical/chat.jsonl --vod-id <vodId> --channel <channel>
chatfilter align --chat data/vods/<vodId>/canonical/chat.jsonl --transcript data/vods/<vodId>/raw/<jobId>/transcript.jsonl --output data/vods/<vodId>/canonical/labeled_chat.jsonl --window-sec 90
chatfilter filter --input data/vods/<vodId>/canonical/chat.jsonl --output data/vods/<vodId>/runs/<runId>/filtered.jsonl --metrics data/vods/<vodId>/runs/<runId>/metrics.json --target-keep 0.20
echo '{"text": "that jump was actually insane", "ts_ms": 0}' | chatfilter filter-live-stream --known-emote KEKW
```

