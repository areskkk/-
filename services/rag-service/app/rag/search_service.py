from __future__ import annotations

from typing import Any

from app.config import Settings
from app.rag.debug import debug_log, summarize_text
from app.rag.document_store import get_backend_mode, get_document_store
from app.rag.pipeline_factory import build_search_pipeline


def _document_to_result(document, score: float) -> dict[str, Any]:
    return {
        "chunk_id": document.meta["chunk_id"],
        "policy_id": document.meta["policy_id"],
        "version": document.meta["version"],
        "title": document.meta["title"],
        "section_path": document.meta["section_path"],
        "chunk_order": document.meta["chunk_order"],
        "source_name": document.meta["source_name"],
        "source_url": document.meta["source_url"],
        "content": document.content,
        "score": float(score),
        "metadata": document.meta["metadata"],
    }


class SearchService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.document_store = get_document_store(settings)
        self.pipeline = build_search_pipeline(settings, self.document_store)

    def search(self, query: str, policy_id: str | None, limit: int) -> dict:
        debug_log(
            self.settings.rag_debug,
            "search.before_pipeline",
            policy_id=policy_id,
            limit=limit,
            query=summarize_text(query),
            document_count=self.document_store.count_documents(),
            store_id=id(self.document_store),
        )
        try:
            result = self.pipeline.run(
                {
                    "text_embedder": {"text": query},
                    "retriever": {"top_k": max(limit, self.settings.rag_search_top_k)},
                },
            )
        except Exception as error:
            debug_log(
                self.settings.rag_debug,
                "search.pipeline.error",
                policy_id=policy_id,
                query=summarize_text(query),
                error=repr(error),
                store_id=id(self.document_store),
            )
            raise

        text_embedder_result = result.get("text_embedder")
        query_embedding = None
        if isinstance(text_embedder_result, dict):
            query_embedding = text_embedder_result.get("embedding")
        embedding_dim = len(query_embedding) if query_embedding is not None else 0
        debug_log(
            self.settings.rag_debug,
            "search.after_query_embedding",
            policy_id=policy_id,
            query=summarize_text(query),
            embedding_generated=query_embedding is not None,
            embedding_dim=embedding_dim,
            store_id=id(self.document_store),
        )

        retriever_result = result.get("retriever")
        documents = []
        if isinstance(retriever_result, dict):
            documents = retriever_result.get("documents", [])
        debug_log(
            self.settings.rag_debug,
            "search.after_retrieve",
            policy_id=policy_id,
            retrieved_count=len(documents),
            store_id=id(self.document_store),
        )
        results = []

        for document in documents:
            if policy_id and document.meta.get("policy_id") != policy_id:
                continue
            score = getattr(document, "score", 0.0) or 0.0
            results.append(_document_to_result(document, score))
            if len(results) >= limit:
                break

        debug_log(
            self.settings.rag_debug,
            "search.after_filter",
            policy_id=policy_id,
            result_count=len(results),
            store_id=id(self.document_store),
        )

        return {
            "backend_mode": get_backend_mode(self.settings),
            "results": results,
        }
