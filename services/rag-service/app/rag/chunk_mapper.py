from __future__ import annotations

from haystack import Document


def chunk_to_document(chunk: dict) -> Document:
    synthetic_chunk_id = chunk["chunk_id"]
    return Document(
        id=synthetic_chunk_id,
        content=chunk["content"],
        meta={
            "chunk_id": synthetic_chunk_id,
            "policy_id": chunk["policy_id"],
            "version": chunk["version"],
            "title": chunk["title"],
            "section_path": chunk["section_path"],
            "chunk_order": chunk["chunk_order"],
            "source_name": chunk["source_name"],
            "source_url": chunk["source_url"],
            "status": chunk["status"],
            "metadata": chunk["metadata"],
        },
    )
