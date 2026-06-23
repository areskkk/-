from __future__ import annotations

import psycopg
from fastapi import APIRouter
from fastapi import status
from fastapi.responses import JSONResponse

from app.config import Settings
from app.rag.document_store import get_backend_mode, get_document_store


READONLY_PROBE_SQL_BY_TABLE = {
    "policies": """
        INSERT INTO policies (
            title,
            source_type,
            source_name,
            source_url,
            status,
            version,
            content
        )
        VALUES (
            'rag readonly ready probe',
            'manual_import',
            'rag-sidecar',
            'https://example.invalid/rag-readonly-ready-probe',
            'draft',
            'ready-probe',
            'this write must be blocked for the RAG APP_DATABASE_URL user'
        )
    """,
    "policy_chunks": """
        INSERT INTO policy_chunks (
            policy_id,
            version,
            title,
            section_path,
            chunk_order,
            content,
            content_hash,
            status,
            metadata
        )
        VALUES (
            gen_random_uuid(),
            'ready-probe',
            'rag readonly ready probe',
            'ready',
            987654321,
            'this write must be blocked for the RAG APP_DATABASE_URL user',
            'rag-readonly-ready-probe',
            'effective',
            '{}'::jsonb
        )
    """,
    "policy_ai_whitelist": """
        INSERT INTO policy_ai_whitelist (
            policy_id,
            enabled
        )
        VALUES (
            gen_random_uuid(),
            true
        )
    """,
}


def _requires_readonly_app_database(settings: Settings) -> bool:
    return (
        settings.node_env == "production"
        or settings.rag_require_persistent_backend
        or settings.rag_backend_mode == "haystack_pgvector"
    )


def _probe_app_database_readonly_table(
    conn: psycopg.Connection,
    table_name: str,
) -> str:
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(READONLY_PROBE_SQL_BY_TABLE[table_name])
            raise RuntimeError(
                f"readonly probe unexpectedly wrote to {table_name}",
            )
    except psycopg.errors.InFailedSqlTransaction:
        return "blocked"
    except psycopg.errors.InsufficientPrivilege:
        return "blocked"
    except psycopg.errors.ReadOnlySqlTransaction:
        return "blocked"
    except psycopg.errors.UndefinedTable:
        raise
    except RuntimeError:
        raise
    except Exception as error:
        if getattr(error, "sqlstate", None) in {"25006", "42501"}:
            return "blocked"
        raise


def _probe_app_database_readonly(
    conn: psycopg.Connection,
) -> dict[str, str]:
    return {
        table_name: _probe_app_database_readonly_table(conn, table_name)
        for table_name in READONLY_PROBE_SQL_BY_TABLE
    }


def create_health_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok", "service": "rag-sidecar"}

    @router.get(
        "/health/ready",
        status_code=status.HTTP_200_OK,
        response_model=None,
        responses={503: {"description": "Not ready"}},
    )
    def ready():
        checks: dict[str, object] = {
            "backend_mode": get_backend_mode(settings),
            "persistent_backend_required": settings.rag_require_persistent_backend,
            "embedding_model_ref": settings.embedding_model_ref,
            "internal_api_key_required": settings.node_env == "production",
            "readonly_app_database_required": _requires_readonly_app_database(settings),
        }
        try:
            if (
                settings.rag_require_persistent_backend
                and settings.rag_backend_mode != "haystack_pgvector"
            ):
                checks["persistent_backend"] = "missing"
            else:
                checks["persistent_backend"] = "ok"
            if settings.node_env == "production" and not settings.rag_service_internal_api_key:
                checks["internal_api_key"] = "missing"
            else:
                checks["internal_api_key"] = "ok"
            with psycopg.connect(settings.app_database_url) as conn:
                with conn.cursor() as cur:
                    for table_name in [
                        "policies",
                        "policy_chunks",
                        "policy_ai_whitelist",
                    ]:
                        cur.execute("SELECT to_regclass(%s)", (table_name,))
                        exists = cur.fetchone()[0]
                        checks[f"app_db_table_{table_name}"] = (
                            "ok" if exists else "missing"
                        )
                        if exists:
                            cur.execute(f"SELECT 1 FROM {table_name} LIMIT 1")
                            cur.fetchone()
                if _requires_readonly_app_database(settings):
                    readonly_checks = _probe_app_database_readonly(conn)
                    for table_name, probe_result in readonly_checks.items():
                        checks[f"app_db_readonly_{table_name}"] = probe_result
                    checks["app_db_readonly_business_tables"] = (
                        "blocked"
                        if all(value == "blocked" for value in readonly_checks.values())
                        else "not_blocked"
                    )
                else:
                    checks["app_db_readonly_business_tables"] = "not_required"
            checks["app_db"] = "ok"
            get_document_store(settings)
            checks["document_store"] = "ok"
            if settings.rag_backend_mode == "haystack_pgvector":
                with psycopg.connect(settings.pg_conn_str) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT extname FROM pg_extension WHERE extname = 'vector'",
                        )
                        checks["pgvector_extension"] = "ok" if cur.fetchone() else "missing"
                        cur.execute(
                            "SELECT to_regclass(%s)",
                            (settings.rag_pgvector_table_name,),
                        )
                        checks["pgvector_table"] = "ok" if cur.fetchone()[0] else "missing"
            if "missing" in checks.values():
                return JSONResponse(
                    status_code=503,
                    content={"status": "not_ready", "checks": checks},
                )
            return {"status": "ok", "checks": checks}
        except Exception as error:
            checks["error"] = error.__class__.__name__
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "checks": checks},
            )

    return router
