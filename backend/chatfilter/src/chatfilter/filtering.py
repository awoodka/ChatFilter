from __future__ import annotations

import json
import re
from collections import Counter, deque
from dataclasses import dataclass
from typing import Any

from .normalize import (
    contains_any,
    is_url_like,
    normalize_text_for_fingerprint,
    tokenize_simple,
    unicode_emoji_count,
)

_RE_GAMBLE_CMD = re.compile(r"(^|\s)!gamble(?:\s|$)", re.IGNORECASE)


@dataclass
class FilterConfig:
    target_keep: float = 0.20
    chorus_window_ms: int = 30_000
    chorus_threshold: int = 5
    emoji_ratio_drop: float = 0.80
    emote_repeat_drop: int = 4
    known_emotes: tuple[str, ...] = ()


@dataclass
class LiveFilterState:
    # chorus tracking: fingerprint -> deque[timestamps]
    fp_times: dict[str, deque[int]]
    fp_kept_rep: dict[str, int]  # fingerprint -> rep ts (kept)


def make_live_filter_state() -> LiveFilterState:
    return LiveFilterState(fp_times={}, fp_kept_rep={})


def _normalize_emote_token(tok: str) -> str:
    return tok.strip().strip(".,!?;:\"'()[]{}<>").lower()


def _strip_known_emotes(text: str, known_emotes: set[str]) -> tuple[str, int]:
    if not text.strip() or not known_emotes:
        return text.strip(), 0
    raw_tokens = tokenize_simple(text)
    kept: list[str] = []
    removed = 0
    for tok in raw_tokens:
        norm = _normalize_emote_token(tok)
        if norm and norm in known_emotes:
            removed += 1
            continue
        kept.append(tok)
    return " ".join(kept).strip(), removed


def _emote_like_token(tok: str) -> bool:
    # Approx: many twitch emotes are uppercase-ish tokens; tags may also include emotes, but we use this as fallback.
    if len(tok) < 3:
        return False
    return tok.isupper() and tok.isalpha()


def _is_pure_emoji_or_emote_spam(
    text: str, tokens: list[str], tags: dict[str, Any], cfg: FilterConfig, known_emotes: set[str]
) -> bool:
    if not tokens:
        return True

    # If TwitchDownloader extracted emote fragments, use that as a strong signal.
    emote_objs = tags.get("emotes")
    emote_count = len(emote_objs) if isinstance(emote_objs, list) else 0
    emoji_count = unicode_emoji_count(text)

    known_emote_tokens = sum(1 for t in tokens if _normalize_emote_token(t) in known_emotes)
    emote_like = sum(1 for t in tokens if _emote_like_token(t))
    total = len(tokens)
    spam_like = emote_count + emoji_count + emote_like + known_emote_tokens

    if total >= 3 and (spam_like / max(1, total)) >= cfg.emoji_ratio_drop:
        return True

    # repeated same token
    c = Counter(tokens)
    if any(
        v >= cfg.emote_repeat_drop
        and (_emote_like_token(k) or unicode_emoji_count(k) > 0 or _normalize_emote_token(k) in known_emotes)
        for k, v in c.items()
    ):
        return True

    # if stripping non-spam leaves nothing meaningful
    non_spam = [
        t
        for t in tokens
        if not _emote_like_token(t)
        and unicode_emoji_count(t) == 0
        and _normalize_emote_token(t) not in known_emotes
    ]
    if not non_spam and (emoji_count > 0 or emote_count > 0 or emote_like > 0 or known_emote_tokens > 0):
        return True

    return False


def _normalize_repeat_token(tok: str) -> str:
    return tok.strip().strip(".,!?;:\"'()[]{}<>").lower()


def _has_gamble_command(text: str) -> bool:
    return bool(_RE_GAMBLE_CMD.search(text))


def _is_single_word_repeat(tokens: list[str]) -> bool:
    if len(tokens) < 2:
        return False
    normed = [_normalize_repeat_token(t) for t in tokens]
    normed = [t for t in normed if t]
    if len(normed) < 2:
        return False
    return len(set(normed)) == 1


def candidate_score(text: str, tokens: list[str]) -> int:
    score = 0
    tl = text.lower()
    if "?" in text:
        score += 2
    if "@" in text:
        score += 2
    if len(tokens) >= 16:
        score += 3
    elif len(tokens) >= 12:
        score += 2
    elif 6 <= len(tokens) <= 11:
        score += 1

    if contains_any(tl, ("because", "when", "if ", " tho", "though", " but ")):
        score += 1
    if contains_any(tl, ("lol", "lmao", "lmfao", "kekw", "lul")):
        score += 1
    return score


