# API 接口规格（MVP 补齐版）

> 文档状态：V1 补齐草案
> 适用范围：企业端 H5、政府端、管理后台、Agent/RAG/OCR 能力中台
> 更新时间：2026-06-09
> 风格：REST + OpenAPI 风格
> 认证：MVP 自建账号 + Bearer Token；预留政务统一认证、赣服通、政务 OA 接入
> 重要边界：AI/Agent 只做辅助解释、预审草稿、材料校验和人工兜底，不自动替代最终行政审批决定。

---

## 0. 文档目标与接口成熟度

当前后端已有一批接口可运行，但仍存在多政策申报、撤回、独立预审、补正通知、企业画像导入、文件下载、前端工作台等缺口。本文件用于把 MVP 接口规格从“列表级”补齐到“可按接口逐项实现”的程度。

### 0.1 成熟度标识

| 标识 | 含义 | 下一步处理 |
| --- | --- | --- |
| 已实现 | 当前代码已有路由与基本服务逻辑 | 后续按本规格校准字段、错误码、权限和测试 |
| 待补齐-P0 | MVP 核心闭环必须补齐 | 下一批优先实现 |
| 待补齐-P1 | 影响体验或运营，但可在 P0 后实现 | 第二优先级实现 |
| 后续扩展 | 超出 MVP 或需外部系统接入 | 暂不阻塞 MVP 试点 |

### 0.2 当前最关键待补齐接口

| 优先级 | 接口 | 原因 |
| --- | --- | --- |
| P0 | `PUT /api/v1/applications/{application_id}` | 草稿编辑缺口，企业无法完整保存表单上下文 |
| P0 | `POST /api/v1/applications/{application_id}/withdraw` | 状态机已有撤回，接口未补齐 |
| P0 | `POST /api/v1/review/tasks/{item_id}/precheck` | 政府端主动预审入口缺失 |
| P0 | `POST /api/v1/review/tasks/{item_id}/supplement-request` | 补正通知独立接口缺失，当前仅能通过 `decision=request_supplement` 间接实现 |
| P0 | `POST /api/v1/admin/enterprise-profiles/import` | 后台导入企业画像缺口 |
| P0 | `GET /api/v1/files/{file_id}` / `GET /api/v1/files/{file_id}/download-url` | 文件查看、材料预览、政府端审核缺少标准接口 |
| P1 | `POST /api/v1/applications/batch` 或扩展 `POST /api/v1/applications` 支持 `policy_ids` | 多政策申报口径要求后端按政策拆分子项 |
| P1 | `GET /api/v1/enterprise-dashboard` | 企业端工作台聚合数据缺口 |
| P1 | `GET /api/v1/admin/dashboard/operations` | 管理后台运营看板缺口 |
| P1 | `GET/POST /api/v1/admin/threshold-configs` | 低置信度阈值配置缺口 |
| P1 | `GET/POST /api/v1/admin/prompt-templates` | Prompt 模板管理缺口 |
| P1 | `GET/POST /api/v1/admin/model-routes` | 模型路由配置缺口 |

---

## 1. 通用约定

### 1.1 Base URL

```text
/api/v1
```

健康检查接口保留根路径：

```text
/health
/health/live
/health/ready
```

### 1.2 认证

除特别说明外，所有业务接口都需要：

```http
Authorization: Bearer <jwt_token>
```

Token 载荷至少包含：

```json
{
  "sub": "user_id",
  "roles": ["owner", "admin"],
  "user_type": "enterprise"
}
```

### 1.3 角色与权限

| 角色 / 用户类型 | 说明 | 典型权限 |
| --- | --- | --- |
| enterprise | 企业用户 | 企业绑定、画像维护、政策问答、申报、补正 |
| reviewer | 政府审核人员 | 审核任务列表、详情、预审、决策、补正通知 |
| admin | 平台管理员 / 运营 | 政策管理、企业画像导入、人工兜底、审计、Agent metrics |
| system | 系统内部 | Agent Worker、审计、定时任务，不直接暴露给前端 |

具体权限由后端 `permissionService` 判定；管理后台和政府端接口必须做权限校验，不能只判断已登录。

### 1.4 响应包络

成功响应：

```json
{
  "success": true,
  "data": {},
  "trace_id": "trace_001"
}
```

