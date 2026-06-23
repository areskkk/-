from __future__ import annotations

import base64
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

SUPPORTED_MATERIAL_TYPES = {
    "business_license",
    "financial_report",
    "employment_proof",
    "contract",
    "other",
}


@dataclass(frozen=True)
class Settings:
    provider_engine: str
    internal_api_key: str | None
    node_env: str
    require_engine_ready: bool
    max_file_bytes: int
    allow_fixture_path: bool
    aliyun_app_id: str
    aliyun_app_name: str


def _optional_env(name: str) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def load_settings() -> Settings:
    return Settings(
        provider_engine=os.getenv("OCR_PROVIDER_ENGINE", "rapidocr"),
        internal_api_key=_optional_env("OCR_SERVICE_INTERNAL_API_KEY"),
        node_env=os.getenv("NODE_ENV", "development"),
        require_engine_ready=os.getenv("OCR_REQUIRE_ENGINE_READY", "").lower() == "true",
        max_file_bytes=int(os.getenv("OCR_MAX_FILE_BYTES", str(10 * 1024 * 1024))),
        allow_fixture_path=os.getenv("OCR_ALLOW_FIXTURE_PATH", "").lower() == "true",
        aliyun_app_id=os.getenv("OCR_ALIYUN_MARKET_APPID", "112343563"),
        aliyun_app_name=os.getenv("OCR_ALIYUN_MARKET_APPNAME", "云市场1350670480"),
    )


settings = load_settings()
app = FastAPI(title="Nankang Zhuqibao OCR Service")


class AnalyzeRequest(BaseModel):
    material_type: str
    file_path: str | None = None
    file_base64: str | None = None
    file_url: str | None = None
    mime_type: str
    original_filename: str


@app.middleware("http")
async def require_internal_api_key(request: Request, call_next):
    if settings.internal_api_key and request.url.path.startswith("/ocr/"):
        provided = request.headers.get("x-internal-api-key", "")
        if provided != settings.internal_api_key:
            return JSONResponse(
                status_code=401,
                content={"detail": "invalid internal api key"},
            )
    return await call_next(request)


def _run_rapidocr(path: str) -> list:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as error:  # pragma: no cover - runtime validated
        raise RuntimeError("rapidocr_onnxruntime is not installed") from error

    engine = RapidOCR()
    result, _ = engine(path)
    return result or []


def _extract_lines(ocr_result: list) -> list[tuple[str, float]]:
    lines: list[tuple[str, float]] = []
    for item in ocr_result:
        if not isinstance(item, list) or len(item) < 3:
            continue
        text = str(item[1]).strip()
        confidence = float(item[2])
        if text:
            lines.append((text, confidence))
    return lines


def _normalize_key(key: str) -> str:
    return key.strip().lower().replace(" ", "_")


def _parse_key_value_lines(
    lines: list[tuple[str, float]],
    material_type: str,
) -> tuple[dict[str, Any], dict[str, float], list[str]]:
    fields: dict[str, Any] = {}
    confidence: dict[str, float] = {}
    warnings: list[str] = []

    mapping = {
        "enterprise_name": {"enterprise_name", "企业名称", "名称"},
        "credit_code": {"credit_code", "统一社会信用代码"},
        "legal_person": {"legal_person", "法定代表人", "法人代表"},
        "registered_address": {"registered_address", "注册地址", "住所"},
        "business_scope": {"business_scope", "经营范围"},
        "report_year": {"report_year", "报告年度", "年度"},
        "revenue_amount": {"revenue_amount", "营业收入", "收入"},
        "net_profit": {"net_profit", "净利润"},
        "employee_count": {"employee_count", "员工人数", "用工人数"},
        "social_security_count": {"social_security_count", "社保人数"},
        "contract_name": {"contract_name", "合同名称"},
        "party_a": {"party_a", "甲方"},
        "party_b": {"party_b", "乙方"},
        "contract_amount": {"contract_amount", "合同金额"},
        "signed_date": {"signed_date", "签订日期"},
    }

    for text, line_confidence in lines:
        normalized_text = text.replace("：", ":")
        if ":" not in normalized_text:
            continue

        key, raw_value = normalized_text.split(":", 1)
        normalized_key = _normalize_key(key)
        value = raw_value.strip()
        if not value:
            continue

        matched_field = None
        for field_key, aliases in mapping.items():
            if normalized_key in {_normalize_key(alias) for alias in aliases}:
                matched_field = field_key
                break

        if matched_field is None:
            continue

        fields[matched_field] = value
        confidence[matched_field] = round(line_confidence, 4)

    if material_type == "business_license":
        fields["valid_period"] = {
            "start_date": None,
            "end_date": None,
            "long_term": True,
        }
        confidence["valid_period"] = 0.9

    required_fields_by_type = {
        "business_license": [
            "enterprise_name",
            "credit_code",
            "legal_person",
            "registered_address",
            "business_scope",
            "valid_period",
        ],
        "financial_report": ["enterprise_name", "report_year", "revenue_amount"],
        "employment_proof": ["enterprise_name", "employee_count"],
        "contract": ["party_a", "party_b", "contract_amount", "signed_date"],
        "other": [],
    }
    missing = [
        field
        for field in required_fields_by_type.get(material_type, [])
        if field not in fields
    ]
    if missing:
        warnings.append(f"missing fields: {', '.join(missing)}")

    credit_code = str(fields.get("credit_code", "")).replace(" ", "")
    if credit_code and len(credit_code) < 18:
        confidence["credit_code"] = min(confidence.get("credit_code", 1.0), 0.82)
        warnings.append("credit_code low confidence; manual confirmation required")

    return fields, confidence, warnings


