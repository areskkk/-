# 政策结构化 Schema

> 目标：把政策原文转为可检索、可预判、可审核的结构化数据。  
> 原则：规则优先，AI 只辅助提取、解释和总结，结构化结果必须人工审核发布。

## 1. Policy Schema

```json
{
  "policy_id": "POLICY-2026-001",
  "title": "政策标题",
  "department": "责任部门",
  "source_type": "official",
  "source_url": "https://example.gov.cn/policy",
  "version": "v1",
  "status": "draft",
  "effective_date": "2026-01-01",
  "expire_date": "2026-12-31",
  "applicable_objects": ["家具制造企业"],
  "conditions": [],
  "materials": [],
  "process": [],
  "deadlines": [],
  "exclusion_rules": []
}
```

## 2. Condition DSL

完整语法见 `docs/规则表达式DSL语法定义.md`。本 Schema 只定义政策结构化时写入 `PolicyCondition` 的核心字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| field_key | string | 画像字段或材料字段 |
| operator | enum | eq、neq、in、not_in、gte、lte、between、exists |
| target_value | any | 目标值 |
| required | boolean | 是否硬性条件 |
| evidence_type | enum | profile、material、manual |
| fail_action | enum | ineligible、need_info、manual_review |

示例：

```json
{
  "field_key": "industry",
  "operator": "in",
  "target_value": ["家具制造", "木材加工"],
  "required": true,
  "evidence_type": "profile",
  "fail_action": "ineligible"
}
```

组合表达式示例：

```json
{
  "logic": "AND",
  "conditions": [
    {
      "field_key": "enterprise.region",
      "operator": "eq",
      "target_value": "南康区",
      "required": true,
      "evidence_type": "profile",
      "fail_action": "ineligible"
    },
    {
      "logic": "OR",
      "conditions": [
        {
          "field_key": "material.green_product_certificate",
          "operator": "exists",
          "target_value": true,
          "required": false,
          "evidence_type": "material",
          "fail_action": "need_info"
        },
        {
          "field_key": "application.self_commitment",
          "operator": "exists",
          "target_value": true,
          "required": false,
          "evidence_type": "manual",
          "fail_action": "manual_review"
        }
      ]
    }
  ]
}
```

## 3. Material Requirement Schema

```json
{
  "material_type": "business_license",
  "name": "营业执照",
  "required": true,
  "reuse_allowed_in_application": true,
  "validity_days": null,
  "ocr_fields": ["enterprise_name", "credit_code", "registered_address"]
}
```

## 4. 政策生命周期

| 状态 | 说明 | 可操作 |
| --- | --- | --- |
| draft | 草稿 | 编辑、提交审核 |
| effective | 生效 | 被检索、推荐、申报 |
| revoked | 废止 | 禁止新申报，存量申报转人工复核 |
| archived | 归档 | 只读 |

## 5. 人工审核要求

- AI 提取的结构化结果默认是草稿。
- 政策管理员必须审核条件、材料、流程、时限后发布。
- 每次发布生成版本号。
- 修改已生效政策必须生成新版本，不覆盖历史版本。
