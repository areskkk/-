from __future__ import annotations

from typing import Any

import psycopg
from haystack.document_stores.in_memory import InMemoryDocumentStore
from haystack.utils import Secret

from app.config import Settings


class PgvectorConfigurationError(RuntimeError):
    pass


_IN_MEMORY_STORE: InMemoryDocumentStore | None = None
_PGVECTOR_STORE: Any | None = None


def get_backend_mode(settings: Settings) -> str:
    if settings.rag_backend_mode == "haystack_pgvector":
        return "haystack_pgvector"
    if settings.rag_backend_mode == "haystack_inmemory":
        return "haystack_inmemory"
    return "local_fallback"


def _require_pg_conn_str(settings: Settings) -> str:
    if not settings.pg_conn_str:
        raise PgvectorConfigurationError(
            "PG_CONN_STR is required when RAG_BACKEND_MODE=haystack_pgvector",
        )
    return settings.pg_conn_str


def _assert_vector_extension(pg_conn_str: str) -> None:
    with psycopg.connect(pg_conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT extname FROM pg_extension WHERE extname = 'vector'",
            )
            installed = cur.fetchone()
            cur.execute(
                "SELECT name FROM pg_available_extensions WHERE name = 'vector'",
            )
            available = cur.fetchone()

    if installed:
        return

    if available:
        raise PgvectorConfigurationError(
            "vector extension is available but not installed in the target database",
        )

    raise PgvectorConfigurationError(
        "vector extension is not installed and not available in the target PostgreSQL instance",
    )


def _build_pgvector_document_store(settings: Settings):
    pg_conn_str = _require_pg_conn_str(settings)
    _assert_vector_extension(pg_conn_str)

    try:
        from haystack_integrations.document_stores.pgvector import PgvectorDocumentStore
    except ImportError as error:
        raise PgvectorConfigurationError(
            "pgvector-haystack is not installed; install the optional pgvector dependency first",
        ) from error

    try:
        return PgvectorDocumentStore(
            connection_string=Secret.from_token(pg_conn_str),
            table_name=settings.rag_pgvector_table_name,
            embedding_dimension=settings.haystack_embedding_dimension,
            vector_function="cosine_similarity",
            recreate_table=False,
            search_strategy=settings.rag_pgvector_search_strategy,
        )
    except Exception as error:  # pragma: no cover - exercised by integration/runtime
        raise PgvectorConfigurationError(
            f"failed to initialize PgvectorDocumentStore: {error!r}",
        ) from error


def get_document_store(settings: Settings):
    global _IN_MEMORY_STORE
    global _PGVECTOR_STORE

    if settings.rag_backend_mode == "haystack_inmemory":
        if _IN_MEMORY_STORE is None:
            _IN_MEMORY_STORE = InMemoryDocumentStore()
        return _IN_MEMORY_STORE

    if settings.rag_backend_mode == "haystack_pgvector":
        if _PGVECTOR_STORE is None:
            _PGVECTOR_STORE = _build_pgvector_document_store(settings)
        return _PGVECTOR_STORE

    raise RuntimeError(
        f"unsupported RAG_BACKEND_MODE for sidecar runtime: {settings.rag_backend_mode}",
    )
