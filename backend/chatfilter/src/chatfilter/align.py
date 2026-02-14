from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional


_RE_URL = re.compile(r"https?://\S+", re.IGNORECASE)
_RE_NON_ALNUM = re.compile(r"[^a-z0-9\s]")
_RE_MULTI_SPACE = re.compile(r"\s+")


def _norm_for_similarity(text: str) -> str:
    """
    Normalize text for token overlap similarity:
    - lowercase
    - remove URLs
    - strip non-alphanumeric to spaces
    - collapse whitespace
    """
    t = text.lower()
    t = _RE_URL.sub(" ", t)
    t = _RE_NON_ALNUM.sub(" ", t)
    t = _RE_MULTI_SPACE.sub(" ", t).strip()
    return t


def _token_set(text: str) -> set[str]:
    t = _norm_for_similarity(text)
    if not t:
        return set()
    return {tok for tok in t.split(" ") if tok}


def token_count(text: str) -> int:
    t = _norm_for_similarity(text)
    if not t:
        return 0
    return len([x for x in t.split(" ") if x])


def similarity(a_tokens: set[str], b_tokens: set[str]) -> float:
    # 0..1 overlap metric: |A ∩ B| / max(|A|, |B|)
    if not a_tokens or not b_tokens:
        return 0.0
    inter = 0
    # iterate smaller set
    if len(a_tokens) <= len(b_tokens):
        for x in a_tokens:
            if x in b_tokens:
                inter += 1
    else:
        for x in b_tokens:
            if x in a_tokens:
                inter += 1
    denom = max(len(a_tokens), len(b_tokens))
    return float(inter) / float(denom) if denom else 0.0


@dataclass(frozen=True)
class TranscriptSeg:
    start_ms: int
    end_ms: int
    text: str
    tokens: set[str]


def read_transcript_jsonl(path: str) -> list[TranscriptSeg]:
    segs: list[TranscriptSeg] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            start_ms = obj.get("start_ms")
            end_ms = obj.get("end_ms")
            text = obj.get("text")
            if not isinstance(start_ms, int):
                continue
            if not isinstance(end_ms, int):
                end_ms = start_ms
            if not isinstance(text, str):
                continue
            t = text.strip()
            if not t:
                continue
            segs.append(TranscriptSeg(start_ms=start_ms, end_ms=end_ms, text=t, tokens=_token_set(t)))
    segs.sort(key=lambda s: s.start_ms)
    return segs


def label_read_aloud(
    *,
    msg_ts_ms: int,
    msg_text: str,
    segs: list[TranscriptSeg],
    window_ms: int,
    min_tokens: int,
    threshold: float,
    start_seg_idx: int,
) -> tuple[bool, float, Optional[int], int]:
    """
    Returns (label, best_similarity, best_seg_start_ms, next_start_seg_idx).

    `start_seg_idx` should be an index such that segs[start_seg_idx].start_ms is close to msg_ts_ms,
    allowing linear-time scanning across increasing chat timestamps.
    """
    if token_count(msg_text) < min_tokens:
        return (False, 0.0, None, start_seg_idx)

    msg_tokens = _token_set(msg_text)
    if not msg_tokens:
        return (False, 0.0, None, start_seg_idx)

    # advance idx to first segment with start_ms >= msg_ts_ms
    i = start_seg_idx
    n = len(segs)
    while i < n and segs[i].start_ms < msg_ts_ms:
        i += 1

    end_ms = msg_ts_ms + window_ms
    best = 0.0
    best_start: Optional[int] = None

    j = i
    while j < n:
        s = segs[j]
        if s.start_ms > end_ms:
            break
        sim = similarity(msg_tokens, s.tokens)
        if sim > best:
            best = sim
            best_start = s.start_ms
            if best >= threshold:
                return (True, best, best_start, i)
        j += 1

    return (best >= threshold, best, best_start, i)


def align_chat_jsonl_to_transcript_jsonl(
    *,
    input_chat_jsonl: str,
    transcript_jsonl: str,
    output_jsonl: str,
    window_sec: float = 90.0,
    min_tokens: int = 4,
    threshold: float = 0.72,
    emit_debug_fields: bool = False,
) -> dict[str, Any]:
    segs = read_transcript_jsonl(transcript_jsonl)
    window_ms = int(window_sec * 1000)

    total = 0
    written = 0
    positives = 0
    seg_idx = 0

    with open(input_chat_jsonl, "r", encoding="utf-8") as fin, open(output_jsonl, "w", encoding="utf-8") as fout:
        for line in fin:
            raw = line.strip()
            if not raw:
                continue
            total += 1
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            ts_ms = obj.get("ts_ms")
            text = obj.get("text")
            if not isinstance(ts_ms, int) or not isinstance(text, str):
                # keep record shape but mark negative if possible
                if isinstance(obj, dict):
                    obj["label_read_aloud"] = False
                    fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
                    written += 1
                continue

            label, best_sim, best_start_ms, seg_idx = label_read_aloud(
                msg_ts_ms=ts_ms,
                msg_text=text,
                segs=segs,
                window_ms=window_ms,
                min_tokens=min_tokens,
                threshold=threshold,
                start_seg_idx=seg_idx,
            )
            obj["label_read_aloud"] = bool(label)
            if emit_debug_fields:
                obj["label_best_sim"] = float(best_sim)
                obj["label_best_seg_start_ms"] = int(best_start_ms) if best_start_ms is not None else None
            fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            written += 1
            if label:
                positives += 1

    return {
        "total_chat_lines": total,
        "written_lines": written,
        "positives": positives,
        "window_sec": window_sec,
        "min_tokens": min_tokens,
        "threshold": threshold,
        "transcript_segments": len(segs),
    }

