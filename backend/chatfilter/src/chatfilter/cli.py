from __future__ import annotations

import argparse
import json
import os
import sys

from .align import align_chat_jsonl_to_transcript_jsonl
from .convert import convert_twitchdownloader_chat_json_to_jsonl
from .filtering import FilterConfig, evaluate_live_candidate, filter_jsonl, make_live_filter_state


def _cmd_convert(args: argparse.Namespace) -> int:
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    res = convert_twitchdownloader_chat_json_to_jsonl(
        input_path=args.input, output_path=args.output, vod_id=args.vod_id, channel=args.channel
    )
    print(json.dumps(res, indent=2))
    return 0


def _cmd_align(args: argparse.Namespace) -> int:
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    res = align_chat_jsonl_to_transcript_jsonl(
        input_chat_jsonl=args.chat,
        transcript_jsonl=args.transcript,
        output_jsonl=args.output,
        window_sec=float(args.window_sec),
        min_tokens=int(args.min_tokens),
        threshold=float(args.threshold),
        emit_debug_fields=bool(args.emit_debug_fields),
    )
    print(json.dumps(res, indent=2))
    return 0


def _cmd_filter(args: argparse.Namespace) -> int:
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    if args.metrics:
        os.makedirs(os.path.dirname(args.metrics), exist_ok=True)

    cfg = FilterConfig(
        target_keep=args.target_keep,
        chorus_window_ms=args.chorus_window_ms,
        chorus_threshold=args.chorus_threshold,
        known_emotes=tuple(args.known_emote or []),
    )
    res = filter_jsonl(input_path=args.input, output_path=args.output, metrics_path=args.metrics, cfg=cfg)
    print(json.dumps(res, indent=2))
    return 0


def _cmd_filter_live_stream(args: argparse.Namespace) -> int:
    cfg = FilterConfig(
        target_keep=1.0,  # unused in live stream mode
        chorus_window_ms=args.chorus_window_ms,
        chorus_threshold=args.chorus_threshold,
        known_emotes=tuple(args.known_emote or []),
    )
    state = make_live_filter_state()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if not isinstance(obj, dict):
                raise ValueError("not a JSON object")
        except Exception:
            print(json.dumps({"keep": False, "drop_reason": "invalid_json"}), flush=True)
            continue
        decision = evaluate_live_candidate(obj=obj, cfg=cfg, state=state)
        print(json.dumps(decision, ensure_ascii=False), flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="chatfilter")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("convert", help="Convert TwitchDownloader chat JSON -> canonical JSONL")
    c.add_argument("--input", required=True, help="Path to TwitchDownloader chat JSON")
    c.add_argument("--output", required=True, help="Path to write canonical JSONL")
    c.add_argument("--vod-id", default=None)
    c.add_argument("--channel", default=None)
    c.set_defaults(func=_cmd_convert)

    a = sub.add_parser("align", help="Weak-label chat messages as read-aloud by matching transcript text")
    a.add_argument("--chat", required=True, help="Path to canonical chat JSONL")
    a.add_argument("--transcript", required=True, help="Path to transcript JSONL (start_ms/end_ms/text)")
    a.add_argument("--output", required=True, help="Path to write labeled chat JSONL")
    a.add_argument("--window-sec", type=float, default=90.0, help="Lookahead window after chat message timestamp")
    a.add_argument("--min-tokens", type=int, default=4, help="Minimum token count to consider for matching")
    a.add_argument("--threshold", type=float, default=0.72, help="Token-overlap threshold (0..1)")
    a.add_argument(
        "--emit-debug-fields",
        action="store_true",
        help="Include label_best_sim and label_best_seg_start_ms in output JSONL",
    )
    a.set_defaults(func=_cmd_align)

    f = sub.add_parser("filter", help="Filter canonical JSONL down to a target keep ratio")
    f.add_argument("--input", required=True)
    f.add_argument("--output", required=True)
    f.add_argument("--metrics", default=None)
    f.add_argument("--target-keep", type=float, default=0.20)
    f.add_argument("--chorus-window-ms", type=int, default=30_000)
    f.add_argument("--chorus-threshold", type=int, default=5)
    f.add_argument("--known-emote", action="append", default=[])
    f.set_defaults(func=_cmd_filter)

    fl = sub.add_parser("filter-live-stream", help="Stateful live filter over stdin JSON lines")
    fl.add_argument("--chorus-window-ms", type=int, default=30_000)
    fl.add_argument("--chorus-threshold", type=int, default=5)
    fl.add_argument("--known-emote", action="append", default=[])
    fl.set_defaults(func=_cmd_filter_live_stream)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

