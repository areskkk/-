from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi import Request
from fastapi.responses import JSONResponse

from app.api.health import create_health_router
from app.api.rag import router as rag_router
from app.config import load_settings
from app.rag.document_store import PgvectorConfigurationError, get_document_store
from app.rag.pipeline_factory import warm_up_runtime


logger = logging.getLogger("rag-service")
logger.info("app.init.start")
settings = load_settings()
logging.basicConfig(level=getattr(logging, settings.rag_service_log_level.upper(), logging.INFO))
logger.info(
    "config.loaded backend_mode=%s log_level=%s debug=%s",
    settings.rag_backend_mode,
    settings.rag_service_log_level,
    settings.rag_debug,
)
logger.info(
    "embedding_model_source=%s model_ref=%s",
    settings.embedding_model_source,
    settings.embedding_model_ref,
)
if os.getenv("HF_ENDPOINT"):
    logger.info("hf_endpoint=%s", os.getenv("HF_ENDPOINT"))
if os.getenv("HTTP_PROXY") or os.getenv("HTTPS_PROXY"):
    logger.info("proxy_configured=true")

if settings.rag_backend_mode == "haystack_pgvector":
    logger.info("pgvector.validation.start")
    if not settings.pg_conn_str:
        logger.error("pgvector.validation.error reason=missing_pg_conn_str")
        raise RuntimeError(
            "RAG_BACKEND_MODE=haystack_pgvector requires PG_CONN_STR",
        )
    try:
        get_document_store(settings)
        logger.info(
            "pgvector.validation.ok table_name=%s search_strategy=%s",
            settings.rag_pgvector_table_name,
            settings.rag_pgvector_search_strategy,
        )
    except PgvectorConfigurationError as error:
        logger.error("pgvector.validation.error reason=%s", str(error))
        raise
    except Exception as error:
        logger.exception("pgvector.validation.error reason=document_store_init_failed")
        raise RuntimeError(
            f"failed to initialize pgvector document store: {error!r}",
        ) from error

app = FastAPI(title="Nankang Zhuqibao RAG Service")
logger.info("app.init.done")


@app.middleware("http")
async def require_internal_api_key(request: Request, call_next):
    internal_api_key = settings.rag_service_internal_api_key or ""
    if internal_api_key and request.url.path.startswith("/rag/"):
        provided = request.headers.get("x-internal-api-key", "")
        if provided != internal_api_key:
            return JSONResponse(
                status_code=401,
                content={"detail": "invalid internal api key"},
            )
    return await call_next(request)


@app.middleware("http")
async def log_request_exceptions(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as error:
        logger.exception(
            "request.error method=%s path=%s error=%r",
            request.method,
            request.url.path,
            error,
        )
        raise


@app.on_event("startup")
async def on_startup() -> None:
    try:
        document_store = get_document_store(settings)
        warm_up_runtime(settings, document_store)
    except Exception:
        logger.exception("fastapi.startup.warmup.error")
        raise
    logger.info(
        "fastapi.startup.complete host=%s port=%s",
        settings.rag_service_host,
        settings.rag_service_port,
    )


app.include_router(create_health_router(settings))
app.include_router(rag_router)