失败响应：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "参数错误",
    "details": {}
  },
  "trace_id": "trace_001"
}
```

### 1.5 错误码

| code | HTTP | 说明 |
| --- | --- | --- |
| AUTH_REQUIRED | 401 | 未登录或 Bearer Token 缺失 |
| FORBIDDEN | 403 | 无权限访问资源或执行动作 |
| NOT_FOUND | 404 | 资源不存在 |
| VALIDATION_ERROR | 400 | 参数校验失败 |
| CONFLICT | 409 | 状态、版本、幂等键或并发冲突 |
| RATE_LIMITED | 429 | 触发频率、并发、预算限制 |
| LOW_CONFIDENCE | 422 | 低置信度，需要人工处理 |
| INTERNAL_ERROR | 500 | 系统异常 |

### 1.6 分页

请求参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| page | number | 1 | 页码，从 1 开始 |
| page_size | number | 20 | 每页数量，建议最大 100 |

响应结构：

```json
{
  "page": 1,
  "page_size": 20,
  "total": 100,
  "items": []
}
```

### 1.7 幂等约定

写类接口建议支持以下两种方式之一：

1. 请求体字段：`idempotency_key`
2. 请求头：`Idempotency-Key`

当前已实现接口以请求体 `idempotency_key` 为主，后续补齐接口时建议兼容请求头。幂等键必须按“业务对象 + 操作类型 + 版本”生成，例如：

```text
submit_application:<application_id>:v1
resume_fallback:<task_id>:v1
review_precheck:<item_id>:v1
```

### 1.8 时间、金额和数字

- 时间统一使用 ISO 8601 字符串，例如 `2026-06-09T10:00:00.000Z`。
- 金额、营收、纳税额等用数字，单位由字段名说明；金额默认“元”。
- 后端返回数据库 decimal 时，可返回 number 或 string，但同一字段必须保持一致。

### 1.9 文件上传

上传接口使用：

```http
Content-Type: multipart/form-data
```

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| file | file | 是 | 文件内容 |
| enterprise_id | string | 是 | 所属企业 |

---

## 2. 核心枚举

### 2.1 企业绑定状态

| 值 | 说明 |
| --- | --- |
| pending | 待人工审核 |
| agent_approved | Agent / 规则低风险自动通过 |
| manual_approved | 人工通过 |
| rejected | 拒绝 |
| revoked | 撤销 |

### 2.2 申报状态

| 值 | 企业端文案 | 说明 |
| --- | --- | --- |
| draft | 草稿 | 企业可编辑 |
| submitted | 已提交 | 等待预审或审核 |
| pre_reviewing | 预审中 | 系统/Agent 预审中 |
| reviewing | 审核中 | 政府人工审核中 |
| need_supplement | 需补正 | 企业需补材料或字段 |
| resubmitted | 已补正 | 企业完成补正，待重新审核 |
| manual_review | 人工复核中 | 低置信度、冲突或自由裁量 |
| approved | 已通过 | 审核通过 |
| rejected | 不通过 | 审核不通过 |
| withdrawn | 已撤回 | 企业提交后撤回 |
| timeout_closed | 超时关闭 | 补正或办理超时关闭 |
| archived | 已归档 | 只读归档 |

### 2.3 资格预判结果

| 值 | 说明 |
| --- | --- |
| eligible | 满足已发布规则中的主要条件 |
| ineligible | 明确不满足硬性条件 |
| need_info | 缺少关键字段或材料 |
| manual_review | 低置信度、证据冲突或需人工判断 |

### 2.4 OCR 状态

| 值 | 说明 |
| --- | --- |
| pending | 待识别 |
| success | 识别成功 |
| low_confidence | 存在低置信字段，需要人工确认 |
| failed | 识别失败 |

### 2.5 Agent Run 状态

| 值 | 说明 |
| --- | --- |
| queued | 已排队 |
| running | 执行中 |
| interrupted | 中断，等待人工兜底 |
| resuming | 恢复任务已排队 |
| resume_failed | 恢复失败 |
| completed | 完成 |
| failed | 失败 |
| cancelled | 取消 |

---

## 3. 健康检查

### 3.1 GET /health（已实现）

用途：基础服务健康检查。

Response:

```json
{
  "status": "ok",
  "service": "nankang-zhuqibao-api"
}
```

### 3.2 GET /health/live（已实现）

用途：存活检查，供负载均衡使用。

### 3.3 GET /health/ready（已实现）

用途：就绪检查，至少检查数据库和 Agent job 表。

Response:

```json
{
  "status": "ok",
  "checks": {
    "database": "ok",
    "agent_run_jobs": "ok"
  }
}
```

验收标准：生产部署必须接入 readiness 门禁；ready 非 200 时不得接流量。

---

## 4. 账号与认证

### 4.1 POST /api/v1/auth/register（已实现）

Request:

```json
{
  "name": "张三",
  "phone": "13800000000",
  "password": "StrongPassword123",
  "user_type": "enterprise"
}
```

Response:

```json
{
  "user_id": "uuid",
  "name": "张三",
  "phone": "13800000000",
  "user_type": "enterprise",
  "roles": []
}
```

规则：

- `phone` 必须唯一。
- 密码不得明文存储。
- 注册动作必须写审计。

### 4.2 POST /api/v1/auth/login（已实现）

Request:

```json
{
  "phone": "13800000000",
  "password": "StrongPassword123"
}
```

Response:

```json
{
  "token": "jwt_token",
  "user": {
    "user_id": "uuid",
    "name": "张三",
    "phone": "13800000000",
    "user_type": "enterprise",
    "roles": ["owner"]
  }
}
```

---

## 5. 企业账号与绑定

### 5.1 POST /api/v1/enterprises/bind（已实现，需增强）

用途：企业用户提交企业绑定申请。

Request:

```json
{
  "enterprise_name": "南康某家具有限公司",
  "credit_code": "913607XX0000000000",
  "license_file_id": "uuid"
}
```

Response:

```json
{
  "binding_id": "uuid",
  "status": "agent_approved",
  "review": {
    "type": "agent_or_rule_review",
    "result": "approved",
    "reason": "统一社会信用代码格式正确，企业名称与营业执照 OCR 一致",
    "risk_items": []
  }
}
```

当前实现说明：

- 当前是简化自动通过规则，主要校验信用代码格式、企业名称和 `license_file_id` 非空。
- 下一步应补齐营业执照文件存在性校验、OCR 一致性校验、低置信转人工兜底。

验收标准：

- 新企业低风险可自动通过并留痕。
- 已存在企业、名称不一致、OCR 低置信、信用代码不一致必须进入人工审核。
- 绑定成功后用户获得企业 owner 权限。

### 5.2 GET /api/v1/enterprises/me（已实现）

用途：获取当前用户绑定的企业列表。

Response:

```json
[
  {
    "enterprise_id": "uuid",
    "name": "南康某家具有限公司",
    "credit_code": "913607XX0000000000",
    "status": "active",
    "role": "owner",
    "auth_status": "agent_approved"
  }
]
```

### 5.3 GET /api/v1/enterprise-dashboard（待补齐-P1）

用途：企业端首页聚合展示推荐政策、待办、申报进度、补正提醒。

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| enterprise_id | string | 是 | 企业 ID |

Response:

```json
{
  "enterprise_id": "uuid",
  "todo_counts": {
    "draft": 1,
    "need_supplement": 2,
    "manual_review": 1
  },
  "recommended_policies": [
    {
      "policy_id": "uuid",
      "title": "政策标题",
      "match_score": 0.82,
      "eligibility_result": "need_info"
    }
  ],
  "recent_applications": [],
  "fallback_tasks": []
}
```

---

## 6. 企业画像

### 6.1 GET /api/v1/enterprise-profile（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| enterprise_id | string | 否 | 多企业用户可指定；不传默认第一个绑定企业 |

Response:

```json
{
  "current_profile": {
    "profile_id": "uuid",
    "enterprise_id": "uuid",
    "enterprise_name": "南康某家具有限公司",
    "credit_code": "913607XX0000000000",
    "industry": "家具制造",
    "scale": "small",
    "revenue_amount": 12000000,
    "employee_count": 80,
    "tax_amount": 900000,
    "export_amount": 1000000,
    "tech_upgrade_status": "planned",
    "profile_json": {}
  },
  "snapshot_status": "current_profile_only"
}
```

### 6.2 PUT /api/v1/enterprise-profile（已实现）

Request:

```json
{
  "enterprise_id": "uuid",
  "enterprise_name": "南康某家具有限公司",
  "credit_code": "913607XX0000000000",
  "industry": "家具制造",
  "scale": "small",
  "revenue_amount": 12000000,
  "employee_count": 80,
  "tax_amount": 900000,
  "export_amount": 1000000,
  "tech_upgrade_status": "planned",
  "profile_json": {
    "factory_area": 5000
  }
}
```

规则：

- 仅企业绑定成员可维护本企业画像。
- 提交申报时必须冻结快照，后续画像更新不得影响已提交申报。

### 6.3 POST /api/v1/admin/enterprise-profiles/import（待补齐-P0）

用途：管理后台批量导入企业画像。

Request:

```json
{
  "idempotency_key": "enterprise_profile_import_20260609_v1",
  "mode": "upsert",
  "source": "government_import",
  "rows": [
    {
      "enterprise_name": "南康某家具有限公司",
      "credit_code": "913607XX0000000000",
      "industry": "家具制造",
      "scale": "small",
      "revenue_amount": 12000000,
      "employee_count": 80,
      "tax_amount": 900000,
      "export_amount": 1000000,
      "tech_upgrade_status": "planned",
      "profile_json": {}
    }
  ]
}
```

Response:

```json
{
  "import_id": "uuid",
  "total": 1,
  "inserted": 1,
  "updated": 0,
  "failed": 0,
  "errors": []
}
```

规则：

- 需要管理员权限。
- 按 `credit_code` 幂等 upsert。
- 导入详情必须写审计。
- 单批建议最大 1000 条；更大批量应走异步导入任务。

---

## 7. 政策库与政策结构化

### 7.1 GET /api/v1/policies（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| page | number | 否 | 页码 |
| page_size | number | 否 | 每页数量 |
| keyword | string | 否 | 待补齐：标题/内容搜索 |
| category | string | 否 | 待补齐：政策分类 |
| department_id | string | 否 | 待补齐：部门筛选 |

Response:

```json
{
  "page": 1,
  "page_size": 20,
  "total": 1,
  "items": [
    {
      "policy_id": "uuid",
      "title": "政策标题",
      "version": "v1",
      "status": "effective",
      "effective_date": "2026-01-01",
      "expire_date": "2026-12-31",
      "source_name": "南康区政府",
      "source_url": "https://example.gov/policy"
    }
  ]
}
```

### 7.2 GET /api/v1/policies/{policy_id}（已实现）

Response:

```json
{
  "policy_id": "uuid",
  "title": "政策标题",
  "content": "政策正文",
  "version": "v1",
  "status": "effective",
  "conditions": [],
  "materials": []
}
```

### 7.3 POST /api/v1/admin/policies/import（已实现，需增强）

Request:

```json
{
  "title": "政策标题",
  "source_type": "text",
  "content": "政策正文",
  "source_name": "南康区政府",
  "source_url": "https://example.gov/policy",
  "department_id": "dept_001",
  "version": "v1",
  "effective_date": "2026-01-01",
  "expire_date": "2026-12-31",
  "file_id": "uuid"
}
```

当前实现说明：

- 当前支持 JSON/text 导入。
- `file_id` 只是引用，尚未解析 PDF/Word 文件内容。

下一步增强：

- 支持从上传文件解析政策正文。
- 支持结构化草稿生成。
- 支持版本冲突校验。

### 7.4 PUT /api/v1/admin/policies/{policy_id}/schema（已实现）

Request:

```json
{
  "conditions": [
    {
      "field_key": "enterprise_profile.revenue_amount",
      "operator": "gte",
      "target_value": 1000000,
      "required": true,
      "evidence_type": "profile",
      "message": "年营收需不低于 100 万元"
    }
  ],
  "materials": [
    {
      "material_type": "business_license",
      "required": true,
      "validity_days": 365,
      "reuse_allowed_in_application": true
    }
  ]
}
```

### 7.5 POST /api/v1/admin/policies/{policy_id}/publish（已实现）

用途：发布政策，使企业端可见、资格预判可用。

Response:

```json
{
  "policy_id": "uuid",
  "status": "effective"
}
```

### 7.6 POST /api/v1/admin/rag/policies/{policy_id}/index（已实现）

用途：将政策同步到 RAG sidecar / 向量库。

Response:

```json
{
  "policy_id": "uuid",
  "indexed": true,
  "backend_mode": "haystack_pgvector",
  "chunk_count": 12
}
```

验收标准：

- 生产环境必须使用持久化 RAG 后端。
- 缺少 RAG internal API key 时不得通过生产 ready。

---

## 8. 政策问答与资格预判

### 8.1 POST /api/v1/policy-qa（已实现）

Request:

```json
{
  "question": "南康家具企业有哪些补贴可以申请？",
  "policy_id": "uuid"
}
```

Response:

```json
{
  "status": "answered",
  "answer": "根据《政策标题》可引用内容：……",
  "confidence": 0.86,
  "citations": [
    {
      "policy_id": "uuid",
      "title": "政策标题",
      "version": "v1",
      "source_name": "南康区政府",
      "source_url": "https://example.gov/policy",
      "snippet": "引用片段"
    }
  ],
  "fallback_task": null,
  "follow_up_questions": [],
  "scoring": {
    "retrieval_backend_mode": "haystack_pgvector"
  }
}
```

Agent 编排开启时可能返回异步轮询信息：

```json
{
  "status": "need_info",
  "answer": "Agent run has been queued. Please poll the run URL for the final answer.",
  "confidence": 0,
  "citations": [],
  "fallback_task": null,
  "scoring": {
    "agent_orchestration_enabled": true,
    "run_id": "uuid",
    "poll_url": "/api/v1/agent-runs/{run_id}",
    "async_status": "queued"
  }
}
```

规则：

- 没有引用时不得给正式政策答案。
- 检索低置信或无引用时进入人工兜底。
- RAG 不可用时可降级关键词检索，但必须在 `scoring` 中说明。

### 8.2 POST /api/v1/eligibility/check（已实现单政策，待增强多政策）

当前实现请求：

```json
{
  "enterprise_id": "uuid",
  "policy_id": "uuid",
  "application_id": "uuid",
  "item_id": "uuid",
  "profile_snapshot": {},
  "evidence": {}
}
```

目标请求，兼容多政策：

```json
{
  "enterprise_id": "uuid",
  "policy_ids": ["uuid_policy_1", "uuid_policy_2"],
  "application_id": "uuid",
  "profile_snapshot": {},
  "evidence": {}
}
```

目标 Response:

```json
{
  "results": [
    {
      "policy_id": "uuid_policy_1",
      "result": "need_info",
      "matched_conditions": [],
      "failed_conditions": [],
      "missing_fields": ["enterprise_profile.tax_amount"],
      "citations": [],
      "evidence_refs": [],
      "fallback_task": null,
      "ai_summary": "还需补充纳税额后才能判断。",
      "rule_first": true
    }
  ]
}
```

当前实现说明：

- 当前仅支持 `policy_id` 单政策。
- 如果传 `policy_ids` 会返回 `VALIDATION_ERROR`。

下一步补齐：

- 支持 `policy_ids` 批量判断。
- 每个政策独立返回结果。
- 对低置信 OCR、证据冲突、自由裁量创建人工兜底任务。

---

## 9. 申报

### 9.1 POST /api/v1/applications（已实现单政策，待增强多政策）

当前请求：

```json
{
  "enterprise_id": "uuid",
  "policy_id": "uuid"
}
```

目标请求：

```json
{
  "enterprise_id": "uuid",
  "policy_ids": ["uuid_policy_1", "uuid_policy_2"],
  "idempotency_key": "create_application_uuid_v1",
  "form_data": {
    "contact_name": "张三",
    "contact_phone": "13800000000"
  }
}
```

目标 Response:

```json
{
  "application_id": "uuid",
  "enterprise_id": "uuid",
  "status": "draft",
  "policy_items": [
    {
      "item_id": "uuid",
      "policy_id": "uuid_policy_1",
      "status": "draft"
    }
  ],
  "form_data": {}
}
```

当前实现说明：

- 当前只支持单 `policy_id`。
- 审计中会标记 `single_policy_only`。

### 9.2 PUT /api/v1/applications/{application_id}（待补齐-P0）

用途：保存草稿表单、联系人、备注、政策差异化字段。

Request:

```json
{
  "idempotency_key": "update_application_uuid_v1",
  "form_data": {
    "contact_name": "张三",
    "contact_phone": "13800000000",
    "project_name": "智能家具产线改造"
  },
  "policy_item_forms": [
    {
      "item_id": "uuid",
      "fields": {
        "requested_amount": 100000
      }
    }
  ]
}
```

Response:

```json
{
  "application_id": "uuid",
  "status": "draft",
  "updated_at": "2026-06-09T10:00:00.000Z"
}
```

规则：

- 仅 `draft` 状态可编辑。
- 已提交后不得直接修改，只能撤回或补正。
- 必须写审计。

### 9.3 GET /api/v1/applications（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| enterprise_id | string | 是 | 企业 ID |
| page | number | 否 | 页码 |
| page_size | number | 否 | 每页数量 |
| status | string | 否 | 待补齐：状态筛选 |

Response:

```json
{
  "page": 1,
  "page_size": 20,
  "total": 1,
  "items": [
    {
      "application_id": "uuid",
      "enterprise_id": "uuid",
      "status": "draft",
      "submit_time": null,
      "deadline_at": null,
      "created_at": "2026-06-09T10:00:00.000Z"
    }
  ]
}
```

### 9.4 GET /api/v1/applications/{application_id}（已实现）

Response:

```json
{
  "application_id": "uuid",
  "enterprise_id": "uuid",
  "applicant_user_id": "uuid",
  "profile_snapshot_id": "uuid",
  "status": "submitted",
  "submit_time": "2026-06-09T10:00:00.000Z",
  "deadline_at": "2026-06-14T10:00:00.000Z",
  "policy_items": [
    {
      "item_id": "uuid",
      "policy_id": "uuid",
      "status": "submitted",
      "review_result": null
    }
  ],
  "materials": [],
  "supplement": null
}
```

### 9.5 POST /api/v1/applications/{application_id}/submit（已实现单政策，待增强多政策）

Request:

```json
{
  "idempotency_key": "submit_application_uuid_v1"
}
```

Response:

```json
{
  "application_id": "uuid",
  "status": "submitted",
  "profile_snapshot_id": "uuid"
}
```

规则：

- 仅 `draft` 可提交。
- 提交时冻结企业画像快照。
- 提交时冻结材料版本。
- 多政策申报时每个 `ApplicationPolicyItem` 独立进入审核流。

当前实现说明：

- 当前只支持单政策提交。
- 多政策场景会返回 `CONFLICT`。

### 9.6 POST /api/v1/applications/{application_id}/withdraw（待补齐-P0）

用途：企业提交后撤回。

Request:

```json
{
  "idempotency_key": "withdraw_application_uuid_v1",
  "reason": "企业主动撤回，稍后重新提交"
}
```

Response:

```json
{
  "application_id": "uuid",
  "from_status": "submitted",
  "status": "withdrawn",
  "withdrawn_at": "2026-06-09T10:00:00.000Z"
}
```

规则：

- 仅 `submitted` 状态允许企业撤回。
- 已进入 `reviewing` 后是否允许撤回由事项配置决定，MVP 默认不允许。
- 撤回后不得继续审核。
- 必须写审计。

### 9.7 POST /api/v1/applications/{application_id}/supplements（已实现）

Request:

```json
{
  "materials": [
    {
      "material_type": "business_license",
      "file_id": "uuid",
      "mode": "replace",
      "issue_date": "2026-01-01",
      "expire_date": "2027-01-01",
      "security_level": "L2"
    }
  ],
  "comment": "已补充最新营业执照"
}
```

Response:

```json
{
  "application_id": "uuid",
  "status": "resubmitted",
  "materials": []
}
```

规则：

- 仅 `need_supplement` 状态可补正。
- `mode=append` 表示新增材料，`mode=replace` 表示替换现有材料。
- 文件必须属于当前企业。

### 9.8 POST /api/v1/applications/{application_id}/agent-assist（已实现）

用途：企业端触发申报辅助 Agent。

Request:

```json
{
  "item_id": "uuid",
  "idempotency_key": "application_agent_uuid_v1"
}
```

Response:

```json
{
  "run_id": "uuid",
  "status": "queued",
  "current_node": "queued",
  "poll_url": "/api/v1/agent-runs/{run_id}"
}
```

---

## 10. 文件、材料与 OCR

### 10.1 POST /api/v1/files（已实现）

Content-Type: `multipart/form-data`

Form fields:

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| file | file | 是 | 上传文件 |
| enterprise_id | string | 是 | 企业 ID |

Response:

```json
{
  "file_id": "uuid",
  "enterprise_id": "uuid",
  "original_filename": "license.png",
  "mime_type": "image/png",
  "byte_size": 123456,
  "file_hash": "sha256",
  "created_at": "2026-06-09T10:00:00.000Z"
}
```

生产增强要求：

- 支持对象存储或共享存储。
- 文件必须鉴权访问。
- 敏感材料不得公开暴露 URL。

### 10.2 GET /api/v1/files/{file_id}（待补齐-P0）

用途：获取文件元数据。

Response:

```json
{
  "file_id": "uuid",
  "enterprise_id": "uuid",
  "original_filename": "license.png",
  "mime_type": "image/png",
  "byte_size": 123456,
  "file_hash": "sha256",
  "created_at": "2026-06-09T10:00:00.000Z"
}
```

### 10.3 GET /api/v1/files/{file_id}/download-url（待补齐-P0）

用途：返回短期有效的下载/预览 URL。

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| purpose | string | 否 | `preview` / `download` |

Response:

```json
{
  "file_id": "uuid",
  "url": "https://object-storage/signed-url",
  "expires_at": "2026-06-09T10:10:00.000Z"
}
```

规则：

- 企业用户只能访问本企业文件。
- 审核人员只能访问授权审核任务中的材料文件。
- 下载 URL 必须短期有效。

### 10.4 POST /api/v1/materials（已实现）

Request:

```json
{
  "application_id": "uuid",
  "material_type": "business_license",
  "file_id": "uuid",
  "issue_date": "2026-01-01",
  "expire_date": "2027-01-01",
  "security_level": "L2"
}
```

Response:

```json
{
  "material_id": "uuid",
  "application_id": "uuid",
  "material_type": "business_license",
  "file_id": "uuid",
  "ocr_status": "pending",
  "security_level": "L2",
  "original_filename": "license.png"
}
```

规则：

- 当前只允许绑定到 `draft` 申报。
- 材料只在本次申报内复用，不作为长期企业材料库。

### 10.5 GET /api/v1/applications/{application_id}/materials（待补齐-P1）

用途：列出某申报下材料。

Response:

```json
{
  "application_id": "uuid",
  "items": [
    {
      "material_id": "uuid",
      "material_type": "business_license",
      "file_id": "uuid",
      "ocr_status": "success",
      "is_current": true
    }
  ]
}
```

### 10.6 POST /api/v1/materials/{material_id}/ocr（已实现）

Request:

```json
{
  "provider": "sidecar",
  "force": false
}
```

Response:

```json
{
  "ocr_result_id": "uuid",
  "material_id": "uuid",
  "ocr_status": "success",
  "fields": {
    "enterprise_name": "南康某家具有限公司",
    "credit_code": "913607XX0000000000"
  },
  "field_confidence": {
    "enterprise_name": 0.96,
    "credit_code": 0.94
  },
  "overall_confidence": 0.95,
  "warnings": []
}
```

规则：

- OCR 字段置信度低于阈值时返回 `low_confidence`，不能作为硬证据。
- OCR 失败不应阻止草稿保存，但提交/审核时必须体现风险。

### 10.7 GET /api/v1/materials/{material_id}/ocr（已实现）

用途：获取最新 OCR 结果。

---

## 11. 政府审核

### 11.1 GET /api/v1/review/tasks（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| page | number | 否 | 页码 |
| page_size | number | 否 | 每页数量 |
| status | string | 否 | 待补齐：状态筛选 |
| policy_id | string | 否 | 待补齐：政策筛选 |
| department_id | string | 否 | 待补齐：部门筛选 |
| keyword | string | 否 | 待补齐：企业名/政策名搜索 |

Response:

```json
{
  "page": 1,
  "page_size": 20,
  "total": 1,
  "items": [
    {
      "item_id": "uuid",
      "application_id": "uuid",
      "application_status": "submitted",
      "policy_item_status": "submitted",
      "review_result": null,
      "enterprise": {
        "enterprise_id": "uuid",
        "name": "南康某家具有限公司"
      },
      "policy": {
        "policy_id": "uuid",
        "title": "政策标题",
        "version": "v1"
      },
      "current_department_id": "dept_001",
      "submit_time": "2026-06-09T10:00:00.000Z",
      "deadline_at": "2026-06-14T10:00:00.000Z"
    }
  ]
}
```

### 11.2 GET /api/v1/review/tasks/{item_id}（已实现）

Response:

```json
{
  "task": {
    "item_id": "uuid",
    "application_id": "uuid",
    "application_status": "submitted",
    "policy_item_status": "submitted",
    "review_result": null,
    "enterprise": {},
    "policy": {}
  },
  "profile_snapshot": {},
  "materials": [],
  "review_records": [],
  "agent_drafts": [],
  "agent_assist_disclaimer": "AI 辅助意见仅供参考，最终审核结论以人工审核为准。"
}
```

### 11.3 POST /api/v1/review/tasks/{item_id}/precheck（待补齐-P0）

用途：政府端主动发起规则 + Agent 预审。

Request:

```json
{
  "idempotency_key": "review_precheck_item_uuid_v1",
  "mode": "async",
  "force": false
}
```

Response:

```json
{
  "item_id": "uuid",
  "application_id": "uuid",
  "status": "pre_reviewing",
  "run_id": "uuid",
  "poll_url": "/api/v1/agent-runs/{run_id}",
  "precheck": {
    "eligibility_result": "need_info",
    "risk_items": [],
    "missing_evidence": []
  }
}
```

规则：

- 允许状态：`submitted`、`resubmitted`、`reviewing`、`manual_review`。
- 预审不能直接改变最终审核结论。
- 预审结果应写 review record 或 agent draft，并写审计。

### 11.4 POST /api/v1/review/tasks/{item_id}/agent-draft（已实现）

用途：生成审核意见草稿。

Request:

```json
{
  "idempotency_key": "review_draft_item_uuid_v1"
}
```

Response:

```json
{
  "run_id": "uuid",
  "status": "queued",
  "poll_url": "/api/v1/agent-runs/{run_id}"
}
```

规则：

- AI 草稿不得自动调用审核决策接口。
- 审核人员必须通过 `review/agent-drafts/{draft_id}/handle` 采纳、修改或忽略。

### 11.5 POST /api/v1/review/agent-drafts/{draft_id}/handle（已实现）

Request:

```json
{
  "action": "adopt",
  "comment": "采纳草稿",
  "revised_opinion": "修改后的意见"
}
```

`action` 可选：

| 值 | 说明 |
| --- | --- |
| adopt | 采纳草稿，但不自动审批 |
| revise | 修改草稿 |
| ignore | 忽略草稿 |

Response:

```json
{
  "draft_id": "uuid",
  "status": "adopted",
  "handled_by": "uuid",
  "handled_at": "2026-06-09T10:00:00.000Z"
}
```

### 11.6 POST /api/v1/review/tasks/{item_id}/decision（已实现单政策，待增强多政策）

Request:

```json
{
  "decision": "approve",
  "comment": "材料完整，符合政策条件。",
  "idempotency_key": "review_decision_item_uuid_v1"
}
```

`decision` 可选：

| 值 | 说明 |
| --- | --- |
| approve | 通过 |
| reject | 驳回 |
| request_supplement | 要求补正 |

Response:

```json
{
  "item_id": "uuid",
  "application_id": "uuid",
  "policy_item_status": "approved",
  "application_status": "approved",
  "review_result": "approved"
}
```

当前实现说明：

- 当前只支持单政策申报的审核决策。
- `request_supplement` 必须传 `comment`。

多政策目标规则：

- 每个子项独立审核。
- 主单状态由子项状态汇总：全部通过为 `approved`；任一补正为 `need_supplement`；全部终态且存在拒绝为 `rejected` 或按业务规则聚合。

### 11.7 POST /api/v1/review/tasks/{item_id}/supplement-request（待补齐-P0）

用途：审核人员独立发起补正通知，不必通过通用审核决策接口。

Request:

```json
{
  "idempotency_key": "supplement_request_item_uuid_v1",
  "reason": "营业执照 OCR 低置信，需要重新上传或人工确认。",
  "deadline_at": "2026-06-14T18:00:00.000Z",
  "required_materials": [
    {
      "material_type": "business_license",
      "requirement": "请上传清晰营业执照原件照片",
      "allow_replace": true
    }
  ],
  "field_requirements": [
    {
      "field_key": "enterprise_profile.tax_amount",
      "requirement": "请补充上一年度纳税额"
    }
  ]
}
```

Response:

```json
{
  "item_id": "uuid",
  "application_id": "uuid",
  "application_status": "need_supplement",
  "policy_item_status": "need_supplement",
  "review_record_id": "uuid",
  "deadline_at": "2026-06-14T18:00:00.000Z"
}
```

规则：

- 必须写 review record 和 audit log。
- 企业端补正入口应读取最新补正要求。
- 补正原因和材料要求不能为空。

---

## 12. Agent Run 与人工兜底恢复

### 12.1 POST /api/v1/agent-runs（已实现）

用途：创建通用 Agent Run。普通前端优先使用业务入口，例如 `policy-qa`、`application/agent-assist`、`review/agent-draft`。

Request:

```json
{
  "entrypoint": "consultation",
  "input": {
    "question": "南康家具企业补贴条件是什么？"
  },
  "idempotency_key": "agent_run_consultation_uuid_v1"
}
```

`entrypoint` 可选：

| 值 | 说明 |
| --- | --- |
| consultation | 政策咨询 |
| application | 申报辅助 |
| review | 审核草稿 |

Response:

```json
{
  "run_id": "uuid",
  "status": "queued",
  "current_node": "queued",
  "state": {},
  "poll_url": "/api/v1/agent-runs/{run_id}"
}
```

### 12.2 GET /api/v1/agent-runs/{run_id}（已实现）

用途：轮询 Agent Run 状态。

Response:

```json
{
  "run_id": "uuid",
  "status": "completed",
  "current_node": "final",
  "state": {},
  "error_message": null,
  "version": 3
}
```

### 12.3 GET /api/v1/agent-runs/{run_id}/steps（已实现）

用途：查看 Agent 执行步骤和工具调用摘要。

Response:

```json
[
  {
    "step_id": "uuid",
    "run_id": "uuid",
    "node_name": "retrieval_planner",
    "agent_type": "retrieval_planner",
    "status": "completed",
    "input": {},
    "output": {},
    "tool_calls": [],
    "token_usage": {},
    "started_at": "2026-06-09T10:00:00.000Z",
    "completed_at": "2026-06-09T10:00:01.000Z"
  }
]
```

### 12.4 POST /api/v1/agent-runs/{run_id}/resume（已实现）

用途：人工兜底任务处理完成后恢复 Agent Run。

Request:

```json
{
  "task_id": "uuid",
  "idempotency_key": "resume_fallback_uuid_v1",
  "resume_payload": {
    "resolution_type": "field_confirmed",
    "confirmed_fields": {
      "tax_amount": 1200000
    },
    "human_comment": "已电话核验并补充企业近一年纳税额。"
  }
}
```

Response:

```json
{
  "run_id": "uuid",
  "status": "resuming",
  "current_node": "resume_queued",
  "poll_url": "/api/v1/agent-runs/{run_id}"
}
```

规则：

- 必须传 `idempotency_key`。
- 仅 `interrupted` 或 `resume_failed` 的 run 可恢复。
- `task_id` 必须是当前 fallback task。
- resume request、resume job、run 状态必须事务一致。
- 恢复完成必须写 `agent_run.resumed` 审计。

---

## 13. 管理后台：人工兜底、审计、Agent 观测

### 13.1 GET /api/v1/admin/fallback-tasks（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| page | number | 否 | 页码 |
| page_size | number | 否 | 每页数量 |
| status | string | 否 | `pending` / `processing` / `resolved` / `closed` |
| source_type | string | 否 | `policy_qa` / `eligibility` / `ocr` / `rag_retrieval` / `agent_run` |

Response:

```json
{
  "page": 1,
  "page_size": 20,
  "total": 1,
  "items": [
    {
      "task_id": "uuid",
      "source_type": "policy_qa",
      "reason": "policy_qa_manual_review",
      "status": "pending",
      "created_at": "2026-06-09T10:00:00.000Z"
    }
  ]
}
```

### 13.2 GET /api/v1/admin/fallback-tasks/{task_id}（已实现）

用途：查看人工兜底任务详情。

### 13.3 POST /api/v1/admin/fallback-tasks/{task_id}/resolve（已实现）

Request:

```json
{
  "resolution_type": "answer",
  "resolved_payload": {
    "answer": "人工确认后的答案",
    "citations": []
  },
  "comment": "已核验政策依据"
}
```

Response:

```json
{
  "task_id": "uuid",
  "status": "resolved",
  "resolved_payload": {},
  "resolved_at": "2026-06-09T10:00:00.000Z"
}
```

规则：

- 处理结果必须写审计。
- 如果任务关联 Agent Run，前端后续应调用 `POST /agent-runs/{run_id}/resume`。

### 13.4 GET /api/v1/admin/audit-logs（已实现）

Query:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| page | number | 否 | 页码 |
| page_size | number | 否 | 每页数量 |
| action | string | 否 | 待补齐：动作筛选 |
| actor_id | string | 否 | 待补齐：操作者筛选 |
| target_type | string | 否 | 待补齐：对象类型筛选 |
| trace_id | string | 否 | 待补齐：链路筛选 |

### 13.5 GET /api/v1/admin/agent-runs（已实现）

用途：后台查看 Agent Run 列表。

### 13.6 GET /api/v1/admin/agent-runs/{run_id}（已实现）

用途：后台查看 Agent Run 详情、steps、LLM calls、job 状态。

### 13.7 GET /api/v1/admin/agent-metrics（已实现）

Response:

```json
{
  "queue_depth": {
    "queued": 0,
    "running": 0,
    "stale": 0
  },
  "model_health": [],
  "fallback_sla": {
    "overdue_count": 0
  },
  "alerts": {
    "daily_budget_overrun": {
      "status": "ok",
      "operator_action": "none"
    }
  }
}
```

验收标准：

- queued、running、stale 可观测。
- daily budget overrun 可 firing。
- 模型 circuit open 可观测。
- fallback SLA overdue 可观测。

---

## 14. 管理后台：配置与看板待补齐接口

### 14.1 GET /api/v1/admin/dashboard/operations（待补齐-P1）

用途：运营看板。

Response:

```json
{
  "consultation": {
    "total": 1000,
    "answered_rate": 0.82,
    "citation_rate": 0.96,
    "fallback_count": 20
  },
  "applications": {
    "created": 100,
    "submitted": 80,
    "approved": 50,
    "need_supplement": 10
  },
  "review": {
    "avg_duration_hours": 12.5,
    "supplement_rate": 0.12
  },
  "ai": {
    "draft_adoption_rate": 0.45,
    "manual_review_rate": 0.18
  }
}
```

### 14.2 GET /api/v1/admin/threshold-configs（待补齐-P1）

用途：查看低置信度阈值配置。

### 14.3 PUT /api/v1/admin/threshold-configs/{config_id}（待补齐-P1）

Request:

```json
{
  "threshold": 0.85,
  "action": "manual_review",
  "reason": "OCR 字段低于 0.85 转人工确认"
}
```

### 14.4 GET /api/v1/admin/prompt-templates（待补齐-P1）

用途：Prompt 模板列表。

### 14.5 POST /api/v1/admin/prompt-templates（待补齐-P1）

Request:

```json
{
  "agent_type": "review",
  "version": "review-v2",
  "content": "提示词内容",
  "schema": "review_draft",
  "status": "draft",
  "change_reason": "补充人工责任边界"
}
```

### 14.6 POST /api/v1/admin/prompt-templates/{template_id}/publish（待补齐-P1）

用途：发布 Prompt stable 版本。

### 14.7 GET /api/v1/admin/model-routes（待补齐-P1）

用途：查看模型路由配置。

### 14.8 PUT /api/v1/admin/model-routes/{agent_type}（待补齐-P1）

Request:

```json
{
  "primary_model": "qwen3.6-plus",
  "fallback_model": "qwen-plus-2025-07-28",
  "max_tokens": 4096,
  "temperature": 0.2,
  "timeout_ms": 30000,
  "daily_budget_cents": 50000,
  "change_reason": "生产灰度模型调整"
}
```

规则：

- 发布前必须跑 smoke 和 eval。
- 变更必须写审计。
- 必须支持回滚。

---

## 15. 权限、审计与安全要求

### 15.1 权限基线

| 场景 | 要求 |
| --- | --- |
| 企业接口 | 必须校验用户属于目标企业 |
| 政府审核接口 | 必须校验审核权限和部门范围 |
| 管理后台接口 | 必须校验 admin 权限 |
| 文件访问 | 必须校验企业、审核任务或管理员权限 |
| Agent Run 查询 | 企业只能看自己的 run；管理员可按权限查看全部 |

### 15.2 审计基线

以下动作必须写审计：

- 注册、登录失败可选记录风控日志
- 企业绑定
- 企业画像更新 / 导入
- 政策导入、结构化、发布
- 文件上传、材料绑定、OCR 分析
- 申报创建、编辑、提交、撤回、补正
- 预审、审核决策、补正通知
- AI 草稿采纳/修改/忽略
- 人工兜底处理和 Agent resume
- 模型路由、Prompt、阈值配置变更
- 预算 overrun、熔断、降级

### 15.3 数据脱敏

- LLM prompt、审计 detail、错误响应不得包含 API key、token、身份证、手机号、银行卡等敏感信息原文。
- 材料文件 URL 不得长期公开。
- OCR 低置信字段不得作为硬证据。

---

## 16. Agent 工具与 REST API 映射

| Agent 工具 | 后端 API / 内部服务 | 状态 |
| --- | --- | --- |
| getEnterpriseProfile | `GET /api/v1/enterprise-profile` | 已实现 |
| saveEnterpriseProfile | `PUT /api/v1/enterprise-profile` | 已实现 |
| semanticSearch | RAG sidecar / `ragService.search` | 已实现，生产待验收 |
| getPolicyDetail | `GET /api/v1/policies/{policy_id}` | 已实现 |
| matchConditions | 内部 Rule Engine | 已实现 |
| checkEligibility | `POST /api/v1/eligibility/check` | 已实现单政策，多政策待补齐 |
| createApplication | `POST /api/v1/applications` | 已实现单政策，多政策待补齐 |
| updateApplicationDraft | `PUT /api/v1/applications/{application_id}` | 待补齐-P0 |
| submitApplication | `POST /api/v1/applications/{application_id}/submit` | 已实现单政策，多政策待补齐 |
| splitApplicationByPolicy | 内部 Application Service | 待补齐-P1 |
| loadApplicationDetail | `GET /api/v1/review/tasks/{item_id}` | 已实现 |
| generateReviewDraft | `POST /api/v1/review/tasks/{item_id}/agent-draft` | 已实现 |
| handleReviewDraft | `POST /api/v1/review/agent-drafts/{draft_id}/handle` | 已实现 |
| createSupplementNotice | `POST /api/v1/review/tasks/{item_id}/supplement-request` | 待补齐-P0 |
| ocrAnalyze | `POST /api/v1/materials/{material_id}/ocr` | 已实现 |
| validateFileFormat | `POST /api/v1/files` | 已实现 |
| createFallbackTask | 内部 Fallback Service | 已实现 |
| resolveFallbackTask | `POST /api/v1/admin/fallback-tasks/{task_id}/resolve` | 已实现 |
| resumeAgentRun | `POST /api/v1/agent-runs/{run_id}/resume` | 已实现 |
| writeAuditLog | 内部 Audit Service | 已实现 |
| checkPermission | 内部 Permission Service | 已实现 |

### 16.1 Agent 工具调用约束

- 读类工具可重试 2 次。
- 写类工具必须提供 `idempotency_key`，不自动盲重试。
- 模型 JSON 格式错误重试 1 次，仍失败转人工。
- RAG 超时降级关键词检索，并记录 `degrade_reason`。
- OCR 不可用时允许人工录入字段，不阻塞草稿保存。
- 低置信、无引用、规则冲突、OCR 低置信必须进入人工兜底或人工确认。
- 审核意见草稿必须人工确认后才能生效。

---

## 17. 接口补齐验收标准

### 17.1 单接口验收

每个新增接口必须满足：

1. 路由已注册。
2. 请求体和 query 参数有校验。
3. 权限校验接入。
4. 状态机校验正确。
5. 幂等键处理清晰。
6. 成功响应符合 `success/data/trace_id` 包络。
7. 错误响应使用统一错误码。
8. 写操作有审计。
9. 单测或集成测试覆盖成功、无权限、状态冲突、重复调用。

### 17.2 核心业务链路验收

#### 企业端链路

1. 注册登录。
2. 企业绑定。
3. 维护企业画像。
4. 政策问答返回引用。
5. 资格预判给出规则优先结果。
6. 创建申报草稿。
7. 上传文件、绑定材料、OCR。
8. 保存草稿。
9. 提交申报。
10. 查看进度。
11. 收到补正后提交补正。

#### 政府端链路

1. 审核人员登录。
2. 查看审核任务。
3. 查看申报详情、材料、OCR 证据。
4. 发起预审。
5. 生成 AI 草稿。
6. 采纳/修改/忽略草稿。
7. 发起补正或审核通过/驳回。
8. 审计日志可追踪。

#### 后台链路

1. 导入政策。
2. 配置结构化规则和材料。
3. 发布政策。
4. 同步 RAG 索引。
5. 导入企业画像。
6. 处理人工兜底。
7. 查看 Agent metrics 和审计。
8. 配置阈值、Prompt、模型路由。

### 17.3 生产预发验收

必须执行并保存结果：

```bash
npm run build
npm test
npm run test:rag-heavy
npm run llm:agent-core-eval
npm run llm:bailian-smoke
npm run ops:preprod-agent-runtime-check
```

通过口径：

- `build` 通过。
- 全量测试通过。
- RAG heavy 通过。
- Agent core eval 通过。
- Bailian smoke 使用真实 key 通过，不能是 skipped。
- 预发 runtime check `failed=0`。
- RAG sidecar ready 200，且生产使用持久化后端。
- OCR sidecar 可处理真实营业执照。
- API Web 与 Agent Worker 分离部署。
- 文件存储可跨 API/Worker/OCR 访问。

---

## 18. 下一批接口补齐建议

建议按以下顺序实现，不要一次性扩太多：

### Batch A：企业申报闭环补齐

1. `PUT /api/v1/applications/{application_id}`
2. `POST /api/v1/applications/{application_id}/withdraw`
3. `GET /api/v1/files/{file_id}`
4. `GET /api/v1/files/{file_id}/download-url`
5. `GET /api/v1/applications/{application_id}/materials`

验收：企业端可完整草稿、材料预览、提交、撤回。

### Batch B：政府审核闭环补齐

1. `POST /api/v1/review/tasks/{item_id}/precheck`
2. `POST /api/v1/review/tasks/{item_id}/supplement-request`
3. 审核列表增加筛选。
4. 审计日志增加筛选。

验收：政府端可主动预审、补正、审核，企业端可看到补正要求。

### Batch C：后台运营补齐

1. `POST /api/v1/admin/enterprise-profiles/import`
2. `GET /api/v1/admin/dashboard/operations`
3. `GET/PUT /api/v1/admin/threshold-configs`
4. `GET/POST/PUBLISH /api/v1/admin/prompt-templates`
5. `GET/PUT /api/v1/admin/model-routes`

验收：后台能支撑政策运营、企业画像导入、AI 配置与观测。

### Batch D：多政策申报

1. 扩展 `POST /api/v1/applications` 支持 `policy_ids`。
2. 扩展 `POST /api/v1/eligibility/check` 支持 `policy_ids`。
3. 扩展 submit / review decision 支持多子项聚合状态。

验收：企业一次选择多个政策，后端拆成多个 `ApplicationPolicyItem`，政府端按子项审核，企业端展示主单和子项状态。
