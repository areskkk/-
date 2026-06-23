from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class IndexPolicyRequest(BaseModel):
    policy_id: str = Field(min_length=1)


class IndexPolicyResponse(BaseModel):
    backend_mode: str
    policy_id: str
    version: str
    chunk_count: int
    index_strategy: str = "delete_then_insert"


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    policy_id: str | None = None
    limit: int = Field(default=5, ge=1, le=10)


class SearchResultItem(BaseModel):
    chunk_id: str
    policy_id: str
    version: str
    title: str
    section_path: str
    chunk_order: int
    source_name: str | None = None
    source_url: str | None = None
    content: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    backend_mode: str
    results: list[SearchResultItem]
