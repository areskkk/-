# Agent 工具定义文档

> 工具风格：函数签名 + JSON Schema。  
> 重试策略：读类工具重试 2 次；写类工具需幂等键，不自动盲重试；模型 JSON 格式错误重试 1 次，仍失败转人工。

## 1. 通用错误码

| code | 说明 |
| --- | --- |
| AUTH_REQUIRED | 未登录 |
| FORBIDDEN | 无权限 |
| NOT_FOUND | 资源不存在 |
| VALIDATION_ERROR | 参数错误 |
| TIMEOUT | 调用超时 |
| LOW_CONFIDENCE | 低置信度 |
| CONFLICT | 状态或版本冲突 |
| TOOL_ERROR | 工具异常 |

## 2. 企业诉求 Agent 工具

### getEnterpriseProfile

```ts
getEnterpriseProfile(input: { enterprise_id: string }): EnterpriseProfileSnapshot
```

| 项 | 要求 |
| --- | --- |
| 权限 | 当前用户需绑定企业或政府授权 |
| 超时 | 1s |
| 幂等 | 是 |
| 重试 | 读类重试 2 次 |

### getConversationHistory

```ts
getConversationHistory(input: { session_id: string; limit?: number }): ConversationTurn[]
```

返回最近对话轮次，用于意图识别和上下文补全。

### saveConversationTurn

```ts
saveConversationTurn(input: { session_id: string; role: "user" | "assistant"; content: string; trace_id: string; idempotency_key: string }): { turn_id: string }
```

写类工具，必须传 `idempotency_key`，失败不自动盲重试。

### speechToText

```ts
speechToText(input: { file_id: string; language?: "zh"; sensitive?: boolean }): { text: string; confidence: number }
```

敏感语音走私有化或专有云 Speech-to-Text。

## 3. 检索调度 Agent 工具

### semanticSearch

```ts
semanticSearch(input: { query: string; filters?: object; top_k: number }): { items: PolicyHit[]; top1_score: number }
```

Top1 < 0.75 时标记低置信度。

### keywordSearch

```ts
keywordSearch(input: { query: string; filters?: object; top_k: number }): { items: PolicyHit[] }
```

RAGFlow/语义检索超时时的降级工具。

### filterByPermission

```ts
filterByPermission(input: { user_id: string; policy_ids: string[]; action: string }): { allowed_policy_ids: string[]; denied_policy_ids: string[] }
```

权限过滤必须在返回候选政策前执行。

### getPolicyDetail

```ts
getPolicyDetail(input: { policy_id: string; version?: string }): PolicyDetail
```

返回政策原文、版本、结构化字段和来源链接。

### rewriteQuery

```ts
rewriteQuery(input: { query: string; enterprise_profile?: object }): { rewritten_query: string; keywords: string[] }
```

模型 JSON 格式错误重试 1 次。

## 4. 政策分析 Agent 工具

### matchConditions

```ts
matchConditions(input: { policy_id: string; profile_snapshot_id: string; material_ids?: string[] }): EligibilityResult
```

规则引擎工具，模型不得覆盖结果。

### getPolicyConditions

```ts
getPolicyConditions(input: { policy_id: string; version?: string }): PolicyCondition[]
```

### calculateComplianceScore

```ts
calculateComplianceScore(input: { matched: number; total: number; hard_failed: boolean }): { score: number; rank_reason: string }
```

仅用于排序，不替代硬性资格判断。

### explainGap

```ts
explainGap(input: { eligibility_result: EligibilityResult; audience: "enterprise" | "reviewer" }): { explanation: string; citations: Citation[] }
```

必须带政策引用。

## 5. 申报辅助 Agent 工具

### getMaterialRequirements

```ts
getMaterialRequirements(input: { policy_ids: string[] }): MaterialRequirement[]
```

### checkMaterialReuse

```ts
checkMaterialReuse(input: { application_id: string; material_type: string; hash?: string }): { reusable: boolean; material_id?: string; reason: string }
```

只检查本次申报内复用。

### prefillForm

```ts
prefillForm(input: { form_schema_id: string; profile_snapshot_id: string }): { fields: object; missing_fields: string[] }
```

### validateMaterialCompleteness

```ts
validateMaterialCompleteness(input: { application_id: string; policy_ids: string[] }): { complete: boolean; missing_materials: string[]; low_confidence_fields: string[] }
```

### createApplication

```ts
createApplication(input: { enterprise_id: string; policy_ids: string[]; idempotency_key: string }): { application_id: string }
```

写类工具，必须幂等。

### splitApplicationByPolicy

```ts
splitApplicationByPolicy(input: { application_id: string; idempotency_key: string }): { item_ids: string[] }
```

## 6. 审核 Agent 工具

### loadApplicationDetail

```ts
loadApplicationDetail(input: { item_id: string }): ApplicationReviewDetail
```

### compareConditions

```ts
compareConditions(input: { item_id: string }): { comparisons: ConditionComparison[]; result: "pass" | "need_supplement" | "reject" | "manual_review" }
```

### generateReviewDraft

```ts
generateReviewDraft(input: { item_id: string; comparisons: ConditionComparison[]; risk_flags: string[] }): { draft: string; citations: Citation[] }
```

草稿必须人工确认后生效。

### markRiskFlag

```ts
markRiskFlag(input: { item_id: string; risk_type: string; reason: string; idempotency_key: string }): { risk_id: string }
```

### createSupplementNotice

```ts
createSupplementNotice(input: { item_id: string; missing_materials: string[]; missing_fields: string[]; deadline_at: string; idempotency_key: string }): { notice_id: string }
```

## 7. 通用/OCR/系统工具

### ocrAnalyze

```ts
ocrAnalyze(input: { file_id: string; material_type?: string }): { fields: object; field_confidence: Record<string, number>; overall_confidence: number }
```

字段置信度 < 0.85 转人工确认。
字段级返回 Schema 见 `docs/OCR识别字段定义.md`；字段路径映射见 `docs/字段路径映射表.md`。

### validateFileFormat

```ts
validateFileFormat(input: { file_id: string; allowed_types: string[]; max_size_mb: number }): { valid: boolean; reason?: string }
```

### sendNotification

```ts
sendNotification(input: { user_id: string; channel: "site" | "sms"; template_id: string; payload: object; idempotency_key: string }): { notification_id: string }
```

### writeAuditLog

```ts
writeAuditLog(input: { actor_id: string; action: string; target_type: string; target_id: string; trace_id: string; idempotency_key: string }): { audit_log_id: string }
```

### checkPermission

```ts
checkPermission(input: { user_id: string; action: string; resource_type: string; resource_id: string }): { allowed: boolean; reason?: string }
```
