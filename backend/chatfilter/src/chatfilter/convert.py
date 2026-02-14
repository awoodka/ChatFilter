from __future__ import annotations

import json
from typing import Any, Iterable


def _iter_td_comments(td_obj: Any) -> Iterable[dict[str, Any]]:
    """
    TwitchDownloader chat JSON schema varies by version.
    We try a few common shapes:
    - { "comments": [ ... ] }
    - { "data": { "comments": [ ... ] } }
    - [ ... ] (already a list of comments)
    """
    if isinstance(td_obj, list):
        for c in td_obj:
            if isinstance(c, dict):
                yield c
        return
    if not isinstance(td_obj, dict):
        return
    if isinstance(td_obj.get("comments"), list):
        for c in td_obj["comments"]:
            if isinstance(c, dict):
                yield c
        return
    data = td_obj.get("data")
    if isinstance(data, dict) and isinstance(data.get("comments"), list):
        for c in data["comments"]:
            if isinstance(c, dict):
                yield c


def _comment_offset_seconds(comment: dict[str, Any]) -> float | None:
    for k in (
        "content_offset_seconds",
        "contentOffsetSeconds",
        "content_offset",
        "offset_seconds",
        "offsetSeconds",
    ):
        v = comment.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except Exception:
                pass
    return None


def _extract_username_userid(comment: dict[str, Any]) -> tuple[str | None, str | None]:
    # common shapes: commenter: { display_name, name, id }, user: { ... }
    commenter = comment.get("commenter")
    if isinstance(commenter, dict):
        username = commenter.get("display_name") or commenter.get("name") or commenter.get("login")
        user_id = commenter.get("id") or commenter.get("user_id") or commenter.get("userId")
        return (str(username) if username is not None else None, str(user_id) if user_id is not None else None)
    user = comment.get("user")
    if isinstance(user, dict):
        username = user.get("display_name") or user.get("name") or user.get("login")
        user_id = user.get("id") or user.get("user_id") or user.get("userId")
        return (str(username) if username is not None else None, str(user_id) if user_id is not None else None)
    return (None, None)


def _extract_message_text_and_tags(comment: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """
    Try to reconstruct message text from fragments if present; otherwise fall back to string fields.
    Preserve useful tag-like info if available.
    """
    tags: dict[str, Any] = {}

    msg = comment.get("message")
    if isinstance(msg, dict):
        # fragments: [{ text: "...", emote: { id, ... } }, ...]
        fragments = msg.get("fragments")
        if isinstance(fragments, list):
            parts: list[str] = []
            emotes: list[dict[str, Any]] = []
            for fr in fragments:
                if not isinstance(fr, dict):
                    continue
                t = fr.get("text")
                if isinstance(t, str):
                    parts.append(t)
                em = fr.get("emote")
                if isinstance(em, dict):
                    emotes.append(em)
            if emotes:
                tags["emotes"] = emotes
            text = "".join(parts).strip()
            if text:
                return text, tags
        # fallbacks
        for k in ("text", "body"):
            if isinstance(msg.get(k), str):
                return msg[k].strip(), tags

    # other fallbacks
    for k in ("message", "text", "body"):
        if isinstance(comment.get(k), str):
            return comment[k].strip(), tags

    return "", tags


def convert_twitchdownloader_chat_json_to_jsonl(
    *, input_path: str, output_path: str, vod_id: str | None, channel: str | None
) -> dict[str, Any]:
    with open(input_path, "r", encoding="utf-8") as f:
        td = json.load(f)

    total = 0
    written = 0

    with open(output_path, "w", encoding="utf-8") as out:
        for c in _iter_td_comments(td):
            total += 1
            offset_s = _comment_offset_seconds(c)
            if offset_s is None:
                continue
            ts_ms = int(offset_s * 1000)
            username, user_id = _extract_username_userid(c)
            text, tags = _extract_message_text_and_tags(c)
            if not text:
                continue
            obj = {
                "ts_ms": ts_ms,
                "channel": channel,
                "username": username,
                "user_id": user_id,
                "text": text,
                "tags": tags,
                "vod_id": vod_id,
                "source": "twitchdownloader",
            }
            out.write(json.dumps(obj, ensure_ascii=False) + "\n")
            written += 1

    return {"total_comments": total, "written_messages": written}

