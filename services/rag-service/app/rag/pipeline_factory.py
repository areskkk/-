from __future__ import annotations

from haystack import Pipeline
from haystack.components.embedders import (
    SentenceTransformersDocumentEmbedder,
    SentenceTransformersTextEmbedder,
)
from haystack.components.retrievers.in_memory import InMemoryEmbeddingRetriever

from app.config import Settings
from app.rag.debug import debug_log
from app.rag.document_store import get_backend_mode

_DOCUMENT_EMBEDDER: SentenceTransformersDocumentEmbedder | None = None
_TEXT_EMBEDDER: SentenceTransformersTextEmbedder | None = None
_SEARCH_PIPELINE: Pipeline | None = None


def build_document_embedder(settings: Settings) -> SentenceTransformersDocumentEmbedder:
    global _DOCUMENT_EMBEDDER
    if _DOCUMENT_EMBEDDER is None:
        _DOCUMENT_EMBEDDER = SentenceTransformersDocumentEmbedder(
            model=settings.embedding_model_ref,
        )
        debug_log(
            settings.rag_debug,
            "embedder.document.created",
            model_source=settings.embedding_model_source,
            model_ref=settings.embedding_model_ref,
        )
    return _DOCUMENT_EMBEDDER


def build_text_embedder(settings: Settings) -> SentenceTransformersTextEmbedder:
    global _TEXT_EMBEDDER
    if _TEXT_EMBEDDER is None:
        _TEXT_EMBEDDER = SentenceTransformersTextEmbedder(
            model=settings.embedding_model_ref,
        )
        debug_log(
            settings.rag_debug,
            "embedder.text.created",
            model_source=settings.embedding_model_source,
            model_ref=settings.embedding_model_ref,
        )
    return _TEXT_EMBEDDER


def build_retriever(settings: Settings, document_store):
    backend_mode = get_backend_mode(settings)
    if backend_mode == "haystack_inmemory":
        return InMemoryEmbeddingRetriever(document_store=document_store)

    if backend_mode == "haystack_pgvector":
        try:
            from haystack_integrations.components.retrievers.pgvector import (
                PgvectorEmbeddingRetriever,
            )
        except ImportError as error:
            raise RuntimeError(
                "pgvector-haystack is not installed; cannot build PgvectorEmbeddingRetriever",
            ) from error

        return PgvectorEmbeddingRetriever(document_store=document_store)

    raise RuntimeError(f"unsupported backend_mode for retriever: {backend_mode}")


def build_search_pipeline(settings: Settings, document_store) -> Pipeline:
    global _SEARCH_PIPELINE
    if _SEARCH_PIPELINE is None:
        pipeline = Pipeline()
        pipeline.add_component("text_embedder", build_text_embedder(settings))
        pipeline.add_component("retriever", build_retriever(settings, document_store))
        pipeline.connect("text_embedder.embedding", "retriever.query_embedding")
        _SEARCH_PIPELINE = pipeline
    return _SEARCH_PIPELINE


def warm_up_runtime(settings: Settings, document_store) -> None:
    document_embedder = build_document_embedder(settings)
    debug_log(
        settings.rag_debug,
        "embedder.document.warmup.start",
        model_source=settings.embedding_model_source,
        model_ref=settings.embedding_model_ref,
        store_id=id(document_store),
    )
    document_embedder.warm_up()
    debug_log(
        settings.rag_debug,
        "embedder.document.warmup.ok",
        model_source=settings.embedding_model_source,
        model_ref=settings.embedding_model_ref,
        store_id=id(document_store),
    )

    text_embedder = build_text_embedder(settings)
    debug_log(
        settings.rag_debug,
        "embedder.text.warmup.start",
        model_source=settings.embedding_model_source,
        model_ref=settings.embedding_model_ref,
        store_id=id(document_store),
    )
    text_embedder.warm_up()
    debug_log(
        settings.rag_debug,
        "embedder.text.warmup.ok",
        model_source=settings.embedding_model_source,
        model_ref=settings.embedding_model_ref,
        store_id=id(document_store),
    )

    build_search_pipeline(settings, document_store)