def _load_fixture_or_run_rapidocr(path: Path) -> tuple[dict[str, Any] | None, list[tuple[str, float]]]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        if settings.node_env not in {"test", "development"} and not settings.allow_fixture_path:
            raise HTTPException(status_code=400, detail="fixture json input is disabled")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("invalid OCR fixture payload")
        return payload, []

    ocr_result = _run_rapidocr(str(path))
    lines = _extract_lines(ocr_result)
    if not lines:
        raise RuntimeError("ocr engine returned empty result")
    return None, lines


def _analyze_path(path: Path, material_type: str) -> dict:
    fixture, lines = _load_fixture_or_run_rapidocr(path)
    if fixture is not None:
        return fixture

    fields, confidence, warnings = _parse_key_value_lines(lines, material_type)
    overall_confidence = round(sum(confidence.values()) / len(confidence), 4) if confidence else 0.0

    return {
        "material_type": material_type,
        "fields": fields,
        "field_confidence": confidence,
        "overall_confidence": overall_confidence,
        "warnings": warnings,
        "pages": [
            {
                "page_no": 1,
                "text": "\n".join(text for text, _ in lines[:50]),
                "image_quality": "clear",
            }
        ],
        "raw_provider_meta": {
            "provider": settings.provider_engine,
            "line_count": len(lines),
        },
    }


def _write_base64_to_temp_file(request: AnalyzeRequest) -> Path:
    suffix = Path(request.original_filename).suffix.lower()
    safe_suffix = suffix if suffix and suffix.isascii() and len(suffix) <= 10 else ".bin"
    encoded_payload = request.file_base64 or ""
    max_encoded_length = ((settings.max_file_bytes + 2) // 3) * 4
    if len(encoded_payload) > max_encoded_length:
        raise HTTPException(status_code=413, detail="file_base64 exceeds OCR_MAX_FILE_BYTES")
    try:
        payload = base64.b64decode(encoded_payload, validate=True)
    except Exception as error:
        raise HTTPException(status_code=400, detail="invalid file_base64") from error
    if not payload:
        raise HTTPException(status_code=400, detail="file_base64 is empty")
    if len(payload) > settings.max_file_bytes:
        raise HTTPException(status_code=413, detail="file_base64 exceeds OCR_MAX_FILE_BYTES")

    handle = tempfile.NamedTemporaryFile(delete=False, suffix=safe_suffix)
    try:
        handle.write(payload)
        return Path(handle.name)
    finally:
        handle.close()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/health/live")
def live() -> dict:
    return {"status": "ok", "service": "ocr-sidecar"}


@app.get("/health/ready", response_model=None)
def ready():
    engine_ready_required = settings.node_env == "production" or settings.require_engine_ready
    checks: dict[str, Any] = {
        "provider_engine": settings.provider_engine,
        "internal_api_key_required": settings.node_env == "production",
        "internal_api_key": "ok" if settings.internal_api_key else "missing",
        "engine_ready_required": engine_ready_required,
        "max_file_bytes": settings.max_file_bytes,
        "supported_material_types": sorted(SUPPORTED_MATERIAL_TYPES),
        "file_base64_supported": True,
        "file_path_supported": settings.node_env != "production",
        "aliyun_market_app_id": settings.aliyun_app_id,
        "aliyun_market_app_name": settings.aliyun_app_name,
    }
    try:
        if settings.provider_engine == "rapidocr":
            try:
                import rapidocr_onnxruntime  # noqa: F401
                checks["rapidocr_dependency"] = "ok"
            except ImportError:
                checks["rapidocr_dependency"] = "missing"
        else:
            checks["rapidocr_dependency"] = "not_required"

        if settings.node_env == "production" and not settings.internal_api_key:
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "checks": checks},
            )
        if engine_ready_required and checks.get("rapidocr_dependency") == "missing":
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


@app.post("/ocr/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if request.material_type not in SUPPORTED_MATERIAL_TYPES:
        raise HTTPException(status_code=400, detail="unsupported material_type")
    if request.file_url:
        raise HTTPException(status_code=400, detail="file_url is not supported by rapidocr sidecar")

    temp_path: Path | None = None
    if request.file_base64:
        path = _write_base64_to_temp_file(request)
        temp_path = path
    elif request.file_path:
        if settings.node_env == "production":
            raise HTTPException(status_code=400, detail="file_path is disabled in production")
        path = Path(request.file_path)
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=400, detail="file_path not found")
    else:
        raise HTTPException(status_code=400, detail="file_path or file_base64 is required")

    try:
        return _analyze_path(path, request.material_type)
    except Exception as error:  # pragma: no cover - runtime behavior
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