def evaluate_live_candidate(
    *, obj: dict[str, Any], cfg: FilterConfig, state: LiveFilterState
) -> dict[str, Any]:
    text = obj.get("text") or ""
    if not isinstance(text, str) or not text.strip():
        return {"keep": False, "drop_reason": "empty_text"}

    ts_ms = obj.get("ts_ms")
    if not isinstance(ts_ms, int):
        return {"keep": False, "drop_reason": "missing_ts_ms"}

    known_emotes = {_normalize_emote_token(x) for x in cfg.known_emotes if _normalize_emote_token(x)}
    cleaned_text, _removed_known_emotes = _strip_known_emotes(text, known_emotes)
    tokens = tokenize_simple(cleaned_text)
    tags = obj.get("tags") if isinstance(obj.get("tags"), dict) else {}

    if _has_gamble_command(cleaned_text):
        return {"keep": False, "drop_reason": "gamble_command"}

    if len(tokens) <= 1:
        return {"keep": False, "drop_reason": "one_word"}

    if _is_single_word_repeat(tokens):
        return {"keep": False, "drop_reason": "repeated_one_word"}

    if is_url_like(cleaned_text):
        return {"keep": False, "drop_reason": "link"}

    if _is_pure_emoji_or_emote_spam(cleaned_text, tokens, tags, cfg, known_emotes):
        return {"keep": False, "drop_reason": "emoji_emote_spam"}

    # chorus de-dupe: always keep a representative; drop subsequent duplicates once chorus is established
    fp = normalize_text_for_fingerprint(cleaned_text)
    dq = state.fp_times.get(fp)
    if dq is None:
        dq = deque()
        state.fp_times[fp] = dq

    # evict old timestamps
    while dq and (ts_ms - dq[0]) > cfg.chorus_window_ms:
        dq.popleft()
    dq.append(ts_ms)

    chorus_count = len(dq)
    is_chorus = chorus_count >= cfg.chorus_threshold
    if is_chorus and fp in state.fp_kept_rep:
        return {"keep": False, "drop_reason": "chorus_dup"}
    if fp not in state.fp_kept_rep:
        state.fp_kept_rep[fp] = ts_ms

    score = candidate_score(cleaned_text, tokens)
    return {
        "keep": True,
        "score": score,
        "override": ("?" in cleaned_text) or ("@" in cleaned_text) or (len(tokens) >= 16),
        "chorus_rep": is_chorus,
        "cleaned_text": cleaned_text,
    }


def filter_jsonl(
    *, input_path: str, output_path: str, metrics_path: str | None, cfg: FilterConfig
) -> dict[str, Any]:
    """
    Two-pass filter:
    - pass1: apply hard drops + chorus de-dupe, compute candidate_score, record scores
    - pass2: compute threshold to hit target_keep, write kept messages with reasons
    """

    hard_drop_counts: Counter[str] = Counter()

    state = make_live_filter_state()

    rows: list[dict[str, Any]] = []
    scores: list[int] = []

    total_in = 0
    total_after_hard = 0

    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            total_in += 1
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                hard_drop_counts["invalid_json"] += 1
                continue

            decision = evaluate_live_candidate(obj=obj, cfg=cfg, state=state)
            if not decision.get("keep"):
                hard_drop_counts[str(decision.get("drop_reason") or "unknown")] += 1
                continue

            total_after_hard += 1

            row = {
                "obj": obj,
                "score": int(decision.get("score") or 0),
                "override": bool(decision.get("override")),
                "chorus_rep": bool(decision.get("chorus_rep")),
                "cleaned_text": str(decision.get("cleaned_text") or obj.get("text") or ""),
            }
            rows.append(row)
            scores.append(int(decision.get("score") or 0))

    if not rows:
        result = {
            "total_in": total_in,
            "total_after_hard": total_after_hard,
            "kept": 0,
            "kept_ratio": 0.0,
            "drop_reasons": dict(hard_drop_counts),
            "score_threshold": None,
        }
        if metrics_path:
            with open(metrics_path, "w", encoding="utf-8") as mf:
                json.dump(result, mf, indent=2)
        return result

    # Determine threshold by quantile for non-overrides.
    # Keep all overrides, then keep top remaining until target_keep of total_in.
    target_kept = max(1, int(cfg.target_keep * total_in))

    overrides = [r for r in rows if r["override"]]
    non_overrides = [r for r in rows if not r["override"]]

    remaining_budget = max(0, target_kept - len(overrides))
    non_overrides_sorted = sorted(non_overrides, key=lambda r: r["score"], reverse=True)
    chosen_non_overrides = non_overrides_sorted[:remaining_budget]

    kept_set = set()
    for r in overrides:
        kept_set.add(id(r))
    for r in chosen_non_overrides:
        kept_set.add(id(r))

    kept = 0
    with open(output_path, "w", encoding="utf-8") as out:
        for r in rows:
            obj = r["obj"]
            if id(r) not in kept_set:
                continue
            reason = "score_quantile"
            if r["override"]:
                if "?" in obj.get("text", ""):
                    reason = "override_question"
                elif "@" in obj.get("text", ""):
                    reason = "override_mention"
                else:
                    reason = "override_long"
            if r["chorus_rep"]:
                # chorus reps are useful but often low-value; record for debugging
                obj["filter_chorus_rep"] = True
            cleaned_text = r.get("cleaned_text")
            if isinstance(cleaned_text, str) and cleaned_text.strip():
                obj["text"] = cleaned_text.strip()
            obj["filter_keep"] = True
            obj["filter_score"] = r["score"]
            obj["filter_reason_keep"] = reason
            out.write(json.dumps(obj, ensure_ascii=False) + "\n")
            kept += 1

    result = {
        "total_in": total_in,
        "total_after_hard": total_after_hard,
        "kept": kept,
        "kept_ratio": kept / max(1, total_in),
        "drop_reasons": dict(hard_drop_counts),
        "target_keep": cfg.target_keep,
        "target_kept": target_kept,
        "overrides_kept": len(overrides),
        "non_override_budget": remaining_budget,
        "chorus_groups": len(state.fp_kept_rep),
    }
    if metrics_path:
        with open(metrics_path, "w", encoding="utf-8") as mf:
            json.dump(result, mf, indent=2)
    return result
