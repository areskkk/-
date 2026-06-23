from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi import HTTPException

from app.config import Settings, load_settings
from app.rag.debug import debug_log, summarize_text
from app.schemas import (
    IndexPolicyRequest,
    IndexPolicyResponse,
    SearchRequest,
    SearchResponse,
)
from app.rag.index_service import IndexService
from app.rag.search_service import SearchService

router = APIRouter(prefix="/rag")


def get_settings() -> Settings:
    return load_settings()


@router.post("/index/policy", response_model=IndexPolicyResponse)
def index_policy(
    request: IndexPolicyRequest,
    settings: Settings = Depends(get_settings),
) -> IndexPolicyResponse:
    debug_log(
        settings.rag_debug,
        "rag.endpoint.index.start",
        policy_id=request.policy_id,
    )
    service = IndexService(settings)
    try:
        response = IndexPolicyResponse(**service.index_policy(request.policy_id))
        debug_log(
            settings.rag_debug,
            "rag.endpoint.index.done",
            policy_id=request.policy_id,
            backend_mode=response.backend_mode,
            chunk_count=response.chunk_count,
        )
        return response
    except LookupError as error:
        debug_log(
            settings.rag_debug,
            "rag.endpoint.index.lookup_error",
            policy_id=request.policy_id,
            error=repr(error),
        )
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        debug_log(
            settings.rag_debug,
            "rag.endpoint.index.error",
            policy_id=request.policy_id,
            error=repr(error),
        )
        raise


@router.post("/search", response_model=SearchResponse)
def search(
    request: SearchRequest,
    settings: Settings = Depends(get_settings),
) -> SearchResponse:
    debug_log(
        settings.rag_debug,
        "rag.endpoint.search.start",
        policy_id=request.policy_id,
        limit=request.limit,
        query=summarize_text(request.query),
    )
    service = SearchService(settings)
    try:
        response = SearchResponse(**service.search(request.query, request.policy_id, request.limit))
        debug_log(
            settings.rag_debug,
            "rag.endpoint.search.done",
            policy_id=request.policy_id,
            backend_mode=response.backend_mode,
            result_count=len(response.results),
        )
        return response
    except Exception as error:
        debug_log(
            settings.rag_debug,
            "rag.endpoint.search.error",
            policy_id=request.policy_id,
            error=repr(error),
        )
        raise
