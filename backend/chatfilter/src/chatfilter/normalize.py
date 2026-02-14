from __future__ import annotations

import re
from typing import Iterable


_RE_MULTI_SPACE = re.compile(r"\s+")
_RE_MULTI_PUNCT = re.compile(r"([!?.,])\1{2,}")
_RE_URL = re.compile(r"(https?://|www\.)", re.IGNORECASE)


def is_url_like(text: str) -> bool:
    return bool(_RE_URL.search(text))


def normalize_text_for_fingerprint(text: str) -> str:
    """
    Produce a stable, low-entropy string for chorus detection:
    - lowercase
    - collapse repeated punctuation
    - collapse whitespace
    """
    t = text.lower().strip()
    t = _RE_MULTI_PUNCT.sub(r"\1\1", t)
    t = _RE_MULTI_SPACE.sub(" ", t)
    return t


def tokenize_simple(text: str) -> list[str]:
    # A simple, fast tokenizer; good enough for heuristics.
    t = text.strip()
    if not t:
        return []
    return [tok for tok in re.split(r"\s+", t) if tok]


def unicode_emoji_count(text: str) -> int:
    # Rough emoji detection via unicode ranges; intentionally approximate.
    count = 0
    for ch in text:
        o = ord(ch)
        if (
            0x1F300 <= o <= 0x1FAFF  # main emoji blocks
            or 0x2600 <= o <= 0x26FF  # misc symbols
            or 0x2700 <= o <= 0x27BF  # dingbats
        ):
            count += 1
    return count


def contains_any(text: str, needles: Iterable[str]) -> bool:
    tl = text.lower()
    return any(n in tl for n in needles)

