from __future__ import annotations

import hashlib
import re
from typing import Any


MAX_CHUNK_LENGTH = 700


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _is_heading(line: str) -> bool:
    return bool(
        re.match(r"^#{1,6}\s+", line)
        or re.match(r"^[一二三四五六七八九十0-9]+[、.．]\s*\S+", line)
    )


def _heading_text(line: str) -> str:
    return re.sub(r"^#{1,6}\s+", "", line).strip()


def split_policy_content(
    *,
    policy_id: str,
    version: str,
    title: str,
    content: str,
    source_name: str | None,
    source_url: str | None,
    status: str,
) -> list[dict[str, Any]]:
    lines = [line.strip() for line in content.split("\n") if line.strip()]
    chunks: list[dict[str, Any]] = []
    current_section = "正文"
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        text = "\n".join(buffer).strip()
        buffer = []
        if not text:
            return

        parts = [text[i : i + MAX_CHUNK_LENGTH] for i in range(0, len(text), MAX_CHUNK_LENGTH)]
        for part in parts:
            content_part = part.strip()
            if not content_part:
                continue
            chunk_order = len(chunks) + 1
            chunk_type = "title" if current_section == "标题" else "section"
            chunks.append(
                {
                    "policy_id": policy_id,
                    "version": version,
                    "title": title,
                    "section_path": current_section,
                    "chunk_order": chunk_order,
                    "content": content_part,
                    "content_hash": _content_hash(content_part),
                    "source_name": source_name,
                    "source_url": source_url,
                    "status": status,
                    "metadata": {
                        "chunk_type": chunk_type,
                        "policy_id": policy_id,
                        "version": version,
                        "title": title,
                        "section_path": current_section,
                        "source_name": source_name,
                        "source_url": source_url,
                        "status": status,
                    },
                }
            )

    for line in lines:
        if _is_heading(line):
            flush()
            current_section = _heading_text(line)
            buffer.append(line)
            continue
        buffer.append(line)
    flush()

    if not chunks:
        chunks.append(
            {
                "policy_id": policy_id,
                "version": version,
                "title": title,
                "section_path": "标题",
                "chunk_order": 1,
                "content": title,
                "content_hash": _content_hash(title),
                "source_name": source_name,
                "source_url": source_url,
                "status": status,
                "metadata": {
                    "chunk_type": "title",
                    "policy_id": policy_id,
                    "version": version,
                    "title": title,
                    "section_path": "标题",
                    "source_name": source_name,
                    "source_url": source_url,
                    "status": status,
                },
            }
        )

    return chunks
