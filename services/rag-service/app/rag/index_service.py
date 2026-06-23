from __future__ import annotations

from typing import Any

import psycopg

from app.config import Settings
from app.rag.chunk_mapper import chunk_to_document
from app.rag.debug import debug_log, summarize_text
from app.rag.document_store import get_backend_mode, get_document_store
from app.rag.pipeline_factory import build_document_embedder


class IndexService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.document_store = get_document_store(settings)
        self.document_embedder = build_document_embedder(settings)

    def _load_policy_chunks(self, policy_id: str) -> list[dict[str, Any]]:
        sql = """
            SELECT
              c.chunk_id::text AS chunk_id,
              c.policy_id::text AS policy_id,
              c.version,
              c.title,
              c.section_path,
              c.chunk_order,
              c.content,
              c.content_hash,
              c.source_name,
              c.source_url,
              c.status,
              c.metadata
            FROM policy_chunks c
            JOIN policies p ON p.policy_id = c.policy_id
            JOIN policy_ai_whitelist w ON w.policy_id = c.policy_id
            WHERE c.policy_id = %(policy_id)s::uuid
              AND p.status = 'effective'
              AND w.enabled = true
            ORDER BY c.chunk_order ASC
        """

        with psycopg.connect(self.settings.app_database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, {"policy_id": policy_id})
                rows = cur.fetchall()

        return [
            {
                "chunk_id": row[0],
                "policy_id": row[1],
                "version": row[2],
                "title": row[3],
                "section_path": row[4],
                "chunk_order": row[5],
                "content": row[6],
                "content_hash": row[7],
                "source_name": row[8],
                "source_url": row[9],
                "status": row[10],
                "metadata": row[11],
            }
            for row in rows
        ]

    def index_policy(self, policy_id: str) -> dict:
        chunks = self._load_policy_chunks(policy_id)
        if not chunks:
            raise LookupError("policy chunks not found or policy is not searchable")

        debug_log(
            self.settings.rag_debug,
            "index.load_chunks",
            policy_id=policy_id,
            chunk_count=len(chunks),
            store_id=id(self.document_store),
            first_chunk=summarize_text(chunks[0]["content"]),
        )

        documents = [chunk_to_document(chunk) for chunk in chunks]
        existing_documents = self.document_store.filter_documents(
            {
                "field": "meta.policy_id",
                "operator": "==",
                "value": policy_id,
            },
        )
        if existing_documents:
            self.document_store.delete_documents(
                [document.id for document in existing_documents],
            )
        debug_log(
            self.settings.rag_debug,
            "index.after_delete",
            policy_id=policy_id,
            document_count=self.document_store.count_documents(),
            deleted_document_count=len(existing_documents),
            store_id=id(self.document_store),
        )
        try:
            embedded_documents = self.document_embedder.run(documents=documents)["documents"]
        except Exception as error:
            debug_log(
                self.settings.rag_debug,
                "index.embed.error",
                policy_id=policy_id,
                error=repr(error),
                store_id=id(self.document_store),
            )
            raise
        embedded_count = sum(1 for document in embedded_documents if getattr(document, "embedding", None) is not None)
        debug_log(
            self.settings.rag_debug,
            "index.after_embed",
            policy_id=policy_id,
            write_document_count=len(embedded_documents),
            embedded_count=embedded_count,
            store_id=id(self.document_store),
        )
        self.document_store.write_documents(embedded_documents)
        debug_log(
            self.settings.rag_debug,
            "index.after_write",
            policy_id=policy_id,
            document_count=self.document_store.count_documents(),
            store_id=id(self.document_store),
        )

        return {
            "backend_mode": get_backend_mode(self.settings),
            "policy_id": policy_id,
            "version": chunks[0]["version"],
            "chunk_count": len(chunks),
            "index_strategy": "delete_then_insert",
        }
