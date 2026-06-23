from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    rag_service_host: str
    rag_service_port: int
    rag_service_log_level: str
    app_database_url: str
    rag_backend_mode: str
    pg_conn_str: str | None
    rag_pgvector_table_name: str
    rag_pgvector_search_strategy: str
    haystack_embedding_dimension: int
    haystack_embedding_model: str
    haystack_embedding_model_path: str | None
    haystack_reranker_model: str | None
    haystack_enable_reranker: bool
    hf_token: str | None
    rag_search_top_k: int
    rag_debug: bool
    node_env: str
    rag_require_persistent_backend: bool
    rag_service_internal_api_key: str | None

    @property
    def embedding_model_source(self) -> str:
        return "local_path" if self.haystack_embedding_model_path else "hf_repo"

    @property
    def embedding_model_ref(self) -> str:
        return self.haystack_embedding_model_path or self.haystack_embedding_model


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() == "true"


def _read_optional(name: str) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _validate_model_path(path_value: str | None) -> str | None:
    if path_value is None:
        return None

    path = Path(path_value)
    if not path.exists() or not path.is_dir():
        raise ValueError(
            f"HAYSTACK_EMBEDDING_MODEL_PATH does not exist or is not a directory: {path_value}",
        )

    expected_markers = [
        path / "config.json",
        path / "modules.json",
        path / "tokenizer_config.json",
    ]
    if not any(marker.exists() for marker in expected_markers):
        raise ValueError(
            "HAYSTACK_EMBEDDING_MODEL_PATH does not look like a sentence-transformers model directory",
        )

    return str(path)


def load_settings() -> Settings:
    settings = Settings(
        rag_service_host=os.getenv("RAG_SERVICE_HOST", "0.0.0.0"),
        rag_service_port=int(os.getenv("RAG_SERVICE_PORT", "8001")),
        rag_service_log_level=os.getenv("RAG_SERVICE_LOG_LEVEL", "info"),
        app_database_url=os.getenv(
            "APP_DATABASE_URL",
            "postgresql://postgres:postgres@127.0.0.1:5432/nankang_zhuqibao",
        ),
        rag_backend_mode=os.getenv("RAG_BACKEND_MODE", "haystack_inmemory"),
        pg_conn_str=_read_optional("PG_CONN_STR"),
        rag_pgvector_table_name=os.getenv(
            "RAG_PGVECTOR_TABLE_NAME",
            "haystack_policy_documents",
        ),
        rag_pgvector_search_strategy=os.getenv(
            "RAG_PGVECTOR_SEARCH_STRATEGY",
            "hnsw",
        ),
        haystack_embedding_dimension=int(
            os.getenv("HAYSTACK_EMBEDDING_DIMENSION", "384"),
        ),
        haystack_embedding_model=os.getenv(
            "HAYSTACK_EMBEDDING_MODEL",
            "intfloat/multilingual-e5-small",
        ),
        haystack_embedding_model_path=_validate_model_path(
            _read_optional("HAYSTACK_EMBEDDING_MODEL_PATH"),
        ),
        haystack_reranker_model=_read_optional("HAYSTACK_RERANKER_MODEL"),
        haystack_enable_reranker=_read_bool("HAYSTACK_ENABLE_RERANKER", False),
        hf_token=_read_optional("HF_TOKEN"),
        rag_search_top_k=int(os.getenv("RAG_SEARCH_TOP_K", "10")),
        rag_debug=_read_bool("RAG_DEBUG", False),
        node_env=os.getenv("NODE_ENV", "development"),
        rag_require_persistent_backend=_read_bool(
            "RAG_REQUIRE_PERSISTENT_BACKEND",
            os.getenv("NODE_ENV", "development") == "production",
        ),
        rag_service_internal_api_key=_read_optional("RAG_SERVICE_INTERNAL_API_KEY"),
    )
    if (
        settings.rag_require_persistent_backend
        and settings.rag_backend_mode != "haystack_pgvector"
    ):
        raise ValueError(
            "production RAG requires persistent backend; set RAG_BACKEND_MODE=haystack_pgvector",
        )
    if settings.node_env == "production" and not settings.rag_service_internal_api_key:
        raise ValueError(
            "production RAG requires RAG_SERVICE_INTERNAL_API_KEY",
        )
    return settings
