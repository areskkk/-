# Agent Prompt 模板规格

> 说明：本文定义 Prompt 的输入输出契约。MVP 可直接入库的初始模板见 `docs/初始Prompt模板.md`；上线后在后台 `PromptTemplate` 管理、测试、灰度发布和回滚。工具定义见 `docs/Agent工具定义文档.md`，编排见 `docs/Agent编排详细设计.md`。

## 1. 企业诉求 Agent

| 项 | 内容 |
| --- | --- |
| 输入 | 用户问题、企业画像、历史对话 |
| 输出 | intent、missing_fields、follow_up_question |
| 工具 | getEnterpriseProfile、getConversationHistory、saveConversationTurn、speechToText |
| 失败处理 | 意图不明时追问，不给政策结论 |

Output Schema:

```json
{
  "intent": "policy_query",
  "missing_fields": ["tax_amount"],
  "follow_up_question": "请补充近一年纳税额。"
}
```

## 2. 检索调度 Agent

| 项 | 内容 |
| --- | --- |
| 输入 | intent、query、enterprise_profile |
| 输出 | retrieval_query、filters、candidate_policies |
| 工具 | rewriteQuery、semanticSearch、keywordSearch、filterByPermission、getPolicyDetail |
| 失败处理 | Top1 < 0.75 转人工或扩大检索 |

## 3. 政策分析 Agent

| 项 | 内容 |
| --- | --- |
| 输入 | candidate_policies、PolicyCondition、EnterpriseProfileSnapshot |
| 输出 | eligibility_result、matched_conditions、missing_fields、explanation |
| 工具 | getPolicyConditions、matchConditions、calculateComplianceScore、explainGap |
| 失败处理 | 规则冲突或证据缺失转人工 |

## 4. 申报辅助 Agent

| 项 | 内容 |
| --- | --- |
| 输入 | selected_policies、profile、materials |
| 输出 | merged_form_fields、material_checklist、supplement_tips |
| 工具 | getMaterialRequirements、checkMaterialReuse、prefillForm、validateMaterialCompleteness、createApplication、splitApplicationByPolicy、ocrAnalyze |
| 失败处理 | OCR 低置信度提示人工确认 |

## 5. 审核 Agent

| 项 | 内容 |
| --- | --- |
| 输入 | application_item、policy_conditions、materials、ocr_fields |
| 输出 | precheck_result、risk_points、draft_opinion |
| 工具 | loadApplicationDetail、compareConditions、generateReviewDraft、markRiskFlag、createSupplementNotice、writeAuditLog |
| 失败处理 | 自由裁量、低置信度、AI 与规则冲突转人工 |

## 6. 全局约束

- 必须输出引用来源。
- 不得替代最终审批。
- 与规则引擎冲突时，以规则结果为准。
- 所有 Agent 输出写入 trace。
- 调用工具前必须先做权限检查或依赖上游已完成的权限过滤。
- 输出必须是合法 JSON；格式错误允许重试 1 次，仍失败转人工。
- 写类工具必须传 `idempotency_key`。
- 审批意见草稿必须标记为 draft，人工确认前不得生效。
- 初始 Prompt 入库时必须记录 `agent_type`、`version`、`status=draft`、`content`、`created_by`。
- Prompt 发布必须先通过测试样例；灰度版本只对配置范围内流量生效；异常时回滚到上一 stable 版本。
