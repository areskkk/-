# Agent 编排详细设计

> 编排框架：LangGraph 类图编排。  
> 持久化：Postgres Checkpoint + 业务表。  
> 目标：明确节点、边、State Schema、读写字段、失败重试和人工兜底。

## 1. LangGraph 节点

| 节点 | 责任 |
| --- | --- |
| intent_node | 识别用户意图、槽位、缺失字段 |
| retrieval_node | Query 改写、语义检索、关键词降级、权限过滤 |
| policy_analysis_node | 获取政策条件、执行规则匹配、生成差距解释 |
| application_assist_node | 表单预填、材料清单、本次材料复用、创建申报 |
| ocr_node | 文件格式校验、OCR、低置信度标记 |
| review_node | 审核条件比对、风险标记、审批草稿 |
| human_fallback_node | 低置信度、失败、冲突进入平台运营队列 |
| audit_node | 写入工具调用、模型调用、人工动作审计 |

人工兜底恢复的详细机制见 `docs/人工兜底恢复机制设计.md`。

## 2. 主要路径

### 2.1 咨询路径

```text
intent_node -> retrieval_node -> policy_analysis_node -> audit_node -> END
```

低置信度分支：

```text
retrieval_node -> human_fallback_node(interrupt) -> resume -> policy_analysis_node -> audit_node -> END
policy_analysis_node -> human_fallback_node(interrupt) -> resume -> audit_node -> END
```

### 2.2 申报路径

```text
intent_node -> policy_analysis_node -> application_assist_node -> ocr_node -> audit_node -> END
```

OCR 低置信度：

```text
ocr_node -> human_fallback_node(interrupt) -> resume -> application_assist_node -> audit_node -> END
```

### 2.3 审核路径

```text
review_node -> audit_node -> END
```

需要人工复核：

```text
review_node -> human_fallback_node(interrupt) -> resume -> review_node -> audit_node -> END
```

## 3. State Schema

```json
{
  "session": {
    "session_id": "string",
    "trace_id": "string",
    "channel": "web|h5|admin"
  },
  "user_context": {
    "user_id": "string",
    "enterprise_id": "string",
    "roles": ["string"]
  },
  "enterprise_profile_snapshot": {
    "snapshot_id": "string",
    "immutable": true
  },
  "intent": {
    "type": "policy_query|application|progress_query|review",
    "missing_fields": ["string"],
    "confidence": 0.0
  },
  "retrieval_result": {
    "candidate_policy_ids": ["string"],
    "top1_score": 0.0,
    "low_confidence": false
  },
  "policy_conditions": {
    "policy_id": "string",
    "version": "string",
    "conditions": []
  },
  "eligibility_result": {
    "result": "eligible|ineligible|need_info|manual_review",
    "matched_conditions": [],
    "missing_fields": []
  },
  "materials": {
    "material_ids": ["string"],
    "low_confidence_fields": []
  },
  "application": {
    "application_id": "string",
    "item_ids": ["string"],
    "status": "draft|submitted|reviewing"
  },
  "review": {
    "item_id": "string",
    "risk_flags": [],
    "draft_opinion": "string"
  },
  "fallback": {
    "required": false,
    "reason": "string",
    "task_id": "string",
    "interrupt_at": "string",
    "resume_payload": {},
    "resume_idempotency_key": "string"
  },
  "audit_trace": {
    "model_calls": [],
    "tool_calls": [],
    "errors": []
  }
}
```

## 4. 节点读写字段

| 节点 | 读取 | 写入 |
| --- | --- | --- |
| intent_node | session、user_context、enterprise_profile_snapshot | intent |
| retrieval_node | intent、user_context、enterprise_profile_snapshot | retrieval_result |
| policy_analysis_node | retrieval_result、policy_conditions、enterprise_profile_snapshot、materials | eligibility_result |
| application_assist_node | eligibility_result、enterprise_profile_snapshot、materials | application |
| ocr_node | materials、application | materials.low_confidence_fields |
| review_node | application、policy_conditions、materials | review、fallback |
| human_fallback_node | 全部上下文摘要 | fallback.task_id |
| audit_node | audit_trace | AuditLog 业务表 |

## 5. 人工兜底 interrupt/resume

1. 任一节点触发低置信度、规则冲突、OCR 证据不足或工具失败后，写入 `fallback.required=true`、`fallback.reason`、`interrupt_at`。
2. `human_fallback_node` 创建 `FallbackTask`，把当前 LangGraph State 写入 Postgres Checkpoint，同时把业务上下文摘要写入兜底任务。
3. 编排进入 `interrupt`，不继续执行后续节点。
4. 平台运营人员处理任务，补齐人工结论、字段确认、材料确认或审核建议。
5. 后端调用 `POST /api/v1/agent-runs/{run_id}/resume`，传入 `task_id`、`resume_payload`、`idempotency_key`。
6. 编排从 Postgres Checkpoint 恢复 State，合并人工处理结果，并同步更新 Application、ReviewRecord、Material、AuditLog 等业务表。
7. 恢复后根据 `interrupt_at` 回到原路径继续执行；重复 resume 使用幂等键返回已有结果。

## 6. 不可变字段

- 企业画像快照。
- 政策版本。
- 材料 hash。
- 审计记录。
- 已提交申报的历史状态记录。

## 7. 持久化

| 数据 | 存储 |
| --- | --- |
| LangGraph State | Postgres Checkpoint |
| 申报主单/子项 | Application、ApplicationPolicyItem |
| 审核记录 | ReviewRecord |
| 审计日志 | AuditLog |
| 低置信度队列 | FallbackTask |
| 材料结果 | Material、OCRResult |

Checkpoint 用于恢复编排状态；业务表是事实源。

Checkpoint 与业务表写入必须通过事务边界或补偿机制保证一致性：业务事实写入失败时不得把 checkpoint 标记为已完成；checkpoint 写入失败时不得继续推进业务状态。

## 8. 失败与重试

| 场景 | 策略 |
| --- | --- |
| 读类工具失败 | 重试 2 次 |
| 写类工具失败 | 需幂等键，不自动盲重试 |
| 模型 JSON 格式错误 | 重试 1 次，仍失败转人工 |
| RAGFlow 超时 | 降级 keywordSearch |
| OCR 服务不可用 | 允许人工录入字段，不阻塞草稿保存 |
| 权限校验失败 | 终止流程并写审计 |
| 低置信度 | 转 human_fallback_node |

## 9. 可观测性

- 每次节点执行记录 trace_id。
- 每次工具调用记录输入摘要、输出摘要、耗时、错误码。
- 每次模型调用记录模型名、版本、token、耗时。
- 人工修改 AI 草稿必须记录修改前后差异。
