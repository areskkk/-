from __future__ import annotations

import re


NOISE_PATTERNS = [
    re.compile(r"^[-_=]{3,}$"),
    re.compile(r"^第?\s*\d+\s*页$"),
]


def clean_policy_text(text: str) -> str:
    normalized = (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\t", " ")
    )
    lines: list[str] = []
    for raw_line in normalized.split("\n"):
        line = re.sub(r"[ \u3000]+", " ", raw_line).strip()
        if not line:
            continue
        if any(pattern.match(line) for pattern in NOISE_PATTERNS):
            continue
        lines.append(line)

    return "\n".join(lines)
