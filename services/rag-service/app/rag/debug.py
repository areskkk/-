from __future__ import annotations

import logging


logger = logging.getLogger("rag-service")


def summarize_text(text: str, limit: int = 80) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "..."


def debug_log(enabled: bool, message: str, **fields) -> None:
    if not enabled:
        return

    payload = ", ".join(f"{key}={value}" for key, value in fields.items())
    logger.info("%s | %s", message, payload)
